-- Payment choices may change without changing the officially submitted keeper players.
-- Every amendment is atomic, revision-checked and preserved in a private audit trail.
create table public.keeper_payment_amendments (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues,
  season_id uuid not null,
  submission_id uuid not null,
  franchise_id uuid not null,
  previous_revision integer not null,
  revision integer not null check (revision=previous_revision+1),
  status text not null check (status in ('submitted','approved','locked')),
  old_assignments jsonb not null,
  new_assignments jsonb not null,
  reason text not null check (length(btrim(reason)) between 5 and 2000),
  actor_user_id uuid not null references auth.users,
  trade_id uuid references public.trades,
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (submission_id,season_id) references public.keeper_submissions(id,season_id),
  foreign key (season_id,franchise_id) references public.season_teams,
  unique (submission_id,revision)
);
alter table public.keeper_payment_amendments enable row level security;
revoke all on public.keeper_payment_amendments from public,anon,authenticated;
grant select on public.keeper_payment_amendments to authenticated;
create policy payment_amendment_read on public.keeper_payment_amendments for select using (private.is_commissioner(league_id));
create trigger immutable_payment_amendment before update or delete on public.keeper_payment_amendments
  for each row execute function private.prevent_immutable_change();

-- Defer this one uniqueness check only while an audited cyclic payment swap runs.
alter table public.keeper_season_records drop constraint keeper_season_records_pick_id_key;
alter table public.keeper_season_records add constraint keeper_season_records_pick_id_key unique (pick_id) deferrable initially immediate;
create function private.protect_keeper_payment_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and (to_jsonb(new)-array['pick_id','actual_payment_round'])=(to_jsonb(old)-array['pick_id','actual_payment_round'])
    and exists(select 1 from public.keeper_payment_amendments a
      where a.submission_id=old.submission_id and a.season_id=old.season_id and a.actor_user_id=auth.uid() and a.transaction_id=txid_current()
        and a.old_assignments @> jsonb_build_array(jsonb_build_object('player_id',old.player_id,'pick_id',old.pick_id))
        and a.new_assignments @> jsonb_build_array(jsonb_build_object('player_id',new.player_id,'pick_id',new.pick_id))
        and exists(select 1 from public.draft_picks p where p.id=new.pick_id and p.season_id=new.season_id
          and p.current_owner_id=new.franchise_id and p.round=new.actual_payment_round)) then return new;
  end if;
  raise exception 'Historical records are immutable; use an audited keeper payment amendment';
end $$;
drop trigger immutable_keeper_history on public.keeper_season_records;
create trigger immutable_keeper_history before update or delete on public.keeper_season_records
  for each row execute function private.protect_keeper_payment_history();

