-- Live draft rosters are separate from the frozen keeper pool and from the
-- pick that originally paid for a keeper or selected a drafted player.
create table public.live_draft_roster_ownership (
  season_id uuid not null references public.seasons,
  player_id bigint not null references public.players,
  franchise_id uuid not null,
  last_trade_id uuid not null references public.trades,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (season_id,player_id),
  foreign key (season_id,franchise_id) references public.season_teams
);
alter table public.live_draft_roster_ownership enable row level security;
revoke all on public.live_draft_roster_ownership from public,anon,authenticated;

-- A correction must not erase a player owned by another team. A completed
-- trade back permits the ordinary correction and removes the obsolete override;
-- the immutable transfer legs still preserve every trade in the public ledger.
create function private.protect_traded_draft_selection() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'Draft selection history is immutable'; end if;
  if (to_jsonb(new)-array['voided_at','voided_revision']) is distinct from (to_jsonb(old)-array['voided_at','voided_revision'])
    or old.voided_at is not null or new.voided_at is null then
    raise exception 'Draft selection history is immutable; use a draft correction';
  end if;
  if exists(select 1 from public.live_draft_roster_ownership o where o.season_id=old.season_id and o.player_id=old.player_id and o.franchise_id<>old.franchise_id) then
    raise exception 'Trade this player back to the original drafting team before correcting or undoing the selection';
  end if;
  delete from public.live_draft_roster_ownership where season_id=old.season_id and player_id=old.player_id;
  return new;
end $$;
revoke all on function private.protect_traded_draft_selection() from public,anon,authenticated;
create trigger preserve_traded_draft_selection before update or delete on public.live_draft_selections
  for each row execute function private.protect_traded_draft_selection();

create or replace function public.get_draft_board(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; complete_order boolean; result jsonb; rounds integer;
begin
  select * into s from public.seasons where id=p_season for share;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_read_season(p_season) then raise exception 'League access required' using errcode='42501'; end if;
  complete_order:=coalesce(private.draft_order_complete(p_season),false);
  select draft_rounds into rounds from public.rule_versions where id=s.rule_version_id;
  select jsonb_build_object(
    'seasonId',s.id,'draftYear',s.draft_year,'phase',s.phase,'draftFormat',s.draft_format,'roundCount',rounds,
    'clock',private.draft_clock_snapshot(s.id),'revision',s.draft_revision,'keepersRevealedAt',s.keepers_revealed_at,'orderComplete',complete_order,
    'orderLocked',exists(select 1 from public.live_draft_selections where season_id=s.id) or exists(select 1 from private.live_draft_clocks where season_id=s.id and started_at is not null),
    'teams',(select coalesce(jsonb_agg(jsonb_build_object('franchiseId',st.franchise_id,'espnTeamId',f.espn_team_id,'displayName',st.display_name,
      'draftPosition',case when complete_order then st.draft_position else null end)
      order by case when complete_order then st.draft_position else null end,st.franchise_id),'[]'::jsonb)
      from public.season_teams st join public.franchises f on f.id=st.franchise_id where st.season_id=s.id),
    'picks',coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,'round',p.round,'overallPick',case when complete_order then (p.round-1)*s.participant_count+
        case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end else null end,
      'originalFranchiseId',case when complete_order then p.original_franchise_id else null end,
      'currentOwnerId',case when complete_order then p.current_owner_id else null end,
      'rosterOwnerId',case when s.keepers_revealed_at is not null and (k.player_id is not null or d.player_id is not null) then coalesce(o.franchise_id,k.franchise_id,d.franchise_id) else null end,
      'status',case when s.keepers_revealed_at is not null and k.pick_id is not null then 'keeper'
        when s.keepers_revealed_at is not null and d.id is not null then 'selected' else 'available' end,
      'playerId',case when s.keepers_revealed_at is not null then coalesce(k.player_id,d.player_id) else null end,
      'playerName',case when s.keepers_revealed_at is not null then coalesce(kp.full_name,d.player_name) else null end,
      'selectionId',case when s.keepers_revealed_at is not null then d.id else null end)
      order by p.round,case when complete_order then case when s.draft_format='snake' and p.round%2=0 then s.participant_count+1-st.draft_position else st.draft_position end else null end,p.id),'[]'::jsonb),
    'nextPickId',case when complete_order and s.phase='draft_ready' and s.keepers_revealed_at is not null then private.next_live_draft_pick(s.id) else null end
  ) into result
  from public.draft_picks p join public.season_teams st on st.season_id=p.season_id and st.franchise_id=p.original_franchise_id
  left join public.keeper_season_records k on k.pick_id=p.id and k.season_id=s.id
  left join public.players kp on kp.id=k.player_id
  left join public.live_draft_selections d on d.pick_id=p.id and d.voided_at is null
  left join public.live_draft_roster_ownership o on o.season_id=s.id and o.player_id=coalesce(k.player_id,d.player_id)
  where p.season_id=s.id;
  return result;
