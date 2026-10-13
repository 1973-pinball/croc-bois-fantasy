import { bestLineup, values } from './ai-league-engine';
import { singleTeamScoreboard } from './ai-single-team-engine';
import { easternDate, nextDate } from './ai-league-refresh';
import type { AiStats } from './ai-league-types';
import type { AiSingleTeamIdentity } from './ai-single-team-types';
import type { AiLiveSingleFeed, AiLiveSingleScenario, AiLiveSingleState } from './ai-live-single-types';

const KEYS: (keyof AiStats)[] = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'three', 'fgm', 'fga', 'ftm', 'fta'];
const ACTIVE = [0, 1, 2, 3, 4, 5, 6, 11, 11, 11];
const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const add = (a: AiStats, b: AiStats) => { for (const key of KEYS) a[key] += b[key]; };
const categories = (s: AiStats): Record<string, number> => ({ '0': s.pts, '1': s.blk, '2': s.stl, '3': s.ast, '6': s.reb, '11': s.tov, '17': s.three, '19': s.fga ? s.fgm / s.fga : 0, '20': s.fta ? s.ftm / s.fta : 0 });
const dates = (first: string, last: string) => { const result: string[] = []; for (let date = first; date <= last && result.length < 370; date = nextDate(date)) result.push(date); return result; };
const LIMITATIONS = [
  'Sixteen separate prospective experiments: one franchise is automated in each, while the other seven keep their actual dated lineups. Official ownership and the whole-league AI run are unchanged.',
  'The completed public app draft board, including revealed keeper slots and traded picks, is the draft authority. Nothing is redrafted until all 104 real selections are known. The one-team redraft reserves the seven owners’ real selections as an explicit experiment constraint.',
  'Post-draft teams start from their actual draft roster. AI management begins on the first NBA scoring date. Offseason owner changes to that controlled franchise are not copied into its AI roster.',
  'Ten active positions, thirteen roster spots, no IR, at most one acquisition per day and four per matchup period. Drops and newly observed owner releases have a one-day cooldown.',
  'Daily decisions are saved before the first NBA tipoff using captured owner rosters, current eligibility/injuries, and forecasts learned only from already completed dates. All players lock together. A missed lock stays a gap; no historical decisions are invented.',
  'Other owners’ claims take priority at the next AI decision boundary. Intraday owner moves after that boundary cannot rewrite the saved AI lineup; actual opponents still receive their observed daily scoring.',
  'Owner daily scoring is reconstructed from dated ESPN lineup slots and verified NBA box scores. Completed periods are checked against ESPN category totals; discrepancies block championship certification rather than silently changing player statistics.',
  'Standings use completed regular periods; the top four are reseeded into the final two playoff ranges. Ties use category percentage, matchup wins, then the verified original draft order. A tied playoff series advances the higher seed.',
  'The daily scheduled source refresh runs at 10:15 UTC. It captures the next decision early that morning, not immediately before tipoff; later injuries or lineup announcements cannot change that locked decision.',
];

export function createLiveSingles(feed: Pick<AiLiveSingleFeed, 'firstDate' | 'lastDate' | 'matchups'>, teams: AiSingleTeamIdentity[], now: string): AiLiveSingleState {
  return { version: 1, season: 2027, status: 'awaiting_draft', message: 'Waiting for the complete real 2026 draft. Both one-team variations will start from verified selections.', createdAt: now, updatedAt: now, error: null,
    firstDate: feed.firstDate, lastDate: feed.lastDate, forecastAsOf: null, teams: structuredClone(teams), draftOrder: [], matchups: structuredClone(feed.matchups), ownerDraft: null, draftCapturedAt: null,
    players: [], initialPlayers: [], scenarios: [], locks: [], previousOwners: [], ownerTotals: [], scoredDates: [], missedDates: [], verifiedPeriods: [], baselineIssues: [], baseline: { standings: [], results: [] }, limitations: [...LIMITATIONS] };
}