-- This validator deliberately uses the submitted cost/tenure, never mutable profiles.
-- Revealed payment picks count as used only when the exact current keeper owns them.
create function private.validate_fixed_keeper_payments(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; a record; nearest integer;
begin
  select * into strict k from public.keeper_submissions where id=p_submission;
  select * into strict s from public.seasons where id=k.season_id;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if (select count(*) from public.keeper_assignments where submission_id=k.id)>r.roster_capacity then raise exception 'Keeper count exceeds the season roster capacity'; end if;
  for a in select ka.*,dp.round as payment_round,dp.current_owner_id,dp.status as pick_status,dp.season_id as pick_season,
      po.franchise_id as player_owner,rs.frozen_at
    from public.keeper_assignments ka join public.draft_picks dp on dp.id=ka.pick_id
    left join public.player_ownerships po on po.season_id=ka.season_id and po.player_id=ka.player_id
    left join public.roster_snapshots rs on rs.id=po.source_snapshot_id where ka.submission_id=k.id loop
    if a.player_owner is distinct from k.franchise_id or a.frozen_at is null then raise exception 'Player % is not in this franchise''s frozen keeper pool',a.player_id; end if;
    if a.base_round_at_submission is null or a.tenure_at_submission is null or a.base_round_at_submission not between 1 and r.draft_rounds
      or a.tenure_at_submission<1 or a.tenure_at_submission>=r.tenure_limit then raise exception 'Saved keeper cost and tenure are invalid'; end if;
    if a.pick_season<>k.season_id or a.current_owner_id<>k.franchise_id or a.payment_round>a.base_round_at_submission
      or (a.pick_status<>'available' and not (s.keepers_revealed_at is not null and exists(
        select 1 from public.keeper_season_records h where h.season_id=s.id and h.submission_id=k.id and h.player_id=a.player_id and h.pick_id=a.pick_id))) then
      raise exception 'Invalid owned payment pick for player %',a.player_id;
    end if;
    if exists(select 1 from public.keeper_assignments other where other.reserved and other.submission_id<>k.id
      and (other.pick_id=a.pick_id or (other.season_id=k.season_id and other.player_id=a.player_id))) then raise exception 'A selected player or pick is already committed'; end if;
    select max(p.round) into nearest from public.draft_picks p
      where p.season_id=k.season_id and p.current_owner_id=k.franchise_id and p.status='available'
        and p.round>a.payment_round and p.round<=a.base_round_at_submission
        and not exists(select 1 from public.keeper_assignments chosen where chosen.submission_id=k.id and chosen.pick_id=p.id)
        and not exists(select 1 from public.keeper_assignments reserved where reserved.pick_id=p.id and reserved.reserved and reserved.submission_id<>k.id);
    if nearest is not null then raise exception 'Player % must use an available round % pick before an earlier pick',a.player_id,nearest; end if;
  end loop;
end $$;

-- Internal staging is never exposed as an RPC. League lock is already held.
-- The returned snapshot is local to this transaction; any later failure restores it.
create function private.prepare_keeper_payment_amendments(p_league uuid,p_amendments jsonb,p_note text,p_trade uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry jsonb; chosen jsonb; old_rows jsonb; context jsonb:='[]'; k public.keeper_submissions; s public.seasons; n integer;
begin
  if p_amendments is null or jsonb_typeof(p_amendments)<>'array' or jsonb_array_length(p_amendments)>30 then raise exception 'Payment amendments must be an array of at most 30 submissions'; end if;
  if jsonb_array_length(p_amendments)=0 then return context; end if;
  if length(btrim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'A payment change reason of 5 to 2000 characters is required'; end if;
  if (select count(distinct value->>'submission_id') from jsonb_array_elements(p_amendments))<>jsonb_array_length(p_amendments) then raise exception 'Duplicate payment submission'; end if;
  for entry in select value from jsonb_array_elements(p_amendments) loop
    if jsonb_typeof(entry)<>'object' or (entry-array['submission_id','expected_revision','assignments'])<>'{}'::jsonb
      or not (entry ?& array['submission_id','expected_revision','assignments']) or (entry->>'expected_revision') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(entry->'assignments') is distinct from 'array' then raise exception 'Invalid payment amendment'; end if;
    select * into k from public.keeper_submissions where id=(entry->>'submission_id')::uuid for update;
    if not found then raise exception 'Submission not found' using errcode='P0002'; end if;
    select * into strict s from public.seasons where id=k.season_id for update;
    if s.league_id<>p_league or not (private.is_commissioner(s.league_id) or private.can_manage_franchise(k.franchise_id)) then raise exception 'Only an assigned manager or commissioner may change payments' using errcode='42501'; end if;
    if not k.is_current or k.revision is distinct from (entry->>'expected_revision')::integer then raise exception 'Submission changed; reload before changing payments' using errcode='40001'; end if;
    if k.status not in ('submitted','approved','locked') then raise exception 'Submit keepers before changing only their payment picks'; end if;
    if s.phase not in ('keeper_selection','draft_ready') or exists(select 1 from public.live_draft_selections where season_id=s.id) then raise exception 'Keeper payments cannot change after the draft has started or the season is closed'; end if;
    if p_trade is not null and (not exists(select 1 from public.trade_participants where trade_id=p_trade and franchise_id=k.franchise_id)
      or not exists(select 1 from public.trades t where t.id=p_trade and (t.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id where x.trade_id=t.id and p.season_id=s.id)))) then
      raise exception 'Payment amendment must belong to a participating team and affected trade season'; end if;
    chosen:=entry->'assignments'; n:=jsonb_array_length(chosen);
    if n>30 or n<>(select count(*) from public.keeper_assignments where submission_id=k.id)
      or exists(select 1 from jsonb_array_elements(chosen) x where jsonb_typeof(x)<>'object' or (x-array['player_id','pick_id'])<>'{}'::jsonb
        or not (x ?& array['player_id','pick_id']) or jsonb_typeof(x->'player_id') is distinct from 'number'
        or (x->>'player_id') !~ '^[1-9][0-9]*$' or jsonb_typeof(x->'pick_id') is distinct from 'string') then raise exception 'Payment changes must retain the exact submitted keeper players'; end if;
    if (select count(distinct (x->>'player_id')::bigint) from jsonb_array_elements(chosen) x)<>n
      or (select count(distinct (x->>'pick_id')::uuid) from jsonb_array_elements(chosen) x)<>n
      or exists(select 1 from jsonb_array_elements(chosen) x where not exists(
        select 1 from public.keeper_assignments a where a.submission_id=k.id and a.player_id=(x->>'player_id')::bigint)) then raise exception 'Payment changes must retain unique submitted players and picks'; end if;
    if not exists(select 1 from jsonb_array_elements(chosen) x join public.keeper_assignments a on a.submission_id=k.id and a.player_id=(x->>'player_id')::bigint where a.pick_id<>(x->>'pick_id')::uuid) then raise exception 'Choose a different payment pick'; end if;
    if exists(select 1 from public.keeper_assignments a join public.draft_picks p on p.id=a.pick_id where a.submission_id=k.id
      and (a.base_round_at_submission is null or a.tenure_at_submission is null or a.reserved<>(k.status in ('approved','locked'))
        or (k.status in ('approved','locked') and (p.current_owner_id<>k.franchise_id or (s.keepers_revealed_at is null and p.status<>'available'))))) then raise exception 'Existing keeper payment state is inconsistent'; end if;
    if s.keepers_revealed_at is not null then
      if k.status<>'locked' or n<>(select count(*) from public.keeper_season_records where submission_id=k.id)
        or exists(select 1 from public.keeper_assignments a join public.draft_picks p on p.id=a.pick_id where a.submission_id=k.id and (p.status<>'used' or not exists(
          select 1 from public.keeper_season_records h where h.submission_id=k.id and h.player_id=a.player_id and h.pick_id=a.pick_id and h.franchise_id=k.franchise_id
            and h.base_round=a.base_round_at_submission and h.tenure_before=a.tenure_at_submission and h.tenure_after=a.tenure_at_submission+1 and h.rule_version_id=s.rule_version_id))) then
        raise exception 'Revealed keeper payment history is inconsistent'; end if;
    elsif exists(select 1 from public.keeper_season_records where submission_id=k.id) then raise exception 'Unrevealed keeper history is inconsistent'; end if;
    select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]') into old_rows from public.keeper_assignments a where a.submission_id=k.id;
    context:=context||jsonb_build_array(jsonb_build_object('submission_id',k.id,'season_id',s.id,'franchise_id',k.franchise_id,'revision',k.revision,'status',k.status,
      'revealed',s.keepers_revealed_at is not null,'old',old_rows,'updated',chosen));
  end loop;
  -- All preconditions passed. Release only the exact keeper picks being amended.
  for entry in select value from jsonb_array_elements(context) loop
    if (entry->>'revealed')::boolean then update public.draft_picks set status='available' where id in(select (x->>'pick_id')::uuid from jsonb_array_elements(entry->'old') x); end if;
    delete from public.keeper_assignments where submission_id=(entry->>'submission_id')::uuid;
  end loop;
  return context;
end $$;

create function private.finish_keeper_payment_amendments(p_league uuid,p_context jsonb,p_note text,p_trade uuid) returns void
language plpgsql security definer set search_path='' as $$
declare entry jsonb; old_row jsonb; chosen jsonb; new_rows jsonb; amendment_id uuid;
begin
  -- Insert all replacement allocations before validating any whole set.
  for entry in select value from jsonb_array_elements(p_context) loop
    for old_row in select value from jsonb_array_elements(entry->'old') loop
      select value into strict chosen from jsonb_array_elements(entry->'updated') where (value->>'player_id')::bigint=(old_row->>'player_id')::bigint;
      if not exists(select 1 from public.draft_picks where id=(chosen->>'pick_id')::uuid and season_id=(entry->>'season_id')::uuid
        and current_owner_id=(entry->>'franchise_id')::uuid and status='available') then raise exception 'Selected replacement pick is not available to this team in this season'; end if;
      insert into public.keeper_assignments(id,submission_id,season_id,player_id,pick_id,base_round_at_submission,tenure_at_submission,reserved)
        values((old_row->>'id')::uuid,(entry->>'submission_id')::uuid,(entry->>'season_id')::uuid,(old_row->>'player_id')::bigint,(chosen->>'pick_id')::uuid,
          (old_row->>'base_round_at_submission')::integer,(old_row->>'tenure_at_submission')::integer,(old_row->>'reserved')::boolean);
    end loop;
  end loop;
  set constraints public.keeper_season_records_pick_id_key deferred;
  for entry in select value from jsonb_array_elements(p_context) loop
    perform private.validate_fixed_keeper_payments((entry->>'submission_id')::uuid);
    select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]') into new_rows from public.keeper_assignments a where submission_id=(entry->>'submission_id')::uuid;
    insert into public.keeper_payment_amendments(league_id,season_id,submission_id,franchise_id,previous_revision,revision,status,old_assignments,new_assignments,reason,actor_user_id,trade_id)
      values(p_league,(entry->>'season_id')::uuid,(entry->>'submission_id')::uuid,(entry->>'franchise_id')::uuid,(entry->>'revision')::integer,(entry->>'revision')::integer+1,
        entry->>'status',entry->'old',new_rows,btrim(p_note),auth.uid(),p_trade) returning id into amendment_id;
    if (entry->>'revealed')::boolean then
      update public.keeper_season_records h set pick_id=a.pick_id,actual_payment_round=p.round from public.keeper_assignments a join public.draft_picks p on p.id=a.pick_id
        where h.submission_id=(entry->>'submission_id')::uuid and a.submission_id=h.submission_id and a.player_id=h.player_id;
    end if;
    update public.keeper_submissions set revision=revision+1 where id=(entry->>'submission_id')::uuid;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
      values(p_league,auth.uid(),'keeper_payment_amended',(entry->>'submission_id')::uuid,jsonb_build_object('amendmentId',amendment_id,'revision',(entry->>'revision')::integer+1,'tradeId',p_trade));
  end loop;
  set constraints public.keeper_season_records_pick_id_key immediate;
  for entry in select value from jsonb_array_elements(p_context) loop
    if (entry->>'revealed')::boolean then update public.draft_picks set status='used' where id in(select pick_id from public.keeper_assignments where submission_id=(entry->>'submission_id')::uuid); end if;
  end loop;
