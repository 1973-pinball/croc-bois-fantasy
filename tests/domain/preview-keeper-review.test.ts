import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import preview from '../../data/league.json';
import review from '../../data/keeper-readiness-audit.json';
import type { LeagueData } from '../../src/lib/types';

function assertConfirmedPreview(data: LeagueData) {
  const confirmed = [...review.supportedConfirmations, ...review.ruleConfirmedProfiles];
  assert.equal(confirmed.length, 47);
  for (const evidence of confirmed) {
    const player = data.players.find(candidate => candidate.id === evidence.playerId);
    assert.ok(player, evidence.player);
    assert.equal(player.status, 'eligible', evidence.player);
    assert.equal(player.baseCost, evidence.baseRound, evidence.player);
    assert.equal(player.tenure, evidence.tenureYears, evidence.player);
    assert.doesNotMatch(player.reason, /provisional|awaiting|pending|needs commissioner review/i, evidence.player);
  }
  assert.equal(data.players.filter(player => player.status === 'eligible').length, 100);
  assert.equal(data.players.filter(player => player.status === 'ineligible').length, 11);
  assert.equal(data.players.filter(player => player.status === 'review').length, 0);
  assert.deepEqual(data.reviewItems, [], 'resolved profile decisions must leave the fallback reconciliation queue');
}

test('the public fallback confirms reviewed undrafted and retained profiles without repricing', () => {
  assertConfirmedPreview(preview as LeagueData);
  const grimes = preview.players.find(player => player.name === 'Quentin Grimes')!;
  const hart = preview.players.find(player => player.name === 'Josh Hart')!;
  assert.equal(grimes.baseCost, 12);
  assert.equal(grimes.previousRound, 11, 'earlier payment is retained independently of nominal cost');
  assert.equal(hart.baseCost, 12);
  assert.equal(grimes.tenure, 2);
  assert.equal(hart.tenure, 2);
});

const privateInputs = ['.local/workbook.json', '.local/marked-2025-draft.tsv', 'keeper_costs_2025_source.json', 'croc_bois_139935_2025-26_migration.json', 'planning_reconciliation.json'];
test('regenerating preview data retains all reviewed confirmations and original inventory', {
  skip: privateInputs.some(input => !existsSync(input)) ? 'Private commissioner source files are required for preview regeneration.' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'croc-preview-review-'));
  try {
    const output = path.join(directory, 'league.json');
    execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/build-preview-data.ts'), '--output', output], { cwd: process.cwd(), stdio: 'pipe' });
    const generated = JSON.parse(await readFile(output, 'utf8')) as LeagueData;
    assertConfirmedPreview(generated);
    assert.deepEqual(generated.players.map(({ id, baseCost, tenure, teamId }) => ({ id, baseCost, tenure, teamId })), preview.players.map(({ id, baseCost, tenure, teamId }) => ({ id, baseCost, tenure, teamId })));
    assert.deepEqual(generated.picks, preview.picks);
    assert.deepEqual(generated.drafts, preview.drafts);
    assert.deepEqual(generated.trades, preview.trades);
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('croc-preview-review-')) throw new Error('Unexpected temporary preview directory.');
    await rm(resolved, { recursive: true, force: true });
  }
});
