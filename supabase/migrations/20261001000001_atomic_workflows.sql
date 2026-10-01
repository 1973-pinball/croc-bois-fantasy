alter table public.seasons add column trading_opened_at timestamptz;

-- Call only while holding the league row lock. This validates the whole selection,
-- so the order an owner clicks players never changes whether payment is legal.
create function private.validate_keeper_submission(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; a record; nearest integer;
begin
  select * into strict k from public.keeper_submissions where id=p_submission;
  select * into strict s from public.seasons where id=k.season_id;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if (select count(*) from public.keeper_assignments where submission_id=k.id)>r.roster_capacity then
    raise exception 'Keeper count exceeds the season roster capacity'; end if;
  for a in select ka.*,kp.base_round,kp.tenure_years,kp.verification,kp.rule_version_id,
      dp.round as payment_round,dp.current_owner_id,dp.status as pick_status,po.franchise_id as player_owner,rs.frozen_at
    from public.keeper_assignments ka
    left join public.keeper_profiles kp on kp.season_id=ka.season_id and kp.player_id=ka.player_id
    join public.draft_picks dp on dp.id=ka.pick_id
    left join public.player_ownerships po on po.season_id=ka.season_id and po.player_id=ka.player_id
    left join public.roster_snapshots rs on rs.id=po.source_snapshot_id
    where ka.submission_id=k.id loop
    if a.player_owner is distinct from k.franchise_id or a.frozen_at is null then
      raise exception 'Player % is not in this franchise''s frozen keeper pool',a.player_id; end if;
    if a.verification is distinct from 'confirmed' or a.base_round is null or a.tenure_years is null then
      raise exception 'Player % requires commissioner verification of cost and tenure',a.player_id; end if;
    if a.rule_version_id is distinct from s.rule_version_id or a.base_round<1 or a.base_round>r.draft_rounds or a.tenure_years<1 or a.tenure_years>=r.tenure_limit then
      raise exception 'Player % is ineligible under this season''s keeper rules',a.player_id; end if;
    if a.current_owner_id is distinct from k.franchise_id or a.pick_status<>'available' or a.payment_round>a.base_round then
      raise exception 'Invalid owned payment pick for player %',a.player_id; end if;
    if exists(select 1 from public.keeper_assignments other where other.reserved and other.submission_id<>k.id
      and (other.pick_id=a.pick_id or (other.season_id=k.season_id and other.player_id=a.player_id))) then
      raise exception 'A selected player or pick is already committed'; end if;
    select max(p.round) into nearest from public.draft_picks p
      where p.season_id=k.season_id and p.current_owner_id=k.franchise_id and p.status='available'
        and p.round>a.payment_round and p.round<=a.base_round
        and not exists(select 1 from public.keeper_assignments chosen where chosen.submission_id=k.id and chosen.pick_id=p.id)
        and not exists(select 1 from public.keeper_assignments reserved where reserved.pick_id=p.id and reserved.reserved and reserved.submission_id<>k.id);
    if nearest is not null then raise exception 'Player % must use an available round % pick before an earlier pick',a.player_id,nearest; end if;
    update public.keeper_assignments set base_round_at_submission=a.base_round,tenure_at_submission=a.tenure_years where id=a.id;
  end loop;
end $$;

create function public.save_keeper_submission(p_season uuid,p_franchise uuid,p_expected_revision integer,p_assignments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; current_k public.keeper_submissions; new_k public.keeper_submissions; entry jsonb; n integer; r public.rule_versions;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not (private.can_manage_franchise(p_franchise) or private.is_commissioner(s.league_id)) then
    raise exception using errcode='42501',message='Only an assigned manager or commissioner may edit this team'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  if s.phase<>'keeper_selection' or s.keepers_revealed_at is not null then raise exception 'Keeper selection is not open'; end if;
  if not exists(select 1 from public.season_teams where season_id=p_season and franchise_id=p_franchise) then raise exception 'Team is not a participant in this season'; end if;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if p_assignments is null or jsonb_typeof(p_assignments)<>'array' then raise exception 'Assignments must be an array'; end if;
  n:=jsonb_array_length(p_assignments);
  if n>r.roster_capacity then raise exception 'Keeper count exceeds roster capacity'; end if;
  select * into current_k from public.keeper_submissions where season_id=p_season and franchise_id=p_franchise and is_current for update;
  if coalesce(current_k.revision,0)<>p_expected_revision then raise exception using errcode='40001',message='Submission changed; reload before saving'; end if;
  if current_k.status='locked' then raise exception 'The commissioner has locked this submission'; end if;
  if current_k.id is not null then
    update public.keeper_assignments set reserved=false where submission_id=current_k.id;
    update public.keeper_submissions set is_current=false where id=current_k.id;
  end if;
  insert into public.keeper_submissions(season_id,franchise_id,revision,created_by)
    values(p_season,p_franchise,p_expected_revision+1,auth.uid()) returning * into new_k;
  for entry in select value from jsonb_array_elements(p_assignments) loop
    if jsonb_typeof(entry)<>'object' or not (entry ? 'player_id' and entry ? 'pick_id') then raise exception 'Each assignment requires player_id and pick_id'; end if;
    if not exists(select 1 from public.player_ownerships where season_id=p_season and player_id=(entry->>'player_id')::bigint and franchise_id=p_franchise) then raise exception 'Selected player is not owned by this team'; end if;
    if not exists(select 1 from public.draft_picks where id=(entry->>'pick_id')::uuid and season_id=p_season and current_owner_id=p_franchise and status='available') then raise exception 'Selected pick is not available to this team'; end if;
    insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id)
      values(new_k.id,p_season,(entry->>'player_id')::bigint,(entry->>'pick_id')::uuid);
  end loop;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_draft_saved',new_k.id,jsonb_build_object('revision',new_k.revision));
  return to_jsonb(new_k);
end $$;

create function public.transition_keeper_submission(p_submission uuid,p_expected_revision integer,p_action text,p_note text default null) returns jsonb
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
  select * into s from public.seasons where id=k.season_id for update;
  select * into k from public.keeper_submissions where id=p_submission for update;
  if not k.is_current or k.revision<>p_expected_revision then raise exception using errcode='40001',message='Submission changed; reload before reviewing'; end if;
  if s.phase<>'keeper_selection' or s.keepers_revealed_at is not null or k.status='locked' then raise exception 'Keeper submission is locked'; end if;
  if p_action='submit' then
    if k.status not in ('draft','rejected') then raise exception 'Only a draft or rejected submission can be submitted'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_submissions set status='submitted',submitted_at=now(),reviewed_by=null,reviewed_at=null,review_note=null where id=k.id;
  elsif p_action='approve' then
    if k.status<>'submitted' then raise exception 'Only a submitted selection can be approved'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_assignments set reserved=true where submission_id=k.id;
    update public.keeper_submissions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=k.id;
  elsif p_action='reject' then
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
  return to_jsonb(k);
end $$;

create function public.create_trade(p_season uuid,p_category text,p_terms text,p_players jsonb,p_picks jsonb,p_obligations jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare s public.seasons; trade_id uuid; entry jsonb; team_id uuid;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not exists(select 1 from public.league_memberships where league_id=s.league_id and user_id=auth.uid() and active and role in ('manager','commissioner')) then raise exception using errcode='42501',message='An active league manager membership is required to log a trade'; end if;
  if p_category not in ('player_only','advanced') or length(coalesce(p_terms,''))>10000 then raise exception 'Invalid trade terms'; end if;
  if p_players is null or p_picks is null or p_obligations is null or jsonb_typeof(p_players)<>'array' or jsonb_typeof(p_picks)<>'array' or jsonb_typeof(p_obligations)<>'array' then raise exception 'Trade assets must be arrays'; end if;
  if jsonb_array_length(p_players)+jsonb_array_length(p_picks)+jsonb_array_length(p_obligations) not between 1 and 100 then raise exception 'A trade requires between 1 and 100 assets or obligations'; end if;
  if p_category='player_only' and (jsonb_array_length(p_picks)>0 or jsonb_array_length(p_obligations)>0) then raise exception 'Player-only trades cannot include picks or obligations'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  insert into public.trades(league_id,season_id,category,terms,created_by) values(s.league_id,s.id,p_category,coalesce(p_terms,''),auth.uid()) returning id into trade_id;
  for entry in select value from jsonb_array_elements(p_players||p_picks||p_obligations) loop
    for team_id in select (entry->>'from_franchise_id')::uuid union select (entry->>'to_franchise_id')::uuid loop
      if not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=team_id) then raise exception 'Every trade participant must be in this season'; end if;
      insert into public.trade_participants(trade_id,franchise_id) values(trade_id,team_id) on conflict do nothing;
    end loop;
  end loop;
  for entry in select value from jsonb_array_elements(p_players) loop
    insert into public.trade_player_transfers(trade_id,player_id,from_franchise_id,to_franchise_id)
      values(trade_id,(entry->>'player_id')::bigint,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid);
  end loop;
  for entry in select value from jsonb_array_elements(p_picks) loop
    insert into public.trade_pick_transfers(trade_id,pick_id,from_franchise_id,to_franchise_id)
      values(trade_id,(entry->>'pick_id')::uuid,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid);
  end loop;
  for entry in select value from jsonb_array_elements(p_obligations) loop
    if length(coalesce(entry->>'terms','')) not between 1 and 10000 then raise exception 'Obligation terms are required'; end if;
    insert into public.trade_obligations(trade_id,from_franchise_id,to_franchise_id,kind,terms,due_at)
      values(trade_id,(entry->>'from_franchise_id')::uuid,(entry->>'to_franchise_id')::uuid,entry->>'kind',entry->>'terms',(entry->>'due_at')::timestamptz);
  end loop;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(s.league_id,auth.uid(),'trade_created',trade_id);
  return trade_id;
end $$;

create function public.finalize_trade(p_trade uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.trades; s public.seasons; leg record;
begin
  select * into t from public.trades where id=p_trade;
  if not found then raise exception using errcode='P0002',message='Trade not found'; end if;
  if not private.is_commissioner(t.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=t.league_id for update;
  select * into t from public.trades where id=p_trade for update;
  select * into strict s from public.seasons where id=t.season_id;
  if t.application_mode<>'live' then raise exception 'Historical records cannot be applied to bootstrap ownership'; end if;
  if t.status<>'proposed' then raise exception 'Trade has already been finalized or cancelled'; end if;
  if now()<t.review_deadline then raise exception 'The mandatory 24-hour trade review period has not ended'; end if;
  if s.trading_opened_at is null then raise exception 'Trading opens after every team has submitted keepers'; end if;
  if s.phase='archived' then raise exception 'Cannot change an archived season'; end if;
  if (select count(*) from public.trade_participants where trade_id=t.id)<2 then raise exception 'A trade needs at least two teams'; end if;
  if not exists(select 1 from public.trade_player_transfers where trade_id=t.id) and not exists(select 1 from public.trade_pick_transfers where trade_id=t.id) and not exists(select 1 from public.trade_obligations where trade_id=t.id) then raise exception 'Trade has no assets'; end if;
  if exists(select 1 from public.trade_participants tp where tp.trade_id=t.id and not exists(select 1 from public.season_teams st where st.season_id=s.id and st.franchise_id=tp.franchise_id)) then raise exception 'Trade includes a team outside this season'; end if;
  if t.category='player_only' and (exists(select 1 from public.trade_pick_transfers where trade_id=t.id) or exists(select 1 from public.trade_obligations where trade_id=t.id)) then raise exception 'Player-only trades cannot include advanced terms'; end if;
  for leg in select * from public.trade_player_transfers where trade_id=t.id order by player_id loop
    perform 1 from public.player_ownerships where season_id=s.id and player_id=leg.player_id and franchise_id=leg.from_franchise_id for update;
    if not found then raise exception 'Player % is no longer owned by the source team',leg.player_id; end if;
    if exists(select 1 from public.keeper_assignments a join public.keeper_submissions k on k.id=a.submission_id where a.season_id=s.id and a.player_id=leg.player_id and a.reserved and k.is_current and s.keepers_revealed_at is null) then raise exception 'Cannot trade an approved keeper before reveal'; end if;
  end loop;
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
  -- Receiving a later payment pick can invalidate an already approved allocation.
  -- Validate against the prospective ledger before committing any transfer. Include
  -- future pick seasons, but exclude revealed seasons whose picks are already used.
  for leg in
    select k.id from public.keeper_submissions k join public.seasons ks on ks.id=k.season_id
    where ks.league_id=t.league_id and ks.keepers_revealed_at is null
      and k.is_current and k.status in ('approved','locked')
      and (k.season_id=s.id or exists(
        select 1 from public.trade_pick_transfers x join public.draft_picks p on p.id=x.pick_id
        where x.trade_id=t.id and p.season_id=k.season_id))
  loop
    perform private.validate_keeper_submission(leg.id);
  end loop;
  update public.trades set status='finalized',finalized_at=now(),finalized_by=auth.uid() where id=t.id returning * into t;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id) values(t.league_id,auth.uid(),'trade_finalized',t.id);
  return to_jsonb(t);
end $$;

create function private.protect_finalized_trade() returns trigger
language plpgsql set search_path='' as $$
declare trade_uuid uuid;
begin
  if tg_table_name='trades' then
    if old.status='finalized' then raise exception 'Finalized trade is immutable; log a linked correction'; end if;
  else
    trade_uuid:=case when tg_op='DELETE' then old.trade_id else new.trade_id end;
    if exists(select 1 from public.trades where id=trade_uuid and status='finalized') or
      (tg_op='UPDATE' and exists(select 1 from public.trades where id=old.trade_id and status='finalized')) then
      raise exception 'Finalized trade assets are immutable; log a linked correction'; end if;
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger finalized_trade before update or delete on public.trades for each row execute function private.protect_finalized_trade();
create trigger finalized_trade_participants before insert or update or delete on public.trade_participants for each row execute function private.protect_finalized_trade();
create trigger finalized_trade_players before insert or update or delete on public.trade_player_transfers for each row execute function private.protect_finalized_trade();
create trigger finalized_trade_picks before insert or update or delete on public.trade_pick_transfers for each row execute function private.protect_finalized_trade();

-- Public wrappers have explicit authorization; internal validation is not an API.
revoke all on function private.validate_keeper_submission(uuid) from public,anon,authenticated;
revoke all on function public.save_keeper_submission(uuid,uuid,integer,jsonb) from public,anon;
revoke all on function public.transition_keeper_submission(uuid,integer,text,text) from public,anon;
revoke all on function public.create_trade(uuid,text,text,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.finalize_trade(uuid) from public,anon;
grant execute on function public.save_keeper_submission(uuid,uuid,integer,jsonb) to authenticated;
grant execute on function public.transition_keeper_submission(uuid,integer,text,text) to authenticated;
grant execute on function public.create_trade(uuid,text,text,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.finalize_trade(uuid) to authenticated;
