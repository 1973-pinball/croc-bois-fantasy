-- A commissioner may reopen one missed keeper submission without moving the
-- league deadline or expanding that team's deadline-owned payment inventory.
-- Installing this migration does not reopen any team.
create table public.keeper_late_submissions (
  season_id uuid not null,
  franchise_id uuid not null,
  opened_by uuid not null references auth.users,
  opened_at timestamptz not null default clock_timestamp(),
  reason text not null check (length(btrim(reason)) between 5 and 2000),
  consumed_at timestamptz,
  primary key (season_id,franchise_id),
  foreign key (season_id,franchise_id) references public.season_teams,
  check (consumed_at is null or consumed_at>=opened_at)
);
alter table public.keeper_late_submissions enable row level security;
revoke all on public.keeper_late_submissions from public,anon,authenticated;
grant select on public.keeper_late_submissions to authenticated;
create policy keeper_late_submission_read on public.keeper_late_submissions for select using (
  private.can_manage_franchise(franchise_id) or exists(
    select 1 from public.seasons s where s.id=season_id and private.is_commissioner(s.league_id))
);

create function private.keeper_late_submission_open(p_season uuid,p_franchise uuid) returns boolean
language sql volatile security definer set search_path='' as $$
  select exists(select 1 from public.keeper_late_submissions late
    join public.seasons s on s.id=late.season_id
    where late.season_id=p_season and late.franchise_id=p_franchise and late.consumed_at is null
      and s.phase='keeper_selection' and s.keepers_revealed_at is null
      and s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline
      and not exists(select 1 from public.live_draft_selections where season_id=s.id)
      and not exists(select 1 from private.live_draft_clocks where season_id=s.id and started_at is not null)
      and not exists(select 1 from public.keeper_submissions k where k.season_id=s.id
        and k.franchise_id=p_franchise and k.is_current and k.status not in ('draft','rejected')));
$$;
revoke all on function private.keeper_late_submission_open(uuid,uuid) from public,anon,authenticated;

create function public.reopen_keeper_submission(p_season uuid,p_franchise uuid,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; k public.keeper_submissions; late public.keeper_late_submissions;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  if length(btrim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'A reopening reason of 5 to 2000 characters is required'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into strict s from public.seasons where id=p_season for update;
  if s.phase<>'keeper_selection' or s.keepers_revealed_at is not null
    or exists(select 1 from public.live_draft_selections where season_id=s.id)
    or exists(select 1 from private.live_draft_clocks where season_id=s.id and started_at is not null) then
    raise exception 'Keeper submissions cannot reopen after reveal, draft start, or season closure';
  end if;
  if s.keeper_deadline is null or clock_timestamp()<s.keeper_deadline then raise exception 'Reopening is available only after the keeper deadline'; end if;
  if not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=p_franchise) then raise exception 'Team is not a participant in this season'; end if;
  select * into k from public.keeper_submissions where season_id=s.id and franchise_id=p_franchise and is_current for update;
  if k.id is not null and k.status not in ('draft','rejected') then raise exception 'Only a missing, draft, or rejected keeper submission can be reopened'; end if;
  perform private.capture_keeper_deadline_inventory(s.id);
  if not exists(select 1 from public.keeper_payment_deadline_snapshots where season_id=s.id) then
    raise exception 'Deadline pick ownership must be available before reopening a keeper submission';
  end if;
  insert into public.keeper_late_submissions(season_id,franchise_id,opened_by,reason)
    values(s.id,p_franchise,auth.uid(),btrim(p_note))
    on conflict (season_id,franchise_id) do update
      set opened_by=excluded.opened_by,opened_at=excluded.opened_at,reason=excluded.reason,consumed_at=null
    returning * into late;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_submission_reopened',p_franchise,
      jsonb_build_object('seasonId',s.id,'franchiseId',p_franchise,'note',btrim(p_note),'keeperDeadline',s.keeper_deadline));
  return to_jsonb(late);
end $$;
revoke all on function public.reopen_keeper_submission(uuid,uuid,text) from public,anon;
grant execute on function public.reopen_keeper_submission(uuid,uuid,text) to authenticated;