end $$;

create function public.reassign_keeper_payments(p_submission uuid,p_expected_revision integer,p_assignments jsonb,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; context jsonb;
begin
  select * into k from public.keeper_submissions where id=p_submission;
  if not found then raise exception 'Submission not found' using errcode='P0002'; end if;
  select * into strict s from public.seasons where id=k.season_id;
  if not (private.is_commissioner(s.league_id) or private.can_manage_franchise(k.franchise_id)) then raise exception 'Only an assigned manager or commissioner may change payments' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  context:=private.prepare_keeper_payment_amendments(s.league_id,jsonb_build_array(jsonb_build_object('submission_id',p_submission,'expected_revision',p_expected_revision,'assignments',p_assignments)),p_note,null);
  perform private.finish_keeper_payment_amendments(s.league_id,context,p_note,null);
  update public.seasons set draft_revision=draft_revision+1 where id=s.id;
  select * into k from public.keeper_submissions where id=p_submission;
  return to_jsonb(k)||jsonb_build_object('keeper_assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]'::jsonb) from public.keeper_assignments a where a.submission_id=k.id));
end $$;

revoke all on function private.protect_keeper_payment_history() from public,anon,authenticated;
revoke all on function private.validate_fixed_keeper_payments(uuid) from public,anon,authenticated;
revoke all on function private.prepare_keeper_payment_amendments(uuid,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function private.finish_keeper_payment_amendments(uuid,jsonb,text,uuid) from public,anon,authenticated;
revoke all on function public.reassign_keeper_payments(uuid,integer,jsonb,text) from public,anon;
grant execute on function public.reassign_keeper_payments(uuid,integer,jsonb,text) to authenticated;

create or replace function public.finalize_trade(p_trade uuid,p_keeper_payments jsonb,p_note text,p_override_review boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.trades; s public.seasons; leg record; payment_context jsonb;
begin
  select * into t from public.trades where id=p_trade;
  if not found then raise exception using errcode='P0002',message='Trade not found'; end if;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=t.league_id for update;
  select * into t from public.trades where id=p_trade for update;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into strict s from public.seasons where id=t.season_id;
  if t.application_mode<>'live' then raise exception 'Historical records cannot be applied to bootstrap ownership'; end if;
  if t.status<>'proposed' then raise exception 'Trade has already been finalized or cancelled'; end if;
  if p_override_review is null then raise exception 'Explicit review override choice is required'; end if;
  if p_override_review and length(btrim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'A review override reason of 5 to 2000 characters is required'; end if;
  if now()<t.review_deadline and not p_override_review then raise exception 'The mandatory 24-hour trade review period has not ended'; end if;
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  if s.keepers_revealed_at is not null and exists(select 1 from public.trade_player_transfers where trade_id=t.id) then
    raise exception 'Player trades pause after keeper reveal until the new draft roster is finalized. Pick-only trades remain available.';
  end if;
  if (select count(*) from public.trade_participants where trade_id=t.id)<2 then raise exception 'A trade needs at least two teams'; end if;
  if not exists(select 1 from public.trade_player_transfers where trade_id=t.id) and not exists(select 1 from public.trade_pick_transfers where trade_id=t.id) and not exists(select 1 from public.trade_obligations where trade_id=t.id) then raise exception 'Trade has no assets'; end if;
  if exists(select 1 from public.trade_participants tp where tp.trade_id=t.id and not exists(select 1 from public.season_teams st where st.season_id=s.id and st.franchise_id=tp.franchise_id)) then raise exception 'Trade includes a team outside this season'; end if;
  if t.category='player_only' and (exists(select 1 from public.trade_pick_transfers where trade_id=t.id) or exists(select 1 from public.trade_obligations where trade_id=t.id)) then raise exception 'Player-only trades cannot include advanced terms'; end if;
  for leg in select * from public.trade_player_transfers where trade_id=t.id order by player_id loop
    perform 1 from public.player_ownerships where season_id=s.id and player_id=leg.player_id and franchise_id=leg.from_franchise_id for update;
    if not found then raise exception 'Player % is no longer owned by the source team',leg.player_id; end if;
    if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id where a.season_id=s.id and a.player_id=leg.player_id and a.reserved and k.is_current and s.keepers_revealed_at is null) then raise exception 'Cannot trade an approved keeper before reveal'; end if;
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline and exists(
      select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id
      where a.season_id=s.id and a.player_id=leg.player_id and k.is_current and k.status='submitted') then
      raise exception 'Submitted keeper players are fixed after the deadline; only payment picks may change';
    end if;
  end loop;
  payment_context:=private.prepare_keeper_payment_amendments(s.league_id,p_keeper_payments,p_note,p_trade);
  for leg in select x.*,p.season_id as pick_season from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id where x.trade_id=t.id order by x.pick_id loop
    if not exists(select 1 from public.seasons ps where ps.id=leg.pick_season and ps.league_id=t.league_id and ps.draft_year>=s.draft_year) then raise exception 'Pick must belong to this league and this or a future draft'; end if;
    if not exists(select 1 from public.season_teams where season_id=leg.pick_season and franchise_id=leg.to_franchise_id) then raise exception 'Pick recipient is not participating in its draft season'; end if;
    perform 1 from public.draft_picks where id=leg.pick_id and current_owner_id=leg.from_franchise_id and status='available' for update;
    if not found then raise exception 'Pick is no longer available to the source team'; end if;
    if exists(select 1 from public.keeper_assignments where pick_id=leg.pick_id and reserved) then raise exception 'Pick is committed to an approved keeper'; end if;
  end loop;
  -- Ownership checks all pass before any leg is written; transaction rollback is all-or-none.
  update public.player_ownerships o set franchise_id=x.to_franchise_id,updated_at=now() from public.trade_player_transfers x where x.trade_id=t.id and o.season_id=s.id and o.player_id=x.player_id;
  update public.draft_picks p set current_owner_id=x.to_franchise_id from public.trade_pick_transfers x where x.trade_id=t.id and p.id=x.pick_id;
  perform private.finish_keeper_payment_amendments(s.league_id,payment_context,p_note,p_trade);
  -- A changed owner invalidates any player choice made against the prior board, including future drafts.
  update public.seasons ds set draft_revision=ds.draft_revision+1 where ds.id in (
    select dp.season_id from public.trade_pick_transfers x join public.draft_picks dp on dp.id=x.pick_id where x.trade_id=t.id
    union select (value->>'season_id')::uuid from jsonb_array_elements(payment_context)
  );
  -- Receiving a later payment pick can invalidate an already approved allocation.
  -- Validate against the prospective ledger before committing any transfer. Include
  -- future pick seasons, using saved costs and matching revealed keeper payments.
  for leg in
    select k.id from public.keeper_submissions k join public.seasons ks on ks.id=k.season_id
    where ks.league_id=t.league_id
      and k.is_current and k.status in ('approved','locked')
      and (k.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id
        where x.trade_id=t.id and p.season_id=k.season_id))
  loop
    perform private.validate_fixed_keeper_payments(leg.id);
  end loop;
  update public.trades set status='finalized',finalized_at=now(),finalized_by=auth.uid() where id=t.id returning * into t;
  if p_override_review then
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(t.league_id,auth.uid(),'trade_review_overridden',t.id,
      jsonb_build_object('reason',btrim(p_note),'reviewDeadline',t.review_deadline,'finalizedEarly',now()<t.review_deadline));
  end if;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(t.league_id,auth.uid(),'trade_finalized',t.id,
    jsonb_build_object('reviewOverride',p_override_review,'paymentAmendmentCount',jsonb_array_length(payment_context)));
  return to_jsonb(t);
end $$;

create or replace function public.finalize_trade(p_trade uuid) returns jsonb
language sql security definer set search_path='' as $$
  select public.finalize_trade(p_trade,'[]'::jsonb,null,false);
$$;
revoke all on function public.finalize_trade(uuid,jsonb,text,boolean) from public,anon;
grant execute on function public.finalize_trade(uuid,jsonb,text,boolean) to authenticated;
revoke all on function public.finalize_trade(uuid) from public,anon;
grant execute on function public.finalize_trade(uuid) to authenticated;

-- Owners cannot replace the fixed player list through the older save/submit paths.
create or replace function public.save_keeper_submission(p_season uuid,p_franchise uuid,p_expected_revision integer,p_assignments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; current_k public.keeper_submissions; new_k public.keeper_submissions; entry jsonb; n integer; r public.rule_versions;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not (private.can_manage_franchise(p_franchise) or private.is_commissioner(s.league_id)) then
    raise exception using errcode='42501',message='Only an assigned manager or commissioner may edit this team'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  -- Authorization must use the committed account state after any queued revocation.
  if not (private.can_manage_franchise(p_franchise) or private.is_commissioner(s.league_id)) then
    raise exception using errcode='42501',message='Only an assigned manager or commissioner may edit this team'; end if;
  select * into s from public.seasons where id=p_season for update;
  if s.phase not in ('setup','keeper_selection') or s.keepers_revealed_at is not null then raise exception 'Private keeper drafts can only be saved during setup or keeper selection, before reveal'; end if;
  if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline then raise exception 'The keeper deadline has passed; submitted players are fixed. Use payment changes for an existing submission.'; end if;
  if not exists(select 1 from public.season_teams where season_id=p_season and franchise_id=p_franchise) then raise exception 'Team is not a participant in this season'; end if;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if p_assignments is null or jsonb_typeof(p_assignments)<>'array' then raise exception 'Assignments must be an array'; end if;
  n:=jsonb_array_length(p_assignments);
  if n>r.roster_capacity then raise exception 'Keeper count exceeds roster capacity'; end if;
  select * into current_k from public.keeper_submissions where season_id=p_season and franchise_id=p_franchise and is_current for update;
  if p_expected_revision is null or p_expected_revision<0 or coalesce(current_k.revision,0)<>p_expected_revision then raise exception using errcode='40001',message='Submission changed; reload before saving'; end if;
  if current_k.status='locked' then raise exception 'The commissioner has locked this submission'; end if;
  if current_k.id is not null then
    update public.keeper_assignments set reserved=false where submission_id=current_k.id;
    update public.keeper_submissions set is_current=false where id=current_k.id;
  end if;
  insert into public.keeper_submissions(season_id,franchise_id,revision,created_by)
    values(p_season,p_franchise,p_expected_revision+1,auth.uid()) returning * into new_k;
  for entry in select value from jsonb_array_elements(p_assignments) loop
    if jsonb_typeof(entry)<>'object' or not (entry ? 'player_id' and entry ? 'pick_id') then raise exception 'Each assignment requires player_id and pick_id'; end if;
    if not exists(select 1 from public.player_ownerships o join public.roster_snapshots rs on rs.id=o.source_snapshot_id and rs.season_id=o.season_id
      where o.season_id=p_season and o.player_id=(entry->>'player_id')::bigint and o.franchise_id=p_franchise and rs.frozen_at is not null) then
      raise exception 'Selected player is not in this team''s frozen keeper pool'; end if;
    if not exists(select 1 from public.draft_picks where id=(entry->>'pick_id')::uuid and season_id=p_season and current_owner_id=p_franchise and status='available') then raise exception 'Selected pick is not available to this team'; end if;
    insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id)
      values(new_k.id,p_season,(entry->>'player_id')::bigint,(entry->>'pick_id')::uuid);
  end loop;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_draft_saved',new_k.id,jsonb_build_object('revision',new_k.revision));
  return to_jsonb(new_k)||jsonb_build_object('keeper_assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]'::jsonb) from public.keeper_assignments a where a.submission_id=new_k.id));
