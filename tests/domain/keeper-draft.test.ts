import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptKeeperDraftSave, editKeeperDraft, hasKeeperDraftConflict, initializeKeeperDraft, loadKeeperDraft } from '../../src/lib/keeper-draft';

const first = [{ playerId: 101, pickId: 'round-5' }];
const local = [{ playerId: 102, pickId: 'round-4' }];
const coManager = [{ playerId: 103, pickId: 'round-6' }];

test('focus refresh cannot rebase local selections over a co-manager save', () => {
  let draft = initializeKeeperDraft(undefined, first, 1);
  draft = editKeeperDraft(draft, local);
  draft = initializeKeeperDraft(draft, coManager, 2);
  assert.deepEqual(draft.assignments, local, 'unsaved work stays available');
  assert.equal(draft.baseRevision, 1, 'a save must retain the revision actually edited');
  assert.equal(hasKeeperDraftConflict(draft, 2), true, 'save and submit must require an explicit load');
  draft = loadKeeperDraft(coManager, 2);
  assert.deepEqual(draft.assignments, coManager);
  assert.equal(draft.baseRevision, 2);
  assert.equal(hasKeeperDraftConflict(draft, 2), false);
});

test('an untouched open draft cannot silently overwrite a newer saved selection either', () => {
  const draft = initializeKeeperDraft(undefined, first, 1);
  assert.equal(initializeKeeperDraft(draft, coManager, 2), draft);
  assert.equal(hasKeeperDraftConflict(draft, 2), true);
});

test('a first co-manager save conflicts with an accepted empty submission baseline', () => {
  let draft = initializeKeeperDraft(undefined, [], 0);
  draft = editKeeperDraft(draft, local);
  draft = initializeKeeperDraft(draft, coManager, 1);
  assert.equal(draft.baseRevision, 0);
  assert.deepEqual(draft.assignments, local);
  assert.equal(hasKeeperDraftConflict(draft, 1), true);
});

test('a local plan made before loading requires accepting an existing saved draft', () => {
  const draft = editKeeperDraft(undefined, local);
  const refreshed = initializeKeeperDraft(draft, first, 1);
  assert.deepEqual(refreshed.assignments, local);
  assert.equal(refreshed.baseRevision, null);
  assert.equal(hasKeeperDraftConflict(refreshed, 1), true);
  const emptyBaseline = initializeKeeperDraft(draft, [], 0);
  assert.deepEqual(emptyBaseline.assignments, local);
  assert.equal(emptyBaseline.baseRevision, 0);
  assert.equal(hasKeeperDraftConflict(emptyBaseline, 0), false);
});

test('a successful own save advances the baseline and retains edits made in flight', () => {
  const loaded = loadKeeperDraft(first, 1);
  const editingDuringSave = editKeeperDraft(loaded, local);
  const saved = acceptKeeperDraftSave(editingDuringSave, 1, 2);
  assert.deepEqual(saved?.assignments, local);
  assert.equal(saved?.baseRevision, 2);
  assert.equal(hasKeeperDraftConflict(saved, 2), false);
  assert.equal(hasKeeperDraftConflict(saved, 3), true, 'another later save still conflicts');
});

test('late save responses cannot rebase a reset or separately loaded editor', () => {
  assert.equal(acceptKeeperDraftSave(undefined, 1, 2), undefined);
  const replaced = loadKeeperDraft(coManager, 3);
  assert.equal(acceptKeeperDraftSave(replaced, 1, 2), replaced);
});
