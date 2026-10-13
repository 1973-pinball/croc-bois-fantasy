import type {
  AiGameDay, AiLeagueFeed, AiLeagueRun, AiLineup, AiMatchup, AiPeriodResult,
  AiPlayer, AiStanding, AiStats,
} from './ai-league-types';

const ACTIVE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 11, 11, 11];
const KEYS: (keyof AiStats)[] = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'three', 'fgm', 'fga', 'ftm', 'fta'];
const POLICY = 'Nine-category statistical manager v1';
const BASELINE_LIMITATIONS = [
  'Independent fresh 13-round snake redraft; real keepers, traded picks, trades, and rosters are unchanged.',
  'Baseline: ten active slots, three bench spots, four acquisitions per matchup period, and a one-day dropped-player cooldown.',
  'No injured-reserve slots are used. Shared free agents are processed in rotating deterministic team order, which differs from ESPN waiver priority.',
  'All players lock together at the first NBA game of the day; each daily lineup is selected once.',
  'Percentage categories are tied when either team has zero attempts; otherwise made/attempted totals are compared.',
  'Four-team playoffs use the final two playoff period ranges; tied series advance the higher regular-season seed.',
  'Regular-season seeds use category winning percentage, then matchup wins, then the reproducible draft order.',
  'Forecasts are fixed at draft, then updated only after completed games. Missing rows on a complete game day count as no statistics.',
];

const emptyStats = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const clone = <T,>(value: T): T => structuredClone(value);
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const datePart = (value: string) => value.slice(0, 10);
const nextDate = (date: string, offset = 1) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  for (let date = start; date <= end && result.length < 370; date = nextDate(date)) result.push(date);
  return result;
}
function hash(value: string): number {
  let state = 2166136261;
  for (const char of value) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return state >>> 0;
}
const unavailable = (player: AiPlayer) => /^(OUT|O|IR|INJURY_RESERVE|SUSPENSION|SUSPENDED)$/i.test(player.injury ?? '');
const addStats = (target: AiStats, source: AiStats) => {
  for (const key of KEYS) target[key] += finite(source[key]);
};

/** Volume-sensitive percentages and reversed turnovers contribute alongside all seven counting categories. */
export function values(players: AiPlayer[]): Map<number, number> {
  const total = emptyStats();
  for (const player of players) addStats(total, player.forecast);
  const fg = total.fga > 0 ? total.fgm / total.fga : 0.46;
  const ft = total.fta > 0 ? total.ftm / total.fta : 0.78;
  const vectors = players.map(({ forecast: s }) => [
    s.pts, s.reb, s.ast, s.stl, s.blk, s.three, -s.tov,
    s.fgm - fg * s.fga, s.ftm - ft * s.fta,
  ].map(finite));
  const averages = Array.from({ length: 9 }, (_, i) => vectors.reduce((sum, vector) => sum + vector[i], 0) / Math.max(1, vectors.length));
  const deviations = averages.map((average, i) => Math.sqrt(vectors.reduce((sum, vector) => sum + (vector[i] - average) ** 2, 0) / Math.max(1, vectors.length)) || 1);
  return new Map(players.map((player, p) => [player.id, Math.max(0.1, 12 + vectors[p].reduce((sum, value, i) => sum + (value - averages[i]) / deviations[i], 0))]));
}

