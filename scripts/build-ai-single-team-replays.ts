import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiSingleTeamIdentity, AiSingleTeamInput, AiSingleTeamReport } from '../src/lib/ai-single-team-types';

// Run with `pnpm exec tsx scripts/build-ai-single-team-replays.ts`.
// `--fetch-only` stops after sanitized cache collection; `--refresh-metadata` refreshes season provenance.
// No ESPN writes or changes to the separate whole-league experiment are performed.

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_VERSION = 1;
const LEAGUE_ID = 139935;
const CACHE_DIRECTORY = path.join(WORKSPACE, '.local', 'ai-single-team');
const OUTPUT_FILE = path.join(WORKSPACE, 'data', 'ai-single-team-replays.json');

type CacheEnvelope = { version: number; leagueId: number; season: number; key: string; sha256: string; payload: unknown };
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only trusted workspace targets are accepted; temporary files stay beside the final artifact. */
export function workspacePath(target: string): string {
  const resolved = path.resolve(target);
  const relative = path.relative(WORKSPACE, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Target must stay inside the workspace.');
  return resolved;
}

export async function writeAtomicJson(target: string, value: unknown): Promise<void> {
  const destination = workspacePath(target);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = workspacePath(`${destination}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

/** Corrupt or mismatched entries are discarded as cache misses; semantic validation remains mandatory. */
export async function readVerifiedCache<T>(season: number, key: string, validate: (value: unknown) => T): Promise<T | null> {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error('Invalid cache key.');
  const target = workspacePath(path.join(CACHE_DIRECTORY, String(season), `${key}.json`));
  let text: string;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const envelope = JSON.parse(text) as CacheEnvelope;
    if (envelope.version !== CACHE_VERSION || envelope.leagueId !== LEAGUE_ID || envelope.season !== season || envelope.key !== key || !/^[a-f0-9]{64}$/.test(envelope.sha256) || sha256(envelope.payload) !== envelope.sha256) return null;
    return validate(envelope.payload);
  } catch { return null; }
}

export async function saveVerifiedCache(season: number, key: string, payload: unknown): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error('Invalid cache key.');
  await writeAtomicJson(path.join(CACHE_DIRECTORY, String(season), `${key}.json`), {
    version: CACHE_VERSION, leagueId: LEAGUE_ID, season, key, sha256: sha256(payload), payload,
  } satisfies CacheEnvelope);
}

/** Shared cursor preserves source order without exceeding the provider's concurrency budget. */
export async function mapFour<T, U>(values: readonly T[], task: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(values.length);
  let next = 0, failed = false;
  const failures: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { result[index] = await task(values[index], index); }
      catch (error) { failures.push(error); failed = true; }
    }
  }));
  if (failures.length) throw failures[0];
  return result;
}

function loadTrustedEnvironment() {
  for (const name of ['.env.local', '.env.sync.local', '.env.espn.local']) {
    const filename = path.join(WORKSPACE, name);
    if (existsSync(filename)) process.loadEnvFile(filename);
  }
}

export function assertPublishable(report: AiSingleTeamReport, input: AiSingleTeamInput): void {
  const dates = input.days.map(day => day.date);
  const sameDates = (actual: string[]) => actual.length === dates.length && actual.every((date, index) => date === dates[index]);
  const identities = Array.from({ length: 8 }, (_, index) => String(index + 1));
  const keys = new Set(report.scenarios.map(scenario => `${scenario.teamId}:${scenario.mode}`));
  if (input.season !== 2026 || dates.length !== 160 || input.matchups.filter(matchup => !matchup.playoff).length !== 72
    || input.officialScores.length !== 160 || !input.actualChampion || input.ownerDraft?.length !== 104
    || report.status !== 'complete' || !report.baseline.verified || report.baseline.issues.length
    || report.baseline.champion !== input.actualChampion || !sameDates(report.baseline.scoredDates)
    || report.coverage.expectedDates !== 160 || report.coverage.verifiedDates !== 160 || report.coverage.officialPeriods !== 20
    || report.scenarios.length !== 16 || keys.size !== 16
    || identities.some(id => !keys.has(`${id}:post_draft`) || !keys.has(`${id}:redraft`))
    || report.scenarios.some(scenario => scenario.status !== 'complete' || !scenario.champion || !sameDates(scenario.scoredDates))) {
    throw new Error('Public replay gate failed: complete source coverage, verified actual baseline, and all sixteen completed scenarios are required.');
  }
  for (const expected of input.expectedRegularRecords ?? []) {
    const actual = report.baseline.standings.find(row => row.teamId === expected.teamId);
    if (!actual || actual.wins !== expected.wins || actual.losses !== expected.losses || actual.ties !== expected.ties) throw new Error('Public replay gate failed: actual regular-season record mismatch.');
  }
}

async function main() {
  const arguments_ = new Set(process.argv.slice(2));
  if ([...arguments_].some(argument => !['--fetch-only', '--refresh-metadata'].includes(argument))) throw new Error('Supported options: --fetch-only, --refresh-metadata.');
  loadTrustedEnvironment();
  const source = await import('../src/lib/ai-single-team-source');
  let metadata = arguments_.has('--refresh-metadata') ? null : await readVerifiedCache(2026, 'metadata', source.validateAiSingleTeamMetadata);
  if (!metadata) {
    metadata = source.validateAiSingleTeamMetadata(await source.fetchAiSingleTeamMetadata());
    await saveVerifiedCache(2026, 'metadata', metadata);
  }
  console.log(JSON.stringify({ stage: 'source-ready', season: metadata.season, dates: metadata.dates.length, players: metadata.players.length, officialScores: metadata.officialScores.length, draftPicks: metadata.ownerDraft?.length, actualChampion: metadata.actualChampion }));
  let fetched = 0, reused = 0, completed = 0;
  const sourceFailures: string[] = [];
  const collected = await mapFour(metadata.dates, async date => {
    const key = `day-${date}`;
    let day = await readVerifiedCache(2026, key, value => source.validateAiSingleTeamDay(value, metadata!, date));
    if (day) reused++;
    else {
      try { day = source.validateAiSingleTeamDay(await source.fetchAiSingleTeamDay(metadata!, date), metadata!, date); }
      catch (error) {
        sourceFailures.push(`${date}: ${error instanceof Error ? error.message : 'Source validation failed.'}`);
        console.log(JSON.stringify({ stage: 'date-rejected', date, rejectedDates: sourceFailures.length }));
        return null;
      }
      await saveVerifiedCache(2026, key, day);
      fetched++;
    }
    completed++;
    if (completed % 10 === 0 || completed === metadata!.dates.length) console.log(JSON.stringify({ stage: 'daily-inputs', completed, expected: metadata!.dates.length, fetched, reused }));
    return day;
  });
  console.log(JSON.stringify({ stage: 'collection-complete', verifiedDates: completed, rejectedDates: sourceFailures.length, fetched, reused }));
  if (sourceFailures.length) throw new Error(`${sourceFailures.length} dates failed validation. ${sourceFailures.slice(0, 3).join(' ')}`);
  const days = collected.filter((day): day is NonNullable<typeof day> => day !== null);
  if (arguments_.has('--fetch-only')) return;
  const { buildAiSingleTeamReport } = await import('../src/lib/ai-single-team-engine');
  const league = JSON.parse(await readFile(path.join(WORKSPACE, 'data', 'league.json'), 'utf8')) as { teams: { id: number; name: string; shortName: string; color: string }[] };
  const teams: AiSingleTeamIdentity[] = league.teams.map(team => ({ id: String(team.id), name: team.name, shortName: team.shortName, color: team.color }));
  const { dates: _dates, nbaGames: _nbaGames, capturedAt: _capturedAt, sourceHash: _sourceHash, ...settings } = metadata;
  const input: AiSingleTeamInput = { ...settings, days };
  console.log(JSON.stringify({ stage: 'simulate', scenarios: 16, verifiedDates: days.length }));
  const report = buildAiSingleTeamReport(input, teams);
  await writeAtomicJson(path.join(CACHE_DIRECTORY, '2026', 'last-report.json'), report);
  assertPublishable(report, input);
  await writeAtomicJson(OUTPUT_FILE, report);
  console.log(JSON.stringify({ stage: 'published', season: report.season, bytes: Buffer.byteLength(JSON.stringify(report)), baselineVerified: report.baseline.verified, officialPeriods: report.coverage.officialPeriods, scenarios: report.scenarios.length, deltas: report.scenarios.map(scenario => {
    const actual = report.baseline.standings.find(row => row.teamId === scenario.teamId)!;
    const simulated = scenario.standings.find(row => row.teamId === scenario.teamId)!;
    return { teamId: scenario.teamId, mode: scenario.mode, categoryWinDelta: simulated.wins - actual.wins, champion: scenario.champion };
  }) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Source helpers emit only their own bounded validation messages, never private payloads or credentials.
    const message = error instanceof Error ? error.message : 'Unknown build failure.';
    console.error(JSON.stringify({ stage: 'failed', error: message.replace(/https?:\/\/\S+/g, '[source]').slice(0, 400) }));
    process.exitCode = 1;
  });
}
