import { bestLineup, values } from './ai-league-engine';
import type { AiMatchup, AiPeriodResult, AiPlayer, AiStanding, AiStats } from './ai-league-types';
import type { AiSingleTeamDay, AiSingleTeamIdentity, AiSingleTeamInput, AiSingleTeamOfficialAdjustment, AiSingleTeamReport, AiSingleTeamScenario } from './ai-single-team-types';

const KEYS: (keyof AiStats)[] = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'three', 'fgm', 'fga', 'ftm', 'fta'];
const ACTIVE = [0, 1, 2, 3, 4, 5, 6, 11, 11, 11];
const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const nextDate = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
function datesBetween(start: string, end: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return [];
  const dates: string[] = [];
  for (let date = start; date <= end && dates.length < 370; date = nextDate(date)) dates.push(date);
  return dates;
}
const add = (target: AiStats, source: AiStats) => { for (const key of KEYS) target[key] += source[key]; };
const validStats = (stats: AiStats) => stats && KEYS.every(key => Number.isFinite(stats[key]) && stats[key] >= 0) && stats.fgm <= stats.fga && stats.ftm <= stats.fta;
const sameStats = (a: AiStats, b: AiStats) => KEYS.every(key => Math.abs(a[key] - b[key]) < 1e-6);
type DailyTotals = Map<string, Map<string, AiStats>>;
type Board = { results: AiPeriodResult[]; standings: AiStanding[]; champion: string | null };

function ranges(input: Pick<AiSingleTeamInput, 'matchups'>): AiMatchup[] {
  const byPeriod = new Map<number, AiMatchup>();
  for (const matchup of input.matchups) byPeriod.set(matchup.period, matchup);
  return [...byPeriod.values()].sort((a, b) => a.start.localeCompare(b.start) || a.period - b.period);
}

function score(matchup: AiMatchup, totals: DailyTotals, adjustments: AiSingleTeamOfficialAdjustment[], controlledTeamId?: string): AiPeriodResult {
  const homeStats = zero(); const awayStats = zero();
  const dates = datesBetween(matchup.start, matchup.end);
  let complete = dates.length > 0;
  for (const date of dates) {
    const home = totals.get(date)?.get(matchup.home); const away = totals.get(date)?.get(matchup.away);
    if (!home || !away) { complete = false; continue; }
    add(homeStats, home); add(awayStats, away);
  }
  // This is an owner-period source-version residual, never a player-stat correction.
  if (complete) for (const adjustment of adjustments.filter(item => item.period === matchup.period && item.teamId !== controlledTeamId)) {
    const stats = adjustment.teamId === matchup.home ? homeStats : adjustment.teamId === matchup.away ? awayStats : null;
    if (stats) stats[adjustment.stat] += adjustment.official - adjustment.reconstructed;
  }
  const differences = ['pts', 'reb', 'ast', 'stl', 'blk', 'three'].map(key => homeStats[key as keyof AiStats] - awayStats[key as keyof AiStats]);
  differences.push(awayStats.tov - homeStats.tov);
  differences.push(homeStats.fga && awayStats.fga ? homeStats.fgm * awayStats.fga - awayStats.fgm * homeStats.fga : 0);
  differences.push(homeStats.fta && awayStats.fta ? homeStats.ftm * awayStats.fta - awayStats.ftm * homeStats.fta : 0);
  const homeWins = differences.filter(value => value > 1e-9).length;
  const awayWins = differences.filter(value => value < -1e-9).length;
  return { matchupId: matchup.id, period: matchup.period, home: matchup.home, away: matchup.away, homeStats, awayStats, homeWins, awayWins, ties: 9 - homeWins - awayWins, complete, playoff: matchup.playoff };
}

