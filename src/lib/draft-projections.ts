import { z } from 'zod';
import type { DraftCatalogPlayer, DraftPlayerCatalog } from './draft-player-catalog';

export type DraftProjectionSource = 'espn' | 'yahoo' | 'hashtag' | 'basketball-monster';
export type DraftProjectionStats = { pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; three: number; fgm: number; fga: number; ftm: number; fta: number };
/** Stats are per NBA game; games is expected full-season appearances, when supplied. */
export type DraftPlayerProjection = { id: number; name: string; games: number | null; stats: DraftProjectionStats };
export type DraftProjectionDataset = { source: DraftProjectionSource; sourceLabel: string; seasonId: number; importedAt: string; players: DraftPlayerProjection[]; warnings: string[] };

export const PROJECTION_SOURCES: { id: DraftProjectionSource; label: string; url: string; help: string }[] = [
  { id: 'espn', label: 'ESPN projections', url: 'https://fantasy.espn.com/basketball/players/projections', help: 'Import this season’s ESPN projections through the league’s server connection, or paste a CSV/TSV export.' },
  { id: 'yahoo', label: 'Yahoo projections', url: 'https://basketball.fantasysports.yahoo.com/nba/players', help: 'Select projected statistics for the correct season, then paste or upload a CSV/TSV table with full player names and shooting makes/attempts.' },
  { id: 'hashtag', label: 'Hashtag Basketball projections', url: 'https://hashtagbasketball.com/fantasy-basketball-projections', help: 'Paste or upload your projection table with full player names. FG% and FT% cells containing (makes/attempts) are supported. Abbreviated names must be replaced with full names or ESPN IDs.' },
  { id: 'basketball-monster', label: 'Basketball Monster projections', url: 'https://basketballmonster.com/projections.aspx', help: 'Use your Basketball Monster account to export projections, save as CSV/TSV, and import here. Include shooting makes/attempts; your password is never needed here.' },
];

const stat = z.number().finite().min(0).max(200);
export const draftProjectionStatsSchema = z.object({ pts: stat, reb: stat, ast: stat, stl: stat, blk: stat, tov: stat, three: stat, fgm: stat, fga: stat, ftm: stat, fta: stat }).refine(value => value.fgm <= value.fga + 0.00001 && value.ftm <= value.fta + 0.00001 && value.three <= value.fgm + 0.00001, 'Shooting makes exceed attempts or threes exceed field goals.');
export const draftProjectionDatasetSchema = z.object({
  source: z.enum(['espn', 'yahoo', 'hashtag', 'basketball-monster']), sourceLabel: z.string().min(1).max(100),
  seasonId: z.number().int().min(2000).max(2100), importedAt: z.string().datetime(),
  players: z.array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), name: z.string().min(1).max(150), games: z.number().finite().min(0).max(82).nullable(), stats: draftProjectionStatsSchema })).min(1).max(2000),
  warnings: z.array(z.string().max(500)).max(110),
}).refine(value => new Set(value.players.map(player => player.id)).size === value.players.length, 'Duplicate ESPN player identities.');

/** Exact after accents, punctuation and whitespace normalization; never a fuzzy name guess. */
export function normalizeDraftProjectionName(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
const header = (value: string) => value.trim().toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '');
const aliases: Record<string, string[]> = {
  name: ['player', 'name', 'playername', 'fullname'], id: ['espnid', 'espnplayerid', 'playerespnid'], games: ['gp', 'g', 'games', 'gamesplayed', 'projectedgames'],
  pts: ['pts', 'points', 'ppg'], reb: ['reb', 'treb', 'trb', 'rebounds', 'rpg'], ast: ['ast', 'assists', 'apg'], stl: ['stl', 'steals', 'spg'], blk: ['blk', 'blocks', 'bpg'],
  tov: ['to', 'tov', 'turnovers', 'topg'], three: ['3pm', '3ptm', '3pt', '3p', '3', 'three', 'threes', 'threepointersmade', '3pointersmade'],
  fgm: ['fgm', 'fieldgoalsmade'], fga: ['fga', 'fieldgoalsattempted', 'fieldgoalattempts'], ftm: ['ftm', 'freethrowsmade'], fta: ['fta', 'freethrowsattempted', 'freethrowattempts'],
  fgpct: ['fgpct', 'fgpercentage', 'fieldgoalpercentage'], ftpct: ['ftpct', 'ftpercentage', 'freethrowpercentage'], fgpair: ['fg', 'fgma', 'fgmfa', 'fgmfga'], ftpair: ['ft', 'ftma', 'ftmfta'],
};
// Basketball Monster's published table uses p/g, 3/g, r/g, a/g, s/g, b/g,
// fga/g, fta/g and to/g. Its value/z-score columns (pV, rV, etc.) are not stats.
const monsterAliases: Record<string, string[]> = {
  pts: ['p', 'pg'], reb: ['r', 'rg'], ast: ['a', 'ag'], stl: ['s', 'sg'], blk: ['b', 'bg'],
  three: ['3g'], tov: ['tog'], fgm: ['fgmg'], fga: ['fgag'], ftm: ['ftmg'], fta: ['ftag'],
};
const counting = ['pts', 'reb', 'ast', 'stl', 'blk', 'tov', 'three'] as const;
const keys = [...counting, 'fgm', 'fga', 'ftm', 'fta'] as const;