end $$;
revoke all on function public.get_draft_board(uuid) from public;
grant execute on function public.get_draft_board(uuid) to anon,authenticated;

create function public.execute_live_draft_trade(p_season uuid,p_expected_revision integer,p_players jsonb,p_picks jsonb,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; target_season public.seasons; picked public.draft_picks; c private.live_draft_clocks;
  entry jsonb; leg record; owner_id uuid; player_name text; trade_id uuid; affected_season uuid; receipt timestamptz;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  if p_expected_revision is distinct from s.draft_revision then raise exception 'The draft board changed. Refresh before recording the trade.' using errcode='40001'; end if;
  if s.phase<>'draft_ready' or s.keepers_revealed_at is null then raise exception 'Draft trades open only after every keeper is locked and revealed'; end if;
  if length(trim(coalesce(p_note,''))) not between 5 and 2000 then raise exception 'Describe the draft trade in 5 to 2000 characters'; end if;
  if jsonb_typeof(p_players) is distinct from 'array' or jsonb_typeof(p_picks) is distinct from 'array' then raise exception 'Players and picks must be arrays'; end if;
  if jsonb_array_length(p_players)+jsonb_array_length(p_picks) not between 1 and 100 then raise exception 'Include between 1 and 100 draft trade assets'; end if;
  for entry in select value from jsonb_array_elements(p_players) loop
    if jsonb_typeof(entry) is distinct from 'object' or not (entry ?& array['playerId','fromFranchiseId','toFranchiseId'])
      or entry-array['playerId','fromFranchiseId','toFranchiseId']<>'{}'::jsonb
      or jsonb_typeof(entry->'playerId') is distinct from 'number' or (entry->>'playerId')!~'^[1-9][0-9]{0,15}$'
      or (entry->>'playerId')::numeric>9007199254740991 then raise exception 'Invalid player transfer fields'; end if;
  end loop;
  for entry in select value from jsonb_array_elements(p_picks) loop
    if jsonb_typeof(entry) is distinct from 'object' or not (entry ?& array['pickId','fromFranchiseId','toFranchiseId'])
      or entry-array['pickId','fromFranchiseId','toFranchiseId']<>'{}'::jsonb then raise exception 'Invalid pick transfer fields'; end if;
  end loop;
  if (select count(distinct value->>'playerId') from jsonb_array_elements(p_players))<>jsonb_array_length(p_players)
    or (select count(distinct value->>'pickId') from jsonb_array_elements(p_picks))<>jsonb_array_length(p_picks) then raise exception 'A player or pick can appear only once in a draft trade'; end if;
  for leg in select "fromFranchiseId" as from_id,"toFranchiseId" as to_id from jsonb_to_recordset(p_players||p_picks) as x("fromFranchiseId" uuid,"toFranchiseId" uuid) loop
    if leg.from_id is null or leg.to_id is null or leg.from_id=leg.to_id then raise exception 'Choose different sending and receiving teams'; end if;
    if not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=leg.from_id)
      or not exists(select 1 from public.season_teams where season_id=s.id and franchise_id=leg.to_id) then raise exception 'Every trade team must participate in this draft season'; end if;
  end loop;
  select * into c from private.live_draft_clocks where season_id=s.id for update;
  if c.status='running' and c.deadline_at<=clock_timestamp() then raise exception 'Draft timer expired; refresh for the automatic selection before recording a trade' using errcode='40001'; end if;

  -- Validate the entire deal before changing any roster or pick ownership.
  for leg in select * from jsonb_to_recordset(p_players) as x("playerId" bigint,"fromFranchiseId" uuid,"toFranchiseId" uuid) loop
    select coalesce(o.franchise_id,base.franchise_id),base.player_name into owner_id,player_name
      from (select k.franchise_id,p.full_name as player_name from public.keeper_season_records k join public.players p on p.id=k.player_id where k.season_id=s.id and k.player_id=leg."playerId"
        union all select d.franchise_id,d.player_name from public.live_draft_selections d where d.season_id=s.id and d.player_id=leg."playerId" and d.voided_at is null) base
      left join public.live_draft_roster_ownership o on o.season_id=s.id and o.player_id=leg."playerId";
    if not found or owner_id is distinct from leg."fromFranchiseId" then raise exception 'The player is not on the sending team''s live draft roster'; end if;
  end loop;
  for leg in select * from jsonb_to_recordset(p_picks) as x("pickId" uuid,"fromFranchiseId" uuid,"toFranchiseId" uuid) loop
    select * into picked from public.draft_picks where id=leg."pickId" for update;
    if not found then raise exception 'Draft pick not found' using errcode='P0002'; end if;
    select * into strict target_season from public.seasons where id=picked.season_id for update;
    if target_season.league_id<>s.league_id or target_season.draft_year not in (s.draft_year,s.draft_year+1)
      or target_season.phase not in ('setup','keeper_selection','draft_ready') then raise exception 'Choose an unspent pick from this draft or the next draft in this league'; end if;
    if picked.current_owner_id<>leg."fromFranchiseId" or picked.status<>'available'
      or exists(select 1 from public.keeper_assignments where pick_id=picked.id and reserved)
      or exists(select 1 from public.keeper_season_records where pick_id=picked.id)
      or exists(select 1 from public.live_draft_selections where pick_id=picked.id and voided_at is null) then raise exception 'The pick is not unspent and available to the sending team'; end if;
    if not exists(select 1 from public.season_teams where season_id=target_season.id and franchise_id=leg."fromFranchiseId")
      or not exists(select 1 from public.season_teams where season_id=target_season.id and franchise_id=leg."toFranchiseId") then raise exception 'Both teams must participate in the pick''s draft season'; end if;
  end loop;
  for affected_season in select distinct p.season_id from public.draft_picks p join jsonb_to_recordset(p_picks) as x("pickId" uuid) on x."pickId"=p.id order by p.season_id loop
    perform private.capture_keeper_deadline_inventory(affected_season);
  end loop;

  receipt:=clock_timestamp();
  insert into public.trades(league_id,season_id,category,terms,created_at,effective_at,review_deadline,created_by,source_metadata)
    values(s.league_id,s.id,case when jsonb_array_length(p_picks)>0 then 'advanced' else 'player_only' end,trim(p_note),receipt,receipt,receipt+interval '24 hours',auth.uid(),
      jsonb_build_object('kind','live_draft_trade','draftSeasonId',s.id,'draftRevision',s.draft_revision+1,'immediateCommissionerRecord',true)) returning id into trade_id;
  insert into public.trade_participants(trade_id,franchise_id)
    select trade_id,franchise from (select "fromFranchiseId" as franchise from jsonb_to_recordset(p_players||p_picks) as x("fromFranchiseId" uuid)
      union select "toFranchiseId" from jsonb_to_recordset(p_players||p_picks) as x("toFranchiseId" uuid)) participants;
  for leg in select * from jsonb_to_recordset(p_players) as x("playerId" bigint,"fromFranchiseId" uuid,"toFranchiseId" uuid) loop
    -- New live draft picks may not yet have a legacy player record. Adding the
    -- identity permits a public transfer leg without creating frozen ownership.
    insert into public.players(id,full_name) select player_id,full_name from public.draft_player_catalog where player_id=leg."playerId" on conflict(id) do nothing;
    insert into public.trade_player_transfers(trade_id,player_id,from_franchise_id,to_franchise_id,espn_status)
      values(trade_id,leg."playerId",leg."fromFranchiseId",leg."toFranchiseId",'not_required');
    insert into public.live_draft_roster_ownership(season_id,player_id,franchise_id,last_trade_id)
      values(s.id,leg."playerId",leg."toFranchiseId",trade_id)
      on conflict(season_id,player_id) do update set franchise_id=excluded.franchise_id,last_trade_id=excluded.last_trade_id,updated_at=receipt;
  end loop;
  for leg in select * from jsonb_to_recordset(p_picks) as x("pickId" uuid,"fromFranchiseId" uuid,"toFranchiseId" uuid) loop
    insert into public.trade_pick_transfers(trade_id,pick_id,from_franchise_id,to_franchise_id)
      values(trade_id,leg."pickId",leg."fromFranchiseId",leg."toFranchiseId");
    update public.draft_picks set current_owner_id=leg."toFranchiseId" where id=leg."pickId";
  end loop;
  update public.trades set status='finalized',finalized_by=auth.uid(),finalized_at=receipt where id=trade_id;
  if c.status='running' then
    update private.live_draft_clocks set status='paused',remaining_seconds=greatest(0,extract(epoch from deadline_at-clock_timestamp())),deadline_at=null where season_id=s.id;
  end if;
  update public.seasons set draft_revision=draft_revision+1 where id=s.id or id in (
    select p.season_id from public.draft_picks p join jsonb_to_recordset(p_picks) as x("pickId" uuid) on x."pickId"=p.id);
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'live_draft_trade_recorded',trade_id,jsonb_build_object('seasonId',s.id,'revision',s.draft_revision+1,
      'players',p_players,'picks',p_picks,'note',trim(p_note),'clockPaused',c.status='running'));
  return public.get_draft_board(s.id);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Invalid draft trade asset identity';
end $$;
revoke all on function public.execute_live_draft_trade(uuid,integer,jsonb,jsonb,text) from public,anon;
grant execute on function public.execute_live_draft_trade(uuid,integer,jsonb,jsonb,text) to authenticated;
