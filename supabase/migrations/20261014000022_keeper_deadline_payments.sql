-- Adopted 2026-10-14: keeper payments use the picks owned at the deadline,
-- and no payment is committed until the deadline and every submission are in.
-- Legacy rule versions and revealed keeper history retain their original rules.
create function private.uses_deadline_keeper_payments(p_season uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(r.rules->>'keeper_payment_timing'='deadline_after_all_submissions',false)
  from public.seasons s join public.rule_versions r on r.id=s.rule_version_id where s.id=p_season;
$$;

create table public.keeper_payment_deadline_snapshots (
  season_id uuid primary key references public.seasons,
  keeper_deadline timestamptz not null,
  captured_at timestamptz not null default clock_timestamp()
);
create table public.keeper_deadline_pick_owners (
  season_id uuid not null references public.keeper_payment_deadline_snapshots,
  pick_id uuid not null,
  franchise_id uuid not null,
  round integer not null check (round>0),
  status text not null check (status in ('available','used')),
  primary key (season_id,pick_id),
  foreign key (pick_id,season_id) references public.draft_picks(id,season_id),
  foreign key (season_id,franchise_id) references public.season_teams
);
alter table public.keeper_payment_deadline_snapshots enable row level security;
alter table public.keeper_deadline_pick_owners enable row level security;
revoke all on public.keeper_payment_deadline_snapshots,public.keeper_deadline_pick_owners from public,anon,authenticated;
grant select on public.keeper_payment_deadline_snapshots,public.keeper_deadline_pick_owners to authenticated;
create policy keeper_deadline_read on public.keeper_payment_deadline_snapshots for select using (private.can_read_season(season_id));
create policy keeper_deadline_pick_read on public.keeper_deadline_pick_owners for select using (private.can_read_season(season_id));
create trigger immutable_keeper_deadline before update or delete on public.keeper_payment_deadline_snapshots
  for each row execute function private.prevent_immutable_change();
create trigger immutable_keeper_deadline_picks before update or delete on public.keeper_deadline_pick_owners
  for each row execute function private.prevent_immutable_change();

create function private.all_keeper_submissions_received(p_season uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select (select count(*) from public.season_teams where season_id=s.id)=s.participant_count
    and not exists(select 1 from public.season_teams st where st.season_id=s.id and not exists(
      select 1 from public.keeper_submissions k where k.season_id=s.id and k.franchise_id=st.franchise_id
        and k.is_current and k.status in ('submitted','approved','locked')))
  from public.seasons s where s.id=p_season;
$$;

-- Idempotent and independent of keeper selections. All ownership changes call
-- this before writing, so lazy capture still records ownership at the deadline.
create function private.capture_keeper_deadline_inventory(p_season uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.seasons; r public.rule_versions;
begin
  select * into strict s from public.seasons where id=p_season;
  if not private.uses_deadline_keeper_payments(s.id) then return; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into strict s from public.seasons where id=p_season for update;
  if s.keeper_deadline is null or clock_timestamp()<s.keeper_deadline then return; end if;
  if exists(select 1 from public.keeper_payment_deadline_snapshots where season_id=s.id) then return; end if;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if (select count(*) from public.season_teams where season_id=s.id)<>s.participant_count
    or (select count(*) from public.draft_picks where season_id=s.id)<>s.participant_count*r.draft_rounds
    or exists(select 1 from public.season_teams st cross join generate_series(1,r.draft_rounds) n
      where st.season_id=s.id and not exists(select 1 from public.draft_picks p where p.season_id=s.id and p.original_franchise_id=st.franchise_id and p.round=n)) then
    raise exception 'Complete the draft pick inventory before capturing keeper deadline ownership';
  end if;
  insert into public.keeper_payment_deadline_snapshots(season_id,keeper_deadline) values(s.id,s.keeper_deadline);
  insert into public.keeper_deadline_pick_owners(season_id,pick_id,franchise_id,round,status)
    select season_id,id,current_owner_id,round,status from public.draft_picks where season_id=s.id;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_deadline_inventory_captured',s.id,jsonb_build_object('deadline',s.keeper_deadline,'pickCount',s.participant_count*r.draft_rounds));
end $$;

-- Run again after bootstrap on an empty installation. Existing locked or
-- already-settled history requires explicit review rather than silent repair.
create function private.apply_keeper_deadline_payment_rule_20261014() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare target_league constant uuid:='4bda6ccb-0b37-47b2-8d9e-fe452603738d'; s public.seasons; r public.rule_versions;
  next_rule uuid; adopted integer:=0;
begin
  perform 1 from public.leagues where id=target_league for update;
  if not found then return jsonb_build_object('status','awaiting-bootstrap','adopted',0); end if;
  for s in select * from public.seasons where league_id=target_league and keepers_revealed_at is null and phase in ('setup','keeper_selection') order by id for update loop
    if private.uses_deadline_keeper_payments(s.id) then continue; end if;
    if exists(select 1 from public.keeper_submissions where season_id=s.id and is_current and status='locked')
      or exists(select 1 from public.keeper_season_records where season_id=s.id) then raise exception 'Review existing locked keeper selections before adopting deadline payments'; end if;
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline and exists(
      select 1 from public.trades t join public.trade_pick_transfers x on x.trade_id=t.id join public.draft_picks p on p.id=x.pick_id
      where p.season_id=s.id and t.status='finalized' and t.finalized_at>=s.keeper_deadline) then
      raise exception 'Review post-deadline pick trades before adopting deadline ownership snapshots';
    end if;
    select * into strict r from public.rule_versions where id=s.rule_version_id;
    select id into next_rule from public.rule_versions where league_id=s.league_id
      and rules->>'keeper_payment_timing'='deadline_after_all_submissions' and rules->>'supersedes_rule_version'=r.id::text order by version desc limit 1;
    if next_rule is null then
      insert into public.rule_versions(league_id,version,draft_rounds,roster_capacity,tenure_limit,undrafted_initial_round,rules)
        select r.league_id,coalesce(max(version),0)+1,r.draft_rounds,r.roster_capacity,r.tenure_limit,r.undrafted_initial_round,
          r.rules||jsonb_build_object('keeper_payment_timing','deadline_after_all_submissions','keeper_payment_ownership','deadline_inventory',
            'supersedes_rule_version',r.id,'adopted_on','2026-10-14','authorization','League charter amendment approved by vote on 2026-10-14; confirmed by commissioner.')
        from public.rule_versions where league_id=r.league_id returning id into next_rule;
    end if;
    update public.seasons set rule_version_id=next_rule where id=s.id;
    update public.keeper_profiles set rule_version_id=next_rule where season_id=s.id and rule_version_id=r.id;
    update public.keeper_assignments set reserved=false where submission_id in(select id from public.keeper_submissions where season_id=s.id and is_current);
    perform private.capture_keeper_deadline_inventory(s.id);
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
      values(s.league_id,auth.uid(),'keeper_deadline_rule_adopted',s.id,jsonb_build_object('oldRuleVersionId',r.id,'newRuleVersionId',next_rule,'adoptedOn','2026-10-14'));
    adopted:=adopted+1;
  end loop;
  return jsonb_build_object('status','complete','adopted',adopted);
end $$;

create function private.require_keeper_payment_ready(p_season uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.seasons;
begin
  if not private.uses_deadline_keeper_payments(p_season) then return; end if;
  select * into strict s from public.seasons where id=p_season;
  if s.keeper_deadline is null or clock_timestamp()<s.keeper_deadline then raise exception 'Keeper payments cannot be committed before the configured keeper deadline'; end if;
  if not private.all_keeper_submissions_received(s.id) then raise exception 'Every participating team must submit its keeper selection, including zero keepers, before keeper payments are committed'; end if;
  perform private.capture_keeper_deadline_inventory(s.id);
end $$;

create function private.protect_keeper_deadline_inventory() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='draft_picks' then
    if old.current_owner_id is distinct from new.current_owner_id or old.status is distinct from new.status then
      perform private.capture_keeper_deadline_inventory(old.season_id);
    end if;
  elsif old.keeper_deadline is distinct from new.keeper_deadline and private.uses_deadline_keeper_payments(old.id)
    and ((old.keeper_deadline is not null and clock_timestamp()>=old.keeper_deadline)
      or exists(select 1 from public.keeper_payment_deadline_snapshots where season_id=old.id)) then
    raise exception 'The keeper deadline is fixed after it passes; deadline pick ownership cannot be moved';
  end if;
  return new;
end $$;
create trigger capture_keeper_deadline_before_pick_change before update of current_owner_id,status on public.draft_picks
  for each row execute function private.protect_keeper_deadline_inventory();
create trigger fixed_keeper_deadline before update of keeper_deadline on public.seasons
  for each row execute function private.protect_keeper_deadline_inventory();

create function public.get_keeper_payment_inventory(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; snapshot public.keeper_payment_deadline_snapshots;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_read_season(s.id) then raise exception 'League access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  if not private.can_read_season(s.id) then raise exception 'League access required' using errcode='42501'; end if;
  perform private.capture_keeper_deadline_inventory(s.id);
  select * into snapshot from public.keeper_payment_deadline_snapshots where season_id=s.id;
  if not found then return null; end if;
  return jsonb_build_object('deadline',snapshot.keeper_deadline,'capturedAt',snapshot.captured_at,'picks',(
    select coalesce(jsonb_agg(jsonb_build_object('id',p.pick_id,'seasonId',p.season_id,'ownerId',p.franchise_id,
      'originalOwnerId',d.original_franchise_id,'round',p.round,'status',p.status) order by p.round,p.pick_id),'[]'::jsonb)
    from public.keeper_deadline_pick_owners p join public.draft_picks d on d.id=p.pick_id where p.season_id=s.id));
end $$;

-- Official selection terms are frozen at submission, even while payment picks
-- remain previews and can be traded before the deadline.
create function private.validate_keeper_players(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; a record;
begin
  select * into strict k from public.keeper_submissions where id=p_submission;
  select * into strict s from public.seasons where id=k.season_id;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if (select count(*) from public.keeper_assignments where submission_id=k.id)>r.roster_capacity then raise exception 'Keeper count exceeds the season roster capacity'; end if;
  for a in select ka.*,po.franchise_id as player_owner,rs.frozen_at from public.keeper_assignments ka
    left join public.player_ownerships po on po.season_id=ka.season_id and po.player_id=ka.player_id
    left join public.roster_snapshots rs on rs.id=po.source_snapshot_id where ka.submission_id=k.id loop
    if a.player_owner is distinct from k.franchise_id or a.frozen_at is null then raise exception 'Player % is not in this franchise''s frozen keeper pool',a.player_id; end if;
    if a.base_round_at_submission is null or a.tenure_at_submission is null or a.base_round_at_submission not between 1 and r.draft_rounds
      or a.tenure_at_submission<1 or a.tenure_at_submission>=r.tenure_limit then raise exception 'Saved keeper cost and tenure are invalid'; end if;
  end loop;
end $$;

revoke all on function private.uses_deadline_keeper_payments(uuid),private.all_keeper_submissions_received(uuid),private.capture_keeper_deadline_inventory(uuid),
  private.require_keeper_payment_ready(uuid),private.protect_keeper_deadline_inventory(),private.validate_keeper_players(uuid) from public,anon,authenticated;
revoke all on function public.get_keeper_payment_inventory(uuid) from public;
grant execute on function public.get_keeper_payment_inventory(uuid) to anon,authenticated;


-- Payment previews and deadline-aware settlement replace the corresponding RPCs.
create or replace function private.validate_fixed_keeper_payments(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; a record; nearest integer; deadline_inventory boolean;
begin
  select * into strict k from public.keeper_submissions where id=p_submission;
  select * into strict s from public.seasons where id=k.season_id;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  deadline_inventory:=private.uses_deadline_keeper_payments(s.id) and s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline;
  if deadline_inventory then perform private.capture_keeper_deadline_inventory(s.id); end if;
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
    if deadline_inventory and not exists(select 1 from public.keeper_deadline_pick_owners snapshot
      where snapshot.season_id=s.id and snapshot.pick_id=a.pick_id and snapshot.franchise_id=k.franchise_id and snapshot.status='available') then
      raise exception 'Keeper payments must use available picks owned by this team at the keeper deadline';
    end if;
    if exists(select 1 from public.keeper_assignments other where other.reserved and other.submission_id<>k.id
      and (other.pick_id=a.pick_id or (other.season_id=k.season_id and other.player_id=a.player_id))) then raise exception 'A selected player or pick is already committed'; end if;
    select max(p.round) into nearest from public.draft_picks p
      where p.season_id=k.season_id and p.current_owner_id=k.franchise_id and p.status='available'
        and p.round>a.payment_round and p.round<=a.base_round_at_submission
        and (not deadline_inventory or exists(select 1 from public.keeper_deadline_pick_owners snapshot
          where snapshot.season_id=s.id and snapshot.pick_id=p.id and snapshot.franchise_id=k.franchise_id and snapshot.status='available'))
        and not exists(select 1 from public.keeper_assignments chosen where chosen.submission_id=k.id and chosen.pick_id=p.id)
        and not exists(select 1 from public.keeper_assignments reserved where reserved.pick_id=p.id and reserved.reserved and reserved.submission_id<>k.id);
    if nearest is not null then raise exception 'Player % must use an available round % pick before an earlier pick',a.player_id,nearest; end if;
  end loop;
end $$;

create or replace function private.prepare_keeper_payment_amendments(p_league uuid,p_amendments jsonb,p_note text,p_trade uuid) returns jsonb
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
      and (a.base_round_at_submission is null or a.tenure_at_submission is null or (case when private.uses_deadline_keeper_payments(s.id)
          then (a.reserved and k.status not in ('approved','locked')) or (k.status='locked' and not a.reserved)
          else a.reserved<>(k.status in ('approved','locked')) end)
        or (a.reserved and (p.current_owner_id<>k.franchise_id or (s.keepers_revealed_at is null and p.status<>'available'))))) then raise exception 'Existing keeper payment state is inconsistent'; end if;
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

-- Preserve a legal preview. Otherwise allocate the full set from the deadline
-- inventory, tightest cost first, before committing any payment. The ordinary
-- amendment path preserves frozen terms and records every changed allocation.
create function private.reconcile_keeper_deadline_payments(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; a record; payment uuid; selected uuid[]:='{}';
  chosen jsonb:='[]'; context jsonb; reason constant text:='Automatically allocated keeper payments from picks owned at the keeper deadline.';
begin
  select * into strict k from public.keeper_submissions where id=p_submission for update;
  select * into strict s from public.seasons where id=k.season_id;
  if not private.uses_deadline_keeper_payments(s.id) then return; end if;
  perform private.require_keeper_payment_ready(s.id);
  perform private.validate_keeper_players(k.id);
  begin
    perform private.validate_fixed_keeper_payments(k.id);
    return;
  exception when raise_exception then null;
  end;
  for a in select * from public.keeper_assignments where submission_id=k.id order by base_round_at_submission,player_id loop
    select p.id into payment from public.draft_picks p join public.keeper_deadline_pick_owners snapshot
      on snapshot.pick_id=p.id and snapshot.season_id=p.season_id
      where p.season_id=s.id and p.current_owner_id=k.franchise_id and p.status='available'
        and snapshot.franchise_id=k.franchise_id and snapshot.status='available'
        and p.round<=a.base_round_at_submission and not(p.id=any(selected))
        and not exists(select 1 from public.keeper_assignments reserved where reserved.pick_id=p.id and reserved.reserved and reserved.submission_id<>k.id)
      order by p.round desc,(p.id=a.pick_id) desc,p.id limit 1;
    if payment is null then
      raise exception 'Deadline-owned picks cannot fund every submitted keeper; no payments were committed. Review keeper payment inventory with the commissioner.';
    end if;
    selected:=array_append(selected,payment);
    chosen:=chosen||jsonb_build_array(jsonb_build_object('player_id',a.player_id,'pick_id',payment));
  end loop;
  context:=private.prepare_keeper_payment_amendments(s.league_id,jsonb_build_array(jsonb_build_object(
    'submission_id',k.id,'expected_revision',k.revision,'assignments',chosen)),reason,null);
  perform private.finish_keeper_payment_amendments(s.league_id,context,reason,null);
  update public.seasons set draft_revision=draft_revision+1 where id=s.id;
end $$;
revoke all on function private.reconcile_keeper_deadline_payments(uuid) from public,anon,authenticated;

create or replace function public.transition_keeper_submission(p_submission uuid,p_expected_revision integer,p_action text,p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; participant_total integer; deadline_mode boolean; payment_ready boolean;
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
  deadline_mode:=private.uses_deadline_keeper_payments(s.id);
  payment_ready:=not deadline_mode or (s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline and private.all_keeper_submissions_received(s.id));
  if p_action='submit' then
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline then raise exception 'The keeper deadline has passed; new player submissions are closed'; end if;
    if k.status not in ('draft','rejected') then raise exception 'Only a draft or rejected submission can be submitted'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_submissions set status='submitted',submitted_at=now(),reviewed_by=null,reviewed_at=null,review_note=null where id=k.id;
  elsif p_action='approve' then
    if k.status<>'submitted' then raise exception 'Only a submitted selection can be approved'; end if;
    if deadline_mode then
      perform private.validate_keeper_players(k.id);
      if payment_ready then
        perform private.require_keeper_payment_ready(s.id);
        perform private.reconcile_keeper_deadline_payments(k.id);
      end if;
    else perform private.validate_keeper_submission(k.id); end if;
    update public.keeper_assignments set reserved=payment_ready where submission_id=k.id;
    update public.keeper_submissions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=k.id;
  elsif p_action='reject' then
    if s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline then raise exception 'Submitted players are fixed after the keeper deadline; use payment changes instead of returning the submission'; end if;
    if k.status not in ('submitted','approved') then raise exception 'Only submitted or approved selections can be rejected'; end if;
    if nullif(btrim(p_note),'') is null then raise exception 'Explain why this submission was rejected'; end if;
    update public.keeper_assignments set reserved=false where submission_id=k.id;
    update public.keeper_submissions set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=k.id;
  else
    if k.status<>'approved' then raise exception 'Approve this submission before locking it'; end if;
    if deadline_mode then
      perform private.require_keeper_payment_ready(s.id);
      perform private.reconcile_keeper_deadline_payments(k.id);
      update public.keeper_assignments set reserved=true where submission_id=k.id;
    else perform private.validate_keeper_submission(k.id); end if;
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
    perform private.require_keeper_payment_ready(s.id);
    for k in select * from public.keeper_submissions where season_id=s.id and is_current loop
      if deadline_mode then perform private.validate_fixed_keeper_payments(k.id);
      else perform private.validate_keeper_submission(k.id); end if;
    end loop;
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
      where a.season_id=s.id and a.player_id=leg.player_id and k.is_current and (k.status='submitted' or (private.uses_deadline_keeper_payments(s.id) and k.status in ('approved','locked')))) then
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
  -- A predeadline player trade returns its prior official selection for editing;
  -- previews never reserve the transferred player or any payment pick.
  for leg in select distinct k.id from public.keeper_submissions k join public.keeper_assignments a on a.submission_id=k.id
    join public.trade_player_transfers x on x.trade_id=t.id and x.player_id=a.player_id and x.from_franchise_id=k.franchise_id
    where k.season_id=s.id and k.is_current and k.status in ('submitted','approved')
      and private.uses_deadline_keeper_payments(s.id) and (s.keeper_deadline is null or clock_timestamp()<s.keeper_deadline)
  loop
    update public.keeper_assignments set reserved=false where submission_id=leg.id;
    update public.keeper_submissions set status='rejected',reviewed_by=auth.uid(),reviewed_at=clock_timestamp(),
      review_note='A selected keeper was traded before the deadline. Review this private selection and submit it again.' where id=leg.id;
    insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
      values(s.league_id,auth.uid(),'keeper_returned_after_player_trade',leg.id,jsonb_build_object('tradeId',t.id));
  end loop;
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
    select k.id,k.season_id from public.keeper_submissions k join public.seasons ks on ks.id=k.season_id
    where ks.league_id=t.league_id
      and k.is_current and k.status in ('approved','locked')
      and (k.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id
        where x.trade_id=t.id and p.season_id=k.season_id))
  loop
    if private.uses_deadline_keeper_payments(leg.season_id) and not exists(select 1 from public.keeper_assignments where submission_id=leg.id and reserved) then
      perform private.validate_keeper_players(leg.id);
    else perform private.validate_fixed_keeper_payments(leg.id); end if;
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

revoke all on function private.apply_keeper_deadline_payment_rule_20261014() from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on function private.apply_keeper_deadline_payment_rule_20261014() from service_role;
  end if;
end $$;
select private.apply_keeper_deadline_payment_rule_20261014();
