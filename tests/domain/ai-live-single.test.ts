import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceLiveSingles, createLiveSingles, liveSingleRefreshDates } from '../../src/lib/ai-live-single-engine';
import { liveDraftEvidence, parseLiveOfficialScores, parseLiveOwnerDay } from '../../src/lib/ai-live-single-source';
import type { AiGameDay, AiLeagueFeed, AiStats } from '../../src/lib/ai-league-types';
import type { AiLiveOwnerDay, AiLiveSingleFeed } from '../../src/lib/ai-live-single-types';
import type { DraftBoard } from '../../src/lib/draft-board';

const teams = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: `Team ${i + 1}`, shortName: `T${i + 1}`, color: '#123456' }));
const zero = (): AiStats => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, three: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 });
const keys = Object.keys(zero()) as (keyof AiStats)[];
const uuid = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = (day: number) => `2026-10-${day}`;
const capture = (day: number) => `${date(day)}T10:15:00Z`;
const forecast = (id: number): AiStats => ({ pts: 14 + id / 50, reb: 4, ast: 3, stl: 1, blk: 1, tov: 2, three: 2, fgm: 6, fga: 13, ftm: 3, fta: 4 });
function fixture(): AiLiveSingleFeed {
  const players = Array.from({ length: 112 }, (_, i) => ({ id: i + 1, name: `Player ${i + 1}`, nbaTeamId: i % 30 + 1, slots: [i % 5, i % 5 < 2 ? 5 : 6, 11], rank: null, injury: null, forecast: forecast(i) }));
  return { capturedAt: capture(19), players, firstDate: date(20), lastDate: date(23), draftOrder: teams.map(team => team.id),
    ownerDraft: players.slice(0, 104).map((player, index) => ({ teamId: String(Math.floor(index / 13) + 1), playerId: player.id, name: player.name, overallPick: index + 1, keeper: index % 4 === 0 })),
    matchups: [...Array.from({ length: 4 }, (_, i) => ({ id: `regular-${i}`, period: 1, home: String(i + 1), away: String(8 - i), start: date(20), end: date(21), playoff: false })),
      { id: 'semi', period: 2, home: '1', away: '4', start: date(22), end: date(22), playoff: true }, { id: 'final', period: 3, home: '1', away: '2', start: date(23), end: date(23), playoff: true }], days: [], officialScores: [] };
}
function owners(feed: AiLiveSingleFeed, day: number, at = capture(day)): AiLiveOwnerDay {
  return { date: date(day), capturedAt: at, snapshotId: `owners-${day}-${at}`, owners: teams.map((team, i) => {
    const roster = feed.players.slice(i * 13, (i + 1) * 13).map(player => player.id);
    return { teamId: team.id, roster, lineup: roster.map((playerId, j) => ({ playerId, slot: j === 0 ? 0 : 12 })) };
  }) };
}
function day(feed: AiLiveSingleFeed, dayNumber: number, complete = false, capturedAt = capture(dayNumber)): AiLiveSingleFeed['days'][number] {
  const game: AiGameDay = { date: date(dayNumber), startsAt: `${date(dayNumber)}T23:00:00Z`, playerIds: feed.players.map(player => player.id),
    stats: complete ? feed.players.map(player => ({ playerId: player.id, stats: forecast(player.id) })) : [], complete };
  return { game, owners: owners(feed, dayNumber, capturedAt) };
}
function withDays(feed: AiLiveSingleFeed, now: string, days: AiLiveSingleFeed['days']): AiLiveSingleFeed { return { ...structuredClone(feed), capturedAt: now, days }; }
function initial(feed = fixture()) { return advanceLiveSingles(createLiveSingles(feed, teams, feed.capturedAt), feed, feed.capturedAt); }
function official(feed: AiLiveSingleFeed, days: AiLiveSingleFeed['days']) {
  const toCategories = (s: AiStats) => ({ '0': s.pts, '1': s.blk, '2': s.stl, '3': s.ast, '6': s.reb, '11': s.tov, '17': s.three, '19': s.fga ? s.fgm / s.fga : 0, '20': s.fta ? s.ftm / s.fta : 0 });
  return [...new Map(feed.matchups.map(m => [m.period, m])).values()].flatMap(period => teams.map(team => {
    const stats = zero();
    for (const day of days.filter(day => day.game.date >= period.start && day.game.date <= period.end)) {
      const map = new Map(day.game.stats.map(row => [row.playerId, row.stats]));
      for (const slot of day.owners.owners.find(owner => owner.teamId === team.id)!.lineup.filter(slot => slot.slot < 12)) for (const key of keys) stats[key] += map.get(slot.playerId)![key];
    }
    return { period: period.period, teamId: team.id, categories: toCategories(stats) };
  }));
}
function board(feed = fixture()): DraftBoard {
  return { seasonId: uuid(1), draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13, revision: 104,
    clock: { status: 'completed', durationSeconds: 90, remainingSeconds: null, deadlineAt: null, startedAt: capture(18), serverNow: capture(18) },
    keepersRevealedAt: capture(18), orderComplete: true, orderLocked: true, nextPickId: null,
    teams: teams.map((team, i) => ({ franchiseId: uuid(10 + i), espnTeamId: Number(team.id), displayName: team.name, draftPosition: i + 1 })),
    picks: feed.ownerDraft!.map(pick => ({ id: uuid(1000 + pick.overallPick), round: Math.ceil(pick.overallPick / 8), overallPick: pick.overallPick,
      originalFranchiseId: uuid(9 + Number(pick.teamId)), currentOwnerId: uuid(9 + Number(pick.teamId)), status: pick.keeper ? 'keeper' : 'selected',
      playerId: pick.playerId, playerName: pick.name, selectionId: pick.keeper ? null : uuid(2000 + pick.overallPick) })) };
}

