-- Only sanitized league evidence is public. Credentials and raw ESPN responses
-- never belong in these tables. A service-only lease serializes every sync.
create table public.espn_season_history (
  league_id uuid not null references public.leagues,
  espn_season_id integer not null check (espn_season_id between 2000 and 2100),
  playoff_history jsonb,
  statistics jsonb,
  fetched_at timestamptz not null,
  last_hash text not null check (last_hash ~ '^[a-f0-9]{64}$'),
  primary key (league_id,espn_season_id),
  check (playoff_history is not null or statistics is not null)
);
create table public.espn_history_sync_state (
  league_id uuid primary key references public.leagues,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_successful_at timestamptz,
  status text not null default 'idle' check (status in ('idle','running','succeeded','partial','failed')),
  failures jsonb not null default '[]',
  year_attempts jsonb not null default '{}',
  check ((lease_token is null)=(lease_expires_at is null))
);
create table public.espn_history_snapshots (
  id bigint generated always as identity primary key,
  league_id uuid not null references public.leagues,
  espn_season_id integer not null check (espn_season_id between 2000 and 2100),
  run_id uuid not null,
  fetched_at timestamptz not null,
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  observed_playoff_history jsonb,
  observed_statistics jsonb,
  stored_playoff_history jsonb,
  stored_statistics jsonb,
  recorded_at timestamptz not null default now(),
  unique (run_id,espn_season_id)
);
create trigger immutable_espn_history_snapshots before update or delete on public.espn_history_snapshots
  for each row execute function private.prevent_immutable_change();

alter table public.espn_season_history enable row level security;
alter table public.espn_history_sync_state enable row level security;
alter table public.espn_history_snapshots enable row level security;
revoke all on public.espn_season_history,public.espn_history_sync_state,public.espn_history_snapshots from public,anon,authenticated;
grant select on public.espn_season_history,public.espn_history_sync_state,public.espn_history_snapshots to anon,authenticated;
create policy espn_history_read on public.espn_season_history for select using (private.can_read_league(league_id));
create policy espn_history_snapshots_read on public.espn_history_snapshots for select using (private.can_read_league(league_id));
create policy espn_sync_state_read on public.espn_history_sync_state for select using (private.is_commissioner(league_id));

create function private.espn_keys(p_value jsonb,p_allowed text[]) returns boolean
language sql immutable set search_path='' as $$
  select jsonb_typeof(p_value)='object' and not exists(select 1 from jsonb_object_keys(p_value) k where not k=any(p_allowed));
