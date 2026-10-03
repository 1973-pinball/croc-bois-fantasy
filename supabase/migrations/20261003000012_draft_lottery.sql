-- Verified source configuration can exist before bootstrap. Drawing is a separate,
-- explicit commissioner action and never publishes priority or changes draft slots.
create table private.draft_lottery_configurations (
  espn_league_id bigint not null,
  draft_year integer not null,
  definition jsonb not null,
  primary key (espn_league_id,draft_year)
);
revoke all on private.draft_lottery_configurations from public,anon,authenticated;
create trigger immutable_lottery_config before update or delete on private.draft_lottery_configurations for each row execute function private.prevent_immutable_change();

create table public.draft_lottery_runs (
  id uuid primary key,
  season_id uuid not null unique,
  league_id uuid not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null,
  configuration jsonb not null,
  snapshot jsonb not null,
  result jsonb not null,
  foreign key (season_id,league_id) references public.seasons(id,league_id)
);
alter table public.draft_lottery_runs enable row level security;
revoke all on public.draft_lottery_runs from public,anon,authenticated;
create trigger immutable_lottery_run before update or delete on public.draft_lottery_runs for each row execute function private.prevent_immutable_change();

create function public.get_draft_lottery(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; config jsonb; saved public.draft_lottery_runs; standings jsonb; reason text;
  state jsonb; runtime_source text; commissioner boolean;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.can_read_season(s.id) then raise exception 'League access required' using errcode='42501'; end if;
  commissioner := private.is_commissioner(s.league_id);
  select * into saved from public.draft_lottery_runs where season_id=s.id;
  if found then
    -- The snapshot holds only inputs/source, never the private random draw or priority.
    return saved.snapshot || jsonb_build_object('phase',s.phase,'ready',false,'unavailableReason',null,'hasRun',true,
      'result',case when commissioner then saved.result else null end);
  end if;
  runtime_source := pg_catalog.pg_get_functiondef('public.run_draft_lottery(uuid)'::regprocedure);
  select c.definition into config from private.draft_lottery_configurations c join public.leagues l on l.espn_league_id=c.espn_league_id
    where l.id=s.league_id and c.draft_year=s.draft_year;
  if config is null then
    reason := 'Verified prior-season standings and playoff qualification are required before this lottery can run.';
  elsif s.participant_count<>8 or (select count(*) from public.season_teams where season_id=s.id)<>8 then
    reason := 'This lottery requires exactly eight verified season participants; another format needs reviewed odds.';
  elsif jsonb_array_length(config->'standings')<>8
    or (config->>'priorEspnSeasonId')::integer<>s.draft_year
    or (select count(distinct value->>'franchiseId') from jsonb_array_elements(config->'standings'))<>8
    or (select count(distinct value->>'espnTeamId') from jsonb_array_elements(config->'standings'))<>8
    or (select count(distinct (value->>'regularSeasonPlace')::integer) from jsonb_array_elements(config->'standings') where (value->>'regularSeasonPlace')::integer between 1 and 8)<>8
    or (select count(distinct (value->>'finalPlace')::integer) from jsonb_array_elements(config->'standings') where (value->>'finalPlace')::integer between 1 and 8)<>8
    or (select count(*) from jsonb_array_elements(config->'standings') where (value->>'playoffQualified')::boolean)<>4
    or exists(select 1 from jsonb_array_elements(config->'standings') x where not exists(
      select 1 from public.season_teams st join public.franchises f on f.id=st.franchise_id
      where st.season_id=s.id and st.franchise_id=(x->>'franchiseId')::uuid and f.espn_team_id=(x->>'espnTeamId')::integer))
    or jsonb_array_length(config->'configuration'->'franchiseIds')<>8
    or jsonb_array_length(config->'configuration'->'weights')<>8
    or exists(select 1 from jsonb_array_elements_text(config->'configuration'->'franchiseIds') with ordinality f(id,position)
      where not exists(select 1 from jsonb_array_elements(config->'standings') t where t->>'franchiseId'=f.id
        and (t->>'regularSeasonPlace')::integer=9-f.position
        and (config->'configuration'->'weights'->>((f.position-1)::integer))::integer=case when (t->>'playoffQualified')::boolean then 1 else 24 end)) then
    reason := 'The season participants do not match the eight verified prior-season standings and four playoff teams.';
  elsif s.phase not in ('setup','keeper_selection','draft_ready') then
    reason := 'The lottery is closed for this season phase.';
  elsif exists(select 1 from public.season_teams where season_id=s.id and (draft_position is not null or lottery_choice_order is not null))
    or exists(select 1 from public.live_draft_selections where season_id=s.id) then
    reason := 'An existing choice order, draft order, or draft selection prevents a new lottery.';
  end if;
  if config is not null then
    select coalesce(jsonb_agg(jsonb_build_object('franchiseId',x->>'franchiseId','espnTeamId',(x->>'espnTeamId')::integer,
      'managerLabel',x->>'managerLabel','displayName',x->>'displayName','priorTeamName',x->>'priorTeamName',
      'regularSeasonPlace',(x->>'regularSeasonPlace')::integer,'finalPlace',(x->>'finalPlace')::integer,
      'record',x->'record','playoffQualified',(x->>'playoffQualified')::boolean)
      order by (x->>'regularSeasonPlace')::integer),'[]'::jsonb) into standings
      from jsonb_array_elements(config->'standings') x;
  end if;
  state := jsonb_build_object('seasonId',s.id,'phase',s.phase,'ready',reason is null,'unavailableReason',reason,'hasRun',false,
    'standings',coalesce(standings,'[]'::jsonb),
    'source',case when config is null then null else jsonb_build_object('priorEspnSeasonId',(config->>'priorEspnSeasonId')::integer,
      'sha256',config->'source'->>'sha256','url',config->'source'->>'url','capturedAt',config->'source'->>'capturedAt','description',config->'source'->>'description') end,
    'managerSource',case when config is null then null else jsonb_build_object('espnSeasonId',(config->'managerSource'->>'espnSeasonId')::integer,
      'sha256',config->'managerSource'->>'sha256','url',config->'managerSource'->>'url','capturedAt',config->'managerSource'->>'capturedAt','description',config->'managerSource'->>'description') end,
    'algorithm',jsonb_build_object('id','weighted-without-replacement-v1',
      'pythonSource',config->>'pythonSource','pythonSourceSha256',config->>'pythonSourceSha256','pythonSourceLabel',config->>'pythonSourceLabel',
      'typeScriptSource',config->>'typeScriptSource','sourceSha256',config->>'algorithmSourceSha256',
      'databaseSource',runtime_source,'databaseSourceSha256',encode(sha256(convert_to(runtime_source,'UTF8')),'hex')),
    'odds',case when config is null then null else config->'configuration' end,'result',null);
  return state;
end $$;
revoke all on function public.get_draft_lottery(uuid) from public;
grant execute on function public.get_draft_lottery(uuid) to anon,authenticated;

create function public.run_draft_lottery(p_season uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.seasons; state jsonb; config jsonb; entropy uuid; raw_value bigint; ticket integer; discarded integer;
  rejection_limit bigint; remaining_total integer; remaining_weights integer[]; franchise_ids text[];
  selection integer; priority_index integer; column_index integer; cumulative integer;
  priority jsonb:='[]'::jsonb; steps jsonb:='[]'::jsonb; run_id uuid; drawn_at timestamptz; result jsonb;
begin
  select * into s from public.seasons where id=p_season;
  if not found then raise exception 'Season not found' using errcode='P0002'; end if;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  perform 1 from public.leagues where id=s.league_id for update;
  select * into s from public.seasons where id=p_season for update;
  if not private.is_commissioner(s.league_id) then raise exception 'Commissioner access required' using errcode='42501'; end if;
  -- A retry returns the already committed result; it consumes no new randomness or audit event.
  if exists(select 1 from public.draft_lottery_runs where season_id=s.id) then return public.get_draft_lottery(s.id); end if;
  state := public.get_draft_lottery(s.id);
  if not (state->>'ready')::boolean then raise exception '%',state->>'unavailableReason'; end if;
  select c.definition into strict config from private.draft_lottery_configurations c join public.leagues l on l.espn_league_id=c.espn_league_id
    where l.id=s.league_id and c.draft_year=s.draft_year;
  select array_agg(value order by ordinality) into franchise_ids
    from jsonb_array_elements_text(config->'configuration'->'franchiseIds') with ordinality;
  select array_agg(value::integer order by ordinality) into remaining_weights
    from jsonb_array_elements_text(config->'configuration'->'weights') with ordinality;
  -- Sequential weighted sampling matches the original NumPy rule. A selected team
  -- is removed; every other team retains its original weight (24 or 1).
  for priority_index in 1..8 loop
    select sum(weight) into remaining_total from unnest(remaining_weights) weight;
    if remaining_total<=0 then raise exception 'Verified lottery weights are invalid'; end if;
    -- UUID's first 32 bits contain no version/variant bits. Rejection before modulo
    -- makes each integer ticket equally likely for this step's remaining total.
    rejection_limit := (4294967296::bigint / remaining_total) * remaining_total;
    discarded := 0;
    loop
      entropy := gen_random_uuid();
      raw_value := ('x'||substr(replace(entropy::text,'-',''),1,8))::bit(32)::bigint;
      exit when raw_value<rejection_limit;
      discarded := discarded+1;
    end loop;
    ticket := (raw_value%remaining_total)::integer;
    cumulative := 0; selection := null;
    for column_index in 1..8 loop
      cumulative := cumulative+remaining_weights[column_index];
      if ticket<cumulative then selection := column_index; exit; end if;
    end loop;
    if selection is null then raise exception 'Verified lottery weights are invalid'; end if;
    priority := priority || jsonb_build_array(franchise_ids[selection]);
    steps := steps || jsonb_build_array(jsonb_build_object('priority',priority_index,'remainingTotal',remaining_total,
      'ticket',ticket,'selectedFranchiseId',franchise_ids[selection],'entropyUuid',entropy,'discardedEntropyDraws',discarded));
    remaining_weights[selection] := 0;
  end loop;
  if jsonb_array_length(priority)<>8 or (select count(distinct value) from jsonb_array_elements_text(priority))<>8 then raise exception 'Verified lottery weights are invalid'; end if;
  run_id := gen_random_uuid(); drawn_at := clock_timestamp();
  result := jsonb_build_object('id',run_id,'drawnAt',drawn_at,'priorityOrder',priority,
    'sourceSha256',config->'source'->>'sha256','algorithmSourceSha256',config->>'algorithmSourceSha256',
    'pythonSourceSha256',config->>'pythonSourceSha256','databaseSourceSha256',state->'algorithm'->>'databaseSourceSha256',
    'audit',jsonb_build_object('algorithm','weighted-without-replacement-v1','franchiseIds',config->'configuration'->'franchiseIds',
      'weights',config->'configuration'->'weights','marginalMatrix',config->'configuration'->'marginalMatrix','steps',steps));
  insert into public.draft_lottery_runs(id,season_id,league_id,created_by,created_at,configuration,snapshot,result)
    values(run_id,s.id,s.league_id,auth.uid(),drawn_at,config,state,result);
  insert into public.audit_events(league_id,actor_user_id,event_type,entity_id,detail)
    values(s.league_id,auth.uid(),'draft_lottery_generated',s.id,jsonb_build_object('runId',run_id,'result',result));
  -- Public lottery_choice_order, draft_position, season phase, and draft revisions stay unchanged.
  return public.get_draft_lottery(s.id);
end $$;
revoke all on function public.run_draft_lottery(uuid) from public,anon;
grant execute on function public.run_draft_lottery(uuid) to authenticated;


-- Original notebook weights, exact derived odds, and independently verified prior-season
-- regular standings. Runtime draws sequentially from remaining original weights.
-- This only registers inputs; it does not run a lottery or modify the current season.
insert into private.draft_lottery_configurations(espn_league_id,draft_year,definition) values
(139935,2026,$lottery_definition${
  "version": 1,
  "leagueId": 139935,
  "priorEspnSeasonId": 2026,
  "priorSeasonStartYear": 2025,
  "draftYear": 2026,
  "standings": [
    {
      "espnTeamId": 7,
      "franchiseId": "6f828799-7d52-4fef-83d4-03579f52b2df",
      "managerLabel": "James",
      "displayName": "DeepMind AI",
      "priorTeamName": "DeepMind AI",
      "regularSeasonPlace": 1,
      "finalPlace": 2,
      "record": {
        "wins": 102,
        "losses": 58,
        "ties": 2,
        "percentage": 0.6358024691358025
      },
      "playoffQualified": true
    },
    {
      "espnTeamId": 6,
      "franchiseId": "0e926a61-0f4b-40ff-8ce0-f674fb0616be",
      "managerLabel": "Amber",
      "displayName": "Sister Stumpy",
      "priorTeamName": "Sister Stumpy",
      "regularSeasonPlace": 2,
      "finalPlace": 3,
      "record": {
        "wins": 99,
        "losses": 59,
        "ties": 4,
        "percentage": 0.6234567901234568
      },
      "playoffQualified": true
    },
    {
      "espnTeamId": 2,
      "franchiseId": "ea426552-e14c-41e0-831f-558ed0e91691",
      "managerLabel": "Arod",
      "displayName": "Bizarre Bazaar",
      "priorTeamName": "Bizarre Bazaar",
      "regularSeasonPlace": 3,
      "finalPlace": 1,
      "record": {
        "wins": 89,
        "losses": 71,
        "ties": 2,
        "percentage": 0.5555555555555556
      },
      "playoffQualified": true
    },
    {
      "espnTeamId": 1,
      "franchiseId": "91565de8-795e-4ebf-8353-29b83bbfecc7",
      "managerLabel": "Jon",
      "displayName": "Lo Fi Hip Hop Beats to Win To",
      "priorTeamName": "Lo Fi Hip Hop Beats to Win To",
      "regularSeasonPlace": 4,
      "finalPlace": 4,
      "record": {
        "wins": 82,
        "losses": 77,
        "ties": 3,
        "percentage": 0.5154320987654321
      },
      "playoffQualified": true
    },
    {
      "espnTeamId": 8,
      "franchiseId": "c81be1b5-6655-459d-8c3b-ace971b0f0fa",
      "managerLabel": "Alex",
      "displayName": "Double Trouble",
      "priorTeamName": "Double Trouble",
      "regularSeasonPlace": 5,
      "finalPlace": 6,
      "record": {
        "wins": 70,
        "losses": 87,
        "ties": 5,
        "percentage": 0.44753086419753085
      },
      "playoffQualified": false
    },
    {
      "espnTeamId": 5,
      "franchiseId": "f20ba68b-0d3f-46b7-82cf-5ca0b9417a4c",
      "managerLabel": "Shane",
      "displayName": "Paramaribo Potoos",
      "priorTeamName": "Paramaribo Potoos",
      "regularSeasonPlace": 6,
      "finalPlace": 8,
      "record": {
        "wins": 70,
        "losses": 91,
        "ties": 1,
        "percentage": 0.4351851851851852
      },
      "playoffQualified": false
    },
    {
      "espnTeamId": 4,
      "franchiseId": "5cc31eed-a450-4a8e-8380-feccd817c164",
      "managerLabel": "Sebastian",
      "displayName": "The ManyFacedBron",
      "priorTeamName": "Luka Deez Nuts",
      "regularSeasonPlace": 7,
      "finalPlace": 5,
      "record": {
        "wins": 64,
        "losses": 97,
        "ties": 1,
        "percentage": 0.39814814814814814
      },
      "playoffQualified": false
    },
    {
      "espnTeamId": 3,
      "franchiseId": "0a36f406-2ec5-447a-8202-7f602a30b7c9",
      "managerLabel": "Wyndham",
      "displayName": "Antiques Roadshow",
      "priorTeamName": "Antiques Roadshow",
      "regularSeasonPlace": 8,
      "finalPlace": 7,
      "record": {
        "wins": 62,
        "losses": 98,
        "ties": 2,
        "percentage": 0.3888888888888889
      },
      "playoffQualified": false
    }
  ],
  "managerSource": {
    "sha256": "7e3858cb3d2f966a5f2bfe31eb8ff0f0e3c92e9c638d5464af398fc9a2f67e0c",
    "url": "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/139935?view=mTeam&view=mSettings&view=mMatchup&view=mMatchupScore&view=mStandings&view=mRoster",
    "capturedAt": "2026-10-03T16:41:03.111Z",
    "espnSeasonId": 2027,
    "description": "Current team names and manager assignments were verified against the upcoming ESPN season. Display labels were explicitly confirmed by the commissioner on 2026-10-03: Jon means Jonathan, Arod means Anthony, and Amber is the chosen label among the current co-managers of team 6. Account identifiers are not published.",
    "paths": [
      "id",
      "seasonId",
      "teams[].{id,name,owners}",
      "members[].{id,firstName}"
    ]
  },
  "source": {
    "sha256": "cd37ab9913b3197e0108bae4a006b9c6e538d155d1a2f00bd84a4bed58498efd",
    "url": "https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2026/segments/0/leagues/139935?view=mTeam&view=mSettings&view=mMatchup&view=mMatchupScore&view=mStandings&view=mRoster",
    "capturedAt": "2026-10-03T16:41:03.030Z",
    "description": "Regular-season places are ESPN teams[].playoffSeed, checked against record.overall W/L/T and percentage. Postseason finalPlace is rankCalculatedFinal, corroborated by all four completed placement games. Playoff qualification comes separately from the first complete WINNERS_BRACKET round. Lottery configuration uses regular-season places from last to first.",
    "paths": [
      "status.finalScoringPeriod",
      "scoringPeriodId",
      "teams[].{name,playoffSeed,rankCalculatedFinal}",
      "teams[].record.overall.{wins,losses,ties,percentage}",
      "id",
      "seasonId",
      "settings.scheduleSettings.playoffTeamCount",
      "teams[].id",
      "schedule[72].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}",
      "schedule[73].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}",
      "schedule[76].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}",
      "schedule[77].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}",
      "schedule[78].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}",
      "schedule[79].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}"
    ],
    "firstChampionshipMatchupPeriod": 19,
    "qualifyingMatchupIds": [
      73,
      74
    ],
    "championshipMatchupId": 77,
    "finalPlacementMatchups": [
      {
        "id": 77,
        "winnerEspnTeamId": 2,
        "loserEspnTeamId": 7,
        "winnerPlace": 1,
        "loserPlace": 2
      },
      {
        "id": 78,
        "winnerEspnTeamId": 6,
        "loserEspnTeamId": 1,
        "winnerPlace": 3,
        "loserPlace": 4
      },
      {
        "id": 79,
        "winnerEspnTeamId": 4,
        "loserEspnTeamId": 8,
        "winnerPlace": 5,
        "loserPlace": 6
      },
      {
        "id": 80,
        "winnerEspnTeamId": 3,
        "loserEspnTeamId": 5,
        "winnerPlace": 7,
        "loserPlace": 8
      }
    ]
  },
  "pythonSource": "def draft_pick_gen(managers, probabilities):\n    \n    #assign the picks using the probabilities above\n    draft_order = np.random.choice(managers, len(managers),p = probabilities, replace = False)\n    results = list(zip(range(1,len(managers)+1),draft_order))\n    \n    return results\n\nprobabilities = [.24, .24, .24, .24, .01, .01, .01, .01]\n",
  "pythonSourceSha256": "ca7657930bff31d9c1ba8abc069fbd8e659224fe5478f719291be18bf679a84c",
  "pythonSourceLabel": "Original fantasy draft order.ipynb: draft_pick_gen and starting probabilities; historical manager names omitted.",
  "typeScriptSource": "/** Official rule: the notebook's NumPy weighted draw without replacement. */\nexport interface WeightedLotteryConfiguration {\n  franchiseIds: readonly string[];\n  /** Positive integer weights remain unchanged until that franchise is selected. */\n  weights: readonly number[];\n}\n\nexport interface WeightedLotteryStep {\n  priority: number;\n  remainingTotal: number;\n  ticket: number;\n  selectedFranchiseId: string;\n}\n\nfunction validateWeightedConfiguration(configuration: WeightedLotteryConfiguration): void {\n  const { franchiseIds, weights } = configuration;\n  if (franchiseIds.length < 2 || franchiseIds.length > 16 || weights.length !== franchiseIds.length\n    || new Set(franchiseIds).size !== franchiseIds.length || franchiseIds.some(id => !id)\n    || weights.some(weight => !Number.isSafeInteger(weight) || weight <= 0)\n    || weights.reduce((sum, weight) => sum + weight, 0) > 4294967296) {\n    throw new Error('Weighted lotteries require 2–16 distinct franchises with positive integer weights totaling at most 2^32.');\n  }\n}\n\n/** Exact unconditional priority probabilities, calculated over all subsets of selected teams. */\nexport function calculateWeightedLotteryMarginals(configuration: WeightedLotteryConfiguration): number[][] {\n  validateWeightedConfiguration(configuration);\n  const { weights } = configuration;\n  const size = weights.length;\n  const probabilities = Array<number>(1 << size).fill(0);\n  const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0));\n  probabilities[0] = 1;\n  for (let mask = 0; mask < probabilities.length - 1; mask += 1) {\n    let priority = 0;\n    let remainingTotal = 0;\n    for (let column = 0; column < size; column += 1) {\n      if (mask & (1 << column)) priority += 1;\n      else remainingTotal += weights[column];\n    }\n    for (let column = 0; column < size; column += 1) {\n      if (mask & (1 << column)) continue;\n      const probability = probabilities[mask] * weights[column] / remainingTotal;\n      matrix[priority][column] += probability;\n      probabilities[mask | (1 << column)] += probability;\n    }\n  }\n  return matrix;\n}\n\n/** Reference replay of the database's unbiased integer tickets; this does not generate randomness. */\nexport function replayWeightedLottery(configuration: WeightedLotteryConfiguration, tickets: readonly number[]): {\n  priorityOrder: string[]; steps: WeightedLotteryStep[];\n} {\n  validateWeightedConfiguration(configuration);\n  if (tickets.length !== configuration.franchiseIds.length) throw new Error('A replay requires one ticket for every priority.');\n  const remainingWeights = [...configuration.weights];\n  const steps: WeightedLotteryStep[] = [];\n  for (const [index, ticket] of tickets.entries()) {\n    const remainingTotal = remainingWeights.reduce((sum, weight) => sum + weight, 0);\n    if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= remainingTotal) throw new Error('A ticket must be an integer in [0, remainingTotal).');\n    let cumulative = 0;\n    const column = remainingWeights.findIndex(weight => { cumulative += weight; return ticket < cumulative; });\n    steps.push({ priority: index + 1, remainingTotal, ticket, selectedFranchiseId: configuration.franchiseIds[column] });\n    remainingWeights[column] = 0;\n  }\n  return { priorityOrder: steps.map(step => step.selectedFranchiseId), steps };\n}\n\n// Generic matrix/Birkhoff utilities below are retained for simulations and are not\n// the official weighted-without-replacement lottery executed by the database.\nexport interface LotteryConfiguration {\n  franchiseIds: readonly string[];\n  /** Rows are selection priorities; columns correspond to franchiseIds. */\n  marginalMatrix: readonly (readonly number[])[];\n}\n\nexport interface LotteryComponent {\n  weight: number;\n  /** For each priority, the franchise column assigned to that priority. */\n  permutation: number[];\n}\n\nexport interface LotteryAudit {\n  algorithm: \"birkhoff-v1\";\n  franchiseIds: string[];\n  marginalMatrix: number[][];\n  components: LotteryComponent[];\n  randomDraw: number;\n  selectedComponent: number;\n}\n\nexport interface LotteryResult {\n  /** This is the order in which teams choose draft positions, not the draft positions themselves. */\n  priorityOrder: string[];\n  audit: LotteryAudit;\n}\n\nconst EPSILON = 1e-12;\n\nexport function createEightTeamLottery(input: {\n  nonPlayoffFranchiseIds: readonly string[];\n  playoffFranchiseIds: readonly string[];\n}): LotteryConfiguration {\n  if (input.nonPlayoffFranchiseIds.length !== 4 || input.playoffFranchiseIds.length !== 4) {\n    throw new Error(\"This legacy matrix example applies to four non-playoff and four playoff teams; other formats require an explicit matrix.\");\n  }\n  const franchiseIds = [...input.nonPlayoffFranchiseIds, ...input.playoffFranchiseIds];\n  if (new Set(franchiseIds).size !== 8 || franchiseIds.some((id) => !id)) throw new Error(\"Lottery franchises must be distinct.\");\n  const nonPlayoffOdds = [24, 23, 22, 21, 4, 3, 2, 1];\n  const playoffOdds = [1, 2, 3, 4, 21, 22, 23, 24];\n  return {\n    franchiseIds,\n    marginalMatrix: nonPlayoffOdds.map((odds, priority) => [\n      ...Array<number>(4).fill(odds / 100), ...Array<number>(4).fill(playoffOdds[priority] / 100),\n    ]),\n  };\n}\n\nfunction validateMatrix(matrix: readonly (readonly number[])[]): void {\n  const size = matrix.length;\n  if (size < 2 || matrix.some((row) => row.length !== size)) throw new Error(\"A lottery requires a square marginal matrix with at least two teams.\");\n  if (matrix.some((row) => row.some((value) => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error(\"Lottery probabilities must lie between zero and one.\");\n  for (let index = 0; index < size; index += 1) {\n    const rowSum = matrix[index].reduce((sum, value) => sum + value, 0);\n    const columnSum = matrix.reduce((sum, row) => sum + row[index], 0);\n    if (Math.abs(rowSum - 1) > EPSILON || Math.abs(columnSum - 1) > EPSILON) {\n      throw new Error(\"Each lottery row and column must sum to one.\");\n    }\n  }\n}\n\n/** Exact marginal preservation via a mixture of complete permutations, not sequential weighted draws. */\nexport function decomposeBirkhoff(matrix: readonly (readonly number[])[]): LotteryComponent[] {\n  validateMatrix(matrix);\n  const residual = matrix.map((row) => [...row]);\n  const size = residual.length;\n  const components: LotteryComponent[] = [];\n  let remaining = 1;\n  while (remaining > EPSILON) {\n    const columnToRow = Array<number>(size).fill(-1);\n    const matchRow = (row: number, seenColumns: boolean[]): boolean => {\n      for (let column = 0; column < size; column += 1) {\n        if (residual[row][column] <= EPSILON || seenColumns[column]) continue;\n        seenColumns[column] = true;\n        if (columnToRow[column] === -1 || matchRow(columnToRow[column], seenColumns)) {\n          columnToRow[column] = row;\n          return true;\n        }\n      }\n      return false;\n    };\n    for (let row = 0; row < size; row += 1) {\n      if (!matchRow(row, Array<boolean>(size).fill(false))) throw new Error(\"The marginal matrix cannot be decomposed at the supported precision.\");\n    }\n    const permutation = Array<number>(size).fill(-1);\n    columnToRow.forEach((row, column) => { permutation[row] = column; });\n    const weight = Math.min(...permutation.map((column, row) => residual[row][column]));\n    if (!(weight > EPSILON)) throw new Error(\"Lottery decomposition did not make progress.\");\n    components.push({ weight, permutation });\n    permutation.forEach((column, row) => { residual[row][column] = Math.max(0, residual[row][column] - weight); });\n    remaining -= weight;\n    if (components.length > size * size) throw new Error(\"Lottery decomposition exceeded its finite support bound.\");\n  }\n  if (residual.some((row) => row.some((value) => value > EPSILON * size))) throw new Error(\"Lottery decomposition left unexplained probability.\");\n  return components;\n}\n\nexport function sampleLottery(configuration: LotteryConfiguration, rng: () => number): LotteryResult {\n  const { franchiseIds, marginalMatrix } = configuration;\n  if (franchiseIds.length !== marginalMatrix.length || new Set(franchiseIds).size !== franchiseIds.length || franchiseIds.some((id) => !id)) {\n    throw new Error(\"Lottery matrix columns must correspond to distinct franchises.\");\n  }\n  const components = decomposeBirkhoff(marginalMatrix);\n  const randomDraw = rng();\n  if (!Number.isFinite(randomDraw) || randomDraw < 0 || randomDraw >= 1) throw new Error(\"The random source must return a finite number in [0, 1).\");\n  let cumulative = 0;\n  let selectedComponent = components.length - 1;\n  for (const [index, component] of components.entries()) {\n    cumulative += component.weight;\n    if (randomDraw < cumulative) { selectedComponent = index; break; }\n  }\n  return {\n    priorityOrder: components[selectedComponent].permutation.map((column) => franchiseIds[column]),\n    audit: {\n      algorithm: \"birkhoff-v1\", franchiseIds: [...franchiseIds],\n      marginalMatrix: marginalMatrix.map((row) => [...row]), components, randomDraw, selectedComponent,\n    },\n  };\n}\n\n/** Deterministic PRNG for simulations/replay. The caller controls production seed selection. */\nexport function createSeededRng(seed: string): () => number {\n  let state = 2166136261;\n  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619);\n  return () => {\n    state = (state + 0x6d2b79f5) | 0;\n    let value = Math.imul(state ^ (state >>> 15), 1 | state);\n    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);\n    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;\n  };\n}\n",
  "algorithmSourceSha256": "f0bb91900613159ef2c0d17b0bc765a15a542a647f475350a56b88e6adb226aa",
  "configuration": {
    "franchiseIds": [
      "0a36f406-2ec5-447a-8202-7f602a30b7c9",
      "5cc31eed-a450-4a8e-8380-feccd817c164",
      "f20ba68b-0d3f-46b7-82cf-5ca0b9417a4c",
      "c81be1b5-6655-459d-8c3b-ace971b0f0fa",
      "91565de8-795e-4ebf-8353-29b83bbfecc7",
      "ea426552-e14c-41e0-831f-558ed0e91691",
      "0e926a61-0f4b-40ff-8ce0-f674fb0616be",
      "6f828799-7d52-4fef-83d4-03579f52b2df"
    ],
    "weights": [
      24,
      24,
      24,
      24,
      1,
      1,
      1,
      1
    ],
    "marginalMatrix": [
      [
        0.24,
        0.24,
        0.24,
        0.24,
        0.01,
        0.01,
        0.01,
        0.01
      ],
      [
        0.2370653907496012,
        0.2370653907496012,
        0.2370653907496012,
        0.2370653907496012,
        0.012934609250398726,
        0.012934609250398726,
        0.012934609250398726,
        0.012934609250398726
      ],
      [
        0.23161079521981787,
        0.23161079521981787,
        0.23161079521981787,
        0.23161079521981787,
        0.018389204780182217,
        0.018389204780182217,
        0.018389204780182217,
        0.018389204780182217
      ],
      [
        0.2176954028164829,
        0.2176954028164829,
        0.2176954028164829,
        0.2176954028164829,
        0.032304597183516734,
        0.032304597183516734,
        0.032304597183516734,
        0.032304597183516734
      ],
      [
        0.06256365655147396,
        0.06256365655147396,
        0.06256365655147396,
        0.06256365655147396,
        0.18743634344852586,
        0.18743634344852586,
        0.18743634344852586,
        0.18743634344852586
      ],
      [
        0.010060358874183184,
        0.010060358874183184,
        0.010060358874183184,
        0.010060358874183184,
        0.23993964112581667,
        0.23993964112581667,
        0.23993964112581667,
        0.23993964112581667
      ],
      [
        0.0009603807345819734,
        0.0009603807345819734,
        0.0009603807345819734,
        0.0009603807345819734,
        0.24903961926541796,
        0.24903961926541796,
        0.24903961926541796,
        0.24903961926541796
      ],
      [
        0.00004401505385850244,
        0.00004401505385850244,
        0.00004401505385850244,
        0.00004401505385850244,
        0.24995598494614146,
        0.24995598494614146,
        0.24995598494614146,
        0.24995598494614146
      ]
    ]
  }
}$lottery_definition$::jsonb);
