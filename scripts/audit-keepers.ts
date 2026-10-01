import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { evaluateKeeperEligibility, rolloverKeeperCycle, type KeeperCycle } from "../src/domain";

type CellValue = string | number | boolean | null;
interface Cell { cell: string; column: number; value: CellValue; formula?: string | null }
interface Row { row: number; cells: Cell[] }
interface Sheet { name: string; rows: Row[] }
interface Workbook { sha256: string; sheets: Sheet[] }
type Cost = number | "ineligible" | null;
interface DraftEntry { player: string; round: number; keeper: boolean; sourceCells: string[] }
interface Origin { player: string; originalYear: number | null; originalRound: number | null; tenure: number | null; target: Cost; sourceCells: string[]; targetCell: string }
interface CostSourceRow { source_row: number; player: string; keeper_cost_2025: string | number; tenure_before_2025_draft: number | null }
interface Comparison { player: string; expected: Cost; calculated: Cost; status: "match" | "mismatch" | "unresolved" | "conflicting_target"; sourceCells: string[]; targetCell: string; note?: string }

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
const aliases: Record<string, string> = {
  damontissabonis: "domantassabonis", damontassabonis: "domantassabonis", damontassobonis: "domantassabonis",
  camjohnson: "cameronjohnson", paytonprichard: "paytonpritchard", lugenzdort: "luguentzdort",
  nicolasclaxton: "nicclaxton", stephcurry: "stephencurry", kat: "karlanthonytowns", giannis: "giannisantetokounmpo",
  jabarismith: "jabarismithjr", treymurphy: "treymurphyiii", herbjones: "herbertjones",
  garytrent: "garytrentjr", robertwilliams: "robertwilliamsiii", jimmybutleriii: "jimmybutler",
};
function cleanName(value: CellValue | undefined): string {
  return typeof value === "string" ? value.replace(/\s+\(.*/, "").trim() : "";
}
function key(name: string): string {
  const normalized = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return aliases[normalized] ?? normalized;
}
function cell(row: Row, column: number): Cell | undefined { return row.cells.find((entry) => entry.column === column); }
function numeric(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function cost(value: CellValue | undefined): Cost {
  if (typeof value === "string" && /(?:not\s*eligible|ineligible)/i.test(value)) return "ineligible";
  return numeric(value);
}
function reference(sheet: Sheet, row: Row, column: number): string { return `'${sheet.name}'!${cell(row, column)?.cell ?? `column-${column}-row-${row.row}`}`; }
function summary(rows: Comparison[]) {
  return { total: rows.length, matched: rows.filter((row) => row.status === "match").length, mismatched: rows.filter((row) => row.status === "mismatch").length, unresolved: rows.filter((row) => row.status === "unresolved").length, conflictingTargets: rows.filter((row) => row.status === "conflicting_target").length };
}
function comparison(player: string, expected: Cost, calculated: Cost, sourceCells: string[], targetCell: string, note?: string): Comparison {
  return { player, expected, calculated, sourceCells, targetCell, status: expected === null || calculated === null ? "unresolved" : expected === calculated ? "match" : "mismatch", ...(note ? { note } : {}) };
}
function observedCost(cycle: KeeperCycle): Cost {
  const eligibility = evaluateKeeperEligibility(cycle);
  return eligibility.valid ? cycle.nextKeeperRound : eligibility.issues.some((issue) => ["first_round_draft", "tenure_limit", "invalid_keeper_cost"].includes(issue.code)) ? "ineligible" : null;
}

async function inputPath(flag: string, privatePath: string, fixturePath: string): Promise<string> {
  const explicit = argument(flag);
  if (explicit !== undefined) return explicit;
  return await access(privatePath).then(() => privatePath, () => fixturePath);
}
const workbookPath = await inputPath("--workbook", ".local/workbook.json", "data/audit-inputs/workbook.json");
const costsPath = await inputPath("--costs", "keeper_costs_2025_source.json", "data/audit-inputs/keeper-costs-2025.json");
const rostersPath = await inputPath("--rosters", "croc_bois_139935_2025-26_migration.json", "data/audit-inputs/rosters.json");
const workbook = JSON.parse(await readFile(workbookPath, "utf8")) as Workbook;
const sourceRows = (JSON.parse(await readFile(costsPath, "utf8")) as { rows: CostSourceRow[] }).rows;
const roster = JSON.parse(await readFile(rostersPath, "utf8")) as {
  teams: { team_id: number; roster: { entries: { player_id: number; full_name: string }[] } }[];
};
function sheet(name: string): Sheet {
  const result = workbook.sheets.find((entry) => entry.name === name);
  if (!result) throw new Error(`Required historical tab missing: ${name}`);
  return result;
}
function nameSet(source: Sheet, column: number, startingRow: number): Set<string> {
  return new Set(source.rows.filter((row) => row.row >= startingRow).map((row) => key(cleanName(cell(row, column)?.value))).filter(Boolean));
}
function drafts(source: Sheet, keeperKeys: Set<string>): Map<string, DraftEntry> {
  const entries = new Map<string, DraftEntry>();
  for (const row of source.rows) {
    const round = numeric(cell(row, 1)?.value);
    const player = cleanName(cell(row, 5)?.value);
    if (!round || round < 1 || round > 13 || !player || numeric(cell(row, 2)?.value) === null) continue;
    if (entries.has(key(player))) throw new Error(`Duplicate draft player in ${source.name}: ${player}`);
    entries.set(key(player), { player, round, keeper: keeperKeys.has(key(player)), sourceCells: [reference(source, row, 1), reference(source, row, 5)] });
  }
  return entries;
}
const keeperKeys2024 = nameSet(sheet("2025 Draft"), 25, 4);
const workbookKeeperKeys2025 = nameSet(sheet("2025 Draft"), 23, 4);
const draft2024 = drafts(sheet("2024 Draft"), keeperKeys2024);
let draft2025 = drafts(sheet("2025 Draft"), workbookKeeperKeys2025);
const markedPath = argument("--marked-draft") ?? process.env.CROC_MARKED_DRAFT_PATH ?? await inputPath("--marked-draft", ".local/marked-2025-draft.tsv", "data/audit-inputs/marked-2025-draft.tsv");
if (!markedPath) throw new Error("Supply --marked-draft or CROC_MARKED_DRAFT_PATH. The workbook keeper sidebar contains known disagreements and cannot substitute for the commissioner's marked draft.");
if (markedPath) {
  const lines = (await readFile(markedPath, "utf8")).replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const marked = new Map<string, DraftEntry>();
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split("\t");
    const player = cleanName(fields[4]);
    const round = Number(fields[0]);
    if (!player || !Number.isInteger(round) || round < 1 || round > 13) throw new Error(`Invalid marked draft row ${index + 2}.`);
    if (marked.has(key(player))) throw new Error(`Duplicate marked draft player: ${player}`);
    const existing = draft2025.get(key(player));
    if (!existing || existing.round !== round) throw new Error(`Workbook and commissioner marked draft differ for ${player}.`);
    marked.set(key(player), { player, round, keeper: fields[5]?.trim().toLowerCase() === "x", sourceCells: [...existing.sourceCells, `commissioner-marked-2025-draft:row-${index + 2}`] });
  }
  if (marked.size !== draft2025.size) throw new Error("The marked draft and workbook have different player counts.");
  draft2025 = marked;
}

function origins(source: Sheet, targetYear: number, columns: { name: number; year: number; round: number; tenure: number; target: number }): Map<string, Origin> {
  const result = new Map<string, Origin>();
  for (const row of source.rows) {
    if (row.row === 1) continue;
    const player = cleanName(cell(row, columns.name)?.value);
    if (!player) continue;
    const origin: Origin = {
      player, originalYear: numeric(cell(row, columns.year)?.value), originalRound: numeric(cell(row, columns.round)?.value),
      tenure: numeric(cell(row, columns.tenure)?.value), target: cost(cell(row, columns.target)?.value),
      sourceCells: [columns.name, columns.year, columns.round, columns.tenure].map((column) => reference(source, row, column)),
      targetCell: reference(source, row, columns.target),
    };
    if (origin.originalYear !== null && (origin.originalYear < 2000 || origin.originalYear >= targetYear)) continue;
    if (!result.has(key(player))) result.set(key(player), origin);
  }
  return result;
}
const origins2023 = origins(sheet("2023 Draft"), 2023, { name: 11, year: 12, round: 13, tenure: 14, target: 15 });
const origins2024 = origins(sheet("2024 Draft V2"), 2024, { name: 10, year: 11, round: 12, tenure: 13, target: 14 });
const keeperKeys2023 = new Set(sheet("2023 Draft").rows.filter((row) => cell(row, 16)?.value === "Yes").map((row) => key(cleanName(cell(row, 11)?.value))));
const draft2023 = drafts(sheet("2023 Draft"), keeperKeys2023);

function originCycle(playerId: string, origin: Origin, targetYear: number): KeeperCycle | null {
  const tenure = origin.originalYear === null ? origin.tenure : targetYear - origin.originalYear;
  if (tenure === null || tenure < 1) return null;
  return {
    playerId, lastSeason: targetYear - 1, tenureYears: tenure,
    nextKeeperRound: origin.originalRound === null ? null : origin.originalRound - tenure,
    firstRoundDraftIneligible: origin.originalRound === 1,
    source: origin.originalRound === 14 && tenure === 1 ? "undrafted" : "keeper",
  };
}
const historicalAudits: { season: number; method: string; scope: string; summary: ReturnType<typeof summary>; rows: Comparison[] }[] = [];
for (const [year, records] of [[2023, origins2023], [2024, origins2024]] as const) {
  const rows = [...records.values()].map((origin) => {
    const cycle = originCycle(key(origin.player), origin, year);
    const independentTenure = origin.originalYear === null ? origin.tenure : year - origin.originalYear;
    const note = origin.tenure !== independentTenure ? "Stored tenure differs from target year minus original draft year; the year-based tenure is used." : undefined;
    return comparison(origin.player, origin.target, cycle ? observedCost(cycle) : null, origin.sourceCells, origin.targetCell, note);
  });
  historicalAudits.push({ season: year, method: "original_round_minus_elapsed_tenure", scope: year === 2024 ? "Corrected nominal costs in 2024 Draft V2; this does not certify the different amounts actually paid in 2024." : "Arithmetic replay from original-round and tenure inputs; it does not independently certify every pre-2023 transaction.", summary: summary(rows), rows });
}

function legacyArithmeticAudit(source: Sheet, season: number, columns: { name: number; priorRound: number; tenure: number; target: number }): Comparison[] {
  return source.rows.filter((row) => row.row > 1).flatMap((row) => {
    const player = cleanName(cell(row, columns.name)?.value);
    if (!player) return [];
    const priorValue = cell(row, columns.priorRound)?.value;
    const priorRound = numeric(priorValue);
    const tenure = numeric(cell(row, columns.tenure)?.value);
    const calculated: Cost = tenure !== null && tenure >= 5 ? "ineligible" : priorRound === 1 ? "ineligible" : priorRound !== null ? priorRound - 1 : priorValue === "FA" ? 13 : null;
    return [comparison(player, cost(cell(row, columns.target)?.value), calculated,
      [columns.name, columns.priorRound, columns.tenure].map((column) => reference(source, row, column)), reference(source, row, columns.target),
      tenure === 0 ? "Legacy lookup returned zero for missing tenure; preserved as a historical formula input, not imported as valid tenure." : undefined)];
  });
}
for (const [year, source, columns] of [
  [2022, sheet("Player_Pick_Costs"), { name: 6, priorRound: 7, tenure: 8, target: 9 }],
  [2024, sheet("2024 Draft"), { name: 12, priorRound: 13, tenure: 14, target: 15 }],
] as const) {
  const rows = legacyArithmeticAudit(source, year, columns);
  historicalAudits.push({ season: year, method: "legacy_previous_round_minus_one", scope: "Replays the historical table arithmetic. Prior input rounds may include earlier payment escalation, so matching is not proof of correct nominal lifecycle history.", summary: summary(rows), rows });
}

const historicalLegacyCosts2024 = new Map<string, { value: Cost; cell: string }>();
for (const row of sheet("2024 Draft").rows) {
  if (row.row === 1) continue;
  const name = cleanName(cell(row, 12)?.value);
  if (name) historicalLegacyCosts2024.set(key(name), { value: cost(cell(row, 15)?.value), cell: reference(sheet("2024 Draft"), row, 15) });
}
interface Prediction { cycle: KeeperCycle | null; sourceCells: string[]; basis: string; notes: string[]; legacyCost: Cost }
function predict2025(player: string): Prediction {
  const playerKey = key(player);
  const priorDraft = draft2024.get(playerKey);
  const legacy = historicalLegacyCosts2024.get(playerKey);
  if (keeperKeys2024.has(playerKey)) {
    let original = origins2024.get(playerKey);
    const notes: string[] = [];
    if (!original && draft2023.size === 104 && !draft2023.has(playerKey) && !keeperKeys2023.has(playerKey)) {
      original = { player, originalYear: 2023, originalRound: 14, tenure: 1, target: null,
        sourceCells: ["'2023 Draft'!A2:F105 (absent from complete draft)", "'2023 Draft'!K2:P107 (not a 2023 keeper)"], targetCell: "not-applicable" };
      notes.push("Original cycle is inferred from absence in the complete 2023 draft and keeper list: undrafted in 2023, first retained in 2024.");
    }
    if (!original) return { cycle: null, sourceCells: priorDraft?.sourceCells ?? [], basis: "2024_keeper_missing_history", notes: ["A confirmed 2024 keeper needs original cycle metadata."], legacyCost: null };
    const previous = originCycle(playerKey, original, 2024);
    if (!previous) return { cycle: null, sourceCells: original.sourceCells, basis: "2024_keeper_missing_history", notes: ["Original cycle metadata is incomplete."], legacyCost: null };
    try {
      let cycle: KeeperCycle;
      if (priorDraft) cycle = rolloverKeeperCycle(playerKey, previous, { kind: "kept", season: 2024, paymentRound: priorDraft.round });
      else {
        // Nominal cost does not depend on payment. Preserve the missing payment, never invent one.
        cycle = { ...previous, lastSeason: 2024, tenureYears: previous.tenureYears === null ? null : previous.tenureYears + 1,
          nextKeeperRound: previous.nextKeeperRound === null ? null : previous.nextKeeperRound - 1,
          source: "keeper", lastKeeperBaseRound: previous.nextKeeperRound ?? undefined };
        notes.push("The confirmed 2024 keeper list includes this player, but the 2024 draft grid has no selection. Nominal rollover is calculable; actual payment is unresolved.");
      }
      const legacyCost = typeof legacy?.value === "number" ? cycle.tenureYears! >= 5 || legacy.value <= 1 ? "ineligible" : legacy.value - 1 : legacy?.value ?? null;
      return { cycle, sourceCells: [...original.sourceCells, ...(priorDraft?.sourceCells ?? [])], basis: "confirmed_2024_keeper_original_cycle", notes, legacyCost };
    } catch (error) {
      return { cycle: null, sourceCells: [...original.sourceCells, ...(priorDraft?.sourceCells ?? [])], basis: "2024_keeper_conflicts_with_current_rules", notes: [String(error)], legacyCost: null };
    }
  }
  if (priorDraft) return { cycle: rolloverKeeperCycle(playerKey, null, { kind: "drafted", season: 2024, round: priorDraft.round }), sourceCells: priorDraft.sourceCells, basis: "fresh_2024_draft_reset", notes: [], legacyCost: priorDraft.round === 1 ? "ineligible" : priorDraft.round - 1 };
  return { cycle: rolloverKeeperCycle(playerKey, null, { kind: "undrafted", season: 2024, tenureYears: 1 }), sourceCells: ["'2024 Draft'!A2:E105 (absent from complete draft)", "'2025 Draft'!Y4:Y37 (absent from 2024 keeper list)"], basis: "undrafted_after_2024_reentry", notes: ["First undrafted season counted as tenure one for this historical projection; this convention remains an explicit inference."], legacyCost: 13 };
}

const groupedTargets = new Map<string, CostSourceRow[]>();
for (const row of sourceRows) groupedTargets.set(key(row.player), [...(groupedTargets.get(key(row.player)) ?? []), row]);
function chosenSource(rows: CostSourceRow[]): CostSourceRow { return rows.find((row) => cost(row.keeper_cost_2025) !== 13) ?? rows[0]; }
const replayRows = [...groupedTargets.values()].map((rows) => {
  const target = chosenSource(rows);
  const prediction = predict2025(target.player);
  const inputCost = prediction.cycle ? observedCost(prediction.cycle) : null;
  const result = comparison(target.player, cost(target.keeper_cost_2025), inputCost, prediction.sourceCells, `'2025 Draft'!R${target.source_row + 1}`, prediction.notes.join(" ") || undefined);
  const non13Values = new Set(rows.map((row) => cost(row.keeper_cost_2025)).filter((value) => value !== 13));
  if (non13Values.size > 1) result.status = "conflicting_target";
  return {
    ...result, basis: prediction.basis, legacyPaymentBasedPrediction: prediction.legacyCost,
    priorTenureCalculated: prediction.cycle?.tenureYears ?? null,
    priorTenureReported: rows.find((row) => row.tenure_before_2025_draft !== null)?.tenure_before_2025_draft ?? null,
    targetVariants: rows.map((row) => ({ player: row.player, cost: cost(row.keeper_cost_2025), sourceCell: `'2025 Draft'!R${row.source_row + 1}` })),
  };
});

const provisionalPlayers = new Set(["quentingrimes", "joshhart"]);
const derivedRound13Players = new Set(["deniavdija", "paytonpritchard", "andrewwiggins", "dysondaniels"]);
const projectionRows = roster.teams.flatMap((team) => team.roster.entries.map((entry) => {
  const playerKey = key(entry.full_name);
  const draft = draft2025.get(playerKey);
  const targetRows = groupedTargets.get(playerKey);
  const target = targetRows ? chosenSource(targetRows) : undefined;
  const independent = predict2025(entry.full_name);
  const reviewFlags: string[] = [];
  let cycle: KeeperCycle;
  let base2025: number | null = null;
  let sourceCells = draft?.sourceCells ?? ["'2025 Draft'!A2:E105 (absent from complete draft)"];
  if (draft?.keeper) {
    base2025 = typeof target?.keeper_cost_2025 === "number" ? target.keeper_cost_2025 : null;
    if (provisionalPlayers.has(playerKey)) {
      base2025 = 13;
      reviewFlags.push("provisional_commissioner_base_2025_round_13_pending_history_check");
    } else if (base2025 === null && derivedRound13Players.has(playerKey) && draft.round === 13) {
      base2025 = 13;
      reviewFlags.push("base_2025_derived_from_round_13_payment_and_maximum_round");
    }
    const reportedTenure = targetRows?.find((row) => row.tenure_before_2025_draft !== null)?.tenure_before_2025_draft;
    const priorTenure = reportedTenure ?? independent.cycle?.tenureYears ?? null;
    if (reportedTenure === undefined || reportedTenure === null) reviewFlags.push("tenure_inferred_from_complete_2024_draft_and_keeper_list");
    if (target) sourceCells = [...sourceCells, `'2025 Draft'!R${target.source_row + 1}`];
    sourceCells.push(...independent.sourceCells);
    if (base2025 === null) reviewFlags.push("missing_base_cost");
    const previous: KeeperCycle = { playerId: String(entry.player_id), lastSeason: 2024, tenureYears: priorTenure, nextKeeperRound: base2025, source: "keeper", firstRoundDraftIneligible: false };
    try {
      cycle = rolloverKeeperCycle(String(entry.player_id), previous, { kind: "kept", season: 2025, paymentRound: draft.round });
    } catch (error) {
      reviewFlags.push(`cycle_reconciliation_required: ${String(error)}`);
      cycle = { ...previous, lastSeason: 2025, tenureYears: priorTenure === null ? null : priorTenure + 1, nextKeeperRound: base2025 === null ? null : base2025 - 1, lastKeeperBaseRound: base2025 ?? undefined, lastPaymentRound: draft.round };
    }
    if (independent.cycle && base2025 !== independent.cycle.nextKeeperRound) reviewFlags.push("authoritative_2025_base_differs_from_independent_history_replay");
  } else if (draft) {
    cycle = rolloverKeeperCycle(String(entry.player_id), null, { kind: "drafted", season: 2025, round: draft.round });
  } else {
    cycle = rolloverKeeperCycle(String(entry.player_id), null, { kind: "undrafted", season: 2025, tenureYears: 1 });
    reviewFlags.push("undrafted_first_season_tenure_one_is_an_explicit_inference");
  }
  const eligibility = evaluateKeeperEligibility(cycle);
  return {
    player: entry.full_name, espnPlayerId: entry.player_id, franchiseId: String(team.team_id),
    status2025: draft ? draft.keeper ? "keeper" : "fresh-draft" : "undrafted",
    base2025, payment2025: draft?.round ?? null, tenureAfter2025: cycle.tenureYears,
    base2026: cycle.nextKeeperRound, eligible: eligibility.valid,
    ineligibilityReasons: eligibility.issues.map((issue) => issue.code),
    reviewFlags, sourceCells: [...new Set(sourceCells)],
  };
}));

if (draft2024.size !== 104 || draft2025.size !== 104) throw new Error("Expected complete 104-pick drafts for the historical eight-team seasons.");
if (projectionRows.length !== 111 || new Set(projectionRows.map((row) => row.espnPlayerId)).size !== 111) throw new Error("The frozen final roster must contain 111 distinct player IDs.");
const markedKeeperDisagreements = [...draft2025.values()].filter((entry) => entry.keeper !== workbookKeeperKeys2025.has(key(entry.player))).map((entry) => entry.player);
const replaySummary = summary(replayRows);
const projectionSummary = {
  total: projectionRows.length,
  keepers2025: projectionRows.filter((row) => row.status2025 === "keeper").length,
  freshlyDrafted2025: projectionRows.filter((row) => row.status2025 === "fresh-draft").length,
  undrafted2025: projectionRows.filter((row) => row.status2025 === "undrafted").length,
  eligible: projectionRows.filter((row) => row.eligible).length,
  ineligible: projectionRows.filter((row) => !row.eligible).length,
  provisionalCosts: projectionRows.filter((row) => row.reviewFlags.some((flag) => flag.startsWith("provisional_"))).length,
  inferredKeeperTenures: projectionRows.filter((row) => row.reviewFlags.includes("tenure_inferred_from_complete_2024_draft_and_keeper_list")).length,
};
const report = {
  schemaVersion: 1,
  sourceWorkbookSha256: workbook.sha256,
  summary: { replay2025: replaySummary, projection2026: projectionSummary },
  grandfatherPolicy: {
    authoritativeBaseline: "Commissioner-confirmed 2025 nominal costs, explicit duplicate precedence, and specific commissioner rulings.",
    preserveHistoricalPayments: true,
    retroactiveRepricing: false,
    independentReplayPurpose: "Audit discrepancies without silently replacing the authoritative 2025 baseline used for 2026.",
    explicitRulings: ["Evan Mobley's fresh 2025 draft resets cost and tenure.", "Quentin Grimes and Josh Hart retain provisional 2025 nominal round thirteen pending review."],
  },
  methodology: [
    "2025 replay does not use the 2025 target costs as calculation inputs. Actual 2024 keepers are identified by the commissioner-maintained 2024 list; their original year and round come from 2024 Draft V2. Newly drafted 2024 players reset to the actual draft round and tenure one; undrafted reentries start at round thirteen.",
    "The current domain engine advances nominal cost independently of payment. The older 2024 Draft sheet and corrected 2024 Draft V2 sheet are audited separately, including the V2 column explicitly labeled WRONG WAY BUT WHAT WE DID.",
    "2026 projection uses commissioner-confirmed 2025 costs and explicit rulings as its authoritative baseline. Independent historical discrepancies stay visible instead of silently rewriting that baseline.",
    "Known aliases are normalized explicitly; earlier non-round-thirteen entries take precedence over duplicate round-thirteen defaults. Conflicting non-thirteen targets remain flagged.",
    "Only player names, NBA player IDs, franchise numbers, costs, tenure, draft years and source-cell references are emitted. Authentication data, manager account IDs, workbook trade prose and local paths are excluded.",
  ],
  historicalAudits,
  replay2025: { summary: replaySummary, rows: replayRows },
  projection2026: { summary: projectionSummary, rows: projectionRows },
  sourceChecks: {
    draft2024Entries: draft2024.size, confirmedKeepers2024: keeperKeys2024.size,
    draft2025Entries: draft2025.size, confirmedKeepers2025: [...draft2025.values()].filter((entry) => entry.keeper).length,
    markedDraftUsed: Boolean(markedPath), markedKeeperDisagreements,
    confirmed2024KeepersMissingDraftSelection: [...keeperKeys2024].filter((playerKey) => !draft2024.has(playerKey)).map((playerKey) => origins2024.get(playerKey)?.player ?? playerKey),
    duplicateRawTargetRows: sourceRows.length - groupedTargets.size,
    rawTargetRows: sourceRows.length,
  },
  limitations: [
    "The 2026 Draft tab is an unfilled template with blank player inputs and stale prior-year headers/references. It provides no independent expected 2026 player-cost table; 2026 is validated against the confirmed rules and frozen roster instead.",
    "Historical formula replay checks arithmetic against independent input columns, not the truth of every original draft-year entry. A formula match is not a complete transaction-history certification.",
    "2018–2021 lifecycle replay is not certified: the workbook includes a historical keeper-point system and incomplete rule-version/retention metadata. Those draft tabs must be imported with their own historical rules.",
    "Seventeen retained players have inferred tenure rather than directly supplied tenure. The undrafted first-season tenure-one convention is separately labeled. Null source cells are never silently interpreted as zero.",
    "Quentin Grimes and Josh Hart retain their commissioner-provisional 2025 base thirteen and projected 2026 base twelve pending the promised history check.",
    "Historical actual keeper payments are preserved; this audit does not certify historical pick availability or retroactively apply the current allocation policy.",
  ],
};
const outputPath = argument("--output", "data/keeper-audit.json")!;
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath, summary: report.summary, historical: historicalAudits.map(({ season, method, summary: counts }) => ({ season, method, ...counts })), sourceChecks: report.sourceChecks }, null, 2));
