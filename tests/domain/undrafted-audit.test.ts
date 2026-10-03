import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import audit from '../../data/keeper-audit.json';
import readiness from '../../data/keeper-readiness-audit.json';

test('established undrafted rules resolve all matching profiles while retaining old evidence and actual payments', () => {
  assert.equal(audit.projection2026.summary.undraftedRuleConfirmedPlayers, 36);
  assert.equal(audit.projection2026.summary.unresolvedReviewPlayers, 0);
  assert.equal(audit.projection2026.summary.provisionalCosts, 0);
  assert.equal(audit.projection2026.summary.historicalProvisionalCosts, 2);
  assert.equal(audit.projection2026.summary.reconstructedKeeperTenures, 17);
  const initialUndrafted = audit.projection2026.rows.filter(row => row.status2025 === 'undrafted');
  assert.equal(initialUndrafted.length, 30);
  for (const row of initialUndrafted) {
    assert.equal(row.base2026, 13);
    assert.equal(row.tenureAfter2025, 1);
    assert.deepEqual(row.reviewFlags, []);
    assert.ok(row.historicalReviewFlags.some(flag => flag === 'undrafted_first_season_tenure_one_is_an_explicit_inference'));
  }
  for (const [name, payment] of [['Josh Hart', 12], ['Quentin Grimes', 11]] as const) {
    const row = audit.projection2026.rows.find(player => player.player === name)!;
    assert.equal(row.base2025, 13);
    assert.equal(row.base2026, 12);
    assert.equal(row.tenureAfter2025, 2);
    assert.equal(row.payment2025, payment);
    assert.equal(row.tenureBasis, 'undrafted_after_2024_reentry');
    assert.equal(row.priorTenureReported, null);
    assert.deepEqual(row.reviewFlags, []);
    assert.ok(row.historicalReviewFlags.includes('provisional_commissioner_base_2025_round_13_pending_history_check'));
  }
  assert.equal(readiness.supportedConfirmations.length, 11);
  assert.equal(readiness.ruleConfirmedProfiles.length, 36);
  assert.deepEqual(readiness.pendingReviews, []);
  assert.deepEqual(readiness.decisionsNeeded, []);
  assert.equal(readiness.observedReviewDate, '2026-10-01');
  assert.equal(readiness.roster.filter(row => row.observedStatus === 'review').length, 47);
  for (const row of readiness.ruleConfirmedProfiles) {
    const source = audit.projection2026.rows.find(player => player.espnPlayerId === row.playerId)!;
    assert.equal(row.baseRound, source.base2026);
    assert.equal(row.tenureYears, source.tenureAfter2025);
    assert.equal(row.evidence.actualPayment2025, source.payment2025);
  }
});

type Workbook = { sheets: { name: string; rows: { row: number; cells: { column: number; value: string | number | null }[] }[] }[] };
type Roster = { teams: { team_id: number; roster: { entries: { player_id: number; full_name: string }[] } }[] };
type Report = { projection2026: { rows: { player: string; base2025: number | null; base2026: number | null; tenureAfter2025: number | null; reviewFlags: string[]; tenureBasis: string }[] } };
const inputs = ['.local/workbook.json', '.local/marked-2025-draft.tsv', 'keeper_costs_2025_source.json', 'croc_bois_139935_2025-26_migration.json'];
test('rule confirmation follows matching history rather than a player-name whitelist', {
  skip: inputs.some(file => !existsSync(file)) ? 'Private commissioner source inputs are required for the extractor mutation check.' : false,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'croc-undrafted-audit-'));
  try {
    const workbook = JSON.parse(await readFile(inputs[0], 'utf8')) as Workbook;
    const marked = await readFile(inputs[1], 'utf8');
    const importedRoster = JSON.parse(await readFile(inputs[3], 'utf8')) as Roster;
    const roster: Roster = { teams: importedRoster.teams.map(team => ({ team_id: team.team_id, roster: { entries: team.roster.entries.map(player => ({ player_id: player.player_id, full_name: player.full_name })) } })) };
    const run = async (name: string, book: Workbook, marks: string, players: Roster) => {
      const workbookPath = path.join(directory, `${name}-workbook.json`);
      const marksPath = path.join(directory, `${name}-marked.tsv`);
      const rosterPath = path.join(directory, `${name}-roster.json`);
      const reportPath = path.join(directory, `${name}-report.json`);
      await Promise.all([writeFile(workbookPath, JSON.stringify(book)), writeFile(marksPath, marks), writeFile(rosterPath, JSON.stringify(players))]);
      execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/audit-keepers.ts'),
        '--workbook', workbookPath, '--costs', path.resolve(inputs[2]), '--marked-draft', marksPath, '--rosters', rosterPath, '--output', reportPath], { stdio: 'pipe' });
      return JSON.parse(await readFile(reportPath, 'utf8')) as Report;
    };
    const renamedWorkbook = structuredClone(workbook);
    const draft2025 = renamedWorkbook.sheets.find(sheet => sheet.name === '2025 Draft')!;
    const deniCell = draft2025.rows.flatMap(row => row.cells).find(cell => cell.column === 5 && String(cell.value).startsWith('Deni Avdija'))!;
    deniCell.value = 'Example Undrafted Keeper';
    const renamedRoster = structuredClone(roster);
    renamedRoster.teams.flatMap(team => team.roster.entries).find(player => player.player_id === 4683021)!.full_name = 'Example Undrafted Keeper';
    const renamed = await run('renamed', renamedWorkbook, marked.replace(/Deni Avdija[^\r\n\t]*/, 'Example Undrafted Keeper'), renamedRoster);
    const generic = renamed.projection2026.rows.find(row => row.player === 'Example Undrafted Keeper')!;
    assert.equal(generic.base2025, 13);
    assert.equal(generic.base2026, 12);
    assert.equal(generic.tenureAfter2025, 2);
    assert.deepEqual(generic.reviewFlags, []);

    const changedWorkbook = structuredClone(workbook);
    const draft2024 = changedWorkbook.sheets.find(sheet => sheet.name === '2024 Draft')!;
    draft2024.rows.find(row => row.row === 105)!.cells.find(cell => cell.column === 5)!.value = 'Josh Hart';
    const changed = await run('different-history', changedWorkbook, marked, roster);
    const hart = changed.projection2026.rows.find(row => row.player === 'Josh Hart')!;
    assert.equal(hart.base2025, null);
    assert.ok(hart.reviewFlags.includes('undrafted_cost_confirmation_requires_matching_history'));
    assert.ok(hart.reviewFlags.includes('missing_base_cost'));
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('croc-undrafted-audit-')) throw new Error('Unexpected temporary audit directory.');
    await rm(resolved, { recursive: true, force: true });
  }
});
