import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import identities from '../../data/identities.json';
import { validateDraftScheduleWindow } from '../../src/lib/draft-advisor-schedule';

const require = createRequire(import.meta.url);
type Handler = (request: Request) => Promise<Response>;
/** Execute the actual handlers and HTTP helpers, replacing only their external service/auth boundaries. */
function moduleWithDependencies(path: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  const fixtureRequire = (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected fixture dependency: ${name}`);
    return dependencies[name];
  };
  new Function('require', 'exports', code)(fixtureRequire, exports);
  return exports;
}

type FixtureOptions = { role?: string | null; userId?: string | null; active?: boolean; authError?: boolean; membershipError?: boolean; seasonError?: boolean; configured?: boolean; serviceError?: string };
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [], filters: { table: string; values: Record<string, unknown> }[] = [];
  const db = {
    auth: { getUser: async () => { calls.push('auth'); return { data: { user: options.userId === null ? null : { id: options.userId ?? 'fixture-commissioner' } }, error: options.authError ? { message: 'Invalid auth' } : null }; } },
    from: (table: string) => {
      assert.ok(['league_memberships', 'seasons'].includes(table), 'The private advisor must not write into another table.');
      const values: Record<string, unknown> = {}; filters.push({ table, values }); calls.push(table);
      const query = {
        select: (_fields: string) => query,
        eq: (key: string, value: unknown) => { values[key] = value; return query; },
        maybeSingle: async () => {
          assert.equal(values.league_id, identities.leagueId);
          if (table === 'league_memberships') {
            assert.equal(values.user_id, options.userId ?? 'fixture-commissioner'); assert.equal(values.active, true);
            return { data: options.active === false || options.role === null ? null : { role: options.role ?? 'commissioner' }, error: options.membershipError ? { message: 'Unavailable' } : null };
          }
          return { data: values.id === identities.seasonId ? { draft_year: 2026 } : null, error: options.seasonError ? { message: 'Unavailable' } : null };
        },
      };
      return query;
    },
  };
  const http = moduleWithDependencies('../../src/lib/supabase/http.ts', {
    'next/server': require('next/server'), './server': { createClient: async () => options.configured === false ? null : db }, './config': { SETUP_MESSAGE: 'Fixture setup is unavailable.' },
  });
  const service = (kind: string, output: unknown) => (args: unknown, serviceOptions?: unknown) => { calls.push(kind); if (options.serviceError) throw new Error(options.serviceError); return { ...output as object, args, ...(serviceOptions ? { serviceOptions } : {}) }; };
  const projections = moduleWithDependencies('../../src/app/api/draft-projections/route.ts', {
    zod: require('zod'), '../../../../data/identities.json': identities, '@/lib/supabase/http': http,
    '@/lib/draft-projection-service': { importEspnDraftProjections: service('espn', { marker: 'projection-result' }), importYahooDraftProjections: service('yahoo', { marker: 'projection-result' }), importDraftProjectionText: service('text', { marker: 'projection-result' }) },
  });
  const schedule = moduleWithDependencies('../../src/app/api/draft-schedule/route.ts', {
    '../../../../data/identities.json': identities, '@/lib/supabase/http': http,
    '@/lib/draft-advisor-schedule-server': { fetchDraftAdvisorSchedule: service('schedule', { marker: 'schedule-result' }) },
    '@/lib/draft-advisor-schedule': { validateDraftScheduleWindow },
  });
  return { post: projections.POST as Handler, get: schedule.GET as Handler, calls, filters };
}
const origin = 'https://league.example.invalid';
const body = { action: 'espn', seasonId: identities.seasonId };
function request(payload: unknown = body, suppliedOrigin: string | null = origin) {
  return new Request(`${origin}/api/draft-projections`, { method: 'POST', headers: { ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
function scheduleRequest(query = 'seasonId=2027&startDate=2026-10-20') { return new Request(`${origin}/api/draft-schedule?${query}`); }

test('anonymous and invalid sessions cannot import or load schedule; source access never begins', async () => {
  for (const options of [{ userId: null }, { authError: true }]) {
    const app = fixture(options);
    for (const [handler, req] of [[app.post, request()], [app.get, scheduleRequest()]] as const) {
      const response = await handler(req);
      assert.equal(response.status, 401); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal((await response.json()).error, 'UNAUTHENTICATED');
    }
    assert.deepEqual(app.calls, ['auth', 'auth']);
  }
});

test('managers, inactive commissioners, and absent memberships receive 403 before any source or season read', async () => {
  for (const options of [{ role: 'manager' }, { role: 'viewer' }, { role: null }, { role: 'commissioner', active: false }]) {
    const app = fixture(options);
    assert.equal((await app.post(request())).status, 403);
    assert.equal((await app.get(scheduleRequest())).status, 403);
    assert.deepEqual(app.calls, ['auth', 'league_memberships', 'auth', 'league_memberships']);
  }
});

test('authorization failures are fail-closed and every endpoint response remains private', async () => {
  for (const options of [{ membershipError: true }, { configured: false }]) {
    const app = fixture(options);
    const responses = [await app.post(request()), await app.get(scheduleRequest())];
    for (const response of responses) { assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); }
    assert.ok(!app.calls.some(call => ['espn', 'text', 'schedule'].includes(call)));
  }
});

test('projection imports reject cross-origin or missing-origin requests before checking auth', async () => {
  for (const suppliedOrigin of ['https://attacker.invalid', null]) {
    const app = fixture(); const response = await app.post(request(body, suppliedOrigin));
    assert.equal(response.status, 403); assert.deepEqual(app.calls, []);
  }
});

test('the source receives only the verified league season, never caller-supplied endpoints or credentials', async () => {
  const app = fixture(); const response = await app.post(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await response.json()).dataset, { marker: 'projection-result', args: 2027 });
  assert.deepEqual(app.calls, ['auth', 'league_memberships', 'seasons', 'espn']);
  for (const extra of [{ url: 'https://attacker.invalid' }, { cookies: 'untrusted' }, { leagueId: 'another-league' }]) {
    const blocked = fixture(); assert.equal((await blocked.post(request({ ...body, ...extra }))).status, 400);
    assert.ok(!blocked.calls.includes('espn'));
  }
  const foreign = fixture(); assert.equal((await foreign.post(request({ ...body, seasonId: '00000000-0000-4000-8000-000000000000' }))).status, 400);
  assert.ok(!foreign.calls.includes('espn'));
});

test('revoking commissioner access blocks the next request even with the same authenticated session', async () => {
  const options: FixtureOptions = { role: 'commissioner' }, app = fixture(options);
  assert.equal((await app.post(request())).status, 200);
  options.role = 'manager';
  assert.equal((await app.post(request())).status, 403);
  assert.equal((await app.get(scheduleRequest())).status, 403);
  assert.equal(app.calls.filter(call => call === 'espn').length, 1);
});

test('text imports remain an explicit provider/basis request and oversized input never reaches the parser', async () => {
  const app = fixture();
  const response = await app.post(request({ action: 'import', seasonId: identities.seasonId, source: 'basketball-monster', basis: 'totals', text: 'fixture-csv' }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).dataset.args, { seasonId: 2027, source: 'basketball-monster', basis: 'totals', text: 'fixture-csv' });
  const large = fixture();
  const rejected = await large.post(request({ action: 'import', seasonId: identities.seasonId, source: 'yahoo', basis: 'per-game', text: 'x'.repeat(2_100_001) }));
  assert.equal(rejected.status, 400); assert.ok(!large.calls.includes('text'));
});

test('schedule validates season/window after authorization and sends no private account data to its public source', async () => {
  const app = fixture(); const response = await app.get(scheduleRequest());
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await response.json()).schedule.args, { seasonId: 2027, startDate: '2026-10-20' });
  const fullSeason = await app.get(scheduleRequest('seasonId=2027&scope=season'));
  assert.equal(fullSeason.status, 200);
  assert.deepEqual((await fullSeason.json()).schedule.args, { seasonId: 2027, scope: 'season' });
  for (const query of ['seasonId=https://attacker.invalid', 'seasonId=2027&startDate=2025-10-20', 'seasonId=2027&startDate=2026-02-30', 'seasonId=2027&scope=season&startDate=2026-10-20', 'seasonId=2027&scope=invalid']) {
    const invalid = fixture(); assert.equal((await invalid.get(scheduleRequest(query))).status, 400); assert.ok(!invalid.calls.includes('schedule'));
  }
});

test('Yahoo automatic imports use the same commissioner gate and verified season with private responses', async () => {
  const yahoo = { ...body, action: 'yahoo' };
  for (const options of [{ userId: null }, { role: 'manager' }, { role: 'commissioner', active: false }, { membershipError: true }]) {
    const app = fixture(options);
    assert.ok([401, 403, 503].includes((await app.post(request(yahoo))).status));
    assert.ok(!app.calls.includes('yahoo'));
  }
  const app = fixture(); const response = await app.post(request(yahoo));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await response.json()).dataset, { marker: 'projection-result', args: 2027, serviceOptions: {} });
  assert.deepEqual(app.calls, ['auth', 'league_memberships', 'seasons', 'yahoo']);
  const manual = await app.post(request({ ...yahoo, refresh: true }));
  assert.equal(manual.status, 200);
  assert.deepEqual((await manual.json()).dataset, { marker: 'projection-result', args: 2027, serviceOptions: { refresh: true } });
  const invalidRefresh = fixture();
  assert.equal((await invalidRefresh.post(request({ ...yahoo, refresh: 'yes' }))).status, 400);
  assert.ok(!invalidRefresh.calls.includes('yahoo'));
  for (const extra of [{ url: 'https://attacker.invalid' }, { cookies: 'untrusted' }, { leagueId: 'another-league' }]) {
    const blocked = fixture(); assert.equal((await blocked.post(request({ ...yahoo, ...extra }))).status, 400); assert.ok(!blocked.calls.includes('yahoo'));
  }
  const foreign = fixture(); assert.equal((await foreign.post(request({ ...yahoo, seasonId: '00000000-0000-4000-8000-000000000000' }))).status, 400);
  assert.ok(!foreign.calls.includes('yahoo'));
  const failure = fixture({ serviceError: 'Yahoo is limiting projection requests.' });
  const rejected = await failure.post(request(yahoo)); assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error, 'PROJECTION_IMPORT_FAILED');
});

test('Yahoo caches successful reads by season with their source timestamp, while manual refresh deduplicates and preserves cache on failure', async () => {
  type Dataset = { seasonId: number; importedAt: string };
  const calls: number[] = [];
  let resolveRead: ((dataset: Dataset) => void) | undefined;
  let rejectRead: ((reason: Error) => void) | undefined;
  const service = moduleWithDependencies('../../src/lib/draft-projection-service.ts', {
    'server-only': {}, '../../data/draft-player-catalog.json': { espnSeasonId: 2027, players: [] },
    './ai-league-feed': {}, './draft-projections': {}, './espn-history-sync-core': {},
    './yahoo-draft-projections': {
      fetchYahooDraftProjections: (seasonId: number) => {
        calls.push(seasonId);
        return new Promise<Dataset>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
      },
    },
  }).importYahooDraftProjections as (seasonId: number, options?: { refresh?: boolean }) => Promise<Dataset>;
  const original = { seasonId: 2027, importedAt: '2026-10-13T12:00:00.000Z' };
  const first = service(2027), concurrent = service(2027);
  assert.deepEqual(calls, [2027]);
  resolveRead!(original);
  assert.equal(await first, original); assert.equal(await concurrent, original);
  assert.equal(await service(2027), original); assert.deepEqual(calls, [2027]);
  const refresh = service(2027, { refresh: true }), secondRefresh = service(2027, { refresh: true });
  assert.deepEqual(calls, [2027, 2027]);
  const updated = { seasonId: 2027, importedAt: '2026-10-13T12:01:00.000Z' };
  resolveRead!(updated);
  assert.equal(await refresh, updated); assert.equal(await secondRefresh, updated);
  assert.equal(await service(2027), updated);
  const failed = service(2027, { refresh: true });
  rejectRead!(new Error('Rate limited'));
  await assert.rejects(failed, /Rate limited/);
  assert.equal(await service(2027), updated);
  const otherSeason = service(2028);
  assert.deepEqual(calls, [2027, 2027, 2027, 2028]);
  const future = { seasonId: 2028, importedAt: '2027-10-13T12:00:00.000Z' };
  resolveRead!(future); assert.equal(await otherSeason, future);
  assert.equal(await service(2027), updated);
});
