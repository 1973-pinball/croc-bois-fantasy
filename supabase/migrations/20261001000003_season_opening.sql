create function public.open_keeper_selection(p_season uuid,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; r public.rule_versions;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception using errcode='P0002',message='Season not found'; end if;
  if not private.is_commissioner(s.league_id) then raise exception using errcode='42501',message='Commissioner access required'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  select * into strict r from public.rule_versions where id=s.rule_version_id;
  if s.phase<>'setup' then raise exception 'Season is not in setup'; end if;
  if length(btrim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'Record the commissioner setup review before opening'; end if;
  if (select count(*) from public.season_teams where season_id=s.id)<>s.participant_count then raise exception 'Finish registering every season participant'; end if;
  if not exists(select 1 from public.roster_snapshots where season_id=s.id and frozen_at is not null) then raise exception 'A verified frozen roster snapshot is required'; end if;
  if exists(select 1 from public.player_ownerships o join public.roster_snapshots rs on rs.id=o.source_snapshot_id where o.season_id=s.id and rs.frozen_at is null) then raise exception 'Player ownership must reference the frozen snapshot'; end if;
  if exists(select 1 from public.roster_entries e join public.roster_snapshots rs on rs.id=e.snapshot_id where rs.season_id=s.id and rs.frozen_at is not null and not exists(select 1 from public.player_ownerships o where o.season_id=s.id and o.player_id=e.player_id)) then raise exception 'Finish importing the frozen roster ownership'; end if;
  if exists(select 1 from public.player_ownerships o where o.season_id=s.id and not exists(select 1 from public.keeper_profiles kp where kp.season_id=s.id and kp.player_id=o.player_id and kp.rule_version_id=s.rule_version_id)) then raise exception 'Every rostered player needs a keeper profile under this season''s rules'; end if;
  if exists(select 1 from public.season_teams st cross join generate_series(1,r.draft_rounds) round_number where st.season_id=s.id and not exists(select 1 from public.draft_picks p where p.season_id=s.id and p.original_franchise_id=st.franchise_id and p.round=round_number)) then raise exception 'Finish creating every original draft pick'; end if;
  if exists(select 1 from public.draft_picks where season_id=s.id and (round>r.draft_rounds or status<>'available')) then raise exception 'Opening picks must be valid and unused'; end if;
  update public.seasons set phase='keeper_selection' where id=s.id returning * into s;
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail) values(s.league_id,auth.uid(),'keeper_selection_opened',s.id,jsonb_build_object('note',p_note));
  return to_jsonb(s);
end $$;
revoke all on function public.open_keeper_selection(uuid,text) from public,anon;
grant execute on function public.open_keeper_selection(uuid,text) to authenticated;

-- Pending trades are available to all league managers during the review window.
create or replace function private.can_read_trade(p_trade uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.trades t where t.id=p_trade and
    ((t.status='finalized' and private.can_read_league(t.league_id)) or
      exists(select 1 from public.league_memberships m where m.league_id=t.league_id and m.user_id=(select auth.uid()) and m.active and m.role in ('manager','commissioner'))));
$$;