/** Exact maximum-weight bipartite assignment; repeated UTIL slots have separate mask bits. */
export function bestLineup(roster: number[], players: Map<number, AiPlayer>, scores: Map<number, number>, scheduled?: Set<number>): AiLineup['slots'] {
  type State = { score: number; assignments: AiLineup['slots'] };
  let states: (State | undefined)[] = Array(1 << ACTIVE_SLOTS.length);
  states[0] = { score: 0, assignments: [] };
  for (const id of [...roster].sort((a, b) => a - b)) {
    const player = players.get(id);
    if (!player || (scheduled && (!scheduled.has(id) || unavailable(player)))) continue;
    const previous = states;
    states = [...previous];
    for (let mask = 0; mask < previous.length; mask++) {
      const state = previous[mask];
      if (!state) continue;
      for (let index = 0; index < ACTIVE_SLOTS.length; index++) {
        if ((mask & (1 << index)) || !player.slots.includes(ACTIVE_SLOTS[index])) continue;
        const next = mask | (1 << index);
        const score = state.score + (scores.get(id) ?? 0);
        if (!states[next] || score > states[next]!.score + 1e-9) {
          states[next] = { score, assignments: [...state.assignments, { slot: ACTIVE_SLOTS[index], playerId: id }] };
        }
      }
    }
  }
  let best = states[0]!;
  for (const state of states) if (state && state.score > best.score + 1e-9) best = state;
  return best.assignments;
}

function draft(run: AiLeagueRun, date: string): void {
  const scores = values(run.players);
  const players = new Map(run.players.map(player => [player.id, player]));
  const available = new Set(run.players.map(player => player.id));
  for (let round = 0; round < 13; round++) {
    const order = round % 2 ? [...run.draftOrder].reverse() : run.draftOrder;
    for (const teamId of order) {
      const team = run.teams.find(candidate => candidate.id === teamId)!;
      const occupied = bestLineup(team.roster, players, scores);
      const missing = [...ACTIVE_SLOTS];
      for (const assignment of occupied) missing.splice(missing.indexOf(assignment.slot), 1);
      const ranked = run.players.filter(player => available.has(player.id)).map(player => ({
        player,
        score: (scores.get(player.id) ?? 0) + (missing.some(slot => slot !== 11 && player.slots.includes(slot)) ? 5 : 0),
      })).sort((a, b) => b.score - a.score || a.player.id - b.player.id);
      const selected = ranked[0].player;
      team.roster.push(selected.id);
      available.delete(selected.id);
      run.decisions.push({
        id: `draft-${round + 1}-${teamId}`, date, teamId, kind: 'draft', playerIds: [selected.id],
        reason: `Round ${round + 1}: selected ${selected.name} using pre-draft nine-category value and unfilled starting positions. Snake pick ${run.decisions.length + 1}.`,
      });
    }
  }
}

function resultFor(matchup: AiMatchup): AiPeriodResult {
  return { matchupId: matchup.id, period: matchup.period, home: matchup.home, away: matchup.away, homeStats: emptyStats(), awayStats: emptyStats(), homeWins: 0, awayWins: 0, ties: 9, complete: false, playoff: matchup.playoff };
}

function scoreCategories(result: AiPeriodResult): void {
  const home = result.homeStats;
  const away = result.awayStats;
  const comparisons: number[] = ['pts', 'reb', 'ast', 'stl', 'blk', 'three'].map(key => home[key as keyof AiStats] - away[key as keyof AiStats]);
  comparisons.push(away.tov - home.tov);
  // Cross multiplication preserves exact ratio ties and avoids averaging daily percentages.
  comparisons.push(home.fga > 0 && away.fga > 0 ? home.fgm * away.fga - away.fgm * home.fga : 0);
  comparisons.push(home.fta > 0 && away.fta > 0 ? home.ftm * away.fta - away.ftm * home.fta : 0);
  result.homeWins = comparisons.filter(value => value > 1e-9).length;
  result.awayWins = comparisons.filter(value => value < -1e-9).length;
  result.ties = 9 - result.homeWins - result.awayWins;
}

function standings(run: AiLeagueRun): AiStanding[] {
  const table: AiStanding[] = run.teams.map(team => ({ teamId: team.id, wins: 0, losses: 0, ties: 0, matchupWins: 0, matchupLosses: 0, matchupTies: 0, played: 0 }));
  for (const result of run.results.filter(item => item.complete && !item.playoff)) {
    for (const [teamId, wins, losses] of [[result.home, result.homeWins, result.awayWins], [result.away, result.awayWins, result.homeWins]] as const) {
      const row = table.find(candidate => candidate.teamId === teamId)!;
      row.wins += wins;
      row.losses += losses;
      row.ties += result.ties;
      row.played++;
      if (wins > losses) row.matchupWins++;
      else if (wins < losses) row.matchupLosses++;
      else row.matchupTies++;
    }
  }
  const percentage = (row: AiStanding) => (row.wins + row.ties / 2) / Math.max(1, row.wins + row.losses + row.ties);
  return table.sort((a, b) => percentage(b) - percentage(a) || b.matchupWins - a.matchupWins || run.draftOrder.indexOf(a.teamId) - run.draftOrder.indexOf(b.teamId));
}

