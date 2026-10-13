-- Provision the reviewed 2027 original-owner inventory for cross-year trade proposals.
-- This does not submit/finalize a trade, roll over the active season, or copy a lottery/roster.
create or replace function private.provision_2027_trade_picks() returns jsonb
language plpgsql security definer set search_path='' as $$
declare source public.seasons; target public.seasons; rounds integer;
  new_season boolean := false; participants_added integer := 0; picks_added integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('croc-bois:2027-trade-picks',0));
  -- Match official workflows' league -> season lock order.
  perform 1 from public.leagues where id='4bda6ccb-0b37-47b2-8d9e-fe452603738d'::uuid and espn_league_id=139935 for update;
  if not found then raise exception 'Reviewed Croc Bois league is required'; end if;
  select s.* into source from public.seasons s join public.leagues l on l.id=s.league_id
    where l.espn_league_id=139935 and l.id='4bda6ccb-0b37-47b2-8d9e-fe452603738d'::uuid and s.draft_year=2026 for update of s;
  if not found then raise exception 'Reviewed Croc Bois 2026 season is required'; end if;
  select draft_rounds into rounds from public.rule_versions where id=source.rule_version_id and league_id=source.league_id;
  if source.participant_count<>8 or rounds<>13 or (select count(*) from public.season_teams where season_id=source.id)<>8
    or (select count(distinct f.espn_team_id) from public.season_teams st join public.franchises f on f.id=st.franchise_id
      where st.season_id=source.id and f.espn_team_id between 1 and 8)<>8 then
    raise exception 'Reviewed eight-franchise, thirteen-round inventory is required';
  end if;
  select * into target from public.seasons where league_id=source.league_id and draft_year=2027 for update;
  if not found then
    insert into public.seasons(league_id,label,draft_year,rule_version_id,participant_count,phase,draft_format)
      values(source.league_id,'2027–28',2027,source.rule_version_id,8,'setup',source.draft_format) returning * into target;
    new_season := true;
  end if;
  if target.participant_count<>8 or target.rule_version_id<>source.rule_version_id
    or exists(select 1 from public.season_teams st where st.season_id=target.id and not exists(
      select 1 from public.season_teams current_team where current_team.season_id=source.id and current_team.franchise_id=st.franchise_id))
    or exists(select 1 from public.draft_picks where season_id=target.id and round>13) then
    raise exception 'Existing 2027 configuration conflicts with the reviewed original-owner inventory';
  end if;
  if (target.phase<>'setup' or target.keepers_revealed_at is not null)
    and ((select count(*) from public.season_teams where season_id=target.id)<>8
      or (select count(*) from public.draft_picks where season_id=target.id)<>104) then
    raise exception 'Incomplete 2027 inventory cannot be repaired after setup or keeper reveal';
  end if;
  insert into public.season_teams(season_id,franchise_id,league_id,display_name)
    select target.id,franchise_id,league_id,display_name from public.season_teams where season_id=source.id
    on conflict(season_id,franchise_id) do nothing;
  get diagnostics participants_added = row_count;
  -- Existing UUIDs, transfers and used status win. Never infer future ownership from current-year transfers.
  insert into public.draft_picks(season_id,original_franchise_id,current_owner_id,round)
    select target.id,st.franchise_id,st.franchise_id,n from public.season_teams st cross join generate_series(1,13) n
    where st.season_id=target.id on conflict(season_id,original_franchise_id,round) do nothing;
  get diagnostics picks_added = row_count;
  if (select count(*) from public.draft_picks where season_id=target.id)<>104 then raise exception '2027 draft inventory is incomplete'; end if;
  if new_season or participants_added>0 or picks_added>0 then
    insert into public.audit_events(league_id,event_type,entity_id,detail) values(source.league_id,'future_pick_inventory_provisioned',target.id,
      jsonb_build_object('draftYear',2027,'sourceSeasonId',source.id,'seasonCreated',new_season,'participantsAdded',participants_added,'picksAdded',picks_added,
        'source','Recorded 2027 original-owner reference grid in data/draft-pick-evidence.json; provisioned for the user-requested cross-year pick workflow.',
        'purpose','Enable 2026 / 2027 pick proposals without changing current-season state or executing any trade.'));
  end if;
  return jsonb_build_object('seasonId',target.id,'draftYear',2027,'seasonCreated',new_season,'participantsAdded',participants_added,'picksAdded',picks_added,'pickCount',104);
end;
$$;
revoke all on function private.provision_2027_trade_picks() from public,anon,authenticated;
-- Administrative migration connection only: no browser RPC is exposed.
do $$ begin
  if exists(select 1 from public.seasons s join public.leagues l on l.id=s.league_id
    where l.id='4bda6ccb-0b37-47b2-8d9e-fe452603738d'::uuid and l.espn_league_id=139935 and s.draft_year=2026) then
    perform private.provision_2027_trade_picks();
  end if;
end $$;