end $$;

create or replace function public.transition_keeper_submission(p_submission uuid,p_expected_revision integer,p_action text,p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; participant_total integer;
begin
  select * into k from public.keeper_submissions where id=p_submission;
  if not found then raise exception using errcode='P0002',message='Submission not found'; end if;
  select * into strict s from public.seasons where id=k.season_id;
  if p_action='submit' then
    if not (private.can_manage_franchise(k.franchise_id) or private.is_commissioner(s.league_id)) then raise exception using errcode='42501',message='Only an assigned manager or commissioner may submit'; end if;
  elsif p_action in ('approve','reject','lock') then
    if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  else raise exception 'Unknown keeper action'; end if;
  if length(coalesce(p_note,''))>2000 then raise exception 'Review note is too long'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  if p_action='submit' then
    if not (private.can_manage_franchise(k.franchise_id) or private.is_commissioner(s.league_id)) then raise exception using errcode='42501',message='Only an assigned manager or commissioner may submit'; end if;
  elsif not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into s from public.seasons where id=k.season_id for update;
  select * into k from public.keeper_submissions where id=p_submission for update;
  if not k.is_current or k.revision is distinct from p_expected_revision then raise exception using errcode='40001',message='Submission changed; reload before reviewing'; end if;
  if s.phase<>'keeper_selection' or s.keepers_revealed_at is not null or k.status='locked' then raise exception 'Keeper submission is locked'; end if;
  if p_action='submit' then
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline then raise exception 'The keeper deadline has passed; new player submissions are closed'; end if;
    if k.status not in ('draft','rejected') then raise exception 'Only a draft or rejected submission can be submitted'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_submissions set status='submitted',submitted_at=now(),reviewed_by=null,reviewed_at=null,review_note=null where id=k.id;
  elsif p_action='approve' then
    if k.status<>'submitted' then raise exception 'Only a submitted selection can be approved'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_assignments set reserved=true where submission_id=k.id;
    update public.keeper_submissions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=k.id;
  elsif p_action='reject' then
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline then raise exception 'Submitted players are fixed after the keeper deadline; use payment changes instead of returning the submission'; end if;
    if k.status not in ('submitted','approved') then raise exception 'Only submitted or approved selections can be rejected'; end if;
    if nullif(btrim(p_note),'') is null then raise exception 'Explain why this submission was rejected'; end if;
    update public.keeper_assignments set reserved=false where submission_id=k.id;
    update public.keeper_submissions set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=k.id;
  else
    if k.status<>'approved' then raise exception 'Approve this submission before locking it'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_submissions set status='locked',locked_at=now() where id=k.id;
  end if;
  select count(*) into participant_total from public.season_teams where season_id=s.id;
  if participant_total=s.participant_count and not exists(select 1 from public.season_teams st where st.season_id=s.id and not exists(
      select 1 from public.keeper_submissions ks where ks.season_id=s.id and ks.franchise_id=st.franchise_id and ks.is_current and ks.status in ('submitted','approved','locked'))) then
    update public.seasons set trading_opened_at=coalesce(trading_opened_at,now()) where id=s.id;
  end if;
  if participant_total=s.participant_count and not exists(select 1 from public.season_teams st where st.season_id=s.id and not exists(
      select 1 from public.keeper_submissions ks where ks.season_id=s.id and ks.franchise_id=st.franchise_id and ks.is_current and ks.status='locked')) then
    -- Recheck every locked selection against current rights before revealing any of them.
    for k in select * from public.keeper_submissions where season_id=s.id and is_current loop perform private.validate_keeper_submission(k.id); end loop;
    insert into public.keeper_season_records(season_id,player_id,franchise_id,submission_id,pick_id,base_round,actual_payment_round,tenure_before,tenure_after,rule_version_id)
      select ks.season_id,a.player_id,ks.franchise_id,ks.id,a.pick_id,a.base_round_at_submission,p.round,a.tenure_at_submission,a.tenure_at_submission+1,s.rule_version_id
      from public.keeper_submissions ks join public.keeper_assignments a on a.submission_id=ks.id join public.draft_picks p on p.id=a.pick_id
      where ks.season_id=s.id and ks.is_current and ks.status='locked';
    update public.draft_picks set status='used' where id in(select pick_id from public.keeper_season_records where season_id=s.id);
    update public.seasons set keepers_revealed_at=now(),phase='draft_ready' where id=s.id;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(s.league_id,auth.uid(),'keepers_revealed',s.id);
  end if;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_'||p_action,p_submission,jsonb_build_object('note',p_note));
  select * into k from public.keeper_submissions where id=p_submission;
  return to_jsonb(k)||jsonb_build_object('keeper_assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]'::jsonb) from public.keeper_assignments a where a.submission_id=k.id));
end $$;