/** Quoted CSV and copied spreadsheet TSV, including escaped quotes and line breaks. */
function table(text: string) {
  if (!text.trim() || text.length > 2_000_000) throw new Error('Import a nonempty CSV/TSV file under 2 MB.');
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let quoted = false, commas = 0, tabs = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') { if (quoted && input[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted) { if (char === '\n') break; if (char === ',') commas++; if (char === '\t') tabs++; }
  }
  const delimiter = tabs > commas ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], field = ''; quoted = false; let closedQuote = false;
  const endField = () => { row.push(field.trim()); field = ''; closedQuote = false; };
  const endRow = () => { endField(); if (row.some(value => value !== '')) rows.push(row); row = []; if (rows.length > 2001) throw new Error('Import at most 2,000 players at a time.'); };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) { quoted = false; closedQuote = true; }
      else if (!field.trim() && !closedQuote) { quoted = true; field = ''; }
      else throw new Error('Malformed quoted CSV/TSV field.');
    } else if (!quoted && char === delimiter) endField();
    else if (!quoted && char === '\n') endRow();
    else { if (closedQuote && char.trim()) throw new Error('Unexpected text after a quoted CSV/TSV field.'); field += char; }
  }
  if (quoted) throw new Error('A quoted CSV/TSV field is missing its closing quote.');
  if (field || row.length) endRow();
  if (rows.length < 2) throw new Error('Include column headers and at least one player row.');
  return rows;
}
function numeric(value: string, label: string): number | null {
  const supplied = value.trim();
  if (supplied.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(supplied)) throw new Error(`${label} has ambiguous comma formatting. Use a decimal point.`);
  const clean = supplied.replace(/,/g, '');
  if (!clean || /^(?:--?|n\/?a|null)$/i.test(clean)) return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(clean)) throw new Error(`${label} must be a nonnegative number.`);
  const number = Number(clean);
  if (!Number.isFinite(number)) throw new Error(`${label} is invalid.`);
  return number;
}
function percentage(value: string, label: string): number | null {
  const parsed = numeric(value.replace(/%$/, ''), label);
  if (parsed === null) return null;
  const result = value.endsWith('%') || parsed > 1 ? parsed / 100 : parsed;
  if (result > 1) throw new Error(`${label} must be between 0% and 100%.`);
  return result;
}
function shootingPair(value: string): [number, number] | null {
  // Hashtag includes percentage and a rounded makes/attempts pair in the same cell.
  const pair = value.match(/^(?:[\d.]+%?\s*)?\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/) ?? value.match(/^\s*([\d.]+)\s*[\/-]\s*([\d.]+)\s*$/);
  return pair ? [numeric(pair[1], 'Shooting makes')!, numeric(pair[2], 'Shooting attempts')!] : null;
}
function dataset(source: DraftProjectionSource, seasonId: number, importedAt: string, players: DraftPlayerProjection[], warnings: string[]): DraftProjectionDataset {
  return draftProjectionDatasetSchema.parse({ source, sourceLabel: PROJECTION_SOURCES.find(item => item.id === source)!.label, seasonId, importedAt, players, warnings });
}
class DuplicateDraftProjectionError extends Error {}