test('the live experiments wait for the complete real draft and retain traded pick ownership and keeper attribution', () => {
  const feed = fixture(); const pending = { ...feed, ownerDraft: null, draftOrder: [] };
  const state = initial(pending); assert.equal(state.status, 'awaiting_draft'); assert.equal(state.scenarios.length, 0); assert.equal(state.ownerDraft, null);
  const names = new Map(feed.players.map(player => [player.id, player.name])); const source = board(feed);
  const evidence = liveDraftEvidence(source, names); assert.deepEqual(evidence.ownerDraft, feed.ownerDraft);
  source.picks[1].currentOwnerId = source.teams[1].franchiseId;
  assert.equal(liveDraftEvidence(source, names).ownerDraft![1].teamId, '2');
  source.picks[2].status = 'available'; source.picks[2].playerId = null;
  assert.equal(liveDraftEvidence(source, names).ownerDraft, null);
  assert.throws(() => liveDraftEvidence({ ...source, draftYear: 2027 }, names), /Wrong draft year/);
});

test('sixteen independent scenarios initialize only from the real completed draft without changing input evidence', () => {
  const feed = fixture(), copy = structuredClone(feed), state = initial(feed);
  assert.deepEqual(feed, copy); assert.equal(state.scenarios.length, 16);
  assert.equal(new Set(state.scenarios.map(item => `${item.teamId}:${item.mode}`)).size, 16);
  for (const scenario of state.scenarios) {
    const mine = feed.ownerDraft!.filter(pick => pick.teamId === scenario.teamId);
    if (scenario.mode === 'post_draft') assert.deepEqual(scenario.initialRoster, mine.map(pick => pick.playerId));
    else {
      const other = new Set(feed.ownerDraft!.filter(pick => pick.teamId !== scenario.teamId).map(pick => pick.playerId));
      assert.ok(scenario.initialRoster.every(id => !other.has(id)));
      assert.deepEqual(scenario.decisions.map(row => row.overallPick), mine.map(pick => pick.overallPick));
    }
    assert.equal(scenario.lineups.length, 0); assert.equal(scenario.champion, null);
  }
  state.scenarios[0].finalRoster.pop(); assert.equal(state.scenarios[1].finalRoster.length, 13);
});

test('same-day and future outcomes cannot affect pre-tipoff receipts or previously saved choices', () => {
  const feed = fixture(), before = initial(feed), morning = capture(20), original = withDays(feed, morning, [day(feed, 20)]);
  const altered = structuredClone(original); altered.days[0].game.stats = feed.players.map(player => ({ playerId: player.id, stats: { ...zero(), pts: 10000 + player.id } }));
  const first = advanceLiveSingles(before, original, morning), comparison = advanceLiveSingles(before, altered, morning);
  assert.deepEqual(first.scenarios.map(s => s.decisions), comparison.scenarios.map(s => s.decisions));
  assert.deepEqual(first.scenarios.map(s => s.lineups), comparison.scenarios.map(s => s.lineups));
  const late = advanceLiveSingles(first, withDays(feed, `${date(20)}T23:30:00Z`, [day(feed, 20, true, `${date(20)}T23:30:00Z`)]), `${date(20)}T23:30:00Z`);
  assert.deepEqual(late.scenarios.map(s => s.decisions), first.scenarios.map(s => s.decisions)); assert.deepEqual(late.scoredDates, []);
  const tomorrow = capture(21), settled = advanceLiveSingles(first, withDays(feed, tomorrow, [day(feed, 20, true, tomorrow)]), tomorrow);
  assert.deepEqual(settled.scenarios.map(s => s.lineups), first.scenarios.map(s => s.lineups));
  assert.deepEqual(settled.scoredDates, [date(20)]); assert.deepEqual(first.scoredDates, []);
  assert.deepEqual(advanceLiveSingles(settled, withDays(feed, tomorrow, [day(feed, 20, true, tomorrow)]), tomorrow), settled);
});

