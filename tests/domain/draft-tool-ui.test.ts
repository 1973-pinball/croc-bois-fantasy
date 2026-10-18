import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import identities from '../../data/identities.json';
import { DRAFT_TOOL_FRANCHISE_ID, DRAFT_TOOL_USER_ID } from '../../src/lib/draft-tool-access';
import { leagueData } from '../../src/lib/league-data';
import type { DraftBoard } from '../../src/lib/draft-board';
import type { DraftForecastMode, DraftForecastRequestInput } from '../../src/lib/draft-forecast-request';
import type { LeagueAccount } from '../../src/components/league-account';

const require = createRequire(import.meta.url);
const noop = () => undefined;
const sourceCache = new Map<string, string>();

// Exercise the actual JSX and access branches with real React rendering. Only
// browser hooks and unrelated child widgets are replaced; no browser is needed.
function componentModule(path: string, dependencies: Record<string, unknown>) {
  const url = new URL(path, import.meta.url);
  let code = sourceCache.get(path);
  if (!code) {
    code = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    sourceCache.set(path, code);
  }
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', code)((name: string) => {
    if (name in dependencies) return dependencies[name];
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@/lib/')) return require(fileURLToPath(new URL(`../../src/lib/${name.slice(6)}`, import.meta.url)));
    if (name.endsWith('.json')) return require(fileURLToPath(new URL(name, url)));
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    throw new Error(`Unexpected component dependency: ${name}`);
  }, exports);
  return exports;
}

function account(overrides: Partial<LeagueAccount> = {}): LeagueAccount {
  return {
    session: { user: { id: DRAFT_TOOL_USER_ID }, memberships: [], assignments: [] },
    commissioner: false, draftToolFranchiseId: DRAFT_TOOL_FRANCHISE_ID,
    seasonId: identities.seasonId, connection: 'live', sessionLoading: false,
    // A stale team preference must not replace the explicitly granted franchise.
    ownTeamIds: [1], data: leagueData, live: null,
    franchiseId: (id: number) => id === 4 ? DRAFT_TOOL_FRANCHISE_ID : identities.franchises['1'],
    reloadSession: async () => undefined, reloadLeague: async () => undefined,
    keeperLateSubmissionOpen: () => false, keeperPlayersFrozen: () => false,
    ...overrides,
  } as LeagueAccount;
}

function board(): DraftBoard {
  return {
    seasonId: identities.seasonId, draftYear: 2026, phase: 'draft_ready', draftFormat: 'snake', roundCount: 13,
    revision: 2, keepersRevealedAt: '2026-10-18T12:00:00Z', orderComplete: true, orderLocked: true,
    nextPickId: null, picks: [],
    clock: { status: 'waiting', durationSeconds: 90, remainingSeconds: null, deadlineAt: null, startedAt: null, serverNow: '2026-10-18T12:00:00Z' },
    teams: [
      { franchiseId: identities.franchises['1'], espnTeamId: 1, displayName: 'Another manager’s team', draftPosition: 1 },
      { franchiseId: DRAFT_TOOL_FRANCHISE_ID, espnTeamId: 4, displayName: 'Sebastian’s team', draftPosition: 2 },
    ],
  };
}

function strategyFixture() {
  const analysisCalls: { input: DraftForecastRequestInput | null; mode: DraftForecastMode }[] = [];
  const mounts: string[] = [];
  const widget = (name: string) => () => { mounts.push(name); return createElement('div', { 'data-widget': name }, name); };
  const module = componentModule('../../src/components/commissioner-strategy-tools.tsx', {
    './use-advisor-board': { useAdvisorBoard: () => ({ board: board(), error: '', refreshing: false, refresh: noop, accept: noop }) },
    './use-draft-forecast': { useDraftForecast: (input: DraftForecastRequestInput | null, mode: DraftForecastMode) => {
      analysisCalls.push({ input, mode });
      return { report: null, resultMode: mode, busy: false, current: false, stale: false, error: '', progress: null, retry: noop };
    } },
    './keeper-comparison': { KeeperComparison: widget('keeper-comparison') },
    './draft-rosters': { DraftRosters: widget('draft-rosters') },
    './draft-candidate-table': { DraftCandidateTable: widget('available-players') },
    './draft-trade-editor': { DraftTradeEditor: widget('draft-trade-editor') },
  });
  const Component = module.CommissionerStrategyTools as ComponentType<{ account: LeagueAccount; view: 'draft' | 'keepers' }>;
  return { analysisCalls, mounts, render: (value = account(), view: 'draft' | 'keepers' = 'draft') => renderToStaticMarkup(createElement(Component, { account: value, view })) };
}

