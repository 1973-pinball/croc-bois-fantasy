import type { DraftPlayerCatalog } from './draft-player-catalog';
import { importDraftProjections, type DraftProjectionDataset } from './draft-projections';

// Yahoo's global /nba/players path is an application-error page. This public
// league supplies a nine-category display context; no league ownership is read
// into the result. Only publicly displayed player projections are imported.
export const YAHOO_PROJECTION_URL = 'https://basketball.fantasysports.yahoo.com/nba/842/players';
const PAGE_SIZE = 25;
const MAX_PLAYERS = 2000;
const MAX_PAGE_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 80_000_000;
const REQUEST_TIMEOUT = 12_000;
const TOTAL_TIMEOUT = 90_000;
const FIELDS = ['fgm', 'fga', 'ftm', 'fta', 'three', 'pts', 'reb', 'ast', 'stl', 'blk', 'tov'] as const;
type YahooStats = Record<typeof FIELDS[number], number>;
type YahooProjection = { yahooId: string; name: string; providerRank: number; games: number; totals: YahooStats };
export type YahooProjectionPage = { players: YahooProjection[]; yahooIds: string[]; rowCount: number; excluded: number; nextOffset: number | null };

const TITLES: Record<string, typeof FIELDS[number] | 'games'> = {
  'games played': 'games', 'field goals made': 'fgm', 'field goals attempted': 'fga',
  'free throws made': 'ftm', 'free throws attempted': 'fta', '3-point shots made': 'three',
  'points scored': 'pts', 'total rebounds': 'reb', assists: 'ast', steals: 'stl',
  'blocked shots': 'blk', turnovers: 'tov',
};
function decode(value: string) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt|nbsp));/gi, (match, decimal, hex, named) => {
    if (decimal || hex) {
      const code = decimal ? Number(decimal) : parseInt(hex, 16);
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[named.toLowerCase()];
  });
}
const text = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
function attributes(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
  return attrs;
}
function select(html: string, name: string) {
  const matches = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].filter(match => attributes(match[1]).name === name);
  if (matches.length !== 1) throw new Error('Yahoo’s projection filters could not be verified. Try again later.');
  return [...matches[0][2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(match => ({
    value: attributes(match[1]).value, label: text(match[2]), selected: /(?:^|\s)selected(?:\s|=|$)/i.test(match[1]),
  }));
}
function pageUrl(offset: number) {
  const url = new URL(YAHOO_PROJECTION_URL);
  url.search = new URLSearchParams({ status: 'ALL', eteam: 'ALL', fteam: 'NONE', pos: 'P', cut_type: '33', stat1: 'S_PSR', myteam: '0', sort: 'OR', sdir: '1', ...(offset ? { count: String(offset) } : {}) }).toString();
  return url.toString();
}
function number(value: string): number | null {
  if (!value || /^[-–—]+$/.test(value)) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) throw new Error('Yahoo returned an unreadable projected statistic.');
  const result = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(result) || result < 0) throw new Error('Yahoo returned an invalid projected statistic.');
  return result;
}