test('missed nonempty daily locks remain explicit gaps and cannot be filled by hindsight', () => {
  const feed = fixture(), before = initial(feed), tomorrow = capture(21);
  const result = advanceLiveSingles(before, withDays(feed, tomorrow, [day(feed, 20, true, tomorrow)]), tomorrow);
  assert.deepEqual(result.missedDates, [date(20)]); assert.deepEqual(result.scoredDates, []);
  assert.ok(result.scenarios.every(s => s.lineups.length === 0 && s.champion === null && s.status === 'needs_data'));
  const repeated = advanceLiveSingles(result, withDays(feed, capture(22), [day(feed, 20, true, capture(22))]), capture(22));
  assert.deepEqual(repeated.missedDates, [date(20)]); assert.ok(repeated.scenarios.every(s => s.lineups.length === 0));
  const lateDraft = advanceLiveSingles(createLiveSingles(feed, teams, capture(21)), { ...feed, capturedAt: capture(21) }, capture(21));
  assert.equal(lateDraft.status, 'needs_data'); assert.equal(lateDraft.scenarios.length, 0);
});

test('opening-day draft initialization requires verified evidence that the first tipoff is still ahead', () => {
  const feed = fixture(), late = `${date(20)}T23:01:00Z`;
  const input = withDays(feed, late, [day(feed, 20, false, late)]);
  const afterTipoff = advanceLiveSingles(createLiveSingles(feed, teams, late), input, late);
  assert.equal(afterTipoff.ownerDraft, null); assert.equal(afterTipoff.scenarios.length, 0); assert.equal(afterTipoff.status, 'needs_data');
  const missing = advanceLiveSingles(createLiveSingles(feed, teams, capture(20)), withDays(feed, capture(20), []), capture(20));
  assert.equal(missing.ownerDraft, null); assert.equal(missing.scenarios.length, 0);
  const beforeTipoff = advanceLiveSingles(createLiveSingles(feed, teams, capture(20)), withDays(feed, capture(20), [day(feed, 20)]), capture(20));
  assert.equal(beforeTipoff.scenarios.length, 16);
});

test('actual opponents retain final observed lineup scoring while later owner claims cannot rewrite saved AI lineups', () => {
  const feed = fixture(), before = initial(feed), locked = advanceLiveSingles(before, withDays(feed, capture(20), [day(feed, 20)]), capture(20));
  const evidence = day(feed, 20, true, capture(21));
  const owner = evidence.owners.owners[1]; owner.lineup[0].slot = 12; owner.lineup[1].slot = 0;
  const settled = advanceLiveSingles(locked, withDays(feed, capture(21), [evidence]), capture(21));
  const actual = evidence.game.stats.find(row => row.playerId === owner.lineup[1].playerId)!.stats;
  assert.deepEqual(settled.ownerTotals[0].teams.find(team => team.teamId === '2')!.stats, actual);
  assert.deepEqual(settled.scenarios.map(s => s.lineups), locked.scenarios.map(s => s.lineups));
  assert.deepEqual(settled.locks[0], locked.locks[0], 'The pregame ownership snapshot remains immutable');
});

test('daily owner ownership claims take priority only at a future decision and acquisitions remain isolated', () => {
  const feed = fixture(), before = initial(feed), locked = advanceLiveSingles(before, withDays(feed, capture(20), [day(feed, 20)]), capture(20));
  const controlled = locked.scenarios.find(s => s.teamId === '1' && s.mode === 'post_draft')!;
  const claimed = controlled.finalRoster[0], next = day(feed, 21);
  for (const owner of next.owners.owners) { owner.roster = owner.roster.filter(id => id !== claimed); owner.lineup = owner.lineup.filter(slot => slot.playerId !== claimed); }
  next.owners.owners[1].roster.push(claimed); next.owners.owners[1].lineup.push({ playerId: claimed, slot: 12 });
  const result = advanceLiveSingles(locked, withDays(feed, capture(21), [day(feed, 20, true, capture(21)), next]), capture(21));
  const changed = result.scenarios.find(s => s.teamId === '1' && s.mode === 'post_draft')!;
  assert.ok(!changed.finalRoster.includes(claimed)); assert.ok(changed.decisions.some(row => row.kind === 'forced_return' && row.playerIds[0] === claimed));
  assert.deepEqual(changed.lineups[0], controlled.lineups[0]);
  assert.ok(result.scenarios.every(s => s.finalRoster.length <= 13 && s.acquisitions <= 2 && Object.values(s.acquisitionsByPeriod).every(n => n <= 4)));
});

