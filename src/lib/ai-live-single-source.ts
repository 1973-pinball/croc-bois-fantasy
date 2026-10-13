import { createHash } from 'node:crypto';
import { validatedEspnCookies } from './espn-history-sync-core';
import { draftBoardSchema } from './draft-board';
import type { EspnCookies } from './ai-league-feed';
import type { AiLeagueFeed, AiPlayer } from './ai-league-types';
import type { AiLiveOwnerDay, AiLiveSingleFeed } from './ai-live-single-types';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Live owner evidence is incomplete.'); return value as Json; };
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('Live owner evidence is incomplete.'); return value; };
const id = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Live owner identity is invalid.'); return value; };
const teamId = (value: unknown) => { const result = id(value); if (result > 8) throw new Error('Unknown live franchise.'); return String(result); };

/** Uses the complete commissioner board, including keeper slots; ESPN offline import order is not substituted. */
export function liveDraftEvidence(value: unknown, names: ReadonlyMap<number, string>): Pick<AiLiveSingleFeed, 'ownerDraft' | 'draftOrder'> {
  const board = draftBoardSchema.parse(value);
  if (board.draftYear !== 2026) throw new Error('Wrong draft year for the 2026–27 experiment.');
  if (!board.orderComplete || !board.keepersRevealedAt || board.picks.length !== 104 || board.picks.some(pick => pick.status === 'available')) return { ownerDraft: null, draftOrder: [] };
  const franchiseIds = new Map(board.teams.map(team => [team.franchiseId, String(team.espnTeamId)]));
  const ownerDraft = board.picks.map(pick => {
    if (pick.playerId === null || pick.overallPick === null || !pick.currentOwnerId || !names.has(pick.playerId)) throw new Error('The complete live draft has an unresolved player or pick.');
    const owner = franchiseIds.get(pick.currentOwnerId);
    if (!owner || !/^[1-8]$/.test(owner)) throw new Error('The live draft has an unknown franchise.');
    return { playerId: pick.playerId, teamId: owner, name: names.get(pick.playerId)!, overallPick: pick.overallPick, keeper: pick.status === 'keeper' };
  });
  if (new Set(ownerDraft.map(pick => pick.playerId)).size !== 104 || new Set(ownerDraft.map(pick => pick.overallPick)).size !== 104) throw new Error('Live draft identities are duplicated.');
  return { ownerDraft: ownerDraft.sort((a, b) => a.overallPick - b.overallPick), draftOrder: [...board.teams].sort((a, b) => a.draftPosition! - b.draftPosition!).map(team => franchiseIds.get(team.franchiseId)!) };
}

export function parseLiveOwnerDay(payload: unknown, options: { date: string; scoringPeriod: number; players: AiPlayer[]; capturedAt: string; snapshotId: string }): AiLiveOwnerDay {
  const league = object(payload), known = new Set(options.players.map(player => player.id));
  if (league.id !== 139935 || league.seasonId !== 2027 || league.scoringPeriodId !== options.scoringPeriod) throw new Error('Live owner source has the wrong league, season or scoring date.');
  const sides = array(league.schedule).map(object).flatMap(matchup => [matchup.home, matchup.away]).filter(Boolean).map(object).filter(side => side.rosterForCurrentScoringPeriod && array(object(side.rosterForCurrentScoringPeriod).entries).length > 0);
  const held = new Set<number>();
  const owners = sides.map(side => {
    const franchise = teamId(side.teamId), entries = array(object(side.rosterForCurrentScoringPeriod).entries).map(object);
    const lineup = entries.map(entry => {
      const playerId = id(entry.playerId), slot = entry.lineupSlotId;
      if (!known.has(playerId) || held.has(playerId) || typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > 13) throw new Error('Live owner roster has an unknown, duplicate or invalid player/slot.');
      held.add(playerId); return { playerId, slot };
    });
    return { teamId: franchise, roster: lineup.map(slot => slot.playerId), lineup };
  });
  if (owners.length !== 8 || new Set(owners.map(owner => owner.teamId)).size !== 8) throw new Error('All eight dated owner rosters must be verified.');
  return { date: options.date, capturedAt: options.capturedAt, snapshotId: options.snapshotId, owners };
}

