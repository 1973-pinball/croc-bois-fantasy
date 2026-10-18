import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import identities from '../../data/identities.json';
import { validateDraftScheduleWindow } from '../../src/lib/draft-advisor-schedule';
import * as projectionRanks from '../../src/lib/draft-projection-ranks';
import * as draftToolAccess from '../../src/lib/draft-tool-access';
import type { DraftProjectionDataset } from '../../src/lib/draft-projections';

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

type FixtureOptions = {
  role?: string | null; userId?: string | null; active?: boolean; authError?: boolean; membershipError?: boolean; seasonError?: boolean; configured?: boolean; serviceError?: string;
  projectionDataset?: DraftProjectionDataset; rankSnapshot?: unknown; rpcError?: { code?: string; message: string }; rpcThrow?: boolean;
  assignmentError?: boolean; assignment?: Partial<{ user_id: string; league_id: string; manager_id: string; franchise_id: string; effective_from: string; effective_to: string | null }> | null;
};
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [], filters: { table: string; values: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    auth: { getUser: async () => { calls.push('auth'); return { data: { user: options.userId === null ? null : { id: options.userId ?? 'fixture-commissioner' } }, error: options.authError ? { message: 'Invalid auth' } : null }; } },
    from: (table: string) => {
      assert.ok(['league_memberships', 'manager_assignments', 'seasons'].includes(table), 'The private advisor must not write into another table.');
      const values: Record<string, unknown> = {}; filters.push({ table, values }); calls.push(table);
      const query = {
        select: (_fields: string) => query,
        eq: (key: string, value: unknown) => { values[key] = value; return query; },
        lte: (key: string, value: unknown) => { values[`lte:${key}`] = value; return query; },
        or: (value: string) => { values.or = value; return query; },
        then: (resolve: (result: { data: unknown[]; error: { message: string } | null }) => unknown) => {
          assert.equal(table, 'manager_assignments');
          assert.equal(values.league_id, identities.leagueId);
          assert.equal(values.user_id, options.userId ?? 'fixture-commissioner');
          assert.equal(typeof values['lte:effective_from'], 'string');
          assert.match(String(values.or), /^effective_to\.is\.null,effective_to\.gt\./);
          const assignment = options.assignment === undefined || options.assignment === null ? null : {
            user_id: options.userId ?? 'fixture-commissioner', league_id: identities.leagueId,
            manager_id: draftToolAccess.DRAFT_TOOL_MANAGER_ID, franchise_id: draftToolAccess.DRAFT_TOOL_FRANCHISE_ID,
            effective_from: '2026-01-01T00:00:00Z', effective_to: null, ...options.assignment,
          };
          return Promise.resolve(resolve({ data: assignment ? [assignment] : [], error: options.assignmentError ? { message: 'Unavailable' } : null }));
        },
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.ok(['get_draft_provider_ranks', 'save_draft_provider_ranks'].includes(name));
      calls.push(name); rpcCalls.push({ name, args });
      assert.equal(args.p_season, identities.seasonId);
      assert.deepEqual(Object.keys(args).sort(), name === 'get_draft_provider_ranks' ? ['p_season', 'p_source'] : ['p_season', 'p_snapshot']);
      if (options.rpcThrow) throw new Error('Private database connection failed; internal detail');
      if (options.rpcError) return { data: null, error: options.rpcError };
      if (options.active === false || options.role === null || (options.role !== undefined && options.role !== 'commissioner')) return { data: null, error: { code: '42501', message: 'Commissioner access required' } };
      return { data: options.rankSnapshot !== undefined ? options.rankSnapshot : name === 'save_draft_provider_ranks' ? args.p_snapshot : null, error: null };
    },
  };
  const http = moduleWithDependencies('../../src/lib/supabase/http.ts', {
    'next/server': require('next/server'), './server': { createClient: async () => options.configured === false ? null : db }, './config': { SETUP_MESSAGE: 'Fixture setup is unavailable.' },
  });
  const access = moduleWithDependencies('../../src/lib/draft-tool-access-server.ts', {
    'server-only': {}, '../../data/identities.json': identities, './draft-tool-access': draftToolAccess,
  });
  const service = (kind: string, output: unknown) => (args: unknown, serviceOptions?: unknown) => { calls.push(kind); if (options.serviceError) throw new Error(options.serviceError); return kind !== 'schedule' && options.projectionDataset ? options.projectionDataset : { ...output as object, args, ...(serviceOptions ? { serviceOptions } : {}) }; };
  const projections = moduleWithDependencies('../../src/app/api/draft-projections/route.ts', {
    zod: require('zod'), '../../../../data/identities.json': identities, '@/lib/supabase/http': http,
    '@/lib/draft-tool-access-server': access,
    '@/lib/draft-projection-ranks': projectionRanks,
    '@/lib/draft-projection-service': { importEspnDraftProjections: service('espn', { marker: 'projection-result' }), importYahooDraftProjections: service('yahoo', { marker: 'projection-result' }), importDraftProjectionText: service('text', { marker: 'projection-result' }) },
  });
  const ranks = moduleWithDependencies('../../src/app/api/draft-projection-ranks/route.ts', {
    zod: require('zod'), '../../../../data/identities.json': identities, '@/lib/supabase/http': http,
    '@/lib/draft-projection-ranks': projectionRanks,
  });
  const schedule = moduleWithDependencies('../../src/app/api/draft-schedule/route.ts', {
    '../../../../data/identities.json': identities, '@/lib/supabase/http': http,
    '@/lib/draft-tool-access-server': access,
    '@/lib/draft-advisor-schedule-server': { fetchDraftAdvisorSchedule: service('schedule', { marker: 'schedule-result' }) },
    '@/lib/draft-advisor-schedule': { validateDraftScheduleWindow },
  });
  return { post: projections.POST as Handler, get: schedule.GET as Handler, getRanks: ranks.GET as Handler, calls, filters, rpcCalls };
}
const origin = 'https://league.example.invalid';
const body = { action: 'espn', seasonId: identities.seasonId };
function request(payload: unknown = body, suppliedOrigin: string | null = origin) {
  return new Request(`${origin}/api/draft-projections`, { method: 'POST', headers: { ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
function scheduleRequest(query = 'seasonId=2027&startDate=2026-10-20') { return new Request(`${origin}/api/draft-schedule?${query}`); }
function rankRequest(query = `seasonId=${identities.seasonId}`) { return new Request(`${origin}/api/draft-projection-ranks?${query}`); }
function rankedDataset(source: DraftProjectionDataset['source'] = 'basketball-monster'): DraftProjectionDataset {
  return { source, sourceLabel: 'Private fixture import', seasonId: 2027, importedAt: '2026-10-14T12:00:00.000Z', warnings: [],
    players: [1, 2, 3].map(id => ({ id, name: `Fixture player ${id}`, games: 70, ...(id < 3 ? { providerRank: id + 2 } : {}),
      stats: { pts: 20, reb: 5, ast: 5, stl: 1, blk: 1, tov: 2, three: 2, fgm: 7, fga: 14, ftm: 4, fta: 5 } })) };
}
const rankedImport = { action: 'import', seasonId: identities.seasonId, source: 'basketball-monster', basis: 'per-game', text: 'fixture-csv' };
const rankSnapshot = () => ({ source: 'basketball-monster', seasonId: 2027, importedAt: '2026-10-14T12:00:00.000Z', ranks: [{ id: 1, providerRank: 3 }, { id: 2, providerRank: 4 }] });

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
    const expectedRead = options.role === 'manager' ? ['auth', 'league_memberships', 'manager_assignments'] : ['auth', 'league_memberships'];
    assert.deepEqual(app.calls, [...expectedRead, ...expectedRead]);
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

test('Sebastian’s verified current assignment grants read access to direct projections and the complete schedule only', async () => {
  const app = fixture({ role: 'manager', userId: draftToolAccess.DRAFT_TOOL_USER_ID, assignment: {} });
  for (const action of ['espn', 'yahoo']) {
    const response = await app.post(request({ ...body, action }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await response.json()).dataset.args, 2027);
  }
  const schedule = await app.get(scheduleRequest('seasonId=2027&scope=season'));
  assert.equal(schedule.status, 200); assert.equal(schedule.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await schedule.json()).schedule.args, { seasonId: 2027, scope: 'season' });
  for (const source of ['espn', 'yahoo', 'basketball-monster']) {
    assert.equal((await app.post(request({ ...rankedImport, source }))).status, 403);
  }
  assert.equal((await app.get(scheduleRequest())).status, 403);
  assert.equal((await app.getRanks(rankRequest())).status, 403);
  assert.ok(!app.calls.includes('text'));
  assert.ok(!app.rpcCalls.some(call => call.name === 'save_draft_provider_ranks'));
});

test('another manager, same-team co-manager, another franchise, and invalid assignment dates cannot obtain the restricted capability', async () => {
  const assignments = [
    null, { manager_id: 'another-manager' }, { franchise_id: identities.franchises['2'] }, { user_id: 'another-account' }, { league_id: 'another-league' },
    { effective_from: '2099-01-01T00:00:00Z' }, { effective_from: 'invalid' }, { effective_to: '2026-01-01T00:00:00Z' }, { effective_to: 'invalid' },
  ];
  for (const assignment of assignments) {
    const app = fixture({ role: 'manager', userId: draftToolAccess.DRAFT_TOOL_USER_ID, assignment });
    assert.equal((await app.post(request())).status, 403);
    assert.equal((await app.get(scheduleRequest('seasonId=2027&scope=season'))).status, 403);
    assert.ok(!app.calls.some(call => ['espn', 'yahoo', 'text', 'schedule', 'seasons'].includes(call)));
  }
  for (const options of [{ role: 'viewer' }, { active: false }, { role: null }]) {
    const app = fixture({ role: 'manager', userId: draftToolAccess.DRAFT_TOOL_USER_ID, assignment: {}, ...options });
    assert.equal((await app.post(request())).status, 403);
    assert.ok(!app.calls.includes('manager_assignments'));
  }
});

test('revoking Sebastian’s assignment or membership blocks the next read and assignment failures fail closed', async () => {
  for (const revoke of [(options: FixtureOptions) => { options.assignment = null; }, (options: FixtureOptions) => { options.active = false; }]) {
    const options: FixtureOptions = { role: 'manager', userId: draftToolAccess.DRAFT_TOOL_USER_ID, assignment: {} }, app = fixture(options);
    assert.equal((await app.post(request())).status, 200);
    revoke(options);
    assert.equal((await app.post(request())).status, 403);
    assert.equal((await app.get(scheduleRequest('seasonId=2027&scope=season'))).status, 403);
    assert.equal(app.calls.filter(call => call === 'espn').length, 1);
  }
  const unavailable = fixture({ role: 'manager', userId: draftToolAccess.DRAFT_TOOL_USER_ID, assignment: {}, assignmentError: true });
  for (const response of [await unavailable.post(request()), await unavailable.get(scheduleRequest('seasonId=2027&scope=season'))]) {
    assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.ok(!unavailable.calls.some(call => ['espn', 'schedule', 'seasons'].includes(call)));
});

test('a different account cannot inherit Draft Tool access even if it is linked to Sebastian’s manager identity', async () => {
  const app = fixture({ role: 'manager', userId: 'another-account', assignment: {} });
  assert.equal((await app.post(request())).status, 403);
  assert.equal((await app.get(scheduleRequest('seasonId=2027&scope=season'))).status, 403);
  assert.ok(!app.calls.some(call => ['espn', 'schedule', 'seasons'].includes(call)));
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

test('private rank restoration requires a valid session and active commissioner authorization on every request', async () => {
  for (const [options, status] of [[{ userId: null }, 401], [{ authError: true }, 401], [{ role: 'manager' }, 403], [{ role: null }, 403], [{ active: false }, 403], [{ configured: false }, 503]] as const) {
    const app = fixture(options), response = await app.getRanks(rankRequest());
    assert.equal(response.status, status); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.ok(!('snapshot' in await response.json()));
  }
  const options: FixtureOptions = { role: 'commissioner', rankSnapshot: rankSnapshot() }, app = fixture(options);
  assert.equal((await app.getRanks(rankRequest())).status, 200);
  options.role = 'manager'; assert.equal((await app.getRanks(rankRequest())).status, 403);
});

test('rank restoration uses the verified season and fixed BBM source, never a caller-selected account or paid public cache', async () => {
  const saved = rankSnapshot(), app = fixture({ rankSnapshot: saved });
  const response = await app.getRanks(rankRequest(`seasonId=${identities.seasonId}&source=yahoo&userId=another-account`));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), { snapshot: saved });
  assert.deepEqual(app.rpcCalls, [{ name: 'get_draft_provider_ranks', args: { p_season: identities.seasonId, p_source: 'basketball-monster' } }]);
  assert.ok(!app.calls.some(call => ['espn', 'yahoo', 'text', 'schedule'].includes(call)));
  assert.deepEqual(await (await fixture().getRanks(rankRequest())).json(), { snapshot: null });
  for (const query of ['', 'seasonId=invalid', 'seasonId=00000000-0000-4000-8000-000000000000']) {
    const invalid = fixture(); assert.equal((await invalid.getRanks(rankRequest(query))).status, 400); assert.equal(invalid.rpcCalls.length, 0);
  }
  const unavailable = fixture({ seasonError: true }); assert.equal((await unavailable.getRanks(rankRequest())).status, 503); assert.equal(unavailable.rpcCalls.length, 0);
});

test('invalid or mismatched saved ranks fail closed without returning the payload or internal database error', async () => {
  for (const saved of [{}, { ...rankSnapshot(), source: 'yahoo' }, { ...rankSnapshot(), seasonId: 2028 }, { ...rankSnapshot(), ranks: [{ id: 1, providerRank: 0 }] }]) {
    const response = await fixture({ rankSnapshot: saved }).getRanks(rankRequest());
    assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await response.json()).error, 'RANKS_UNAVAILABLE');
  }
  const response = await fixture({ rpcError: { message: 'Private internal rank storage detail' } }).getRanks(rankRequest());
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes('Private internal'));
});

test('BBM imports save only supplied rank fields to the authenticated account while preserving every projection statistic', async () => {
  const dataset = rankedDataset(), before = structuredClone(dataset), app = fixture({ projectionDataset: dataset });
  const response = await app.post(request(rankedImport));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), { dataset, rankSnapshot: rankSnapshot() });
  assert.deepEqual(app.rpcCalls, [{ name: 'save_draft_provider_ranks', args: { p_season: identities.seasonId, p_snapshot: rankSnapshot() } }]);
  assert.deepEqual(dataset, before);
  const stored = JSON.stringify(app.rpcCalls[0].args.p_snapshot);
  for (const privateField of ['name', 'stats', 'games', 'text', 'warnings', 'sourceLabel', 'userId']) assert.ok(!stored.includes(`"${privateField}"`));
});