test('period verification requires all nine actual-owner categories and suppresses complete claims on discrepancies', () => {
  const feed = fixture(); let state = initial(feed);
  state = advanceLiveSingles(state, withDays(feed, capture(20), [day(feed, 20)]), capture(20));
  state = advanceLiveSingles(state, withDays(feed, capture(21), [day(feed, 20, true, capture(21)), day(feed, 21)]), capture(21));
  const completed = [day(feed, 20, true, capture(22)), day(feed, 21, true, capture(22))];
  const input = withDays(feed, capture(22), [completed[1]]); input.officialScores = official(feed, completed);
  const verified = advanceLiveSingles(state, input, capture(22)); assert.deepEqual(verified.verifiedPeriods, [1]);
  const broken = structuredClone(input); broken.officialScores[0].categories['0'] += 1;
  const unverified = advanceLiveSingles(state, broken, capture(22)); assert.deepEqual(unverified.verifiedPeriods, []); assert.ok(unverified.baselineIssues.length > 0);
  assert.ok(unverified.scenarios.every(s => s.champion === null && s.status === 'needs_data'));
  const corrected = advanceLiveSingles(verified, { ...broken, capturedAt: capture(23) }, capture(23));
  assert.deepEqual(corrected.verifiedPeriods, [], 'A later official correction revokes obsolete verification');
  assert.ok(corrected.baselineIssues.length > 0); assert.ok(corrected.scenarios.every(s => s.champion === null));
});

test('refresh planning preserves a slot for today and never refills missed or already settled dates', () => {
  const feed = fixture(), state = initial(feed);
  assert.deepEqual(liveSingleRefreshDates(state, date(19)), []);
  assert.deepEqual(liveSingleRefreshDates(state, date(23)), [date(20), date(21), date(23)]);
  state.scoredDates = [date(20)]; state.missedDates = [date(21)];
  assert.deepEqual(liveSingleRefreshDates(state, date(23)), [date(22), date(23)]);
});

test('owner roster parser rejects wrong season, wrong scoring day, unknown players, duplicate claims and missing teams', () => {
  const feed = fixture(), rows = owners(feed, 20).owners;
  const side = (i: number) => ({ teamId: Number(rows[i].teamId), rosterForCurrentScoringPeriod: { entries: rows[i].lineup.map(slot => ({ playerId: slot.playerId, lineupSlotId: slot.slot })) } });
  const payload = { id: 139935, seasonId: 2027, scoringPeriodId: 1, schedule: Array.from({ length: 4 }, (_, i) => ({ home: side(i * 2), away: side(i * 2 + 1) })) };
  const options = { date: date(20), scoringPeriod: 1, players: feed.players, capturedAt: capture(20), snapshotId: 'safe-snapshot' };
  assert.deepEqual(parseLiveOwnerDay(payload, options).owners, rows);
  assert.throws(() => parseLiveOwnerDay({ ...payload, seasonId: 2026 }, options), /wrong league, season or scoring/);
  assert.throws(() => parseLiveOwnerDay({ ...payload, scoringPeriodId: 2 }, options), /wrong league, season or scoring/);
  const unknown = structuredClone(payload); unknown.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerId = 9999;
  assert.throws(() => parseLiveOwnerDay(unknown, options), /unknown, duplicate or invalid/);
  const duplicate = structuredClone(payload); duplicate.schedule[0].home.rosterForCurrentScoringPeriod.entries[0].playerId = duplicate.schedule[0].away.rosterForCurrentScoringPeriod.entries[0].playerId;
  assert.throws(() => parseLiveOwnerDay(duplicate, options), /unknown, duplicate or invalid/);
  assert.throws(() => parseLiveOwnerDay({ ...payload, schedule: payload.schedule.slice(0, 3) }, options), /All eight/);
});

test('official category parser rejects absent category values and duplicate team-period evidence', () => {
  const feed = fixture(), categoryScores = Object.fromEntries([0, 1, 2, 3, 6, 11, 17, 19, 20].map(id => [id, { score: 0 }]));
  const payload = { id: 139935, seasonId: 2027, schedule: [{ matchupPeriodId: 1, home: { teamId: 1, cumulativeScore: { scoreByStat: categoryScores } }, away: { teamId: 8, cumulativeScore: { scoreByStat: categoryScores } } }] };
  const source: AiLeagueFeed = { ...feed, season: 2027, currentDate: date(22), days: [], limitations: [] };
  assert.equal(parseLiveOfficialScores(payload, source).length, 2);
  const missing = structuredClone(payload); delete (missing.schedule[0].home.cumulativeScore.scoreByStat as Record<string, unknown>)['19'];
  assert.throws(() => parseLiveOfficialScores(missing, source), /incomplete/);
  assert.throws(() => parseLiveOfficialScores({ ...payload, schedule: [...payload.schedule, ...payload.schedule] }, source), /duplicated/);
});