function playoffRanges(feed: AiLeagueFeed): AiMatchup[] {
  const periods = new Map<number, AiMatchup>();
  for (const matchup of feed.matchups.filter(item => item.playoff)) periods.set(matchup.period, matchup);
  return [...periods.values()].sort((a, b) => a.start.localeCompare(b.start) || a.period - b.period).slice(-2);
}

function seriesWinner(run: AiLeagueRun, result: AiPeriodResult): string {
  if (result.homeWins > result.awayWins) return result.home;
  if (result.awayWins > result.homeWins) return result.away;
  return run.standings.findIndex(row => row.teamId === result.home) < run.standings.findIndex(row => row.teamId === result.away) ? result.home : result.away;
}

function seedPlayoffs(run: AiLeagueRun, feed: AiLeagueFeed): void {
  const regular = run.matchups.filter(matchup => !matchup.playoff);
  if (!regular.length || regular.some(matchup => !run.results.find(result => result.matchupId === matchup.id)?.complete)) return;
  const ranges = playoffRanges(feed);
  if (ranges.length !== 2) return;
  const [semifinal, final] = ranges;
  const add = (matchup: AiMatchup) => {
    if (run.matchups.some(item => item.id === matchup.id)) return;
    run.matchups.push(matchup);
    run.results.push(resultFor(matchup));
  };
  const seeds = run.standings.slice(0, 4).map(row => row.teamId);
  add({ ...semifinal, id: 'ai-semifinal-1', home: seeds[0], away: seeds[3] });
  add({ ...semifinal, id: 'ai-semifinal-2', home: seeds[1], away: seeds[2] });
  const semis = ['ai-semifinal-1', 'ai-semifinal-2'].map(id => run.results.find(result => result.matchupId === id)!);
  if (semis.every(result => result.complete)) {
    add({ ...final, id: 'ai-final', home: seriesWinner(run, semis[0]), away: seriesWinner(run, semis[1]) });
  }
  const championship = run.results.find(result => result.matchupId === 'ai-final');
  if (championship?.complete) run.champion = seriesWinner(run, championship);
}

function refreshResults(run: AiLeagueRun, feed: AiLeagueFeed): void {
  const scored = new Set(run.scoredDates);
  for (const result of run.results) {
    scoreCategories(result);
    const matchup = run.matchups.find(item => item.id === result.matchupId)!;
    result.complete = dateRange(matchup.start, matchup.end).every(date => scored.has(date));
  }
  run.standings = standings(run);
  seedPlayoffs(run, feed);
}