$$;
create function private.espn_integer(p_value jsonb,p_min numeric default 1) returns boolean
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_value)='number' and p_value::text ~ '^[0-9]+$' then p_value::text::numeric between p_min and 9007199254740991 else false end;
$$;
create function private.validate_espn_source(p_source jsonb,p_league bigint,p_year integer,p_evidence boolean default false) returns void
language plpgsql set search_path='' as $$
declare item jsonb; source_url text; query_part text; pair text;
begin
  if not coalesce(private.espn_keys(p_source,array['kind','leagueId','sha256','url','capturedAt','paths','method','matchups','championship']),false)
    or not coalesce(p_source->>'kind' in ('espn-local-json','espn-browser-export','espn-server-sync'),false)
    or not coalesce(p_source->>'sha256' ~ '^[a-f0-9]{64}$',false)
    or not coalesce(p_source->'leagueId'=to_jsonb(p_league),false)
    or jsonb_typeof(p_source->'paths') is distinct from 'array' then raise exception 'Invalid sanitized ESPN provenance'; end if;
  if p_evidence and (p_source ? 'method' or p_source ? 'matchups' or p_source ? 'championship') then raise exception 'Invalid additional ESPN evidence'; end if;
  for item in select value from jsonb_array_elements(p_source->'paths') loop
    if jsonb_typeof(item)<>'string' or length(item#>>'{}')>256 or (item#>>'{}') !~ '^[A-Za-z0-9_.{},\[\]-]+$' then raise exception 'Invalid sanitized source path'; end if;
  end loop;
  if p_source ? 'capturedAt' then
    if jsonb_typeof(p_source->'capturedAt')<>'string' or (p_source->>'capturedAt') !~ '^\d{4}-\d{2}-\d{2}T' then raise exception 'Invalid source capture time'; end if;
    perform (p_source->>'capturedAt')::timestamptz;
  end if;
  if p_source ? 'url' then
    source_url:=p_source->>'url';
    if jsonb_typeof(p_source->'url')<>'string' or length(source_url)>2000
      or source_url !~ ('^https://(lm-api-reads\.fantasy\.espn\.com|fantasy\.espn\.com)/apis/v3/games/fba/(seasons/'||p_year||'/segments/[0-9]+/leagues/'||p_league||'|leagueHistory/'||p_league||')/?(\?|$)')
      or source_url ~ '[#@[:space:]]' then raise exception 'Invalid sanitized ESPN source URL'; end if;
    query_part:=split_part(source_url,'?',2);
    if query_part<>'' then foreach pair in array string_to_array(query_part,'&') loop
      if pair !~ '^(view=(mTeam|mSettings|mMatchup|mMatchupScore|mStandings)|seasonId=[0-9]+|leagueId=[0-9]+)$' then raise exception 'Invalid source URL query'; end if;
      if pair like 'seasonId=%' and split_part(pair,'=',2)<>p_year::text then raise exception 'Source URL year mismatch'; end if;
      if pair like 'leagueId=%' and split_part(pair,'=',2)<>p_league::text then raise exception 'Source URL league mismatch'; end if;
    end loop; end if;
  end if;
end $$;

create function private.validate_espn_history(p_value jsonb,p_year integer,p_league bigint,p_playoff boolean) returns void
language plpgsql set search_path='' as $$
declare item jsonb; matchup jsonb; final_game jsonb; team_ids bigint[]:='{}'; franchise_ids text[]:='{}'; qualifiers text[]:='{}'; bracket_ids bigint[]:='{}'; winners bigint[]:='{}'; matchup_ids bigint[]:='{}'; flags bigint[]:='{}'; champion text;
begin
  if not coalesce(private.espn_keys(p_value,case when p_playoff then array['draftYear','espnSeasonId','priorSeasonStartYear','playoffTeamCount','firstChampionshipMatchupPeriod','participants','qualifiedFranchiseIds','championFranchiseId','additionalSourceEvidence','source'] else array['draftYear','espnSeasonId','priorSeasonStartYear','qualificationStatus','participants','source'] end),false)
    or p_value->'espnSeasonId' is distinct from to_jsonb(p_year) or p_value->'draftYear' is distinct from to_jsonb(p_year)
    or p_value->'priorSeasonStartYear' is distinct from to_jsonb(p_year-1)
    or jsonb_typeof(p_value->'participants') is distinct from 'array' then raise exception 'Invalid sanitized ESPN season'; end if;
  if jsonb_array_length(p_value->'participants') not between (case when p_playoff then 4 else 2 end) and 100 then raise exception 'Invalid ESPN participant coverage'; end if;
  perform private.validate_espn_source(p_value->'source',p_league,p_year,not p_playoff);
  for item in select value from jsonb_array_elements(p_value->'participants') loop
    if not coalesce(private.espn_keys(item,case when p_playoff then array['espnTeamId','franchiseId','qualified','regularSeasonWins'] else array['espnTeamId','franchiseId','regularSeasonWins'] end),false)
      or not private.espn_integer(item->'espnTeamId') or jsonb_typeof(item->'franchiseId') is distinct from 'string' or not coalesce(item->>'franchiseId' ~ '^[1-9][0-9]*$',false)
      or (item ? 'regularSeasonWins' and not private.espn_integer(item->'regularSeasonWins',0)) then raise exception 'Invalid sanitized ESPN participant'; end if;
    if (item->>'espnTeamId')::bigint=any(team_ids) or item->>'franchiseId'=any(franchise_ids) then raise exception 'Duplicate ESPN participant'; end if;
    team_ids:=array_append(team_ids,(item->>'espnTeamId')::bigint); franchise_ids:=array_append(franchise_ids,item->>'franchiseId');
    if p_playoff then
      if jsonb_typeof(item->'qualified') is distinct from 'boolean' then raise exception 'Qualification flags must be explicit'; end if;
      if (item->>'qualified')::boolean then qualifiers:=array_append(qualifiers,item->>'franchiseId'); flags:=array_append(flags,(item->>'espnTeamId')::bigint); end if;
    end if;
  end loop;
  if not p_playoff then
    if p_value->>'qualificationStatus' is distinct from 'unverified' then raise exception 'Statistics cannot assert playoff qualification'; end if;
    return;
  end if;
  if p_value->'playoffTeamCount' is distinct from '4'::jsonb or not private.espn_integer(p_value->'firstChampionshipMatchupPeriod')
    or cardinality(qualifiers)<>4 or jsonb_typeof(p_value->'qualifiedFranchiseIds') is distinct from 'array'
    or jsonb_array_length(p_value->'qualifiedFranchiseIds')<>4
    or not (p_value->'qualifiedFranchiseIds' @> to_jsonb(qualifiers) and p_value->'qualifiedFranchiseIds' <@ to_jsonb(qualifiers))
    or p_value->'source'->>'method' is distinct from 'first-complete-winners-bracket'
    or jsonb_typeof(p_value->'source'->'matchups') is distinct from 'array' then raise exception 'Incomplete verified playoff evidence'; end if;
  if jsonb_array_length(p_value->'source'->'matchups')<>2 then raise exception 'Two championship semifinals are required'; end if;
  for matchup in select value from jsonb_array_elements(p_value->'source'->'matchups') loop
    if not coalesce(private.espn_keys(matchup,array['id','homeEspnTeamId','awayEspnTeamId','winnerEspnTeamId']),false)
      or not private.espn_integer(matchup->'id') or not private.espn_integer(matchup->'homeEspnTeamId') or not private.espn_integer(matchup->'awayEspnTeamId') then raise exception 'Invalid semifinal evidence'; end if;
    if (matchup->>'id')::bigint=any(matchup_ids) then raise exception 'Duplicate semifinal'; end if;
    matchup_ids:=array_append(matchup_ids,(matchup->>'id')::bigint);
    bracket_ids:=bracket_ids||array[(matchup->>'homeEspnTeamId')::bigint,(matchup->>'awayEspnTeamId')::bigint];
    if matchup ? 'winnerEspnTeamId' then
      if not private.espn_integer(matchup->'winnerEspnTeamId') or matchup->'winnerEspnTeamId' not in (matchup->'homeEspnTeamId',matchup->'awayEspnTeamId') then raise exception 'Invalid semifinal winner'; end if;
      winners:=array_append(winners,(matchup->>'winnerEspnTeamId')::bigint);
    end if;
  end loop;
  if (select count(distinct v) from unnest(bracket_ids) v)<>4 or not (bracket_ids @> flags and flags @> bracket_ids) then raise exception 'Semifinals disagree with qualifiers'; end if;
  if p_value ? 'championFranchiseId' or p_value->'source' ? 'championship' then
    final_game:=p_value->'source'->'championship';
    if cardinality(winners)<>2 or not coalesce(private.espn_keys(final_game,array['id','matchupPeriod','homeEspnTeamId','awayEspnTeamId','winnerEspnTeamId']),false)
      or not private.espn_integer(final_game->'id') or not private.espn_integer(final_game->'matchupPeriod') or not private.espn_integer(final_game->'homeEspnTeamId') or not private.espn_integer(final_game->'awayEspnTeamId') or not private.espn_integer(final_game->'winnerEspnTeamId') then raise exception 'A champion needs complete final evidence'; end if;
    if (final_game->>'matchupPeriod')::numeric<=(p_value->>'firstChampionshipMatchupPeriod')::numeric
      or final_game->'homeEspnTeamId'=final_game->'awayEspnTeamId'
      or not ((final_game->>'homeEspnTeamId')::bigint=any(winners) and (final_game->>'awayEspnTeamId')::bigint=any(winners))
      or final_game->'winnerEspnTeamId' not in (final_game->'homeEspnTeamId',final_game->'awayEspnTeamId') then raise exception 'The final must be between semifinal winners'; end if;
    select participant->>'franchiseId' into champion from jsonb_array_elements(p_value->'participants') participant where participant->'espnTeamId'=final_game->'winnerEspnTeamId';
    if p_value->>'championFranchiseId' is distinct from champion then raise exception 'Champion disagrees with final winner'; end if;
  end if;
  if p_value ? 'additionalSourceEvidence' then
    if jsonb_typeof(p_value->'additionalSourceEvidence')<>'array' then raise exception 'Invalid additional evidence'; end if;
    for item in select value from jsonb_array_elements(p_value->'additionalSourceEvidence') loop perform private.validate_espn_source(item,p_league,p_year,true); end loop;
  end if;
end $$;

-- An incomplete observation cannot erase previously verified fields. A new
-- complete conflicting champion must be investigated instead of silently changed.
create function private.merge_espn_history(p_previous jsonb,p_incoming jsonb,p_playoff boolean) returns jsonb
language plpgsql set search_path='' as $$
declare merged jsonb; participants jsonb; carried boolean; evidence jsonb;
begin
  if p_incoming is null then return p_previous; end if;
  if p_previous is null then return p_incoming; end if;
  if p_playoff and p_previous ? 'championFranchiseId' then
    if not (p_incoming ? 'championFranchiseId') then return p_previous; end if;
    if p_previous->'championFranchiseId'<>p_incoming->'championFranchiseId' then raise exception 'Verified champion conflict requires source review'; end if;
  end if;
  -- Preserve a complete stored participant roster against partial observations.
  if exists(select 1 from jsonb_array_elements(p_previous->'participants') old where not exists(select 1 from jsonb_array_elements(p_incoming->'participants') incoming where incoming->'espnTeamId'=old->'espnTeamId' and incoming->'franchiseId'=old->'franchiseId')) then return p_previous; end if;
  select coalesce(jsonb_agg(case when not (incoming ? 'regularSeasonWins') and old ? 'regularSeasonWins' then incoming||jsonb_build_object('regularSeasonWins',old->'regularSeasonWins') else incoming end order by ordinal),'[]'),
    coalesce(bool_or(not (incoming ? 'regularSeasonWins') and old ? 'regularSeasonWins'),false)
    into participants,carried
    from jsonb_array_elements(p_incoming->'participants') with ordinality n(incoming,ordinal)
    left join lateral (select value old from jsonb_array_elements(p_previous->'participants') where value->'espnTeamId'=incoming->'espnTeamId' and value->'franchiseId'=incoming->'franchiseId') prior on true;
  -- Statistics-only evidence has one source: retain its truthful provenance whole.
  if carried and not p_playoff then return p_previous; end if;
  merged:=jsonb_set(p_incoming,'{participants}',participants);
  if carried then
    evidence:=(p_previous->'source')-array['method','matchups','championship'];
    merged:=jsonb_set(merged,'{additionalSourceEvidence}',coalesce(p_incoming->'additionalSourceEvidence','[]')||coalesce(p_previous->'additionalSourceEvidence','[]')||jsonb_build_array(evidence));
  end if;
  return merged;
end $$;

create function public.claim_espn_history_sync(p_league uuid,p_lease_seconds integer default 300) returns jsonb
language plpgsql security definer set search_path='' as $$
declare state public.espn_history_sync_state; started timestamptz:=clock_timestamp(); token uuid:=gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception 'Lease duration must be between 30 and 900 seconds'; end if;
  if not exists(select 1 from public.leagues where id=p_league and espn_league_id is not null) then raise exception 'Configured ESPN league not found'; end if;
  insert into public.espn_history_sync_state(league_id) values(p_league) on conflict do nothing;
  select * into state from public.espn_history_sync_state where league_id=p_league for update;
  started:=clock_timestamp();
  if state.lease_token is not null and state.lease_expires_at>started then return null; end if;
  update public.espn_history_sync_state set lease_token=token,lease_expires_at=started+make_interval(secs=>p_lease_seconds),last_started_at=started,status='running' where league_id=p_league;
  return jsonb_build_object('leaseToken',token,'leaseExpiresAt',started+make_interval(secs=>p_lease_seconds),'startedAt',started);
end $$;

create function public.finish_espn_history_sync(p_league uuid,p_lease_token uuid,p_seasons jsonb,p_failures jsonb default '[]') returns jsonb
language plpgsql security definer set search_path='' as $$
declare state public.espn_history_sync_state; existing public.espn_season_history; league_number bigint; item jsonb; incoming_playoff jsonb; incoming_stats jsonb; stored_playoff jsonb; stored_stats jsonb; source_hash text; captured timestamptz; finished timestamptz:=clock_timestamp(); season_year integer; success_years integer[]:='{}'; failed_years integer[]:='{}'; all_years integer[]; recorded_failures jsonb:='[]'; attempts jsonb; failure_code text; failure_message text; outcome text; stored_count integer:=0;
begin
  select * into state from public.espn_history_sync_state where league_id=p_league for update;
  finished:=clock_timestamp();
  if not found or p_lease_token is null or state.lease_token is distinct from p_lease_token or state.lease_expires_at<=finished then raise exception using errcode='40001',message='The ESPN sync lease is stale or expired'; end if;
  if jsonb_typeof(p_seasons) is distinct from 'array' or jsonb_typeof(p_failures) is distinct from 'array' then raise exception 'Sync results must be arrays'; end if;
  if jsonb_array_length(p_seasons)>100 or jsonb_array_length(p_failures)>100 then raise exception 'Too many season results'; end if;
  select espn_league_id into strict league_number from public.leagues where id=p_league;
  attempts:=state.year_attempts;
  for item in select value from jsonb_array_elements(p_seasons) loop
    if not coalesce(private.espn_keys(item,array['espnSeasonId','playoffHistory','statistics','fetchedAt','sourceHash']),false) or not private.espn_integer(item->'espnSeasonId') then raise exception 'Invalid sanitized season envelope'; end if;
    season_year:=(item->>'espnSeasonId')::integer;
    if season_year not between 2000 and 2100 or season_year=any(success_years) then raise exception 'Invalid or duplicate season result'; end if;
    source_hash:=item->>'sourceHash';
    if not coalesce(source_hash ~ '^[a-f0-9]{64}$',false) or jsonb_typeof(item->'fetchedAt') is distinct from 'string' then raise exception 'Source hash and fetch time are required'; end if;
    captured:=(item->>'fetchedAt')::timestamptz;
    if captured>finished+interval '5 minutes' or captured<'2000-01-01'::timestamptz then raise exception 'Invalid fetch time'; end if;
    incoming_playoff:=nullif(item->'playoffHistory','null'); incoming_stats:=nullif(item->'statistics','null');
    if incoming_playoff is null and incoming_stats is null then raise exception 'A season result needs observed evidence'; end if;
    if incoming_playoff is not null then perform private.validate_espn_history(incoming_playoff,season_year,league_number,true); if incoming_playoff->'source'->>'sha256'<>source_hash then raise exception 'Playoff source hash mismatch'; end if; end if;
    if incoming_stats is not null then perform private.validate_espn_history(incoming_stats,season_year,league_number,false); if incoming_stats->'source'->>'sha256'<>source_hash then raise exception 'Statistics source hash mismatch'; end if; end if;
    select * into existing from public.espn_season_history where league_id=p_league and espn_season_id=season_year;
    if existing.fetched_at is not null and captured<existing.fetched_at then
      stored_playoff:=existing.playoff_history; stored_stats:=existing.statistics;
    else
      stored_playoff:=private.merge_espn_history(existing.playoff_history,incoming_playoff,true);
      stored_stats:=private.merge_espn_history(existing.statistics,incoming_stats,false);
      insert into public.espn_season_history(league_id,espn_season_id,playoff_history,statistics,fetched_at,last_hash)
        values(p_league,season_year,stored_playoff,stored_stats,captured,source_hash)
        on conflict (league_id,espn_season_id) do update set playoff_history=excluded.playoff_history,statistics=excluded.statistics,fetched_at=excluded.fetched_at,last_hash=excluded.last_hash;
    end if;
    insert into public.espn_history_snapshots(league_id,espn_season_id,run_id,fetched_at,source_hash,observed_playoff_history,observed_statistics,stored_playoff_history,stored_statistics)
      values(p_league,season_year,p_lease_token,captured,source_hash,incoming_playoff,incoming_stats,stored_playoff,stored_stats);
    success_years:=array_append(success_years,season_year); stored_count:=stored_count+1;
    attempts:=jsonb_set(attempts,array[season_year::text],jsonb_build_object('attemptedAt',finished,'outcome','succeeded'));
  end loop;
  for item in select value from jsonb_array_elements(p_failures) loop
    if not coalesce(private.espn_keys(item,array['seasonId','code','message']),false) or not private.espn_integer(item->'seasonId') then raise exception 'Invalid sanitized sync failure'; end if;
    season_year:=(item->>'seasonId')::integer; failure_code:=item->>'code';
    if season_year not between 2000 and 2100 or season_year=any(failed_years) then raise exception 'Invalid or duplicate failed season'; end if;
    failure_message:=case failure_code when 'ESPN_AUTH_REQUIRED' then 'ESPN access requires a connected league account.' when 'ESPN_UNAVAILABLE' then 'ESPN could not provide this season.' when 'ESPN_NOT_FOUND' then 'ESPN has no available response for this season.' when 'INVALID_SOURCE' then 'The season source needs review.' when 'BRACKET_UNVERIFIED' then 'Observed statistics were retained; championship evidence is not verified.' else null end;
    if failure_message is null then raise exception 'Invalid sync failure code'; end if;
    failed_years:=array_append(failed_years,season_year);
    recorded_failures:=recorded_failures||jsonb_build_array(jsonb_build_object('seasonId',season_year,'code',failure_code,'message',failure_message));
    attempts:=jsonb_set(attempts,array[season_year::text],jsonb_build_object('attemptedAt',finished,'outcome',case when season_year=any(success_years) then 'partial' else 'failed' end,'code',failure_code));
  end loop;
  all_years:=success_years||failed_years;
  select recorded_failures||coalesce(jsonb_agg(value),'[]') into recorded_failures from jsonb_array_elements(state.failures) where not (value->>'seasonId')::integer=any(all_years);
  outcome:=case when jsonb_array_length(recorded_failures)=0 then 'succeeded' when stored_count>0 then 'partial' else 'failed' end;
  update public.espn_history_sync_state set lease_token=null,lease_expires_at=null,last_finished_at=finished,last_successful_at=case when stored_count>0 then finished else last_successful_at end,status=outcome,failures=recorded_failures,year_attempts=attempts where league_id=p_league;
  insert into public.audit_events(league_id,event_type,entity_id,detail) values(p_league,'espn_history_synced',p_lease_token,jsonb_build_object('stored_seasons',success_years,'failed_years',failed_years,'status',outcome));
  return jsonb_build_object('status',outcome,'storedSeasons',stored_count,'failedYears',(select coalesce(jsonb_agg((value->>'seasonId')::integer),'[]') from jsonb_array_elements(recorded_failures)),'lastSuccessfulAt',case when stored_count>0 then finished else state.last_successful_at end);
end $$;

revoke all on function public.claim_espn_history_sync(uuid,integer),public.finish_espn_history_sync(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function private.espn_keys(jsonb,text[]),private.espn_integer(jsonb,numeric),private.validate_espn_source(jsonb,bigint,integer,boolean),private.validate_espn_history(jsonb,integer,bigint,boolean),private.merge_espn_history(jsonb,jsonb,boolean) from public,anon,authenticated;
-- Hosted Supabase supplies service_role. Lightweight local policy tests may not.
do $$ begin if exists(select 1 from pg_roles where rolname='service_role') then
  revoke all on public.espn_season_history,public.espn_history_sync_state,public.espn_history_snapshots from service_role;
  grant select on public.espn_season_history,public.espn_history_sync_state,public.espn_history_snapshots to service_role;
  grant select (id,league_id,espn_team_id) on public.franchises to service_role;
  grant execute on function public.claim_espn_history_sync(uuid,integer),public.finish_espn_history_sync(uuid,uuid,jsonb,jsonb) to service_role;
end if; end $$;