test('Sebastian’s Draft renders only the five requested sections and fixes analysis to his granted team', () => {
  const app = strategyFixture(), html = app.render();
  const summaries = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(match => match[1]);
  assert.deepEqual(summaries.filter(title => title !== 'How category values are calculated'), [
    'My team · projected category win rates', 'All-team projections · win rates and production',
    'Category values · team rankings and z-scores', 'Recommended pick · completed-roster forecast',
    'Available players · source ranks and roster fit',
  ]);
  assert.match(html, /My team: Sebastian’s team/);
  assert.match(html, /<h3>Sebastian’s team · completed-roster forecast<\/h3>/);
  assert.doesNotMatch(html, /<h3>Another manager’s team · completed-roster forecast<\/h3>/);
  assert.equal(app.analysisCalls.length, 1);
  assert.equal(app.analysisCalls[0].input?.franchiseId, DRAFT_TOOL_FRANCHISE_ID);
  assert.equal(app.analysisCalls[0].mode, 'completed');
  assert.deepEqual(app.mounts, ['available-players']);
  for (const denied of ['Private projection library', 'Projection source', 'Import CSV', 'My draft team', 'Analysis mode',
    'Draft analysis controls', 'Upload a full-season schedule', 'Record the next draft pick', 'Record on public board',
    'Draft rosters · every team', 'Category matchups · each opponent', 'Keeper Suggestions']) assert.ok(!html.includes(denied), denied);
  assert.doesNotMatch(html, /<(?:select|input|textarea)\b/);
});

test('unapproved accounts and restricted keeper requests never mount the strategy workspace', () => {
  for (const [value, view] of [
    [account({ draftToolFranchiseId: null }), 'draft'],
    [account({ session: null }), 'draft'],
    [account(), 'keepers'],
  ] as const) {
    const app = strategyFixture();
    assert.equal(app.render(value, view), '');
    assert.deepEqual(app.mounts, []); assert.deepEqual(app.analysisCalls, []);
  }
});

test('commissioners retain projection imports, team selection, official write tools and keeper analysis', () => {
  const app = strategyFixture(), commissioner = account({ commissioner: true, draftToolFranchiseId: null });
  const html = app.render(commissioner);
  for (const expected of ['Private projection library', 'My draft team', 'Analysis mode', 'Upload a full-season schedule',
    'Record the next draft pick', 'Record on public board', 'Draft rosters · every team', 'Category matchups · each opponent']) assert.ok(html.includes(expected), expected);
  assert.deepEqual(app.mounts, ['available-players', 'draft-trade-editor', 'draft-rosters']);
  assert.equal(app.analysisCalls[0].input?.franchiseId, identities.franchises['1']);
  const keeper = strategyFixture();
  assert.match(keeper.render(commissioner, 'keepers'), /Keeper Suggestions/);
  assert.deepEqual(keeper.mounts, ['keeper-comparison']);
});