export function importDraftProjections(options: { source: DraftProjectionSource; text: string; basis: 'per-game' | 'totals'; seasonId: number; catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>; importedAt?: string }): DraftProjectionDataset {
  if (options.seasonId !== options.catalog.espnSeasonId) throw new Error('These projections need the matching season’s ESPN player catalog.');
  const [titles, ...rows] = table(options.text), headers = titles.map(header), index: Record<string, number> = {};
  if (options.source === 'basketball-monster' && options.basis === 'totals' && titles.some(title => /^(?:p|3|r|a|s|b|fgm|fga|ftm|fta|to)\s*\/\s*g$/i.test(title.trim()))) throw new Error('Basketball Monster columns labeled /g are per-game. Choose the per-game format.');
  for (const [key, names] of Object.entries(aliases)) {
    // BM's toV is a turnover z-score; after case normalization it collides with
    // the usual TOV abbreviation. Require its unambiguous TO or to/g column.
    const sourceNames = options.source === 'basketball-monster' ? [...names.filter(name => key !== 'tov' || name !== 'tov'), ...(monsterAliases[key] ?? [])] : names;
    const matches = headers.flatMap((value, i) => sourceNames.includes(value) || (key === 'id' && options.source === 'espn' && ['id', 'playerid'].includes(value)) ? [i] : []);
    if (matches.length > 1) throw new Error(`More than one ${key} column was found. Keep one unambiguous column.`);
    index[key] = matches[0] ?? -1;
  }
  if (index.name === -1 && index.id === -1) throw new Error('Include Player/Name or an explicit ESPN ID column. Yahoo and Basketball Monster IDs are not ESPN IDs.');
  const absent = counting.filter(key => index[key] === -1);
  if (absent.length) throw new Error(`Missing projection columns: ${absent.join(', ').toUpperCase()}.`);
  const byId = new Map(options.catalog.players.map(player => [player.id, player])), byName = new Map<string, DraftCatalogPlayer[]>();
  for (const player of options.catalog.players) { const name = normalizeDraftProjectionName(player.name); byName.set(name, [...(byName.get(name) ?? []), player]); }
  const players: DraftPlayerProjection[] = [], warnings: string[] = [], seen = new Set<number>(); let skipped = 0;
  for (const [offset, row] of rows.entries()) {
    const value = (key: string) => index[key] < 0 ? '' : row[index[key]] ?? '';
    try {
      if (row.length !== titles.length) throw new Error('The number of cells does not match the header.');
      // Some copied source tables repeat their column header between groups.
      if (row.every((cell, i) => header(cell) === headers[i])) continue;
      const suppliedId = numeric(value('id'), 'ESPN ID'), name = value('name');
      const matches = byName.get(normalizeDraftProjectionName(name)) ?? [];
      const player = suppliedId !== null ? byId.get(suppliedId) : matches.length === 1 ? matches[0] : undefined;
      if (!player) throw new Error('Player did not match a unique ESPN ID or full name.');
      if (suppliedId !== null && name && normalizeDraftProjectionName(name) !== normalizeDraftProjectionName(player.name)) throw new Error('Player name does not match the supplied ESPN ID.');
      if (seen.has(player.id)) throw new DuplicateDraftProjectionError('Duplicate player projection. Remove the duplicate and import again.');
      const games = numeric(value('games'), 'Games');
      if (games !== null && games > 82) throw new Error('Projected games must be between 0 and 82.');
      if (options.basis === 'totals' && (games === null || games <= 0)) throw new Error('Season totals need a positive GP/Games value.');
      const stats = {} as DraftProjectionStats;
      for (const key of counting) { const number = numeric(value(key), key.toUpperCase()); if (number === null) throw new Error(`${key.toUpperCase()} is missing.`); stats[key] = number; }
      for (const shot of ['fg', 'ft'] as const) {
        const makeKey = `${shot}m` as 'fgm' | 'ftm', attemptKey = `${shot}a` as 'fga' | 'fta';
        const pair = shootingPair(value(`${shot}pair`)) ?? shootingPair(value(`${shot}pct`));
        const attempts = numeric(value(attemptKey), attemptKey.toUpperCase()) ?? pair?.[1] ?? null;
        let makes = numeric(value(makeKey), makeKey.toUpperCase()) ?? pair?.[0] ?? null;
        if (makes === null && attempts !== null) { const pct = percentage(value(`${shot}pct`), `${shot.toUpperCase()}%`); if (pct !== null) makes = attempts * pct; }
        if (makes === null || attempts === null) throw new Error(`${shot.toUpperCase()}% needs shooting makes and attempts, or attempts plus percentage. Percentages alone cannot be weighted.`);
        stats[makeKey] = makes; stats[attemptKey] = attempts;
      }
      if (options.basis === 'totals') for (const key of keys) stats[key] /= games!;
      const checked = draftProjectionStatsSchema.safeParse(stats);
      if (!checked.success) throw new Error(checked.error.issues[0]?.message || 'Projection statistics are invalid.');
      seen.add(player.id); players.push({ id: player.id, name: player.name, games, stats: checked.data });
    } catch (error) {
      if (error instanceof DuplicateDraftProjectionError) throw error;
      skipped++;
      if (warnings.length < 100) warnings.push(`Row ${offset + 2}: ${error instanceof Error ? error.message : 'Invalid projection.'}`);
    }
  }
  if (!players.length) throw new Error(`No complete projections matched the ESPN catalog. ${warnings[0] ?? 'Check the column headers.'}`);
  if (skipped) warnings.unshift(`${skipped} row${skipped === 1 ? '' : 's'} excluded; unmatched or incomplete players have no projection.`);
  if (players.some(player => player.games === null)) warnings.push('Some players have no projected games. Availability is not estimated for those players.');
  warnings.push('The import season and per-game/season-total choice are supplied by you; verify both against your export. Source rankings do not replace ESPN draft rankings.');
  return dataset(options.source, options.seasonId, options.importedAt ?? new Date().toISOString(), players, warnings);
}