function makeDecisions(run: AiLeagueRun, feed: AiLeagueFeed, day: AiGameDay, now: string): void {
  const scheduled = new Set(day.playerIds);
  const players = new Map(run.players.map(player => [player.id, player]));
  // Current injury information may be used only for today's live decisions.
  if (run.mode === 'live' && day.date === feed.currentDate && Date.parse(feed.capturedAt) <= Date.parse(now)) {
    for (const fresh of feed.players) {
      const saved = players.get(fresh.id);
      if (saved) saved.injury = fresh.injury;
      else if (fresh.slots.some(slot => ACTIVE_SLOTS.includes(slot))) {
        const added = clone(fresh);
        run.players.push(added);
        players.set(added.id, added);
      }
    }
  }
  const scores = values(run.players);
  const active = run.matchups.filter(matchup => matchup.start <= day.date && matchup.end >= day.date);
  const teamIds = new Set(active.flatMap(matchup => [matchup.home, matchup.away]));
  const offset = Math.floor(Date.parse(`${day.date}T12:00:00Z`) / 86_400_000) % run.draftOrder.length;
  const order = [...run.draftOrder.slice(offset), ...run.draftOrder.slice(0, offset)];
  for (const teamId of order.filter(id => teamIds.has(id))) {
    if (run.lineups.some(lineup => lineup.date === day.date && lineup.teamId === teamId)) continue;
    const team = run.teams.find(candidate => candidate.id === teamId)!;
    const matchup = active.find(candidate => candidate.home === teamId || candidate.away === teamId)!;
    const key = `${matchup.period}:${teamId}`;
    const owned = new Set(run.teams.flatMap(candidate => candidate.roster));
    const lineupValue = (roster: number[]) => bestLineup(roster, players, scores, scheduled).reduce((sum, slot) => sum + (scores.get(slot.playerId) ?? 0), 0);
    const retainedValue = (roster: number[]) => roster.reduce((sum, id) => sum + (scores.get(id) ?? 0), 0) * 3;
    const baseline = lineupValue(team.roster) + retainedValue(team.roster);
    let move: { add: AiPlayer; drop: number; gain: number } | null = null;
    if ((run.acquisitions[key] ?? 0) < 4 && day.playerIds.length) {
      const candidates = run.players.filter(player => !owned.has(player.id) && scheduled.has(player.id) && !unavailable(player) && (!run.waiverAvailable[player.id] || run.waiverAvailable[player.id] <= day.date))
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id - b.id).slice(0, 8);
      // Keep valuable core players; evaluate the five weakest reserves against shared available players.
      const droppable = [...team.roster].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || a - b).slice(0, 5);
      for (const add of candidates) for (const drop of droppable) {
        const proposed = team.roster.map(id => id === drop ? add.id : id);
        const gain = lineupValue(proposed) + retainedValue(proposed) - baseline;
        if (gain > 1 && (!move || gain > move.gain + 1e-9)) move = { add, drop, gain };
      }
    }
    if (move) {
      team.roster = team.roster.map(id => id === move.drop ? move.add.id : id);
      run.waiverAvailable[move.drop] = nextDate(day.date);
      run.acquisitions[key] = (run.acquisitions[key] ?? 0) + 1;
      run.decisions.push({
        id: `move-${day.date}-${teamId}`, date: day.date, teamId, kind: 'add_drop', playerIds: [move.add.id], droppedId: move.drop,
        reason: `Added ${move.add.name} for projected nine-category contribution and today's legal lineup; dropped ${players.get(move.drop)?.name}. Expected roster/lineup improvement ${move.gain.toFixed(2)}; acquisition ${run.acquisitions[key]}/4 this period.`,
      });
    }
    const slots = bestLineup(team.roster, players, scores, scheduled);
    const decidedAt = run.mode === 'replay' ? new Date(Date.parse(day.startsAt) - 1).toISOString() : now;
    run.lineups.push({ date: day.date, teamId, slots, decidedAt });
    run.decisions.push({
      id: `lineup-${day.date}-${teamId}`, date: day.date, teamId, kind: 'lineup', playerIds: slots.map(slot => slot.playerId),
      reason: `Assigned ${slots.length} scheduled, available players to eligible slots by maximum expected nine-category contribution using information available before today's lock.`,
    });
  }
}

function scoreDay(run: AiLeagueRun, day: AiGameDay): void {
  const stats = new Map(day.stats.map(row => [row.playerId, row.stats]));
  for (const matchup of run.matchups.filter(item => item.start <= day.date && item.end >= day.date)) {
    const result = run.results.find(item => item.matchupId === matchup.id)!;
    for (const [teamId, target] of [[matchup.home, result.homeStats], [matchup.away, result.awayStats]] as const) {
      const lineup = run.lineups.find(item => item.date === day.date && item.teamId === teamId);
      for (const slot of lineup?.slots ?? []) {
        const actual = stats.get(slot.playerId);
        if (actual) addStats(target, actual);
      }
    }
  }
  // Learning happens after scoring/decisions, including free agents, and never consults later days.
  for (const player of run.players) {
    const actual = stats.get(player.id);
    if (actual) for (const key of KEYS) player.forecast[key] = finite(player.forecast[key]) * 0.95 + finite(actual[key]) * 0.05;
  }
  run.scoredDates.push(day.date);
  run.dataThrough = day.date;
}

