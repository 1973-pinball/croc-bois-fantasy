import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import * as draftBoard from '../../src/lib/draft-board';
import * as practiceDraft from '../../src/lib/practice-draft';
import type { LeagueAccount } from '../../src/components/league-account';
import type { CommissionerPracticeDraft } from '../../src/components/commissioner-practice-draft';

const require = createRequire(import.meta.url);
function fixture() {
  let roomMounts = 0;
  const dependencies: Record<string, unknown> = {
    react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
    '@/lib/draft-board': draftBoard, '@/lib/practice-draft': practiceDraft,
    './live-draft-board.module.css': {},
    './practice-draft-room': { PracticeDraftRoom: () => { roomMounts += 1; return createElement('div', null, 'Practice room'); } },
  };
  const code = ts.transpileModule(readFileSync(new URL('../../src/components/commissioner-practice-draft.tsx', import.meta.url), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected practice entry dependency: ${name}`);
    return dependencies[name];
  }, exports);
  const Component = exports.CommissionerPracticeDraft as typeof CommissionerPracticeDraft;
  return { render: (account: LeagueAccount) => renderToStaticMarkup(createElement(Component, { account, onExit() {} })), roomMounts: () => roomMounts };
}
function account(overrides: Partial<LeagueAccount> = {}) {
  return { session: { user: { id: '10000000-0000-4000-8000-000000000001' } }, commissioner: true, connection: 'live',
    seasonId: '10000000-0000-4000-8000-000000000002', reloadLeague: async () => undefined, ...overrides } as LeagueAccount;
}

test('Practice Draft entry does not render for anonymous accounts, managers, or delegated Draft Tool viewers', () => {
  for (const value of [account({ session: null }), account({ commissioner: false }), account({ commissioner: false, draftToolFranchiseId: '10000000-0000-4000-8000-000000000003' })]) {
    const app = fixture(); assert.equal(app.render(value), ''); assert.equal(app.roomMounts(), 0);
  }
});

test('a commissioner without the live connection sees connection recovery without mounting practice', () => {
  const app = fixture(); const html = app.render(account({ connection: 'preview' }));
  assert.match(html, /Connect to the live league/);
  assert.match(html, /Refresh league connection/);
  assert.match(html, /Exit practice/);
  assert.equal(app.roomMounts(), 0);
});

test('a connected commissioner sees loading until the fresh snapshot is verified', () => {
  const app = fixture(); const html = app.render(account());
  assert.match(html, /Your official draft stays unchanged/);
  assert.match(html, /Loading a separate practice copy/);
  assert.equal(app.roomMounts(), 0);
});
