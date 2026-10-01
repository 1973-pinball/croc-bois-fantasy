import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface AuditReport {
  replay2025: { summary: { total: number; matched: number; mismatched: number; conflictingTargets: number }; rows: { player: string; expected: number | string; calculated: number | string; status: string }[] };
  projection2026: { rows: { player: string; base2025: number | null; base2026: number | null; reviewFlags: string[] }[] };
  sourceChecks: { rawTargetRows: number; duplicateRawTargetRows: number };
  grandfatherPolicy: { preserveHistoricalPayments: boolean; retroactiveRepricing: boolean };
}

const privateInputs = [".local/workbook.json", ".local/marked-2025-draft.tsv", "keeper_costs_2025_source.json", "croc_bois_139935_2025-26_migration.json"];
const missingPrivateInputs = privateInputs.filter((input) => !existsSync(input));

test("historical-input mutation changes the independent 2025 replay while preserving the approved baseline", {
  skip: missingPrivateInputs.length ? "Private commissioner inputs are needed for the historical replay integration test; pure domain tests run without them." : false,
}, async () => {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "croc-keeper-audit-"));
  const workspaceDirectory = process.cwd();
  const sourcePath = path.resolve(".local/workbook.json");
  const sourceText = await readFile(sourcePath, "utf8");
  const runAudit = async (workbookPath: string, outputName: string): Promise<AuditReport> => {
    const outputPath = path.join(fixtureDirectory, outputName);
    execFileSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/audit-keepers.ts"),
      "--workbook", workbookPath, "--output", outputPath,
    ], { cwd: workspaceDirectory, encoding: "utf8", stdio: "pipe" });
    return JSON.parse(await readFile(outputPath, "utf8")) as AuditReport;
  };
  try {
    const baseline = await runAudit(sourcePath, "baseline.json");
    assert.equal(baseline.replay2025.summary.total, 139);
    assert.equal(baseline.replay2025.summary.matched, 137);
    assert.equal(baseline.replay2025.summary.mismatched, 1);
    assert.equal(baseline.replay2025.summary.conflictingTargets, 1);
    assert.equal(baseline.sourceChecks.rawTargetRows, 154);
    assert.equal(baseline.replay2025.summary.total + baseline.sourceChecks.duplicateRawTargetRows, baseline.sourceChecks.rawTargetRows);

    const mutated = JSON.parse(sourceText) as { sheets: { name: string; rows: { cells: { column: number; value: string | number }[] }[] }[] };
    const draft2024 = mutated.sheets.find((sheet) => sheet.name === "2024 Draft")!;
    const cadeRow = draft2024.rows.find((row) => row.cells.some((cell) => cell.column === 5 && cell.value === "Cade Cunningham"))!;
    const roundCell = cadeRow.cells.find((cell) => cell.column === 1)!;
    assert.equal(roundCell.value, 4);
    roundCell.value = 5;
    const mutationPath = path.join(fixtureDirectory, "mutated-workbook.json");
    await writeFile(mutationPath, JSON.stringify(mutated), "utf8");
    const changed = await runAudit(mutationPath, "mutated-audit.json");
    const beforeCade = baseline.replay2025.rows.find((row) => row.player === "Cade Cunningham")!;
    const afterCade = changed.replay2025.rows.find((row) => row.player === "Cade Cunningham")!;
    assert.equal(beforeCade.status, "match");
    assert.equal(afterCade.expected, 3);
    assert.equal(afterCade.calculated, 4);
    assert.equal(afterCade.status, "mismatch");
    assert.equal(changed.replay2025.summary.mismatched, baseline.replay2025.summary.mismatched + 1);

    const projectedCade = changed.projection2026.rows.find((row) => row.player === "Cade Cunningham")!;
    assert.equal(projectedCade.base2025, 3);
    assert.equal(projectedCade.base2026, 2);
    assert.ok(projectedCade.reviewFlags.includes("authoritative_2025_base_differs_from_independent_history_replay"));
    assert.equal(changed.grandfatherPolicy.preserveHistoricalPayments, true);
    assert.equal(changed.grandfatherPolicy.retroactiveRepricing, false);
    assert.equal(await readFile(sourcePath, "utf8"), sourceText);
  } finally {
    // mkdtemp returns this task's exact temporary directory; no computed parent is removed.
    const resolved = path.resolve(fixtureDirectory);
    const expectedParent = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith("croc-keeper-audit-")) throw new Error("Unexpected temporary audit directory.");
    await rm(resolved, { recursive: true, force: true });
  }
});