function table(results: AiPeriodResult[], order: string[]): AiStanding[] {
  const rows = order.map(teamId => ({ teamId, wins: 0, losses: 0, ties: 0, matchupWins: 0, matchupLosses: 0, matchupTies: 0, played: 0 }));
  for (const result of results.filter(item => item.complete && !item.playoff)) {
    for (const [id, wins, losses] of [[result.home, result.homeWins, result.awayWins], [result.away, result.awayWins, result.homeWins]] as const) {
      const row = rows.find(item => item.teamId === id)!;
      row.wins += wins; row.losses += losses; row.ties += result.ties; row.played++;
      if (wins > losses) row.matchupWins++; else if (wins < losses) row.matchupLosses++; else row.matchupTies++;
    }
  }
  const percentage = (row: AiStanding) => (row.wins + row.ties / 2) / Math.max(1, row.wins + row.losses + row.ties);
  return rows.sort((a, b) => percentage(b) - percentage(a) || b.matchupWins - a.matchupWins || order.indexOf(a.teamId) - order.indexOf(b.teamId));
}

export function singleTeamScoreboard(input: Pick<AiSingleTeamInput, 'matchups' | 'officialAdjustments'>, totals: DailyTotals, order: string[], controlledTeamId?: string): Board {
  const adjustments = input.officialAdjustments ?? [];
  const results = input.matchups.filter(item => !item.playoff).map(matchup => score(matchup, totals, adjustments, controlledTeamId));
  const standings = table(results, order);
  const playoff = ranges(input).filter(item => item.playoff).slice(-2);
  if (!results.length || results.some(result => !result.complete) || playoff.length !== 2) return { results, standings, champion: null };
  const seeds = standings.slice(0, 4).map(row => row.teamId);
  const winner = (result: AiPeriodResult) => result.homeWins > result.awayWins ? result.home : result.awayWins > result.homeWins ? result.away : seeds.indexOf(result.home) < seeds.indexOf(result.away) ? result.home : result.away;
  const semifinal = [
    score({ ...playoff[0], id: 'single-semifinal-1', home: seeds[0], away: seeds[3] }, totals, adjustments, controlledTeamId),
    score({ ...playoff[0], id: 'single-semifinal-2', home: seeds[1], away: seeds[2] }, totals, adjustments, controlledTeamId),
  ];
  results.push(...semifinal);
  if (semifinal.some(result => !result.complete)) return { results, standings, champion: null };
  const final = score({ ...playoff[1], id: 'single-final', home: winner(semifinal[0]), away: winner(semifinal[1]) }, totals, adjustments, controlledTeamId);
  results.push(final);
  return { results, standings, champion: final.complete ? winner(final) : null };
}

function inspectDay(day: AiSingleTeamDay, input: AiSingleTeamInput, teamIds: Set<string>, playerIds: Set<number>): string | null {
  if (!day.complete || !day.snapshotId || !Number.isFinite(Date.parse(day.startsAt))) return `Incomplete dated snapshot for ${day.date}.`;
  if (day.season !== undefined && day.season !== input.season) return `Snapshot season mismatch for ${day.date}.`;
  if (day.owners.length !== 8 || new Set(day.owners.map(owner => owner.teamId)).size !== 8 || day.owners.some(owner => !teamIds.has(owner.teamId) || !owner.complete)) return `All eight complete owner snapshots are required for ${day.date}.`;
  const stats = new Map(day.stats.map(row => [row.playerId, row.stats]));
  if (stats.size !== day.stats.length || stats.size !== playerIds.size || [...playerIds].some(id => !stats.has(id)) || day.stats.some(row => !validStats(row.stats))) return `Missing, duplicate, or invalid player statistics for ${day.date}.`;
  if (new Set(day.scheduledPlayerIds).size !== day.scheduledPlayerIds.length || day.scheduledPlayerIds.some(id => !playerIds.has(id))) return `Invalid reconstructed schedule for ${day.date}.`;
  const owned = new Set<number>();
  for (const owner of day.owners) {
    if (new Set(owner.roster).size !== owner.roster.length || owner.roster.some(id => !playerIds.has(id) || owned.has(id))) return `Conflicting or unknown actual ownership for ${day.date}.`;
    owner.roster.forEach(id => owned.add(id));
    if (new Set(owner.lineup.map(slot => slot.playerId)).size !== owner.lineup.length || owner.lineup.some(slot => !owner.roster.includes(slot.playerId) || !Number.isInteger(slot.slot) || slot.slot < 0)) return `Invalid actual lineup for ${day.date}, team ${owner.teamId}.`;
    const summed = zero();
    for (const slot of owner.lineup.filter(slot => slot.slot < 12)) add(summed, stats.get(slot.playerId)!);
    if (!validStats(owner.stats) || !sameStats(summed, owner.stats)) return `Actual lineup totals disagree for ${day.date}, team ${owner.teamId}.`;
  }
  return null;
}

