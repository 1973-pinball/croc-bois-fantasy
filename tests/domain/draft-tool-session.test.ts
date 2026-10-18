import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import identities from '../../data/identities.json';
import * as access from '../../src/lib/draft-tool-access';

const require = createRequire(import.meta.url);
type Assignment = {
  user_id: string; league_id: string; manager_id: string; franchise_id: string; role: string;
  effective_from: string | null; effective_to: string | null;
};
const assigned = (): Assignment => ({
  user_id: access.DRAFT_TOOL_USER_ID, league_id: identities.leagueId, manager_id: access.DRAFT_TOOL_MANAGER_ID,
  franchise_id: access.DRAFT_TOOL_FRANCHISE_ID, role: 'manager', effective_from: '2026-01-01T00:00:00Z', effective_to: null,
});
function moduleWithDependencies(path: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected fixture dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
function fixture(options: { userId?: string | null; role?: string | null; assignments?: Assignment[]; databaseError?: boolean } = {}) {
  const userId = options.userId === undefined ? access.DRAFT_TOOL_USER_ID : options.userId;
  const queries: { table: string; filters: Record<string, unknown> }[] = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId, user_metadata: { full_name: 'Sebastian Rodriguez' } } : null }, error: null }) },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      queries.push({ table, filters });
      assert.ok(['league_memberships', 'manager_assignments'].includes(table));
      const query = {
        select: (fields: string) => { filters.select = fields; return query; },
        eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        lte: (key: string, value: unknown) => { filters[`lte:${key}`] = value; return query; },
        or: (value: string) => { filters.or = value; return query; },
        order: (_key: string) => query,
        then: (resolve: (result: { data: unknown[]; error: { message: string } | null }) => unknown) => {
          assert.equal(filters.user_id, userId);
          if (table === 'league_memberships') assert.equal(filters.active, true);
          else { assert.equal(typeof filters['lte:effective_from'], 'string'); assert.match(String(filters.or), /^effective_to\.is\.null,effective_to\.gt\./); }
          const data = table === 'league_memberships'
            ? options.role === null ? [] : [{ league_id: identities.leagueId, role: options.role ?? 'manager' }]
            : options.assignments ?? [assigned()];
          return Promise.resolve(resolve({ data, error: options.databaseError ? { message: 'Fixture database error' } : null }));
        },
      };
      return query;
    },
  };
  const http = moduleWithDependencies('../../src/lib/supabase/http.ts', {
    'next/server': require('next/server'), './server': { createClient: async () => client }, './config': { SETUP_MESSAGE: 'Fixture configuration' },
  });
  const route = moduleWithDependencies('../../src/app/api/session/route.ts', {
    '@supabase/supabase-js': { isAuthRetryableFetchError: () => false }, '@/lib/supabase/server': { createClient: async () => client },
    '@/lib/supabase/config': { isGoogleSignInEnabled: () => true, SETUP_MESSAGE: 'Fixture configuration' },
    '@/lib/supabase/http': http, '@/lib/draft-tool-access': access,
  });
  return { get: route.GET as () => Promise<Response>, queries };
}

test('session exposes only Sebastian’s restricted franchise capability and keeps his manager role', async () => {
  const app = fixture(), response = await app.get(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(body.draftToolAccess, { franchiseId: access.DRAFT_TOOL_FRANCHISE_ID });
  assert.deepEqual(body.memberships, [{ league_id: identities.leagueId, role: 'manager' }]);
  assert.equal(body.assignments.length, 1);
  assert.ok(!('manager_id' in body.assignments[0])); assert.ok(!('user_id' in body.assignments[0]));
});

test('session never grants restricted access from a profile name, a commissioner role, or a missing or revoked identity assignment', async () => {
  for (const options of [
    { userId: null }, { userId: 'different-account', assignments: [{ ...assigned(), user_id: 'different-account' }] },
    { role: 'commissioner' }, { role: 'viewer' }, { role: null }, { assignments: [] },
    { assignments: [{ ...assigned(), manager_id: 'different-manager' }] },
    { assignments: [{ ...assigned(), franchise_id: identities.franchises['2'] }] },
    { assignments: [{ ...assigned(), effective_from: null }] },
    { assignments: [{ ...assigned(), effective_from: '2099-01-01T00:00:00Z' }] },
    { assignments: [{ ...assigned(), effective_to: '2026-01-01T00:00:00Z' }] },
  ]) {
    const response = await fixture(options).get();
    assert.equal(response.status, 200); assert.equal((await response.json()).draftToolAccess, null);
  }
  const response = await fixture({ databaseError: true }).get();
  assert.equal(response.status, 503); assert.equal((await response.json()).draftToolAccess, undefined);
});

test('assignment boundaries require a current identity match without promoting the account to commissioner', () => {
  const now = Date.parse('2026-10-18T16:00:00Z'), memberships = [{ league_id: identities.leagueId, role: 'manager' }];
  const current = { ...assigned(), effective_from: new Date(now).toISOString() };
  assert.deepEqual(access.restrictedDraftToolAccess(access.DRAFT_TOOL_USER_ID, memberships, [current], now), { franchiseId: access.DRAFT_TOOL_FRANCHISE_ID });
  assert.equal(access.restrictedDraftToolAccess(access.DRAFT_TOOL_USER_ID, memberships, [{ ...current, effective_to: new Date(now).toISOString() }], now), null);
  assert.equal(access.restrictedDraftToolAccess(access.DRAFT_TOOL_USER_ID, memberships, [{ ...current, effective_to: 'invalid' }], now), null);
  assert.equal(access.restrictedDraftToolAccess(access.DRAFT_TOOL_USER_ID, [{ ...memberships[0], league_id: 'other-league' }], [current], now), null);
});