-- Validate late payment choices against the original deadline inventory. Newly
-- acquired picks neither pay for keepers nor force an invalid overpayment.
create or replace function private.validate_keeper_submission(p_submission uuid) returns void
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; a record; nearest integer; deadline_inventory boolean;
begin
  select * into strict k from public.keeper_submissions where id=p_submission;
  select * into strict s from public.seasons where id=k.season_id;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  deadline_inventory:=private.uses_deadline_keeper_payments(s.id) and s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline;
  if deadline_inventory then perform private.capture_keeper_deadline_inventory(s.id); end if;
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
    if deadline_inventory and not exists(select 1 from public.keeper_deadline_pick_owners snapshot
      where snapshot.season_id=s.id and snapshot.pick_id=a.pick_id and snapshot.franchise_id=k.franchise_id and snapshot.status='available') then
      raise exception 'Keeper payments must use available picks owned by this team at the keeper deadline';
    end if;
    if exists(select 1 from public.keeper_assignments other where other.reserved and other.submission_id<>k.id
      and (other.pick_id=a.pick_id or (other.season_id=k.season_id and other.player_id=a.player_id))) then
      raise exception 'A selected player or pick is already committed'; end if;
    select max(p.round) into nearest from public.draft_picks p
      where p.season_id=k.season_id and p.current_owner_id=k.franchise_id and p.status='available'
        and p.round>a.payment_round and p.round<=a.base_round
        and (not deadline_inventory or exists(select 1 from public.keeper_deadline_pick_owners snapshot
          where snapshot.season_id=s.id and snapshot.pick_id=p.id and snapshot.franchise_id=k.franchise_id and snapshot.status='available'))
        and not exists(select 1 from public.keeper_assignments chosen where chosen.submission_id=k.id and chosen.pick_id=p.id)
        and not exists(select 1 from public.keeper_assignments reserved where reserved.pick_id=p.id and reserved.reserved and reserved.submission_id<>k.id);
    if nearest is not null then raise exception 'Player % must use an available round % pick before an earlier pick',a.player_id,nearest; end if;
    update public.keeper_assignments set base_round_at_submission=a.base_round,tenure_at_submission=a.tenure_years where id=a.id;
  end loop;
end $$;

create or replace function public.save_keeper_submission(p_season uuid,p_franchise uuid,p_expected_revision integer,p_assignments jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; current_k public.keeper_submissions; new_k public.keeper_submissions; entry jsonb; n integer; r public.rule_versions; late_submission boolean;
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
  late_submission:=s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline;
  if late_submission and not private.keeper_late_submission_open(s.id,p_franchise) then raise exception 'The keeper deadline has passed; submitted players are fixed. Use payment changes for an existing submission.'; end if;
  if late_submission then perform private.capture_keeper_deadline_inventory(s.id); end if;
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
    if late_submission and not exists(select 1 from public.keeper_deadline_pick_owners snapshot
      where snapshot.season_id=s.id and snapshot.pick_id=(entry->>'pick_id')::uuid and snapshot.franchise_id=p_franchise and snapshot.status='available') then
      raise exception 'Keeper payments must use available picks owned by this team at the keeper deadline';
    end if;
    insert into public.keeper_assignments(submission_id,season_id,player_id,pick_id)
      values(new_k.id,p_season,(entry->>'player_id')::bigint,(entry->>'pick_id')::uuid);
  end loop;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'keeper_draft_saved',new_k.id,jsonb_build_object('revision',new_k.revision));
  return to_jsonb(new_k)||jsonb_build_object('keeper_assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.player_id),'[]'::jsonb) from public.keeper_assignments a where a.submission_id=new_k.id));
end $$;

create or replace function public.transition_keeper_submission(p_submission uuid,p_expected_revision integer,p_action text,p_note text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare k public.keeper_submissions; s public.seasons; r public.rule_versions; participant_total integer; deadline_mode boolean; payment_ready boolean; late_submission boolean;
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
    late_submission:=s.keeper_deadline is not null and clock_timestamp()>=s.keeper_deadline;
    if late_submission and not private.keeper_late_submission_open(s.id,k.franchise_id) then raise exception 'The keeper deadline has passed; new player submissions are closed'; end if;
    if k.status not in ('draft','rejected') then raise exception 'Only a draft or rejected submission can be submitted'; end if;
    perform private.validate_keeper_submission(k.id);
    update public.keeper_submissions set status='submitted',submitted_at=now(),reviewed_by=null,reviewed_at=null,review_note=null where id=k.id;
    if late_submission then
      update public.keeper_late_submissions set consumed_at=clock_timestamp()
        where season_id=s.id and franchise_id=k.franchise_id and consumed_at is null;
      insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
        values(s.league_id,auth.uid(),'keeper_late_submission_consumed',k.id,jsonb_build_object('seasonId',s.id,'franchiseId',k.franchise_id));
    end if;
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