/** Parse the observed public projection table, never prior-season stats or page scripts. */
export function parseYahooProjectionPage(html: string, seasonId: number, offset = 0): YahooProjectionPage {
  if (!Number.isInteger(seasonId) || seasonId < 2001 || seasonId > 2100 || !Number.isInteger(offset) || offset < 0 || offset % PAGE_SIZE) throw new Error('Choose a valid Yahoo projection season and page.');
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  if (!clean.trimEnd().endsWith('</html>')) throw new Error('Yahoo returned an incomplete projection page.');
  const filters = select(clean, 'stat1');
  const projected = filters.filter(option => option.selected);
  if (projected.length !== 1 || projected[0].value !== 'S_PSR' || projected[0].label !== 'Remaining Games (proj)') throw new Error('Yahoo did not return remaining-season projections. Actual statistics were not imported.');
  const season = filters.filter(option => option.label === 'Season (total)');
  if (season.length !== 1 || season[0].value !== `S_S_${seasonId - 1}`) throw new Error('Yahoo’s current projection season does not match this draft season.');
  const selectedStatus = select(clean, 'status').filter(option => option.selected);
  if (selectedStatus.length !== 1 || selectedStatus[0].value !== 'ALL') throw new Error('Yahoo did not return the complete player pool.');

  const tables = [...clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  const candidates = tables.filter(table => /<th\b[^>]*title=["']Games Played["']/i.test(table) && /<th\b[^>]*title=["']Points Scored["']/i.test(table));
  if (candidates.length !== 1) throw new Error('Yahoo’s projection table could not be verified. Try again later.');
  const rows = [...candidates[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]);
  const header = rows.find(row => /<th\b[^>]*title=["']Games Played["']/i.test(row));
  if (!header) throw new Error('Yahoo’s projection columns are missing.');
  const headings = [...header.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)];
  const columns = new Map<string, number>();
  headings.forEach((heading, index) => {
    const key = TITLES[(attributes(heading[1]).title ?? '').toLowerCase()];
    if (key) {
      if (columns.has(key)) throw new Error('Yahoo returned duplicate projection columns.');
      columns.set(key, index);
    }
  });
  if (['games', ...FIELDS].some(field => !columns.has(field))) throw new Error('Yahoo is missing required projection categories or shooting attempts.');
  const rankColumns = headings.flatMap((heading, index) => {
    const links = [...heading[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    const preSeason = links.some(link => {
      if (text(link[2]) !== 'Pre-Season') return false;
      try {
        const url = new URL(attributes(link[1]).href, YAHOO_PROJECTION_URL);
        return url.origin === new URL(YAHOO_PROJECTION_URL).origin && url.searchParams.get('sort') === 'OR';
      } catch { return false; }
    });
    return preSeason ? [index] : [];
  });
  if (rankColumns.length !== 1) throw new Error('Yahoo’s published preseason rank column could not be verified.');
  const result: YahooProjectionPage = { players: [], yahooIds: [], rowCount: 0, excluded: 0, nextOffset: null };
  for (const row of rows) {
    if (/<th\b/i.test(row)) continue;
    const names = [...row.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => ({ attrs: attributes(match[1]), name: text(match[2]) }))
      .filter(link => (link.attrs.class ?? '').split(/\s+/).includes('name') && link.attrs['data-ys-playerid']);
    if (!names.length) {
      if (text(row)) throw new Error('Yahoo returned an unexpected or incomplete player row.');
      continue;
    }
    if (names.length !== 1 || !/^\d+$/.test(names[0].attrs['data-ys-playerid']) || !names[0].name) throw new Error('Yahoo returned an ambiguous player identity.');
    const { attrs } = names[0];
    // Long names are abbreviated in the link text; Yahoo supplies the full
    // player name in its title attribute. Identity matching below stays exact.
    const name = attrs.title || names[0].name;
    const yahooId = attrs['data-ys-playerid'];
    if (result.yahooIds.includes(yahooId)) throw new Error('Yahoo returned duplicate players.');
    result.yahooIds.push(yahooId); result.rowCount++;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => text(match[1]));
    if (cells.length !== headings.length) throw new Error('Yahoo returned an incomplete player row.');
    const providerRank = number(cells[rankColumns[0]]);
    if (providerRank === null || !Number.isSafeInteger(providerRank) || providerRank < 1) throw new Error('Yahoo returned an invalid preseason rank.');
    const games = number(cells[columns.get('games')!]);
    const values = FIELDS.map(field => number(cells[columns.get(field)!]));
    if (games !== null && (!Number.isInteger(games) || games > 82)) throw new Error('Yahoo returned invalid projected games.');
    if (games === null || games === 0 || values.some(value => value === null)) { result.excluded++; continue; }
    const totals = Object.fromEntries(FIELDS.map((field, index) => [field, values[index]!])) as YahooStats;
    if (totals.fgm > totals.fga || totals.ftm > totals.fta || totals.three > totals.fgm) throw new Error('Yahoo returned inconsistent shooting projections.');
    result.players.push({ yahooId, name, providerRank, games, totals });
  }
  if (!result.rowCount || result.rowCount > PAGE_SIZE) throw new Error('Yahoo’s player page is empty or unexpectedly sized.');
  const nextLinks = [...clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter(match => /^Next\s+25$/i.test(text(match[2])));
  if (nextLinks.length > 1) throw new Error('Yahoo returned ambiguous pagination.');
  if (nextLinks.length) {
    const href = attributes(nextLinks[0][1]).href;
    if (!href) throw new Error('Yahoo’s next projection page is unavailable.');
    const next = new URL(href, YAHOO_PROJECTION_URL);
    const expected = new URL(pageUrl(offset + PAGE_SIZE));
    if (next.origin !== expected.origin || next.pathname !== expected.pathname || next.hash || next.username || next.password
      || [...expected.searchParams].some(([key, value]) => next.searchParams.getAll(key).length !== 1 || next.searchParams.get(key) !== value)
      || [...next.searchParams.keys()].some(key => !expected.searchParams.has(key))) throw new Error('Yahoo returned an unexpected projection page link.');
    if (result.rowCount !== PAGE_SIZE) throw new Error('Yahoo returned an incomplete projection page before the next page.');
    result.nextOffset = offset + PAGE_SIZE;
  } else if (result.rowCount === PAGE_SIZE) {
    // A vanished pagination link must not silently publish just the top 25.
    throw new Error('Yahoo’s complete projection pool could not be confirmed. Try again later.');
  }
  return result;
}

async function boundedText(response: Response, total: { bytes: number }) {
  if (Number(response.headers.get('content-length')) > MAX_PAGE_BYTES || !response.body) throw new Error('Yahoo returned an incomplete or unexpectedly large projection page.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength; total.bytes += value.byteLength;
      if (size > MAX_PAGE_BYTES || total.bytes > MAX_TOTAL_BYTES) { await reader.cancel(); throw new Error('Yahoo’s projection response exceeded the supported size.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Fixed public URLs only, sequential pages, no cookies, redirects or access/rate-limit retries. */
export async function fetchYahooDraftProjections(seasonId: number, catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>, fetcher: typeof fetch = fetch): Promise<DraftProjectionDataset> {
  if (seasonId !== catalog.espnSeasonId) throw new Error('The ESPN player catalog does not cover this Yahoo projection season.');
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT), bytes = { bytes: 0 };
  const players: YahooProjection[] = [], ids = new Set<string>(); let offset = 0, excluded = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetcher(pageUrl(offset), { headers: { Accept: 'text/html' }, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT)]) });
    } catch { throw new Error('Yahoo could not be reached before the projection timeout. Try again later or import a projection export.'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new Error('Yahoo is limiting projection requests. The last successful import remains available; try again later.');
      if ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400)) throw new Error('Yahoo’s public projection page is unavailable or requires sign-in. Import a projection export instead.');
      throw new Error('Yahoo could not provide the complete projection pool. Try again later or import a projection export.');
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) { await response.body?.cancel(); throw new Error('Yahoo returned an unexpected projection format.'); }
    const page = parseYahooProjectionPage(await boundedText(response, bytes), seasonId, offset);
    for (const id of page.yahooIds) {
      if (ids.has(id)) throw new Error('Yahoo repeated a player across projection pages. The incomplete refresh was discarded.');
      ids.add(id);
    }
    players.push(...page.players); excluded += page.excluded;
    if (page.nextOffset === null) break;
    if (ids.size >= MAX_PLAYERS || page.nextOffset >= MAX_PLAYERS) throw new Error('Yahoo’s player pool exceeded the supported pagination limit. The incomplete refresh was discarded.');
    offset = page.nextOffset;
  }
  if (!players.length) throw new Error('Yahoo has no complete remaining-season player projections.');
  const csv = [
    'Player,ProviderRank,GP,FGM,FGA,FTM,FTA,3PM,PTS,REB,AST,STL,BLK,TO',
    ...players.map(player => [`"${player.name.replace(/"/g, '""')}"`, player.providerRank, player.games, ...FIELDS.map(field => player.totals[field])].join(',')),
  ].join('\n');
  const dataset = importDraftProjections({ source: 'yahoo', seasonId, text: csv, basis: 'totals', catalog });
  dataset.sourceLabel = 'Yahoo remaining-season projections';
  // GP describes remaining games, not full-season appearances. Retain Yahoo's
  // per-game rates without silently applying remaining GP / 82 as availability.
  dataset.players = dataset.players.map(player => ({ ...player, games: null }));
  dataset.warnings = [
    ...dataset.warnings.filter(warning => !warning.startsWith('The import season and')),
    `Read all ${ids.size} Yahoo player rows across ${offset / PAGE_SIZE + 1} pages${excluded ? `; ${excluded} rows with missing statistics or zero/missing projected games were excluded` : ''}.`,
    'Yahoo supplies remaining-season totals. These are divided by remaining projected games to obtain per-game rates. Before opening day this covers the upcoming season; after opening day it covers only the remaining season.',
    'Yahoo remaining-game counts are not full-season availability estimates. Availability is not scaled by remaining games / 82; compare this source’s per-game rates with that limitation in mind.',
    'Yahoo rank is its published Pre-Season (OR) rank, not a rank calculated from the remaining-season totals. Original ranks are preserved across unmatched or excluded players.',
    'Only public Yahoo player projections and preseason ranks are imported. The public league is a display context; its rosters, owners and scoring settings are not used. ESPN player names and IDs remain authoritative.',
  ];
  return dataset;
}