function categoryValues(stats: AiStats): Record<string, number> {
  return { '0': stats.pts, '1': stats.blk, '2': stats.stl, '3': stats.ast, '6': stats.reb, '11': stats.tov, '17': stats.three, '19': stats.fga ? stats.fgm / stats.fga : 0, '20': stats.fta ? stats.ftm / stats.fta : 0 };
}

function verifyBaseline(input: AiSingleTeamInput, totals: DailyTotals, board: Board, order: string[]): string[] {
  const issues: string[] = [];
  const official = new Map(input.officialScores.map(row => [`${row.period}:${row.teamId}`, row]));
  if (official.size !== input.officialScores.length) issues.push('Official period totals contain duplicate team records.');
  for (const period of ranges(input)) for (const teamId of order) {
    const expected = official.get(`${period.period}:${teamId}`);
    if (!expected) { issues.push(`Missing official totals for period ${period.period}, team ${teamId}.`); continue; }
    const stats = zero();
    const dates = datesBetween(period.start, period.end);
    if (!dates.every(date => totals.get(date)?.has(teamId))) continue;
    for (const date of dates) add(stats, totals.get(date)!.get(teamId)!);
    for (const adjustment of (input.officialAdjustments ?? []).filter(item => item.period === period.period && item.teamId === teamId)) {
      if (stats[adjustment.stat] !== adjustment.reconstructed || expected.categories['1'] !== adjustment.official) {
        issues.push(`Official adjustment evidence does not match its exact raw and official values for period ${period.period}, team ${teamId}.`);
      } else stats[adjustment.stat] += adjustment.official - adjustment.reconstructed;
    }
    for (const [category, value] of Object.entries(categoryValues(stats))) {
      // ESPN publishes ratio categories to five decimal places; counting totals must match exactly.
      const tolerance = category === '19' || category === '20' ? 0.0000051 : 1e-9;
      if (!Number.isFinite(expected.categories[category]) || Math.abs(expected.categories[category] - value) > tolerance) issues.push(`Official category ${category} mismatch in period ${period.period}, team ${teamId}: reconstructed ${value}, official ${expected.categories[category]}.`);
    }
  }
  if (input.expectedRegularRecords) {
    if (input.expectedRegularRecords.length !== 8 || new Set(input.expectedRegularRecords.map(row => row.teamId)).size !== 8) issues.push('Expected regular-season records do not cover all eight teams.');
    if (board.results.filter(result => !result.playoff).every(result => result.complete)) for (const row of board.standings) {
      const expected = input.expectedRegularRecords.find(item => item.teamId === row.teamId);
      if (!expected || expected.wins !== row.wins || expected.losses !== row.losses || expected.ties !== row.ties) issues.push(`Reconstructed regular-season record differs from the official record for team ${row.teamId}.`);
    }
  }
  if (board.champion && input.actualChampion && board.champion !== input.actualChampion) issues.push(`Reconstructed champion ${board.champion} differs from official champion ${input.actualChampion}.`);
  return issues;
}

