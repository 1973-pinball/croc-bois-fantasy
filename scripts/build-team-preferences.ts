import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { extractRosterPositions, type RosterPositionHistory, type PreferenceSource } from '../src/lib/roster-position-history';
import { extractCategoryPreferences, type CategoryPreferences } from '../src/lib/category-preferences';
import { extractDraftPlayerCatalog } from '../src/lib/draft-player-catalog';

/** Reads private captures; publishes only allowlisted counts and NBA player catalog fields. No credentials are needed. */
export async function buildTeamPreferences(inputDirectory = '.local/category-preferences', outputDirectory = 'data') {
  async function readSource(name: string) {
    const raw = await readFile(path.join(inputDirectory, `${name}.json`), 'utf8');
    const source = JSON.parse(await readFile(path.join(inputDirectory, `${name}.source.json`), 'utf8')) as PreferenceSource;
    if (createHash('sha256').update(raw).digest('hex') !== source.sha256) throw new Error(`Source hash mismatch for ${name}.`);
    const parsed = JSON.parse(raw);
    return { payload: Array.isArray(parsed) ? parsed[0] : parsed, source: { sha256: source.sha256, url: source.url, capturedAt: source.capturedAt } };
  }
  const roster: RosterPositionHistory = { version: 1, leagueId: 139935, coverage: { draftYears: [], limitations: [
    'One captured end-of-season roster per franchise and ESPN season; these are not draft selections or daily season averages.',
    'Primary position comes from the player record returned by each season-specific ESPN endpoint. Eligible slots are not counted repeatedly. Bench and injured-reserve players remain roster members.',
    'Average counts and shares give each recorded season equal weight. Unknown positions and missing snapshots remain explicit; no current roster is used to fill a missing older season.',
    'Draft year means the starting calendar year of the NBA season. Franchise identity continues across manager changes.',
  ] }, seasons: [] };
  const categories: CategoryPreferences = { version: 1, leagueId: 139935, coverage: { draftYears: [], limitations: [
    'Only completed regular-season matchups with observed nonzero scoring and official paired category results contribute. Playoffs, future matchups and unscored cancelled weeks are excluded.',
    'Category win rate is (wins + half of ties) divided by recorded decisions. Missing category results are not losses; each category exposes its own denominator.',
    'Category results describe outcomes rather than proving an owner intended to focus on a category. Franchise identity continues across manager changes.',
  ] }, seasons: [] };
  for (let season = 2018; season <= 2026; season += 1) {
    const { payload, source } = await readSource(`espn-${season}`);
    if (payload.seasonId !== season) throw new Error(`Unexpected season in ${season} source.`);
    roster.seasons.push(extractRosterPositions(payload, source));
    const extracted = extractCategoryPreferences(payload, source);
    if (extracted.teams.some(team => team.standingsMatch === false)) throw new Error(`Category outcomes do not reconcile with ${season} regular-season standings.`);
    categories.seasons.push(extracted);
  }
  roster.coverage.draftYears = roster.seasons.map(season => season.draftYear);
  categories.coverage.draftYears = categories.seasons.map(season => season.draftYear);
  const league = await readSource('espn-2027');
  const players = await readSource('espn-2027-players');
  const catalog = extractDraftPlayerCatalog(players.payload, league.payload, players.source);
  await Promise.all([
    writeFile(path.join(outputDirectory, 'roster-position-history.json'), JSON.stringify(roster, null, 2) + '\n'),
    writeFile(path.join(outputDirectory, 'category-preferences.json'), JSON.stringify(categories, null, 2) + '\n'),
    writeFile(path.join(outputDirectory, 'draft-player-catalog.json'), JSON.stringify(catalog, null, 2) + '\n'),
  ]);
  return { rosterSeasons: roster.seasons.length, categorySeasons: categories.seasons.length, playerCatalog: catalog.coverage };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildTeamPreferences(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify(result)), error => { console.error(error instanceof Error ? error.message : 'Preference extraction failed.'); process.exitCode = 1; });
}