function initialize(state: AiLiveSingleState, feed: AiLiveSingleFeed, now: string) {
  const draft = feed.ownerDraft;
  if (!draft) return;
  const known = new Set(feed.players.map(player => player.id));
  if (draft.length !== 104 || new Set(draft.map(pick => pick.playerId)).size !== 104 || new Set(draft.map(pick => pick.overallPick)).size !== 104
    || draft.some(pick => !known.has(pick.playerId) || pick.overallPick < 1 || pick.overallPick > 104 || !state.teams.some(team => team.id === pick.teamId))
    || feed.draftOrder.length !== 8 || new Set(feed.draftOrder).size !== 8 || feed.draftOrder.some(id => !state.teams.some(team => team.id === id))) throw new Error('The completed real draft or its order is incomplete.');
  if (easternDate(new Date(now)) > state.firstDate) { state.status = 'needs_data'; state.message = 'The first NBA scoring date passed before the real draft and starting forecasts were captured. Prospective one-team results cannot be reconstructed.'; return; }
  if (easternDate(new Date(now)) === state.firstDate) {
    const opening = feed.days.find(day => day.game.date === state.firstDate)?.game;
    if (!opening || Date.parse(now) >= Date.parse(opening.startsAt) - 30_000) { state.status = 'needs_data'; state.message = 'Opening tipoff was not verified in time to save the experiment. No one-team draft or starting roster has been reconstructed.'; return; }
  }
  state.ownerDraft = structuredClone(draft); state.draftCapturedAt = now; state.forecastAsOf = feed.forecastAsOf ?? feed.capturedAt;
  state.players = structuredClone(feed.players); state.initialPlayers = structuredClone(feed.players); state.draftOrder = [...feed.draftOrder];
  const scores = values(state.players), map = new Map(state.players.map(player => [player.id, player]));
  state.scenarios = state.teams.flatMap(team => (['post_draft', 'redraft'] as const).map(mode => {
    const original = draft.filter(pick => pick.teamId === team.id).sort((a, b) => a.overallPick - b.overallPick);
    const scenario: AiLiveSingleScenario = { teamId: team.id, mode, status: 'preseason', message: 'Waiting for the first NBA scoring date.', actualOpeningRoster: original.map(pick => pick.playerId), initialRoster: [], finalRoster: [], initialCuts: [], forcedReturns: 0, acquisitions: 0, acquisitionsByPeriod: {}, results: [], standings: [], champion: null, decisions: [], lineups: [], scoredDates: [], snapshotIds: [], cooldown: {}, totals: [] };
    if (mode === 'post_draft') scenario.initialRoster = [...scenario.actualOpeningRoster];
    else {
      const reserved = new Set(draft.filter(pick => pick.teamId !== team.id).map(pick => pick.playerId));
      for (const pick of original) {
        const missing = [...ACTIVE]; for (const slot of bestLineup(scenario.initialRoster, map, scores)) missing.splice(missing.indexOf(slot.slot), 1);
        const eligible = state.players.filter(player => !reserved.has(player.id) && !scenario.initialRoster.includes(player.id)).map(player => ({ player, value: (scores.get(player.id) ?? 0) + (missing.some(slot => slot !== 11 && player.slots.includes(slot)) ? 5 : 0) })).sort((a, b) => b.value - a.value || a.player.id - b.player.id);
        if (!eligible.length) throw new Error('The constrained draft pool is exhausted.');
        const id = eligible[0].player.id; scenario.initialRoster.push(id);
        scenario.decisions.push({ id: `${mode}-${team.id}-draft-${pick.overallPick}`, date: easternDate(new Date(now)), teamId: team.id, kind: 'draft', playerIds: [id], overallPick: pick.overallPick, round: Math.floor((pick.overallPick - 1) / 8) + 1, snapshotId: `app-draft-${now}`, reason: 'Selected after the complete real draft was published, using the forecasts captured now. Other owners’ selections are reserved; this pick is a separate simulation.' });
      }
    }
    scenario.finalRoster = [...scenario.initialRoster];
    while (scenario.finalRoster.length > 13) {
      const id = [...scenario.finalRoster].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || a - b)[0];
      scenario.finalRoster = scenario.finalRoster.filter(player => player !== id); scenario.initialCuts.push(id);
      scenario.decisions.push({ id: `${mode}-${team.id}-cut-${id}`, date: easternDate(new Date(now)), teamId: team.id, kind: 'initial_drop', playerIds: [id], droppedId: id, snapshotId: `app-draft-${now}`, reason: 'Kept the thirteen highest-value players under the common no-IR roster limit.' });
    }
    return scenario;
  }));
  state.status = 'preseason'; state.message = 'Real draft verified. Sixteen independent one-team experiments are ready for opening day.';
}

