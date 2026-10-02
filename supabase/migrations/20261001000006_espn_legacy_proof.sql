-- Narrow legacy proof: ESPN TIE labels may be resolved only by consistent scored semifinals and final plus official finalist ranks.

-- This copy retains the exact declared-winner validation applied in migration 5.
-- The extension below removes only its audited proof fields before delegating
-- all identity, whitelist, qualification, bracket and championship checks.
create function private.validate_espn_declared_history(p_value jsonb,p_year integer,p_league bigint,p_playoff boolean) returns void
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

create function private.espn_positive_score(p_value jsonb) returns boolean
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_value)='number' then p_value::text::numeric>0 and p_value::text::numeric<=1.7976931348623157e308 else false end;
$$;

create or replace function private.validate_espn_history(p_value jsonb,p_year integer,p_league bigint,p_playoff boolean) returns void
language plpgsql set search_path='' as $$
declare final_game jsonb:=p_value->'source'->'championship'; matchup jsonb; cleaned_matchups jsonb:='[]'; declared_shape jsonb; score_winner jsonb;
begin
  if not p_playoff or final_game->>'method' is distinct from 'score-and-final-rank' then
    perform private.validate_espn_declared_history(p_value,p_year,p_league,p_playoff);
    return;
  end if;
  if not coalesce(private.espn_keys(final_game,array['id','matchupPeriod','homeEspnTeamId','awayEspnTeamId','winnerEspnTeamId','method','homePoints','awayPoints','homeFinalRank','awayFinalRank']),false)
    or jsonb_typeof(p_value->'source'->'matchups') is distinct from 'array' then raise exception 'Invalid legacy championship proof'; end if;
  -- Every semifinal must carry positive, unequal scores even when ESPN supplied
  -- one declared winner. Mixing a declared result with conflicting scores fails.
  for matchup in select value from jsonb_array_elements(p_value->'source'->'matchups') loop
    if not coalesce(private.espn_keys(matchup,array['id','homeEspnTeamId','awayEspnTeamId','winnerEspnTeamId','homePoints','awayPoints']),false)
      or not private.espn_positive_score(matchup->'homePoints') or not private.espn_positive_score(matchup->'awayPoints')
      or (matchup->>'homePoints')::numeric=(matchup->>'awayPoints')::numeric then raise exception 'Legacy semifinals require positive unequal scores'; end if;
    score_winner:=case when (matchup->>'homePoints')::numeric>(matchup->>'awayPoints')::numeric then matchup->'homeEspnTeamId' else matchup->'awayEspnTeamId' end;
    if matchup->'winnerEspnTeamId' is distinct from score_winner then raise exception 'Legacy semifinal winner disagrees with its scores'; end if;
    cleaned_matchups:=cleaned_matchups||jsonb_build_array(matchup-array['homePoints','awayPoints']);
  end loop;
  if not private.espn_positive_score(final_game->'homePoints') or not private.espn_positive_score(final_game->'awayPoints')
    or (final_game->>'homePoints')::numeric=(final_game->>'awayPoints')::numeric then raise exception 'Legacy final requires positive unequal scores'; end if;
  score_winner:=case when (final_game->>'homePoints')::numeric>(final_game->>'awayPoints')::numeric then final_game->'homeEspnTeamId' else final_game->'awayEspnTeamId' end;
  if final_game->'winnerEspnTeamId' is distinct from score_winner then raise exception 'Legacy final winner disagrees with its scores'; end if;
  if (score_winner=final_game->'homeEspnTeamId' and (final_game->'homeFinalRank' is distinct from '1'::jsonb or final_game->'awayFinalRank' is distinct from '2'::jsonb))
    or (score_winner=final_game->'awayEspnTeamId' and (final_game->'awayFinalRank' is distinct from '1'::jsonb or final_game->'homeFinalRank' is distinct from '2'::jsonb)) then raise exception 'Legacy champion and runner-up must match official final ranks one and two'; end if;
  declared_shape:=jsonb_set(p_value,'{source,matchups}',cleaned_matchups);
  declared_shape:=jsonb_set(declared_shape,'{source,championship}',final_game-array['method','homePoints','awayPoints','homeFinalRank','awayFinalRank']);
  -- The original validator proves four unique qualifiers, exactly two semifinals,
  -- the final pair matching their winners, and the champion matching that final.
  -- The server extractor separately checks the complete raw rank permutation;
  -- raw ESPN team/account objects are never stored to establish this proof.
  perform private.validate_espn_declared_history(declared_shape,p_year,p_league,p_playoff);
end $$;

revoke all on function private.validate_espn_declared_history(jsonb,integer,bigint,boolean),private.espn_positive_score(jsonb) from public,anon,authenticated;
