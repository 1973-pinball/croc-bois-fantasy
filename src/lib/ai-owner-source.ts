import { createHash } from 'node:crypto';
import analytics from '../../data/analytics.json';
import { extractCategoryPreferences } from './category-preferences';
import type { EspnCookies } from './ai-league-feed';
import { validatedEspnCookies } from './espn-history-sync-core';
import type { PreferenceSource } from './roster-position-history';
import type { AiOwnerSnapshot } from './ai-owner-types';

type Json = Record<string, unknown>;
export type AiOwnerDraftEvidence = { teamId: string; name: string; overallPick: number; keeper: boolean | null };
const LEAGUE = 139935;
const CATEGORIES = [0, 1, 2, 3, 6, 11, 17, 19, 20];
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Actual-owner evidence is incomplete.');
  return value as Json;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error('Actual-owner evidence is incomplete.');
  return value;
};
const integer = (value: unknown, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Actual-owner evidence contains an invalid count.');
  return value;
};
const teamId = (value: unknown): string => {
  const id = integer(value, 1);
  if (id > 8) throw new Error('Actual-owner evidence contains an unknown franchise.');
  return String(id);
};
const nameKey = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^jimmybutleriii$/, 'jimmybutler');

/** The commissioner workbook is authoritative for the offline 2025 draft. ESPN's imported board differs. */
export function actual2025DraftEvidence(): AiOwnerDraftEvidence[] {
  return analytics.playerPreferences.rows.flatMap(row => row.selections.filter(selection => selection.season === 2025).map(selection => ({
    teamId: row.franchiseId, name: row.player, overallPick: selection.overallPick, keeper: selection.kept,
  })));
}

function namesFromPool(payload: unknown): Map<number, string> {
  const names = new Map<number, string>();
  for (const raw of array(object(payload).players)) {
    const row = object(raw), player = object(row.player), id = integer(player.id, 1);
    if (row.id !== id || names.has(id) || typeof player.fullName !== 'string' || !player.fullName.trim()) throw new Error('Actual-owner player identities are invalid.');
    names.set(id, player.fullName.trim());
  }
  return names;
}

function extractDraft(league: Json, season: number, names: Map<number, string>, workbook: AiOwnerDraftEvidence[] | undefined): AiOwnerSnapshot['draft'] {
  let result: NonNullable<AiOwnerSnapshot['draft']>;
  if (season === 2026) {
    if (!workbook) return null;
    const byName = new Map<string, number[]>();
    for (const [id, name] of names) byName.set(nameKey(name), [...(byName.get(nameKey(name)) ?? []), id]);
    result = workbook.map(row => {
      const candidates = byName.get(nameKey(row.name)) ?? [];
      if (candidates.length !== 1 || !/^[1-8]$/.test(row.teamId)) throw new Error('The historical owner draft has an unresolved player or franchise.');
      return { teamId: row.teamId, playerId: candidates[0], name: row.name, overallPick: integer(row.overallPick, 1), keeper: typeof row.keeper === 'boolean' ? row.keeper : null };
    });
  } else {
    const detail = object(league.draftDetail);
    if (detail.drafted !== true || detail.inProgress === true) return null;
    result = array(detail.picks).map(raw => {
      const pick = object(raw), playerId = integer(pick.playerId, 1), name = names.get(playerId);
      if (!name) throw new Error('An actual draft player name is unresolved.');
      return { teamId: teamId(pick.teamId), playerId, name, overallPick: integer(pick.overallPickNumber, 1), keeper: typeof pick.keeper === 'boolean' ? pick.keeper : null };
    });
  }
  if (result.length !== 104 || new Set(result.map(row => row.playerId)).size !== 104 || new Set(result.map(row => row.overallPick)).size !== 104
    || result.some(row => row.overallPick > 104) || new Set(result.map(row => row.teamId)).size !== 8) throw new Error('The complete owner draft could not be verified.');
  return result.sort((a, b) => a.overallPick - b.overallPick);
}

