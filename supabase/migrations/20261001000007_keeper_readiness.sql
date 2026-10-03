-- Keeper readiness, explicit schedule administration, and revocation-safe writes.
-- Access checks use the actual check time, including when a transaction waited
-- while another commissioner transaction ended an assignment.
create or replace function private.can_manage_franchise(p_franchise uuid) returns boolean
language sql volatile security definer set search_path='' as $$
  select exists(select 1 from public.manager_assignments a join public.league_memberships m on m.league_id=a.league_id and m.user_id=a.user_id
    where a.franchise_id=p_franchise and a.user_id=(select auth.uid()) and m.active and m.role in ('manager','commissioner')
      and a.effective_from<=clock_timestamp() and (a.effective_to is null or a.effective_to>clock_timestamp()));
$$;
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

alter table public.seasons
  add column keeper_deadline timestamptz,
  add column draft_at timestamptz,
  add column season_time_zone text,
  add column schedule_revision integer not null default 0 check (schedule_revision>=0),
  add constraint season_schedule_dates check (
    (keeper_deadline is null or isfinite(keeper_deadline)) and (draft_at is null or isfinite(draft_at)) and
    (keeper_deadline is null or draft_at is null or keeper_deadline<=draft_at) and
    ((keeper_deadline is null and draft_at is null) or season_time_zone is not null));

create function public.update_schedule(p_season uuid,p_expected_revision integer,p_keeper_deadline timestamptz,p_draft_at timestamptz,p_season_time_zone text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; previous jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select * into s from public.seasons where id=p_season for update;
  if p_expected_revision is null or s.schedule_revision<>p_expected_revision then raise exception using errcode='40001',message='The schedule changed; reload before saving'; end if;
  if s.phase='archived' then raise exception 'An archived season schedule cannot be changed'; end if;
  if length(btrim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'Record a schedule change explanation'; end if;
  if (p_keeper_deadline is not null and not isfinite(p_keeper_deadline)) or (p_draft_at is not null and not isfinite(p_draft_at)) then raise exception 'Enter finite dates and times'; end if;
  if p_keeper_deadline>p_draft_at then raise exception 'The draft cannot be before the keeper deadline'; end if;
  if (p_keeper_deadline is not null or p_draft_at is not null) and p_season_time_zone is null then raise exception 'Choose the season timezone before saving dates'; end if;
  if p_season_time_zone is not null and (length(p_season_time_zone)>100 or p_season_time_zone ~ '^(posix|right)/' or
      (p_season_time_zone<>'UTC' and position('/' in p_season_time_zone)=0) or
      not exists(select 1 from pg_catalog.pg_timezone_names where name=p_season_time_zone)) then raise exception 'Choose a valid IANA timezone'; end if;
  previous:=jsonb_build_object('keeper_deadline',s.keeper_deadline,'draft_at',s.draft_at,'season_time_zone',s.season_time_zone,'schedule_revision',s.schedule_revision);
  update public.seasons set keeper_deadline=p_keeper_deadline,draft_at=p_draft_at,season_time_zone=p_season_time_zone,schedule_revision=schedule_revision+1 where id=s.id returning * into s;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'season_schedule_updated',s.id,jsonb_build_object('previous',previous,'updated',jsonb_build_object('keeper_deadline',s.keeper_deadline,'draft_at',s.draft_at,'season_time_zone',s.season_time_zone,'schedule_revision',s.schedule_revision),'note',btrim(p_note)));
  -- A deadline is informational. Only the explicit commissioner workflow locks keepers.
  return to_jsonb(s);
end $$;

create function public.get_season_readiness(p_season uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.seasons; result jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  select jsonb_build_object(
    'seasonId',s.id,'leagueId',s.league_id,'phase',s.phase,'participantCount',s.participant_count,
    'registeredCount',(select count(*) from public.season_teams where season_id=s.id),
    'hasFrozenSnapshot',exists(select 1 from public.roster_snapshots where season_id=s.id and frozen_at is not null),
    'totalPickCount',(select count(*) from public.draft_picks where season_id=s.id),
    'expectedTotalPickCount',s.participant_count*(select draft_rounds from public.rule_versions where id=s.rule_version_id),
    'inventoryComplete',(select count(*)=s.participant_count from public.season_teams where season_id=s.id)
      and not exists(select 1 from public.season_teams st cross join public.rule_versions r cross join generate_series(1,r.draft_rounds) n
        where st.season_id=s.id and r.id=s.rule_version_id and not exists(select 1 from public.draft_picks p where p.season_id=s.id and p.original_franchise_id=st.franchise_id and p.round=n))
      and not exists(select 1 from public.draft_picks p join public.rule_versions r on r.id=s.rule_version_id where p.season_id=s.id and p.round>r.draft_rounds),
    'keeperDeadline',s.keeper_deadline,'draftAt',s.draft_at,'seasonTimeZone',s.season_time_zone,'scheduleRevision',s.schedule_revision,
    'tradingOpenedAt',s.trading_opened_at,'keepersRevealedAt',s.keepers_revealed_at,
    'teams',coalesce((select jsonb_agg(jsonb_build_object(
      'franchiseId',st.franchise_id,'displayName',st.display_name,'status',coalesce(k.status,'missing'),'revision',k.revision,
      'activeManagerCount',(select count(distinct a.user_id) from public.manager_assignments a join public.league_memberships m on m.league_id=a.league_id and m.user_id=a.user_id
        where a.franchise_id=st.franchise_id and m.active and m.role in ('manager','commissioner') and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())),
      'pendingAccessCount',(select count(*) from public.team_access_requests where franchise_id=st.franchise_id and status='pending'),
      'playerCount',(select count(*) from public.player_ownerships where season_id=s.id and franchise_id=st.franchise_id),
      'profileCounts',(select jsonb_build_object('confirmed',count(*) filter(where kp.verification='confirmed'),'provisional',count(*) filter(where kp.verification='provisional'),
        'unresolved',count(*) filter(where kp.verification='unresolved'),'ineligible',count(*) filter(where kp.verification='ineligible'),'missing',count(*) filter(where kp.player_id is null))
        from public.player_ownerships o left join public.keeper_profiles kp on kp.season_id=o.season_id and kp.player_id=o.player_id and kp.rule_version_id=s.rule_version_id
        where o.season_id=s.id and o.franchise_id=st.franchise_id),
      'pickCount',(select count(*) from public.draft_picks where season_id=s.id and current_owner_id=st.franchise_id),
      'originalPickCount',(select count(*) from public.draft_picks where season_id=s.id and original_franchise_id=st.franchise_id),
      'expectedPickCount',(select draft_rounds from public.rule_versions where id=s.rule_version_id)
    ) order by st.display_name,st.franchise_id) from public.season_teams st left join public.keeper_submissions k on k.season_id=st.season_id and k.franchise_id=st.franchise_id and k.is_current where st.season_id=s.id),'[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.update_schedule(uuid,integer,timestamptz,timestamptz,text,text),public.get_season_readiness(uuid) from public,anon;
grant execute on function public.update_schedule(uuid,integer,timestamptz,timestamptz,text,text),public.get_season_readiness(uuid) to authenticated;
