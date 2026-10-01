import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPlayoffSeason, extractSeasonStatistics, validatePlayoffSeason, type FranchiseMap, type PlayoffHistory, type PlayoffSeason, type StatisticsOnlySeason, type PlayoffProvenance } from '../src/lib/playoff-history';

interface ImportOptions { paths: string[]; mapping: FranchiseMap; leagueId: number; outputPath?: string }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

/** Local files only. Published fields are selected by the pure extractor. */
export async function importPlayoffHistory(options: ImportOptions): Promise<PlayoffHistory> {
  if (!options.paths.length) throw new Error('Supply at least one explicit local JSON file path.');
  const imported: PlayoffSeason[] = [];
  const statisticsOnly: StatisticsOnlySeason[] = [];
  const seenYears = new Set<number>();
  for (const inputPath of options.paths) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) throw new Error('Network URLs are not import inputs. Supply a local export file.');
    const bytes = await readFile(inputPath);
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
    let payloads: unknown[], sourceKind: 'espn-local-json' | 'espn-browser-export' = 'espn-local-json';
    let exportedAt: string | undefined;
    if (Array.isArray(parsed)) payloads = parsed;
    else {
      const top = object(parsed, 'Playoff export');
      if ('seasons' in top) {
        if (top.source !== 'espn-browser-export' || top.leagueId !== options.leagueId || !Array.isArray(top.seasons)) throw new Error('Browser export source, league ID, or seasons list is invalid.');
        if (typeof top.exportedAt !== 'string' || !Number.isFinite(Date.parse(top.exportedAt))) throw new Error('Browser export timestamp is required.');
        exportedAt = top.exportedAt; payloads = top.seasons; sourceKind = 'espn-browser-export';
      } else payloads = [top];
    }
    if (payloads.length === 0) throw new Error('The export contains no successful season payloads. Failures cannot become qualification records.');
    for (const payload of payloads) {
      const raw = object(payload, 'ESPN season payload');
      const provenance = raw.exportSource === undefined ? null : object(raw.exportSource, 'Season provenance');
      if (sourceKind === 'espn-browser-export' && (!provenance || typeof provenance.url !== 'string' || typeof provenance.fetchedAt !== 'string')) throw new Error('Each browser-exported season must carry its source URL and fetch timestamp.');
      const source: PlayoffProvenance = {
        leagueId: options.leagueId, sourceSha256, sourceKind,
        ...(provenance?.url !== undefined ? { sourceUrl: String(provenance.url) } : {}),
        ...(provenance?.fetchedAt !== undefined || exportedAt ? { capturedAt: String(provenance?.fetchedAt || exportedAt) } : {}),
      };
      if (!Array.isArray(raw.schedule)) throw new Error('A season schedule array is required, including an explicit empty array for unavailable brackets.');
      const hasChampionship = raw.schedule.some(matchup => matchup && typeof matchup === 'object' && (matchup as Record<string, unknown>).playoffTierType === 'WINNERS_BRACKET');
      const season = hasChampionship ? extractPlayoffSeason(raw, options.mapping, source) : extractSeasonStatistics(raw, options.mapping, source);
      if (seenYears.has(season.draftYear)) throw new Error(`Repeated season ${season.draftYear} across supplied exports; reconcile duplicates before importing.`);
      seenYears.add(season.draftYear);
      if ('qualificationStatus' in season) statisticsOnly.push(season); else imported.push(season);
    }
  }
  const outputPath = options.outputPath || 'data/playoff-history.json';
  let previous: PlayoffHistory | null = null;
  try { previous = JSON.parse(await readFile(outputPath, 'utf8')) as PlayoffHistory; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous && (previous.version !== 1 || previous.leagueId !== options.leagueId || !Array.isArray(previous.seasons))) throw new Error('Existing playoff-history output has an incompatible version or league.');
  const merged = new Map<number, PlayoffSeason>();
  for (const season of previous?.seasons || []) {
    validatePlayoffSeason(season);
    if (season.source.leagueId !== options.leagueId || merged.has(season.draftYear)) throw new Error('Existing playoff history has conflicting league or duplicate-season records.');
    merged.set(season.draftYear, season);
  }
  for (const season of imported) {
    const existing = merged.get(season.draftYear);
    if (existing) {
      const facts = (item: PlayoffSeason) => ({ draftYear: item.draftYear, espnSeasonId: item.espnSeasonId, priorSeasonStartYear: item.priorSeasonStartYear, playoffTeamCount: item.playoffTeamCount, firstChampionshipMatchupPeriod: item.firstChampionshipMatchupPeriod, participants: item.participants, qualifiedFranchiseIds: item.qualifiedFranchiseIds, championFranchiseId: item.championFranchiseId, matchups: item.source.matchups, championship: item.source.championship });
      if (JSON.stringify(facts(existing)) !== JSON.stringify(facts(season))) throw new Error(`Season ${season.draftYear} already has conflicting recorded facts. Review that record explicitly before replacement.`);
      if (existing.source.sha256 !== season.source.sha256 && !(existing.additionalSourceEvidence || []).some(source => source.sha256 === season.source.sha256 && source.url === season.source.url)) {
        const { kind, leagueId, sha256, url, capturedAt, paths } = season.source;
        existing.additionalSourceEvidence = [...(existing.additionalSourceEvidence || []), { kind, leagueId, sha256, ...(url ? { url } : {}), ...(capturedAt ? { capturedAt } : {}), paths }];
      }
    } else merged.set(season.draftYear, season);
  }
  const partial = new Map<number, StatisticsOnlySeason>();
  for (const season of [...(previous?.statsOnlySeasons || []), ...statisticsOnly]) {
    if (season.qualificationStatus !== 'unverified' || season.draftYear !== season.espnSeasonId || season.priorSeasonStartYear !== season.espnSeasonId - 1 || season.source.leagueId !== options.leagueId) throw new Error('Existing statistics-only season metadata is invalid.');
    const existing = partial.get(season.draftYear);
    if (existing && JSON.stringify(existing.participants) !== JSON.stringify(season.participants)) throw new Error(`Season ${season.draftYear} has conflicting observed category results; review before replacing.`);
    if (!existing) partial.set(season.draftYear, season);
  }
  const result: PlayoffHistory = { version: 1, leagueId: options.leagueId, seasons: [...merged.values()].sort((a, b) => a.draftYear - b.draftYear), ...(partial.size ? { statsOnlySeasons: [...partial.values()].sort((a, b) => a.draftYear - b.draftYear) } : {}) };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function main() {
  const args = process.argv.slice(2), paths: string[] = [];
  let leagueId = 139935, outputPath = 'data/playoff-history.json', mapping: Record<string, string> | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--league-id' || argument === '--output' || argument === '--map') {
      const value = args[++index]; if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--league-id') leagueId = Number(value);
      if (argument === '--output') outputPath = value;
      if (argument === '--map') {
        mapping = {};
        for (const pair of value.split(',')) {
          const match = /^([1-9]\d*):([1-9]\d*)$/.exec(pair);
          if (!match || mapping[match[1]]) throw new Error('Use an explicit, unique ESPN-to-franchise mapping such as --map 1:1,2:2.');
          mapping[match[1]] = match[2];
        }
      }
    } else if (argument.startsWith('--')) throw new Error(`Unknown argument ${argument}.`);
    else paths.push(argument);
  }
  if (!mapping) throw new Error('An explicit --map of verified ESPN team IDs to league franchise IDs is required.');
  if (!Number.isSafeInteger(leagueId) || leagueId < 1) throw new Error('--league-id must be a positive integer.');
  const result = await importPlayoffHistory({ paths, mapping, leagueId, outputPath });
  console.log(JSON.stringify({ output: outputPath, seasons: result.seasons.map(season => ({ draftYear: season.draftYear, qualifiedFranchiseIds: season.qualifiedFranchiseIds })), statsOnlyYears: result.statsOnlySeasons?.map(season => season.draftYear) || [] }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : 'Playoff import failed.'); process.exitCode = 1; });