function fail(run: AiLeagueRun, message: string): AiLeagueRun {
  run.status = 'needs_data';
  run.message = message;
  return run;
}

export function createAiLeagueRun(feed: AiLeagueFeed, teams: { id: string; name: string; shortName: string; color: string }[], now = feed.capturedAt): AiLeagueRun {
  const mode = feed.lastDate && feed.lastDate < feed.currentDate ? 'replay' : 'live';
  const run: AiLeagueRun = {
    version: 1, season: feed.season, label: `${feed.season - 1}–${String(feed.season).slice(-2)} AI league`, mode, policy: POLICY,
    status: 'preseason', message: 'Waiting for the season schedule.', createdAt: now, updatedAt: now, dataThrough: null,
    calendarEnd: feed.lastDate ?? undefined,
    draftOrder: teams.map(team => team.id).sort((a, b) => hash(`${feed.season}:${a}`) - hash(`${feed.season}:${b}`) || a.localeCompare(b)),
    players: clone([...new Map(feed.players.map(player => [player.id, player])).values()]),
    teams: teams.map(team => ({ ...team, roster: [] })), matchups: clone(feed.matchups.filter(matchup => !matchup.playoff)),
    decisions: [], lineups: [], results: [], standings: [], scoredDates: [], missedDates: [], waiverAvailable: {}, acquisitions: {}, champion: null,
    forecastAsOf: feed.forecastAsOf,
    limitations: [...new Set([...BASELINE_LIMITATIONS, `Initial forecast cutoff: ${feed.forecastAsOf ?? 'unverified'}.`, ...feed.limitations])],
  };
  run.results = run.matchups.map(resultFor);
  run.standings = standings(run);
  if (teams.length !== 8 || new Set(teams.map(team => team.id)).size !== 8) return fail(run, 'Eight distinct franchise identities are required before the simulated draft.');
  if (run.players.length < 104) return fail(run, 'At least 104 distinct eligible players with pre-season estimates are required for the 13-round draft.');
  if (!feed.forecastAsOf || !Number.isFinite(Date.parse(feed.forecastAsOf)) || Date.parse(feed.forecastAsOf) > Date.parse(now) || (feed.firstDate && datePart(feed.forecastAsOf) >= feed.firstDate)) {
    return fail(run, 'Pre-season forecast provenance is missing or dated after the draft cutoff. The engine will not draft using future season outcomes.');
  }
  if (mode === 'replay') for (const player of run.players) player.injury = null;
  run.initialPlayers = clone(run.players);
  draft(run, mode === 'replay' && feed.firstDate ? nextDate(feed.firstDate, -1) : feed.currentDate);
  return advanceAiLeagueRun(run, feed, now);
}