export function parseLiveOfficialScores(payload: unknown, feed: AiLeagueFeed): AiLiveSingleFeed['officialScores'] {
  const league = object(payload);
  if (league.id !== 139935 || league.seasonId !== 2027) throw new Error('Wrong official live scoring source.');
  const result: AiLiveSingleFeed['officialScores'] = [];
  for (const raw of array(league.schedule)) {
    const matchup = object(raw), period = id(matchup.matchupPeriodId), range = feed.matchups.find(row => row.period === period);
    if (!range || range.end >= feed.currentDate) continue;
    for (const rawSide of [matchup.home, matchup.away]) {
      const side = object(rawSide), franchise = teamId(side.teamId), values = object(object(side.cumulativeScore).scoreByStat), categories: Record<string, number> = {};
      for (const category of [0, 1, 2, 3, 6, 11, 17, 19, 20]) { const value = object(values[category]).score; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || ((category === 19 || category === 20) && value > 1)) throw new Error('Official live category totals are incomplete.'); categories[category] = value; }
      result.push({ period, teamId: franchise, categories });
    }
  }
  if (new Set(result.map(row => `${row.period}:${row.teamId}`)).size !== result.length) throw new Error('Official live period totals are duplicated.');
  return result;
}

/** Fixed-origin read-only import. Returns only public sports fields and source hashes. */
export async function fetchLiveSingleOwners(feed: AiLeagueFeed, cookies?: EspnCookies): Promise<Pick<AiLiveSingleFeed, 'days' | 'officialScores'>> {
  if (feed.season !== 2027 || !feed.firstDate) throw new Error('Unsupported live season.');
  if (!feed.days.length && feed.currentDate < feed.firstDate) return { days: [], officialScores: [] };
  const connection = validatedEspnCookies(cookies?.espnS2 ?? process.env.ESPN_S2, cookies?.swid ?? process.env.ESPN_SWID);
  if (!connection) throw new Error('The live owner source connection is unavailable.');
  if (feed.days.length > 3) throw new Error('Live owner imports are limited to three dates.');
  // One shared deadline includes all response bodies. Three parallel owner reads
  // cannot turn a stalled provider into twenty-four seconds of extra cron work.
  const signal = AbortSignal.timeout(8_000);
  const rows = await Promise.all((feed.days.length ? feed.days : [null]).map(async game => {
    const scoringPeriod = game ? Math.round((Date.parse(`${game.date}T12:00:00Z`) - Date.parse(`${feed.firstDate}T12:00:00Z`)) / 86_400_000) + 1 : null;
    const query = game ? `view=mBoxscore&view=mMatchupScore&scoringPeriodId=${scoringPeriod}` : 'view=mMatchupScore';
    const response = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/139935?${query}`, {
      headers: { Accept: 'application/json', Cookie: `espn_s2=${connection.s2}; SWID=${connection.swid}` }, cache: 'no-store', redirect: 'manual', signal,
    });
    if (!response.ok) throw new Error('The live owner source could not be refreshed.');
    const text = await response.text(); if (!text.length || text.length > 8_000_000) throw new Error('The live owner source is unexpectedly large.');
    const payload: unknown = JSON.parse(text), capturedAt = new Date().toISOString();
    return { day: game ? { game, owners: parseLiveOwnerDay(payload, { date: game.date, scoringPeriod: scoringPeriod!, players: feed.players, capturedAt, snapshotId: createHash('sha256').update(text).digest('hex') }) } : null, officialScores: parseLiveOfficialScores(payload, feed) };
  }));
  return { days: rows.flatMap(row => row.day ? [row.day] : []), officialScores: rows.at(-1)!.officialScores };
}