test('unranked BBM imports and other providers never invent or persist BBM ranks', async () => {
  const unranked = rankedDataset(); unranked.players.forEach(player => { delete player.providerRank; });
  for (const dataset of [unranked, rankedDataset('espn'), rankedDataset('yahoo')]) {
    const app = fixture({ projectionDataset: dataset });
    const response = await app.post(request({ ...rankedImport, source: dataset.source }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { dataset }); assert.equal(app.rpcCalls.length, 0);
  }
});

test('private rank persistence failures preserve the usable import and never return internal errors', async () => {
  const dataset = rankedDataset();
  for (const options of [{ rpcError: { message: 'Private storage detail' } }, { rpcThrow: true }, { rankSnapshot: {} }, { rankSnapshot: { ...rankSnapshot(), source: 'yahoo' } }, { rankSnapshot: { ...rankSnapshot(), seasonId: 2028 } }]) {
    const response = await fixture({ ...options, projectionDataset: dataset }).post(request(rankedImport));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const result = await response.json(); assert.deepEqual(result.dataset, dataset); assert.match(result.rankSaveError, /could not be saved/);
    assert.equal(result.rankSnapshot, undefined); assert.ok(!JSON.stringify(result).includes('Private storage detail'));
  }
});

test('a retained newer private snapshot is returned without changing the imported projection statistics', async () => {
  const dataset = rankedDataset(), saved = { ...rankSnapshot(), importedAt: '2026-10-15T12:00:00.000Z' };
  saved.ranks[0].providerRank = 6;
  const response = await fixture({ projectionDataset: dataset, rankSnapshot: saved }).post(request(rankedImport));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { dataset, rankSnapshot: saved });
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
