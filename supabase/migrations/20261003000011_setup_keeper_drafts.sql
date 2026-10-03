-- Private planning may be saved before the commissioner opens official keeper submission.
-- Authentication, team assignment, frozen ownership, revision, and privacy rules remain in force.
-- transition_keeper_submission is intentionally unchanged: submit/review/lock still require
-- keeper_selection, and saving never reserves a pick, opens trading, or reveals keepers.
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
  return to_jsonb(new_k);
end $$;