function portalFixture(value: LeagueAccount, requestedView: string) {
  const strategyViews: string[] = [], adminMounts: string[] = [], practiceMounts: LeagueAccount[] = [];
  const empty = () => null;
  const admin = (name: string) => () => { adminMounts.push(name); return createElement('div', null, name); };
  const module = componentModule('../../src/components/league-portal.tsx', {
    'next/image': { __esModule: true, default: empty },
    './league-account': { useLeagueAccount: () => value, AccountButton: empty, LeagueConnectionNotice: empty, OfficialKeeperControls: admin('official-keepers'), OfficialReviewPanel: admin('official-review') },
    './keeper-payment-editor': { KeeperPaymentEditor: empty, paymentDeadlinePicks: () => [] },
    './keeper-profile-review': { KeeperProfileReview: empty }, './league-analytics': { LeagueAnalytics: empty },
    './trade-workspace': { TradeWorkspace: empty }, './draft-pick-grids': { DraftPickGrids: empty, TeamPickInventory: empty },
    './team-access': { TeamAccessPanel: empty, CommissionerTeamAccess: admin('team-access') },
    './league-highlights': { LeagueHighlights: empty },
    './espn-history': { useEspnHistory: () => ({ completedThrough: 2026, history: { seasons: [], statsOnlySeasons: [] } }), EspnHistoryNotice: empty, EspnHistorySyncPanel: admin('history-sync') },
    './season-readiness': { SeasonReadinessPanel: admin('season-readiness'), SeasonScheduleNotice: empty },
    './live-draft-board': { LiveDraftBoard: empty }, './draft-lottery': { DraftLottery: admin('draft-lottery') },
    './commissioner-strategy-tools': { CommissionerStrategyTools: ({ view }: { view: string }) => { strategyViews.push(view); return createElement('div', { 'data-strategy-view': view }); } },
    './commissioner-practice-draft': { CommissionerPracticeDraft: ({ account }: { account: LeagueAccount }) => { practiceMounts.push(account); return createElement('div', { 'data-practice-draft': true }); } },
    './use-portal-location': {
      usePortalLocation: () => ({ view: 'commissioner', search: '', tradeSearch: '', allTeams: false, draftView: 'live', teamId: 1, update: noop,
        href: (params: Record<string, string>) => `/?${new URLSearchParams(params)}` }),
      useQueryFilter: () => [requestedView, noop], useViewFocus: noop,
    },
  });
  const Component = module.LeaguePortal as ComponentType;
  return { html: renderToStaticMarkup(createElement(Component)), strategyViews, adminMounts, practiceMounts };
}

test('restricted commissioner deep links always render only the Draft tab, including admin and keeper URLs', () => {
  for (const requested of ['draft', 'tools', 'keepers', 'practice', 'unrecognized']) {
    const app = portalFixture(account(), requested);
    assert.deepEqual(app.strategyViews, ['draft'], requested); assert.deepEqual(app.adminMounts, [], requested);
    assert.deepEqual(app.practiceMounts, [], requested);
    const nav = app.html.match(/<nav[^>]+aria-label="Commissioner workspaces"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
    assert.match(nav, /Draft Tool/); assert.match(nav, /aria-current="page"/);
    assert.doesNotMatch(nav, /League administration|Keeper Suggestions|Practice Draft/);
    assert.doesNotMatch(app.html, /Team access requests|Official keeper submissions|Reconciliation queue/);
  }
});

test('ordinary managers cannot mount commissioner URL content; commissioner admin and keeper URLs remain usable', () => {
  const blocked = portalFixture(account({ draftToolFranchiseId: null }), 'tools');
  assert.deepEqual(blocked.strategyViews, []); assert.deepEqual(blocked.adminMounts, []);
  assert.doesNotMatch(blocked.html, /aria-label="Commissioner workspaces"/);
  const commissioner = account({ commissioner: true, draftToolFranchiseId: null });
  const admin = portalFixture(commissioner, 'tools');
  assert.deepEqual(admin.strategyViews, []);
  assert.ok(admin.adminMounts.includes('team-access')); assert.ok(admin.adminMounts.includes('official-review'));
  assert.match(admin.html, /League administration/); assert.match(admin.html, /Keeper Suggestions/);
  assert.deepEqual(portalFixture(commissioner, 'keepers').strategyViews, ['keepers']);
});

test('commissioner Practice Draft tab mounts only the separate practice workspace', () => {
  const commissioner = account({ commissioner: true, draftToolFranchiseId: null });
  const app = portalFixture(commissioner, 'practice');
  assert.deepEqual(app.practiceMounts, [commissioner]);
  assert.deepEqual(app.strategyViews, []); assert.deepEqual(app.adminMounts, []);
  const nav = app.html.match(/<nav[^>]+aria-label="Commissioner workspaces"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
  assert.match(nav, /<a[^>]+commissionerView=practice[^>]+aria-current="page"[^>]*>Practice Draft<\/a>/);
  const blocked = portalFixture(account({ draftToolFranchiseId: null }), 'practice');
  assert.deepEqual(blocked.practiceMounts, []);
});