function simulate(input: AiSingleTeamInput, days: AiSingleTeamDay[], teamId: string, mode: AiSingleTeamScenario['mode'], order: string[], baseIssues: string[]): AiSingleTeamScenario {
  const result: AiSingleTeamScenario = {
    teamId, mode, status: 'incomplete', message: '', actualOpeningRoster: [...(days[0]?.owners.find(owner => owner.teamId === teamId)?.roster ?? [])],
    initialRoster: [], finalRoster: [], initialCuts: [], forcedReturns: 0, acquisitions: 0, acquisitionsByPeriod: {},
    results: [], standings: table([], order), champion: null, decisions: [], lineups: [], scoredDates: [], snapshotIds: [],
  };
  const issue = [...baseIssues];
  if (!days.length) { result.message = issue[0] ?? 'Opening-day snapshot is missing.'; return result; }
  // Eligibility and numerical estimates are immutable preseason inputs. Historical final injury labels are not used.
  const players = input.players.map(player => ({ ...structuredClone(player), injury: null }));
  const playerMap = new Map(players.map(player => [player.id, player]));
  const originalScores = values(players);
  const first = days[0];
  const decision = (value: Omit<AiSingleTeamScenario['decisions'][number], 'id' | 'teamId'>) => result.decisions.push({ ...value, id: `${mode}-${teamId}-${result.decisions.length + 1}`, teamId });
  let roster: number[] = [];
  if (mode === 'post_draft') roster = [...result.actualOpeningRoster];
  else {
    const draft = input.ownerDraft;
    if (draft?.length !== 104 || new Set(draft.map(pick => pick.overallPick)).size !== draft.length || new Set(draft.map(pick => pick.playerId)).size !== draft.length || draft.some(pick => !Number.isInteger(pick.overallPick) || pick.overallPick < 1 || pick.overallPick > 104 || !order.includes(pick.teamId) || !playerMap.has(pick.playerId)) || order.some(id => !draft.some(pick => pick.teamId === id))) {
      result.message = 'A complete, uniquely identified actual draft is required for the constrained redraft.'; return result;
    }
    const reserved = new Set(draft.filter(pick => pick.teamId !== teamId).map(pick => pick.playerId));
    for (const pick of draft.filter(pick => pick.teamId === teamId).sort((a, b) => a.overallPick - b.overallPick)) {
      const missing = [...ACTIVE];
      for (const slot of bestLineup(roster, playerMap, originalScores)) missing.splice(missing.indexOf(slot.slot), 1);
      const available = players.filter(player => !reserved.has(player.id) && !roster.includes(player.id)).map(player => ({ player, score: (originalScores.get(player.id) ?? 0) + (missing.some(slot => slot !== 11 && player.slots.includes(slot)) ? 5 : 0) })).sort((a, b) => b.score - a.score || a.player.id - b.player.id);
      if (!available.length) { result.message = 'The constrained draft has too few eligible players.'; return result; }
      const selected = available[0].player;
      roster.push(selected.id);
      decision({ date: input.firstDate, kind: 'draft', playerIds: [selected.id], overallPick: pick.overallPick, round: Math.floor((pick.overallPick - 1) / 8) + 1, snapshotId: first.snapshotId,
        reason: `Fresh selection at actual owned pick ${pick.overallPick}, using preseason nine-category value and unfilled positions. All seven opponents' actual draft selections and keepers are reserved by this experiment.` });
    }
  }
  result.initialRoster = [...roster];
  const cooldown = new Map<number, string>();
  while (roster.length > 13) {
    const droppedId = [...roster].sort((a, b) => (originalScores.get(a) ?? 0) - (originalScores.get(b) ?? 0) || a - b)[0];
    roster = roster.filter(id => id !== droppedId); result.initialCuts.push(droppedId); cooldown.set(droppedId, nextDate(first.date));
    decision({ date: first.date, kind: 'initial_drop', playerIds: [droppedId], droppedId, snapshotId: first.snapshotId, reason: 'Reduced the opening roster to the common 13-player, no-IR baseline by dropping the lowest preseason nine-category value.' });
  }
  const totals: DailyTotals = new Map();
  let previousOtherOwners = new Set<number>();
  for (const day of days) {
    const actual = new Map(day.owners.map(owner => [owner.teamId, structuredClone(owner.stats)]));
    const otherOwners = new Map(day.owners.filter(owner => owner.teamId !== teamId).flatMap(owner => owner.roster.map(id => [id, owner.teamId] as const)));
    // Snapshot release times are unknown: a player first observed released today becomes claimable tomorrow.
    for (const id of previousOtherOwners) if (!otherOwners.has(id)) cooldown.set(id, nextDate(day.date));
    previousOtherOwners = new Set(otherOwners.keys());
    for (const id of roster.filter(id => otherOwners.has(id))) {
      roster = roster.filter(held => held !== id); result.forcedReturns++;
      decision({ date: day.date, kind: 'forced_return', playerIds: [id], droppedId: id, claimedByTeamId: otherOwners.get(id), snapshotId: day.snapshotId, reason: 'Returned to the frozen opponent who actually owned this player on this date. Fixed opponent claims take priority; this does not consume an AI acquisition.' });
    }
    const period = ranges(input).find(period => period.start <= day.date && period.end >= day.date);
    if (!period) { issue.push(`No matchup period covers ${day.date}.`); break; }
    const scores = values(players); const scheduled = new Set(day.scheduledPlayerIds);
    const lineupValue = (ids: number[]) => bestLineup(ids, playerMap, scores, scheduled).reduce((sum, slot) => sum + (scores.get(slot.playerId) ?? 0), 0);
    const retainedValue = (ids: number[]) => 3 * ids.reduce((sum, id) => sum + (scores.get(id) ?? 0), 0);
    const baseline = lineupValue(roster) + retainedValue(roster);
    let move: { add: number; drop?: number; gain: number } | null = null;
    if ((result.acquisitionsByPeriod[period.period] ?? 0) < 4) {
      const candidates = players.filter(player => scheduled.has(player.id) && !otherOwners.has(player.id) && !roster.includes(player.id) && (!cooldown.has(player.id) || cooldown.get(player.id)! <= day.date))
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id - b.id).slice(0, 8);
      const drops: (number | undefined)[] = roster.length < 13 ? [undefined] : [...roster].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || a - b).slice(0, 5);
      for (const candidate of candidates) for (const drop of drops) {
        const proposed = [...roster.filter(id => id !== drop), candidate.id];
        const gain = lineupValue(proposed) + retainedValue(proposed) - baseline;
        if (gain > 1 && (!move || gain > move.gain + 1e-9)) move = { add: candidate.id, drop, gain };
      }
    }
    if (move) {
      roster = [...roster.filter(id => id !== move.drop), move.add];
      if (move.drop !== undefined) cooldown.set(move.drop, nextDate(day.date));
      result.acquisitions++; result.acquisitionsByPeriod[period.period] = (result.acquisitionsByPeriod[period.period] ?? 0) + 1;
      decision({ date: day.date, kind: 'add_drop', playerIds: [move.add], ...(move.drop !== undefined ? { droppedId: move.drop } : {}), snapshotId: day.snapshotId,
        reason: `Added for projected nine-category value and today's legal lineup${move.drop !== undefined ? '; dropped the lowest-value alternative in the selected improvement' : '; filled an open roster spot'}. Expected roster/lineup improvement ${move.gain.toFixed(2)}. Acquisition ${result.acquisitionsByPeriod[period.period]}/4 this period; maximum one per day.` });
    }
    const slots = bestLineup(roster, playerMap, scores, scheduled);
    result.lineups.push({ date: day.date, teamId, slots, decidedAt: new Date(Date.parse(day.startsAt) - 1).toISOString(), snapshotId: day.snapshotId });
    decision({ date: day.date, kind: 'lineup', playerIds: slots.map(slot => slot.playerId), snapshotId: day.snapshotId, reason: 'Maximum projected contribution across ten eligible active positions, decided before games using only preseason estimates and earlier completed dates.' });
    const stats = new Map(day.stats.map(row => [row.playerId, row.stats])); const selected = zero();
    for (const slot of slots) add(selected, stats.get(slot.playerId)!);
    actual.set(teamId, selected); totals.set(day.date, actual);
    result.scoredDates.push(day.date); result.snapshotIds.push(day.snapshotId);
    // Deliberately after every decision and score: today's outcomes may inform only tomorrow's policy.
    for (const player of players) if (scheduled.has(player.id)) for (const key of KEYS) player.forecast[key] = player.forecast[key] * 0.95 + stats.get(player.id)![key] * 0.05;
  }
  Object.assign(result, singleTeamScoreboard(input, totals, order, teamId));
  result.finalRoster = [...roster];
  if (!issue.length && result.scoredDates.length === datesBetween(input.firstDate, input.lastDate).length && result.champion) {
    result.status = 'complete'; result.message = 'Completed with seven opponents frozen to their verified dated rosters and lineups.';
  } else { result.champion = null; result.message = issue[0] ?? 'The full verified calendar and playoff results are required.'; }
  return result;
}