function extractAcquisitions(teams: Json[], league: Json): AiOwnerSnapshot['acquisitions'] {
  const periods = Object.keys(object(object(object(league.settings).scheduleSettings).matchupPeriods));
  if (!periods.length || periods.some(id => !/^[1-9]\d*$/.test(id))) return null;
  return teams.map(team => {
    const counter = object(team.transactionCounter), raw = object(counter.matchupAcquisitionTotals), total = integer(counter.acquisitions);
    const entries = Object.entries(raw).map(([id, count]) => {
      if (!periods.includes(id)) throw new Error('An owner acquisition count has an unknown matchup period.');
      return [id, integer(count)] as const;
    });
    if (entries.reduce((sum, [, count]) => sum + count, 0) !== total) throw new Error('Owner matchup acquisition counts do not reconcile with the season total.');
    // The explicit map and reconciled season total establish that sparse omissions
    // are zero. An absent map or absent total never establishes a zero count.
    const byPeriod = Object.fromEntries(periods.map(id => [id, raw[id] === undefined ? 0 : integer(raw[id])]));
    return { teamId: teamId(team.id), byPeriod };
  });
}

/** Parses a private league response into only the reviewed comparison fields. */
export function parseAiOwnerSnapshot(payload: unknown, options: {
  season: number; source: PreferenceSource; playerNames?: ReadonlyMap<number, string>; draftEvidence?: AiOwnerDraftEvidence[];
}): AiOwnerSnapshot {
  const league = object(payload), { season, source } = options;
  if (![2026, 2027].includes(season) || league.id !== LEAGUE || league.seasonId !== season) throw new Error('Unexpected actual-owner league or season.');
  if (!Number.isFinite(Date.parse(source.capturedAt)) || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Actual-owner provenance is invalid.');
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || url.hostname !== 'lm-api-reads.fantasy.espn.com' || url.pathname !== `/apis/v3/games/fba/seasons/${season}/segments/0/leagues/${LEAGUE}`
    || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'view')) throw new Error('Actual-owner source is invalid.');
  const teams = array(league.teams).map(object), ids = teams.map(team => teamId(team.id));
  if (teams.length !== 8 || new Set(ids).size !== 8) throw new Error('Actual-owner evidence must contain all eight franchises.');
  const names = new Map(options.playerNames);
  for (const team of teams) for (const raw of array(object(team.roster ?? { entries: [] }).entries ?? [])) {
    const entry = object(raw), pool = entry.playerPoolEntry ? object(entry.playerPoolEntry) : undefined;
    const player = pool?.player ? object(pool.player) : undefined;
    if (player && typeof player.fullName === 'string' && typeof player.id === 'number') {
      const id = integer(player.id, 1);
      if (names.has(id) && nameKey(names.get(id)!) !== nameKey(player.fullName)) throw new Error('Actual-owner player identities conflict.');
      names.set(id, player.fullName.trim());
    }
  }
  const limitations = [
    'This compares the same franchises under different starting conditions: AI uses a fresh redraft and its own order; owners used real keeper rights and traded picks. Differences are descriptive, not an estimate of owner skill.',
    'Owner pickup comparisons use ESPN acquisitions per matchup, not individual transaction receipts or drop explanations. Owner daily lineups are not imported.',
    'Category comparisons use only the listed completed regular-season matchup periods; current weeks and playoffs are excluded.',
  ];
  let draft: AiOwnerSnapshot['draft'] = null, categories: AiOwnerSnapshot['categories'] = null, acquisitions: AiOwnerSnapshot['acquisitions'] = null;
  const detail = object(league.draftDetail ?? {}), draftComplete = season === 2026 ? true : detail.drafted === true && detail.inProgress !== true;
  try { draft = extractDraft(league, season, names, options.draftEvidence ?? (season === 2026 ? actual2025DraftEvidence() : undefined)); }
  catch { limitations.push('The complete owner draft could not be reconciled to unique player identities. Draft differences are unavailable.'); }
  if (season === 2026) limitations.push('The actual 2025–26 draft uses the commissioner workbook (104 selections, including keepers). ESPN’s offline draft import has a different order and unmarked keeper flags, so it is not used for those decisions.');
  if (!draftComplete) limitations.push('The upcoming owner draft is not complete. No actual draft selections or keeper choices are assumed from the prior roster.');
  try {
    const extracted = extractCategoryPreferences(league as Parameters<typeof extractCategoryPreferences>[0], { sha256: source.sha256, url: source.url, capturedAt: source.capturedAt });
    const periods = extracted.completedMatchupPeriods;
    const valid = periods.length > 0 && extracted.teams.length === 8 && extracted.teams.every(team => team.matchups === periods.length && team.standingsMatch !== false
      && team.categories.length === 9 && new Set(team.categories.map(category => category.id)).size === 9
      && team.categories.every(category => CATEGORIES.includes(category.id) && category.wins + category.losses + category.ties === team.matchups));
    if (valid) categories = extracted;
    else limitations.push('No complete, reconciled nine-category owner comparison is available yet for all eight franchises.');
  } catch { limitations.push('Actual category results could not be verified. Previously known outcomes are not replaced with zeroes.'); }
  try { acquisitions = extractAcquisitions(teams, league); }
  catch { limitations.push('Owner acquisitions are unavailable because a matchup count or its season-total reconciliation is missing.'); }
  return { season, capturedAt: source.capturedAt, draftComplete, draft, categories, acquisitions, limitations };
}