export function advanceAiLeagueRun(input: AiLeagueRun, feed: AiLeagueFeed, now = feed.capturedAt): AiLeagueRun {
  const run = clone(input);
  run.updatedAt = now;
  run.calendarEnd = feed.lastDate ?? run.calendarEnd;
  run.limitations = [...new Set([...run.limitations, ...feed.limitations])];
  if (run.season !== feed.season) return fail(run, 'Feed season does not match this saved simulation.');
  if (run.teams.some(team => team.roster.length !== 13) || run.teams.length !== 8) return fail(run, 'The initial draft is incomplete; a verified pre-season feed is required to create this experiment.');
  for (const matchup of feed.matchups.filter(item => !item.playoff)) {
    if (!run.matchups.some(saved => saved.id === matchup.id)) {
      run.matchups.push(clone(matchup));
      run.results.push(resultFor(matchup));
    }
  }
  if (!feed.firstDate || !feed.lastDate || !run.matchups.length) return fail(run, 'The real regular-season and playoff date ranges are not available yet.');
  const nowMs = Date.parse(now);
  const errors = new Set<string>();
  const missingDates = new Set<string>();
  for (const date of run.missedDates ?? []) errors.add(`Missed live lineup lock on ${date}; no decisions or scores were backfilled.`);
  const days = [...new Map(feed.days.map(day => [day.date, day])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const daysByDate = new Map(days.map(day => [day.date, day]));
  for (const date of dateRange(feed.firstDate, feed.currentDate < feed.lastDate ? feed.currentDate : feed.lastDate)) {
    if (!daysByDate.has(date) && !run.scoredDates.includes(date) && !run.missedDates?.includes(date)) missingDates.add(`Missing game-day data beginning ${date}.`);
  }
  refreshResults(run, feed);
  for (const date of dateRange(feed.firstDate, feed.currentDate < feed.lastDate ? feed.currentDate : feed.lastDate)) {
    if (run.scoredDates.includes(date)) continue;
    const day = daysByDate.get(date);
    if (!day) {
      if (run.mode === 'replay') break;
      continue;
    }
    if (!Number.isFinite(Date.parse(day.startsAt))) {
      errors.add(`Missing lock time for ${day.date}.`);
      if (run.mode === 'replay') break;
      continue;
    }
    const matchups = run.matchups.filter(matchup => matchup.start <= day.date && matchup.end >= day.date);
    const intendedPlayoffs = feed.matchups.some(matchup => matchup.playoff && matchup.start <= day.date && matchup.end >= day.date);
    if (intendedPlayoffs && !matchups.length) {
      errors.add(`Playoff participants cannot be determined for ${day.date} until earlier periods are fully scored.`);
      if (run.mode === 'replay') break;
      continue;
    }
    const activeIds = new Set(matchups.flatMap(matchup => [matchup.home, matchup.away]));
    const hasLineups = [...activeIds].every(teamId => run.lineups.some(lineup => lineup.date === day.date && lineup.teamId === teamId));
    const lockPassed = nowMs >= Date.parse(day.startsAt);
    if (!hasLineups && day.playerIds.length && run.mode === 'live' && lockPassed) {
      errors.add(`Missed live lineup lock on ${day.date}; no decisions or scores were backfilled.`);
      run.missedDates = [...new Set([...(run.missedDates ?? []), day.date])].sort();
      continue;
    }
    if (!hasLineups && (run.mode === 'replay' || !lockPassed)) makeDecisions(run, feed, day, now);
    if (day.complete && (run.mode === 'replay' || lockPassed || !day.playerIds.length)) {
      scoreDay(run, day);
      refreshResults(run, feed);
    } else if (day.date < feed.currentDate) {
      errors.add(`Incomplete game statistics for ${day.date}.`);
      // Replays may never learn from a later game before an earlier pending decision.
      if (run.mode === 'replay') break;
    }
  }
  run.scoredDates.sort();
  run.dataThrough = run.scoredDates.at(-1) ?? null;
  // Surface the day that actually blocked execution before ordinary unfetched future batches.
  const problems = [...errors, ...missingDates];
  if (problems.length) return fail(run, problems.slice(0, 3).join(' ') + (problems.length > 3 ? ` ${problems.length - 3} more dates need data.` : ''));
  if (run.champion) { run.status = 'complete'; run.message = 'The simulated championship is complete. All results follow the saved decision policy and starting forecasts.'; }
  else if (feed.currentDate < feed.firstDate) { run.status = 'preseason'; run.message = 'All eight teams are drafted. Daily management begins before the first scheduled game.'; }
  else if (feed.currentDate > feed.lastDate) return fail(run, 'The season has ended, but complete regular-season results and two playoff rounds are required before naming a champion.');
  else { run.status = 'active'; run.message = 'The automated managers are running. Standings include completed periods only; current scores remain provisional.'; }
  return run;
}