const ESPN_STATS: Record<keyof DraftProjectionStats, string> = { pts: '0', reb: '6', ast: '3', stl: '2', blk: '1', tov: '11', three: '17', fgm: '13', fga: '14', ftm: '15', fta: '16' };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Accepts only this season’s full-season projection records, never actual/prior-season fallbacks. */
export function extractEspnDraftProjections(payload: unknown, seasonId: number, catalog: Pick<DraftPlayerCatalog, 'players' | 'espnSeasonId'>, importedAt = new Date().toISOString()): DraftProjectionDataset {
  if (seasonId !== catalog.espnSeasonId) throw new Error('These projections need the matching season’s ESPN player catalog.');
  const rows = object(payload)?.players;
  if (!Array.isArray(rows) || !rows.length || rows.length >= 2000) throw new Error('ESPN projections are missing or the player pool may be truncated.');
  const known = new Map(catalog.players.map(player => [player.id, player])), seen = new Set<number>(), players: DraftPlayerProjection[] = []; let excluded = 0;
  for (const row of rows) {
    const entry = object(row), player = object(entry?.player), id = player?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || entry?.id !== id || seen.has(id)) throw new Error('ESPN returned duplicate or conflicting player identities.');
    seen.add(id);
    const records = Array.isArray(player?.stats) ? player.stats.map(object).filter(record => record?.seasonId === seasonId && record.statSourceId === 1 && record.statSplitTypeId === 0 && record.scoringPeriodId === 0) : [];
    if (records.length > 1) throw new Error('ESPN returned conflicting full-season projections.');
    const record = records[0], averages = object(record?.averageStats), totals = object(record?.stats), knownPlayer = known.get(id);
    if (!record || !averages || !knownPlayer) { excluded++; continue; }
    const rawStats = Object.fromEntries(Object.entries(ESPN_STATS).map(([key, statId]) => [key, averages[statId]]));
    const checked = draftProjectionStatsSchema.safeParse(rawStats);
    if (!checked.success) { excluded++; continue; }
    // ESPN's GP stat is 42; appliedTotal is fantasy points and must not be used as games.
    const rawGames = totals?.['42'];
    if (rawGames !== undefined && rawGames !== null && (typeof rawGames !== 'number' || !Number.isFinite(rawGames) || rawGames < 0 || rawGames > 82)) { excluded++; continue; }
    const games = typeof rawGames === 'number' && Number.isFinite(rawGames) && rawGames >= 0 && rawGames <= 82 ? rawGames : null;
    players.push({ id, name: knownPlayer.name, games, stats: checked.data });
  }
  if (!players.length) throw new Error('ESPN did not return complete projections for this season. Import a current projection export instead.');
  const warnings = excluded ? [`${excluded} ESPN players have no complete current-season projection or matching catalog identity and were excluded. Actual statistics were not substituted.`] : [];
  if (players.some(player => player.games === null)) warnings.push('ESPN did not provide projected games for some players; their availability is not estimated.');
  return dataset('espn', seasonId, importedAt, players, warnings);
}
