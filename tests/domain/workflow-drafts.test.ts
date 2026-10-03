import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowDraftStore, workflowDraftKey } from '../../src/lib/workflow-drafts';
import { emptyTradeDraft, isTradeComposerDraft } from '../../src/lib/trade-workspace';
import { selectedReviewProfile } from '../../src/lib/keeper-review-selection';

function fixtureStorage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('multi-leg trade and unfinished editor survive navigation and a new page instance, scoped by season', () => {
  const storage = fixtureStorage(), first = createWorkflowDraftStore(() => storage);
  const key = workflowDraftKey('manager-a', '2026', 'trade');
  const draft = { ...emptyTradeDraft(false), terms: 'Three-team agreement', fromTeam: '1', toTeam: '3', obligationTerms: 'Return after playoffs', legs: [{ key: 'p', kind: 'player' as const, fromTeamId: 1, toTeamId: 2, playerId: 100 }, { key: 'k', kind: 'pick' as const, fromTeamId: 2, toTeamId: 3, pickId: 'pick-a' }] };
  first.account('manager-a'); assert.equal(first.write(key, draft), true);
  assert.deepEqual(first.read(key, isTradeComposerDraft), draft);
  const refreshed = createWorkflowDraftStore(() => storage); refreshed.account('manager-a');
  assert.deepEqual(refreshed.read(key, isTradeComposerDraft), draft);
  assert.equal(refreshed.read(workflowDraftKey('manager-a', '2027', 'trade'), isTradeComposerDraft), null);
  refreshed.remove(key); assert.equal(refreshed.read(key, isTradeComposerDraft), null);
});

test('account change and sign-out clear old drafts without touching unrelated browser data', () => {
  const storage = fixtureStorage(), store = createWorkflowDraftStore(() => storage);
  const oldKey = workflowDraftKey('manager-a', '2026', 'trade'), newKey = workflowDraftKey('manager-b', '2026', 'trade');
  storage.setItem('unrelated', 'retained'); store.write(oldKey, emptyTradeDraft(false));
  store.account('manager-b'); assert.equal(store.read(oldKey, isTradeComposerDraft), null);
  store.write(newKey, emptyTradeDraft(false)); store.account(null);
  assert.equal(store.read(newKey, isTradeComposerDraft), null); assert.equal(storage.getItem('unrelated'), 'retained');
});

test('malformed stored drafts are rejected; blocked storage keeps a navigation draft and reports persistence unavailable', () => {
  const storage = fixtureStorage(), key = workflowDraftKey('a', 'season', 'trade');
  storage.setItem(key, '{"legs":"not-an-array"}');
  const store = createWorkflowDraftStore(() => storage);
  assert.equal(store.read(key, isTradeComposerDraft), null); assert.equal(storage.getItem(key), null);
  storage.setItem(key, 'broken json'); assert.equal(store.read(key, isTradeComposerDraft), null);
  const blocked = createWorkflowDraftStore(() => { throw new Error('blocked'); });
  const draft = { ...emptyTradeDraft(false), terms: 'Preserve my work' };
  assert.equal(blocked.write(key, draft), false); assert.deepEqual(blocked.read(key, isTradeComposerDraft), draft); assert.equal(blocked.persisted(key), false);
  blocked.account(null); assert.equal(blocked.read(key, isTradeComposerDraft), null);
});

test('review drafts are independent by player, account and season', () => {
  const storage = fixtureStorage(), store = createWorkflowDraftStore(() => storage);
  const valid = (value: unknown): value is { note: string } => typeof value === 'object' && value !== null && typeof (value as { note?: unknown }).note === 'string';
  const a = workflowDraftKey('commissioner', '2026', 'profile', 1), b = workflowDraftKey('commissioner', '2026', 'profile', 2);
  store.write(a, { note: 'Draft-history evidence' }); store.write(b, { note: 'Tenure evidence' });
  assert.equal(store.read(a, valid)?.note, 'Draft-history evidence'); assert.equal(store.read(b, valid)?.note, 'Tenure evidence');
  assert.equal(store.read(workflowDraftKey('other', '2026', 'profile', 1), valid), null);
  assert.equal(store.read(workflowDraftKey('commissioner', '2027', 'profile', 1), valid), null);
});

test('review selection follows filters and only an explicitly just-reviewed player can remain outside results', () => {
  const players = [{ id: 1 }, { id: 2 }];
  assert.equal(selectedReviewProfile(players, [players[1]], 1, null)?.id, 2);
  assert.equal(selectedReviewProfile(players, [], 1, null), undefined);
  assert.equal(selectedReviewProfile(players, [], 1, 1)?.id, 1);
  assert.equal(selectedReviewProfile(players, [players[1]], null, null)?.id, 2);
});

test('a late successful save cannot erase a newer draft edited after navigating away and back', () => {
  const storage = fixtureStorage(), store = createWorkflowDraftStore(() => storage);
  const key = workflowDraftKey('manager-a', '2026', 'trade');
  const submitted = { ...emptyTradeDraft(false), terms: 'Agreement sent for review' };
  store.write(key, submitted);
  // Navigation remounts the form from the same draft while its save is still pending.
  const reopened = store.read(key, isTradeComposerDraft)!;
  const newer = { ...reopened, terms: 'New work entered while the old request completes' };
  store.write(key, newer);
  assert.equal(store.removeIfUnchanged(key, submitted), false);
  // Verify a true page reload still restores the newer work after the late completion.
  assert.deepEqual(createWorkflowDraftStore(() => storage).read(key, isTradeComposerDraft), newer);
  assert.equal(store.removeIfUnchanged(key, newer), true);
  assert.equal(createWorkflowDraftStore(() => storage).read(key, isTradeComposerDraft), null);
});

test('stale review completion preserves new notes; explicit discard still clears them', () => {
  const storage = fixtureStorage(), store = createWorkflowDraftStore(() => storage);
  const key = workflowDraftKey('commissioner', '2026', 'profile', 10);
  const submitted = { baseRound: '5', tenure: '2', note: 'Original evidence' };
  const newer = { ...submitted, note: 'Additional evidence entered in the reopened form' };
  store.write(key, submitted); store.write(key, newer);
  assert.equal(store.removeIfUnchanged(key, submitted), false);
  assert.deepEqual(JSON.parse(storage.getItem(key)!), newer);
  store.remove(key);
  assert.equal(storage.getItem(key), null);
  assert.equal(store.removeIfUnchanged(key, submitted), false);
});