/** Read-only, fixed-origin ESPN import; raw member/account data never leaves this module. */
export async function fetchAiOwnerSnapshot(season: number, cookies?: EspnCookies, knownPlayerNames?: ReadonlyMap<number, string>): Promise<AiOwnerSnapshot> {
  if (season !== 2026 && season !== 2027) throw new Error('Unsupported actual-owner season.');
  const connection = validatedEspnCookies(cookies?.espnS2 ?? process.env.ESPN_S2, cookies?.swid ?? process.env.ESPN_SWID ?? process.env.SWID);
  if (!connection) throw new Error('The ESPN owner comparison connection is unavailable.');
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leagues/${LEAGUE}?view=mTeam&view=mSettings&view=mMatchup&view=mMatchupScore&view=mDraftDetail&view=mRoster`;
  // One deadline covers both response bodies and the optional standalone name
  // lookup. The normal simulation refresh supplies its existing complete pool.
  const signal = AbortSignal.timeout(8_000);
  const requestHeaders = { Accept: 'application/json', Cookie: `espn_s2=${connection.s2}; SWID=${connection.swid}` };
  let response: Response;
  try { response = await fetch(url, { headers: requestHeaders, cache: 'no-store', redirect: 'manual', signal }); }
  catch { throw new Error('Actual-owner ESPN data is temporarily unavailable.'); }
  if (!response.ok) throw new Error(`Actual-owner ESPN data returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text.length || text.length > 6_000_000) throw new Error('Actual-owner ESPN response size is unexpected.');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error('Actual-owner ESPN data could not be read.'); }
  const league = object(payload), detail = object(league.draftDetail ?? {});
  let playerNames = knownPlayerNames;
  if (!playerNames && (season === 2026 || detail.drafted === true)) {
    const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: 2000, offset: 0 } };
    let poolResponse: Response;
    try { poolResponse = await fetch(`${url.split('?')[0]}?view=kona_player_info`, { headers: { ...requestHeaders, 'x-fantasy-filter': JSON.stringify(filter) }, cache: 'no-store', redirect: 'manual', signal }); }
    catch { throw new Error('Actual-owner player names are temporarily unavailable.'); }
    if (!poolResponse.ok) throw new Error(`Actual-owner player names returned HTTP ${poolResponse.status}.`);
    const poolText = await poolResponse.text();
    if (!poolText.length || poolText.length > 6_000_000) throw new Error('Actual-owner player response size is unexpected.');
    try { playerNames = namesFromPool(JSON.parse(poolText)); } catch { throw new Error('Actual-owner player identities could not be verified.'); }
  }
  return parseAiOwnerSnapshot(payload, { season, playerNames, source: { sha256: createHash('sha256').update(text).digest('hex'), url, capturedAt: new Date().toISOString() } });
}