/** Pure incremental state machine. A past game day can only settle a previously saved decision. */
export function advanceLiveSingles(previous: AiLiveSingleState, feed: AiLiveSingleFeed, now: string): AiLiveSingleState {
  const state = structuredClone(previous), timestamp = Date.parse(now), today = easternDate(new Date(now));
  if (!Number.isFinite(timestamp) || Date.parse(feed.capturedAt) > timestamp || state.season !== 2027 || state.firstDate !== feed.firstDate || state.lastDate !== feed.lastDate) throw new Error('Live input identity or time is invalid.');
  state.updatedAt = now; state.error = null;
  if (!state.ownerDraft) initialize(state, feed, now);
  if (!state.ownerDraft) return state;
  // New forecasts never overwrite the frozen baseline or learned estimates.
  const latest = new Map(feed.players.map(player => [player.id, player]));
  for (const player of state.players) { const current = latest.get(player.id); if (current) { player.slots = [...current.slots]; player.injury = current.injury; player.nbaTeamId = current.nbaTeamId; } }
  const known = new Set(state.players.map(player => player.id));
  for (const player of feed.players) if (!known.has(player.id)) state.players.push(structuredClone(player));
  const players = new Map(state.players.map(player => [player.id, player]));
  for (const { game, owners } of [...feed.days].sort((a, b) => a.game.date.localeCompare(b.game.date))) {
    const date = game.date;
    if (date < state.firstDate || date > state.lastDate || date > today || state.scoredDates.includes(date) || state.missedDates.includes(date)) continue;
    if (owners.date !== date || Date.parse(owners.capturedAt) > timestamp || !Number.isFinite(Date.parse(game.startsAt))) throw new Error('Dated owner source is invalid.');
    const period = state.matchups.find(matchup => matchup.start <= date && date <= matchup.end);
    if (!period) throw new Error('The NBA date has no fantasy matchup period.');
    let locked = state.locks.some(lock => lock.date === date);
    if (!locked) {
      const empty = game.complete && game.playerIds.length === 0 && game.stats.length === 0;
      if (!empty && (date !== today || timestamp >= Date.parse(game.startsAt) - 30_000 || Date.parse(owners.capturedAt) >= Date.parse(game.startsAt))) { state.missedDates.push(date); continue; }
      const scores = values(state.players), scheduled = new Set(game.playerIds);
      for (const scenario of state.scenarios) {
        const otherOwners = new Map(owners.owners.filter(owner => owner.teamId !== scenario.teamId).flatMap(owner => owner.roster.map(id => [id, owner.teamId] as const)));
        for (const owner of state.previousOwners.filter(owner => owner.teamId !== scenario.teamId)) for (const id of owner.roster) if (!otherOwners.has(id)) scenario.cooldown[id] = nextDate(date);
        const decision = (item: Omit<AiLiveSingleScenario['decisions'][number], 'id' | 'date' | 'teamId' | 'snapshotId'>) => scenario.decisions.push({ ...item, id: `${scenario.mode}-${scenario.teamId}-${date}-${scenario.decisions.length}`, date, teamId: scenario.teamId, snapshotId: owners.snapshotId });
        for (const id of scenario.finalRoster.filter(id => otherOwners.has(id))) { scenario.finalRoster = scenario.finalRoster.filter(player => player !== id); scenario.forcedReturns++; decision({ kind: 'forced_return', playerIds: [id], droppedId: id, claimedByTeamId: otherOwners.get(id), reason: 'The captured owner roster takes priority at this daily decision boundary.' }); }
        const value = (roster: number[]) => bestLineup(roster, players, scores, scheduled).reduce((sum, slot) => sum + (scores.get(slot.playerId) ?? 0), 0) + 3 * roster.reduce((sum, id) => sum + (scores.get(id) ?? 0), 0);
        const baseline = value(scenario.finalRoster); let move: { add: number; drop?: number; gain: number } | null = null;
        if ((scenario.acquisitionsByPeriod[period.period] ?? 0) < 4 && !empty) {
          const candidates = state.players.filter(player => scheduled.has(player.id) && !otherOwners.has(player.id) && !scenario.finalRoster.includes(player.id) && (!scenario.cooldown[player.id] || scenario.cooldown[player.id] <= date)).sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.id - b.id).slice(0, 8);
          const drops: (number | undefined)[] = scenario.finalRoster.length < 13 ? [undefined] : [...scenario.finalRoster].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0) || a - b).slice(0, 5);
          for (const candidate of candidates) for (const drop of drops) { const gain = value([...scenario.finalRoster.filter(id => id !== drop), candidate.id]) - baseline; if (gain > 1 && (!move || gain > move.gain + 1e-9)) move = { add: candidate.id, drop, gain }; }
        }
        if (move) { scenario.finalRoster = [...scenario.finalRoster.filter(id => id !== move.drop), move.add]; if (move.drop !== undefined) scenario.cooldown[move.drop] = nextDate(date); scenario.acquisitions++; scenario.acquisitionsByPeriod[period.period] = (scenario.acquisitionsByPeriod[period.period] ?? 0) + 1; decision({ kind: 'add_drop', playerIds: [move.add], ...(move.drop !== undefined ? { droppedId: move.drop } : {}), reason: `Projected nine-category roster/lineup improvement ${move.gain.toFixed(2)}; acquisition ${scenario.acquisitionsByPeriod[period.period]}/4 this matchup.` }); }
        const slots = bestLineup(scenario.finalRoster, players, scores, scheduled);
        scenario.lineups.push({ date, teamId: scenario.teamId, decidedAt: now, slots, snapshotId: owners.snapshotId });
        decision({ kind: 'lineup', playerIds: slots.map(slot => slot.playerId), reason: empty ? 'Verified empty NBA calendar date; no game-day decision was needed.' : 'Saved before first tipoff using only the captured roster, schedule and available forecasts.' });
      }
      state.locks.push({ ...structuredClone(owners), startsAt: game.startsAt, empty }); state.previousOwners = structuredClone(owners.owners); locked = true;
    }
    if (!locked || !game.complete || date >= today) continue;
    const statistics = new Map(game.stats.map(row => [row.playerId, row.stats]));
    const ownerTotals = owners.owners.map(owner => { const total = zero(); for (const slot of owner.lineup.filter(slot => slot.slot < 12)) add(total, statistics.get(slot.playerId) ?? zero()); return { teamId: owner.teamId, stats: total }; });
    state.ownerTotals.push({ date, snapshotId: owners.snapshotId, teams: ownerTotals });
    for (const scenario of state.scenarios) { const total = zero(); for (const slot of scenario.lineups.find(lineup => lineup.date === date)!.slots) add(total, statistics.get(slot.playerId) ?? zero()); scenario.totals.push({ date, stats: total }); scenario.scoredDates.push(date); scenario.snapshotIds.push(owners.snapshotId); }
    state.scoredDates.push(date);
    for (const player of state.players) if (game.playerIds.includes(player.id)) for (const key of KEYS) player.forecast[key] = player.forecast[key] * .95 + (statistics.get(player.id) ?? zero())[key] * .05;
  }
  const totals = new Map(state.ownerTotals.map(day => [day.date, new Map(day.teams.map(team => [team.teamId, team.stats]))]));
  const periods = [...new Map(state.matchups.map(matchup => [matchup.period, matchup])).values()];
  state.baselineIssues = []; state.verifiedPeriods = [];
  for (const period of periods.filter(period => period.end < today)) {
    if (!dates(period.start, period.end).every(date => totals.has(date))) continue;
    const issues: string[] = [];
    for (const team of state.teams) { const expected = feed.officialScores.find(row => row.period === period.period && row.teamId === team.id); const sum = zero(); for (const date of dates(period.start, period.end)) add(sum, totals.get(date)!.get(team.id)!);
      if (!expected || Object.entries(categories(sum)).some(([id, value]) => !Number.isFinite(expected.categories[id]) || Math.abs(expected.categories[id] - value) > (id === '19' || id === '20' ? .0000051 : 1e-9))) issues.push(`Owner totals need verification for period ${period.period}, ${team.name}.`);
    }
    if (!issues.length) state.verifiedPeriods.push(period.period); else state.baselineIssues.push(...issues);
  }
  const complete = state.scoredDates.length === dates(state.firstDate, state.lastDate).length && state.verifiedPeriods.length === periods.length && !state.missedDates.length;
  state.baseline = singleTeamScoreboard(state, totals, state.draftOrder);
  for (const scenario of state.scenarios) {
    const scenarioTotals = new Map([...totals].map(([date, owners]) => [date, new Map(owners)]));
    for (const day of scenario.totals) scenarioTotals.get(day.date)!.set(scenario.teamId, day.stats);
    Object.assign(scenario, singleTeamScoreboard(state, scenarioTotals, state.draftOrder, scenario.teamId));
    scenario.status = complete && scenario.champion ? 'complete' : state.missedDates.length || state.baselineIssues.length ? 'needs_data' : today < state.firstDate ? 'preseason' : 'active';
    if (scenario.status !== 'complete') scenario.champion = null;
    scenario.message = scenario.status === 'complete' ? 'Complete, with actual owner scoring verified.' : 'Only completed dates and verified prospective decisions contribute.';
  }
  state.status = state.scenarios.every(scenario => scenario.status === 'complete') ? 'complete' : state.missedDates.length || state.baselineIssues.length ? 'needs_data' : today < state.firstDate ? 'preseason' : 'active';
  state.message = state.status === 'complete' ? 'All sixteen one-team seasons are complete.' : state.missedDates.length ? `${state.missedDates.length} missed daily locks remain visible. A complete-season champion cannot be certified.` : state.baselineIssues.length ? 'Saved AI decisions are retained; actual-owner scoring needs verification.' : today < state.firstDate ? 'Real draft verified. Waiting for opening day.' : 'Prospective decisions are saved daily; results settle after the games.';
  return state;
}

export function liveSingleRefreshDates(state: AiLiveSingleState, today: string): string[] {
  if (today < state.firstDate || state.status === 'complete') return [];
  const pending = dates(state.firstDate, today < state.lastDate ? today : state.lastDate).filter(date => !state.scoredDates.includes(date) && !state.missedDates.includes(date));
  const todayPending = pending.includes(today);
  return [...pending.filter(date => date !== today).slice(0, todayPending ? 2 : 3), ...(todayPending ? [today] : [])];
}