/** Pure historical experiments. Never mutates the all-AI run, source snapshots, or actual league. */
export function buildAiSingleTeamReport(input: AiSingleTeamInput, teams: AiSingleTeamIdentity[], now = new Date().toISOString()): AiSingleTeamReport {
  const expected = datesBetween(input.firstDate, input.lastDate);
  const teamIds = new Set(teams.map(team => team.id)); const playerIds = new Set(input.players.map(player => player.id));
  const ordered = [...teamIds].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const hasDraftOrder = input.draftOrder?.length === 8 && new Set(input.draftOrder).size === 8 && input.draftOrder.every(id => teamIds.has(id));
  const order = hasDraftOrder ? [...input.draftOrder!] : ordered;
  const issues: string[] = [];
  if (teams.length !== 8 || teamIds.size !== 8) issues.push('Exactly eight distinct franchises are required.');
  if (!expected.length || expected[expected.length - 1] !== input.lastDate) issues.push('A valid complete season calendar is required.');
  if (!playerIds.size || playerIds.size !== input.players.length || input.players.some(player => !Number.isInteger(player.id) || !validStats(player.forecast))) issues.push('Unique players and valid preseason estimates are required.');
  if (!Number.isFinite(Date.parse(input.forecastAsOf)) || input.forecastAsOf.slice(0, 10) >= input.firstDate) issues.push('Forecast provenance must precede the first replay date.');
  if ((input.officialAdjustments?.length ?? 0) > 1 || input.officialAdjustments?.some(item => input.season !== 2026 || item.season !== 2026 || item.period !== 18 || item.teamId !== '8' || item.stat !== 'blk' || item.reconstructed !== 20 || item.official !== 19 || !item.reason.trim() || !input.matchups.some(matchup => matchup.period === item.period))) issues.push('Only the documented 2026 period-18 team-8 block source discrepancy is authorized as an official adjustment.');
  const periodRanges = ranges(input);
  if (!input.matchups.some(item => !item.playoff) || periodRanges.filter(item => item.playoff).length !== 2 || input.matchups.some(item => !datesBetween(item.start, item.end).length || (!item.playoff && (!teamIds.has(item.home) || !teamIds.has(item.away) || item.home === item.away)))) issues.push('A regular schedule and exactly two playoff date ranges are required.');
  if (new Set(input.matchups.map(item => item.id)).size !== input.matchups.length || input.matchups.some(item => periodRanges.some(range => range.period === item.period && (range.start !== item.start || range.end !== item.end || range.playoff !== item.playoff)))) issues.push('Matchup IDs and per-period boundaries must be consistent.');
  for (const period of periodRanges.filter(item => !item.playoff)) {
    const opponents = input.matchups.filter(item => item.period === period.period).flatMap(item => [item.home, item.away]);
    if (opponents.length !== 8 || new Set(opponents).size !== 8) issues.push(`Regular period ${period.period} must schedule all eight teams exactly once.`);
  }
  if (expected.some(date => periodRanges.filter(period => period.start <= date && period.end >= date).length !== 1)) issues.push('Each calendar date must belong to exactly one matchup period.');
  const byDate = new Map(input.days.map(day => [day.date, day]));
  if (byDate.size !== input.days.length) issues.push('Dated snapshots contain duplicate dates.');
  const metadataValid = issues.length === 0;
  const days: AiSingleTeamDay[] = [];
  if (!issues.length) for (const date of expected) {
    const day = byDate.get(date);
    const error = day ? inspectDay(day, input, teamIds, playerIds) : `Missing historical snapshot for ${date}.`;
    if (error) { issues.push(error); break; }
    days.push(day!);
  }
  const totals: DailyTotals = new Map(days.map(day => [day.date, new Map(day.owners.map(owner => [owner.teamId, structuredClone(owner.stats)]))]));
  const board = metadataValid ? singleTeamScoreboard(input, totals, order) : { results: [], standings: [], champion: null };
  issues.push(...verifyBaseline(input, totals, board, order));
  const verified = issues.length === 0 && days.length === expected.length && board.champion !== null;
  const scenarios = teams.flatMap(team => (['post_draft', 'redraft'] as const).map(mode => simulate(input, days, team.id, mode, order, issues)));
  return {
    version: 1, season: input.season, label: 'One AI manager, seven frozen historical opponents', createdAt: now,
    status: verified && scenarios.length === 16 && scenarios.every(scenario => scenario.status === 'complete') ? 'complete' : 'incomplete', teams: structuredClone(teams),
    baseline: { ...board, verified, issues, champion: verified ? board.champion : null, scoredDates: days.map(day => day.date) }, scenarios,
    officialAdjustments: structuredClone(input.officialAdjustments ?? []),
    coverage: { firstDate: input.firstDate, lastDate: input.lastDate, expectedDates: expected.length, verifiedDates: days.length, officialPeriods: periodRanges.length, snapshotIds: days.map(day => day.snapshotId) },
    limitations: [...new Set([
      ...input.limitations,
      'Post-draft experiments start with the complete actual opening roster. The common 13-player, ten-active, no-IR baseline makes explicit initial cuts when needed.',
      'Constrained redrafts use each team’s actual owned pick positions, including its keeper slots as fresh picks. The other seven teams’ actual selections and keepers are reserved in advance; this known opponent allocation is an experiment constraint.',
      'Seven opponents keep their recorded daily rosters and lineups. Their claims override AI ownership; forced returns can leave vacancies when the four-acquisition period budget is exhausted.',
      'AI acquisitions are limited to four per period and one per day. Voluntary drops and newly observed opponent releases have a one-day cooldown; intraday claim order and ESPN waiver priority are not reconstructed.',
      'The controlled team’s later actual moves are ignored. AI eligibility uses the dated opponent rosters, not final-season ownership or future claims.',
      'Daily NBA availability is reconstructed from dated historical stat-record presence, including DNP rows. This is not an archived pregame injury or roster feed.',
      'All AI lineups lock before the first game. Preseason estimates update 95/5 only after each completed date; no final-season player performance informs draft choices.',
      'Regular standings and the top-four playoff bracket are recalculated. Frozen actual postseason and consolation lineups are reused even when qualification changes. Management continues through the season calendar for each controlled team.',
      'Percentages use total makes/attempts; a category is tied if either team has zero attempts. Tied playoff series advance the higher regular seed.',
      `Seeds use category winning percentage, then matchup wins, then ${hasDraftOrder ? 'the supplied actual draft order' : 'stable franchise ID because a verified original draft order was not supplied'}.`,
      'These constrained outcomes are simulations, not causal estimates of how much an AI manager would improve an owner’s result.',
      ...(input.officialAdjustments?.length ? ['Source-version discrepancy: period 18 team 8 has 20 blocks in independently verified daily NBA records but 19 in the official fantasy weekly total. A disclosed −1 owner-period adjustment preserves official frozen results. It never changes player statistics, forecasts, or the controlled team’s AI score; that comparison therefore includes this one-block difference in source versions.'] : []),
    ])],
  };
}
