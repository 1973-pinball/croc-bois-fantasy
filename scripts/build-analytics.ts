import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Value = string | number | boolean | null;
interface Cell { cell: string; column: number; value: Value; formula?: string | null }
interface Row { row: number; cells: Cell[] }
interface Sheet { name: string; rows: Row[] }
interface Workbook { sha256: string; sheets: Sheet[] }
interface PublicTeam { id: number; name: string; owner: string; shortName: string; color: string }

export const FRANCHISE_ALIASES: Record<string, string[]> = {
  "1": ["Jon", "Jonathan", "Jonathan Martinez"],
  "2": ["Arod", "Anthony", "Anthony Rodriguez"],
  "3": ["Wyn", "Wyndham", "Wyndham Batchelor", "Wyndham Trade"],
  "4": ["Edwin", "Julian", "Edwin/Julian", "Sebastian", "Sebastian Rodriguez"],
  "5": ["Shane", "Shane Trauthwein"],
  "6": ["Justin", "Amber", "Justin & Amber", "Justin Hu", "Amber Hu"],
  "7": ["James", "James Childress"],
  "8": ["Cars", "Alex", "Alex Carsello"],
};
const plainKey = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function franchiseId(name: string): string | null {
  const sought = plainKey(name);
  return Object.entries(FRANCHISE_ALIASES).find(([, aliases]) => aliases.some((alias) => plainKey(alias) === sought))?.[0] ?? null;
}

/** Historical annotations name the recipient first and the earliest owner last. */
export function parseOwnerAnnotation(raw: string) {
  const chain = raw.split(/\bvia\b|[()]/i).map((part) => part.trim()).filter(Boolean);
  const historicalOwner = chain[0] ?? "";
  const originalOwner = chain.at(-1) ?? "";
  return {
    franchiseId: franchiseId(historicalOwner), historicalOwner,
    inferredOriginalFranchiseId: franchiseId(originalOwner), originalOwner,
    annotated: chain.length > 1,
  };
}

/** Only complete, finite observations are used; unknown values never become zeros. */
export function pearsonCorrelation(points: readonly { x: number | null; y: number | null }[]) {
  const matched = points.filter((point): point is { x: number; y: number } => typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y));
  if (matched.length < 2) return { r: null, n: matched.length };
  const meanX = matched.reduce((sum, point) => sum + point.x, 0) / matched.length;
  const meanY = matched.reduce((sum, point) => sum + point.y, 0) / matched.length;
  let covariance = 0, varianceX = 0, varianceY = 0;
  for (const point of matched) {
    covariance += (point.x - meanX) * (point.y - meanY);
    varianceX += (point.x - meanX) ** 2;
    varianceY += (point.y - meanY) ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return { r: null, n: matched.length };
  return { r: Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY))), n: matched.length };
}

const playerAliases: Record<string, string> = {
  stephcurry: "Stephen Curry", kat: "Karl-Anthony Towns", giannis: "Giannis Antetokounmpo",
  giannisantetokounpo: "Giannis Antetokounmpo", damienlillard: "Damian Lillard",
  damontissabonis: "Domantas Sabonis", damontassabonis: "Domantas Sabonis",
  camjohnson: "Cameron Johnson", paytonprichard: "Payton Pritchard", lugenzdort: "Luguentz Dort",
  nicolasclaxton: "Nic Claxton", jabarismith: "Jabari Smith Jr.", treymurphy: "Trey Murphy III",
  herbjones: "Herbert Jones", garytrent: "Gary Trent Jr.", robertwilliams: "Robert Williams III",
  jimmybutleriii: "Jimmy Butler", scaryterry: "Terry Rozier", jonasvalenciunas: "Jonas Valanciunas",
};
function playerName(value: Value | undefined): string {
  if (typeof value !== "string") return "";
  const name = value.replace(/\s+\(.*/, "").trim();
  return playerAliases[plainKey(name)] ?? name;
}
const playerKey = (name: string) => plainKey(playerAliases[plainKey(name)] ?? name);
const getCell = (row: Row, column: number) => row.cells.find((cell) => cell.column === column);
const getNumber = (value: Value | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
const getString = (value: Value | undefined) => typeof value === "string" ? value.trim() : "";
const ref = (sheet: Sheet, cell: Cell | undefined) => cell ? `'${sheet.name}'!${cell.cell}` : "missing-source-cell";

interface Selection {
  season: number;
  round: number;
  overallPick: number;
  player: string;
  franchiseId: string;
  historicalOwner: string;
  originalFranchiseId: string | null;
  originalHistoricalOwner: string;
  originalOwnerEvidence: "explicit_original_owner_column" | "reconstructed_owner_annotation";
  ownerAnnotation: string;
  kept: boolean | null;
  sourceCells: string[];
}
interface SeasonOrder {
  season: number;
  franchiseId: string;
  position: number;
  historicalOwner: string;
  evidence: Selection["originalOwnerEvidence"];
  ownerAnnotation: string;
  sourceCells: string[];
}

export function positionCounts(orders: readonly { season: number; franchiseId: string; position: number }[]) {
  const groups = new Map<string, { franchiseId: string; position: number; count: number; seasons: number[] }>();
  for (const order of orders) {
    const groupKey = `${order.franchiseId}:${order.position}`;
    const group = groups.get(groupKey) ?? { franchiseId: order.franchiseId, position: order.position, count: 0, seasons: [] };
    group.count += 1;
    group.seasons.push(order.season);
    groups.set(groupKey, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.franchiseId) - Number(b.franchiseId) || a.position - b.position);
}

export async function buildAnalytics(workbookPath = ".local/workbook.json", outputPath = "data/analytics.json") {
  const book = JSON.parse(await readFile(workbookPath, "utf8")) as Workbook;
  const league = JSON.parse(await readFile("data/league.json", "utf8")) as { teams: PublicTeam[]; players: { name: string }[] };
  const sheet = (name: string): Sheet => {
    const found = book.sheets.find((entry) => entry.name === name);
    if (!found) throw new Error(`Workbook tab missing: ${name}`);
    return found;
  };
  const draftYears = Array.from({ length: 8 }, (_, index) => 2018 + index);
  const knownKeepers = new Map<number, Map<string, boolean>>();
  knownKeepers.set(2023, new Map(sheet("2023 Draft").rows.flatMap((row) => {
    const marked = getString(getCell(row, 16)?.value).toLowerCase();
    const name = playerName(getCell(row, 11)?.value);
    return name && ["yes", "no"].includes(marked) ? [[playerKey(name), marked === "yes"]] : [];
  })));
  const kept2024 = new Set(sheet("2025 Draft").rows.filter((row) => row.row >= 4).map((row) => playerKey(playerName(getCell(row, 25)?.value))).filter(Boolean));
  const markedDraftCandidates = [".local/marked-2025-draft.tsv", "data/audit-inputs/marked-2025-draft.tsv"];
  let markedDraftPath: string | undefined;
  for (const candidate of markedDraftCandidates) if (await access(candidate).then(() => true, () => false)) { markedDraftPath = candidate; break; }
  if (!markedDraftPath) throw new Error("The commissioner-marked 2025 draft is required; the workbook keeper sidebar has known disagreements.");
  const marked2025 = new Map((await readFile(markedDraftPath, "utf8")).replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/).slice(1).map((line) => {
    const fields = line.split("\t");
    return [playerKey(playerName(fields[4])), fields[5]?.trim().toLowerCase() === "x"] as const;
  }));
  knownKeepers.set(2025, marked2025);

  const selections: Selection[] = [];
  const unresolvedRows: { season: number; sourceCells: string[]; reason: string }[] = [];
  for (const season of draftYears) {
    const source = sheet(`${season} Draft`);
    for (const row of source.rows) {
      const blocks = season === 2018 ? [{ pick: 1, owner: 2, player: 3 }, { pick: 5, owner: 6, player: 7 }]
        : season <= 2021 ? [{ pick: 2, owner: 3, player: 4 }, { pick: 6, owner: 7, player: 8 }]
          : [{ pick: 2, owner: 4, player: 5 }];
      for (const block of blocks) {
        const overallPick = getNumber(getCell(row, block.pick)?.value);
        if (overallPick === null || !Number.isInteger(overallPick) || overallPick < 1 || overallPick > 104) continue;
        const name = playerName(getCell(row, block.player)?.value);
        const ownerText = getString(getCell(row, block.owner)?.value);
        const owner = parseOwnerAnnotation(ownerText);
        const sourceCells = [ref(source, getCell(row, block.pick)), ref(source, getCell(row, block.owner)), ref(source, getCell(row, block.player))];
        if (!name || !owner.franchiseId) {
          unresolvedRows.push({ season, sourceCells, reason: !name ? "No selected player recorded." : "Owner label could not be mapped to a continuing franchise." });
          continue;
        }
        const originalText = season >= 2022 ? getString(getCell(row, 3)?.value) : owner.originalOwner;
        const originalFranchiseId = season >= 2022 ? franchiseId(originalText) : owner.inferredOriginalFranchiseId;
        let kept: boolean | null = null;
        if (season === 2024) kept = kept2024.has(playerKey(name));
        else kept = knownKeepers.get(season)?.get(playerKey(name)) ?? null;
        selections.push({
          season, round: Math.ceil(overallPick / 8), overallPick, player: name,
          franchiseId: owner.franchiseId, historicalOwner: owner.historicalOwner,
          originalFranchiseId, originalHistoricalOwner: originalText,
          originalOwnerEvidence: season >= 2022 ? "explicit_original_owner_column" : "reconstructed_owner_annotation",
          ownerAnnotation: ownerText, kept,
          sourceCells: season >= 2022 ? [...sourceCells, ref(source, getCell(row, 3))] : sourceCells,
        });
      }
    }
  }
  const duplicatePicks = selections.filter((entry, index) => selections.findIndex((other) => other.season === entry.season && other.overallPick === entry.overallPick) !== index);
  if (duplicatePicks.length) throw new Error("Historical parsing found duplicate overall picks; reconcile the source grid before publishing analytics.");
  const canonicalNames = new Map(league.players.map((player) => [playerKey(player.name), player.name]));
  for (const selection of [...selections].sort((a, b) => b.season - a.season)) if (!canonicalNames.has(playerKey(selection.player))) canonicalNames.set(playerKey(selection.player), selection.player);
  selections.forEach((selection) => { selection.player = canonicalNames.get(playerKey(selection.player))!; });

  const allSeasonOrders: SeasonOrder[] = selections.filter((entry) => entry.round === 1 && entry.originalFranchiseId !== null).map((entry) => ({
    season: entry.season, franchiseId: entry.originalFranchiseId!, position: entry.overallPick,
    historicalOwner: entry.originalHistoricalOwner, evidence: entry.originalOwnerEvidence,
    ownerAnnotation: entry.ownerAnnotation, sourceCells: entry.sourceCells,
  }));
  for (const season of draftYears) {
    const order = allSeasonOrders.filter((entry) => entry.season === season);
    if (order.length !== 8 || new Set(order.map((entry) => entry.franchiseId)).size !== 8) throw new Error(`The ${season} original first-round order is incomplete or ambiguous.`);
  }
  const explicitOrders = allSeasonOrders.filter((entry) => entry.evidence === "explicit_original_owner_column");
  const inferredOrders = allSeasonOrders.filter((entry) => entry.evidence === "reconstructed_owner_annotation");

  const affinities = new Map<string, { franchiseId: string; player: string; picks: number; keeperSelections: number; freshSelections: number; unknownSelections: number; seasons: number[]; selections: { season: number; kept: boolean | null; round: number; overallPick: number; historicalOwner: string; sourceCells: string[] }[] }>();
  for (const selection of selections) {
    const groupKey = `${selection.franchiseId}:${playerKey(selection.player)}`;
    const affinity = affinities.get(groupKey) ?? { franchiseId: selection.franchiseId, player: selection.player, picks: 0, keeperSelections: 0, freshSelections: 0, unknownSelections: 0, seasons: [], selections: [] };
    affinity.picks += 1;
    if (selection.kept === true) affinity.keeperSelections += 1;
    else if (selection.kept === false) affinity.freshSelections += 1;
    else affinity.unknownSelections += 1;
    affinity.seasons.push(selection.season);
    affinity.selections.push({ season: selection.season, kept: selection.kept, round: selection.round, overallPick: selection.overallPick, historicalOwner: selection.historicalOwner, sourceCells: selection.sourceCells });
    affinities.set(groupKey, affinity);
  }

  const graph = sheet("Graph");
  const graphHeaders = graph.rows.find((row) => row.row === 3)!;
  const winsYearColumns = graphHeaders.cells.flatMap((entry) => {
    const match = typeof entry.value === "string" ? /^(20\d{2}) wins$/.exec(entry.value) : null;
    return match ? [{ season: Number(match[1]), column: entry.column }] : [];
  });
  const observations = graph.rows.filter((row) => row.row >= 4 && row.row <= 11).map((row) => {
    const historicalOwner = getString(getCell(row, 1)?.value);
    const id = franchiseId(historicalOwner);
    if (!id) throw new Error(`Graph owner cannot be reconciled: ${historicalOwner}`);
    const tradeCell = getCell(row, 2)!;
    const winsCell = getCell(row, 3)!;
    const annualWins = winsYearColumns.map(({ season, column }) => ({ season, wins: getNumber(getCell(row, column)?.value), sourceCell: ref(graph, getCell(row, column)) }));
    const wins = getNumber(winsCell.value), trades = getNumber(tradeCell.value);
    const annualWinsSum = annualWins.every((entry) => entry.wins !== null) ? annualWins.reduce((sum, entry) => sum + entry.wins!, 0) : null;
    const formulaIssues: string[] = [];
    if (row.row === 6) formulaIssues.push("The formula subtracts Edwin's column-D appearances instead of adding them and excludes Julian's alias. This is the recorded workbook count, not a reconciled franchise trade total.");
    if (/-\s*\d+\s*$/.test(tradeCell.formula ?? "")) formulaIssues.push("The formula contains a manual subtraction whose rationale is not recorded in the Graph tab.");
    if (wins !== annualWinsSum) formulaIssues.push("The recorded aggregate win count differs from the available annual cells.");
    return { franchiseId: id, historicalOwner, season: null, wins, trades, annualWins, annualWinsSum, tradeFormula: tradeCell.formula ?? null, formulaIssues, sourceCells: [ref(graph, getCell(row, 1)), ref(graph, tradeCell), ref(graph, winsCell)] };
  });
  const correlation = pearsonCorrelation(observations.map((entry) => ({ x: entry.trades, y: entry.wins })));
  const recordedCorrelation = getNumber(graph.rows.find((row) => row.row === 1)?.cells.find((cell) => cell.column === 11)?.value);

  const firstPickCounts = positionCounts(allSeasonOrders.filter((entry) => entry.position === 1));
  const maximumFirsts = Math.max(...firstPickCounts.map((entry) => entry.count));
  const fishWinners = firstPickCounts.filter((entry) => entry.count === maximumFirsts).map((entry) => ({ franchiseId: entry.franchiseId, value: entry.count, seasons: entry.seasons }));
  const coverageBySeason = draftYears.map((season) => ({
    season, recordedSelections: selections.filter((entry) => entry.season === season).length,
    expectedPicks: 104, unresolvedRows: unresolvedRows.filter((entry) => entry.season === season).length,
    knownKeeperSelections: selections.filter((entry) => entry.season === season && entry.kept === true).length,
    knownFreshSelections: selections.filter((entry) => entry.season === season && entry.kept === false).length,
    unknownClassificationSelections: selections.filter((entry) => entry.season === season && entry.kept === null).length,
  }));
  const report = {
    version: 1,
    generatedFrom: { workbookSha256: book.sha256, sheets: [...draftYears.map((year) => `${year} Draft`), "Graph"], additionalEvidence: ["Commissioner-marked 2025 draft", "Confirmed 2024 keeper list"] },
    seasons: draftYears,
    coverage: { draftYears, selectionCount: selections.length, bySeason: coverageBySeason, unresolvedRows,
      limitations: ["Draft-board appearances include retained players and acquisitions through traded picks; they are not a measure of fresh-draft preference alone.", "2018–2021 original slots are reconstructed from owner annotations. Explicit original-owner columns begin in 2022.", "Historical owner labels are preserved as recorded; franchise continuity does not attribute Edwin's or Julian's selections to incoming manager Sebastian.", "The 2023 Draft!D61 label 'WYNDHAM TRADE' is mapped to Wyndham's franchise; its original owner is separately recorded as Arod in C61."] },
    franchises: league.teams.map((team) => ({ id: String(team.id), name: team.name, currentOwner: team.owner, shortName: team.shortName, color: team.color, aliases: FRANCHISE_ALIASES[String(team.id)] })),
    draftPositions: {
      metric: "original_first_round_position", years: [...new Set(explicitOrders.map((entry) => entry.season))],
      rows: positionCounts(explicitOrders), seasonOrders: explicitOrders,
      inferredYears: [...new Set(inferredOrders.map((entry) => entry.season))], inferredRows: positionCounts(inferredOrders), inferredSeasonOrders: inferredOrders,
      allRows: positionCounts(allSeasonOrders),
      lotteryPriorityAvailable: false,
      explanation: "Original first-round position measures the franchise's draft slot before pick trades. It is not the identity of the team receiving that pick and is not lottery choice priority.",
      reconstruction: "For 2018–2021, the leading owner is the pick recipient and the last owner in a '(via ...)' or nested parenthetical chain is treated as its original owner. Unannotated owners are treated as original owners. Each reconstructed first round contains all eight distinct franchises; individual source annotations remain available for review.",
    },
    actualFirstRoundRecipients: { metric: "actual_recipient_of_first_round_pick", years: draftYears,
      rows: positionCounts(selections.filter((entry) => entry.round === 1).map((entry) => ({ season: entry.season, franchiseId: entry.franchiseId, position: entry.overallPick }))),
      selections: selections.filter((entry) => entry.round === 1),
      explanation: "Recipients can own multiple first-round picks through trades. These counts are deliberately separate from original draft positions." },
    playerPreferences: {
      metric: "draft_board_appearances_by_actual_recipient", years: draftYears,
      rows: [...affinities.values()].sort((a, b) => b.picks - a.picks || a.player.localeCompare(b.player) || a.franchiseId.localeCompare(b.franchiseId)),
      keeperClassificationCoverage: coverageBySeason,
      limitations: ["Keeper classification is unavailable for 2018–2022 and for 2023 names without an explicit Yes/No marker; unknown is not treated as a fresh draft.", "The confirmed 2024 keeper list names 34 players, but only 33 occur on the 2024 draft board; Marcus Smart has no recorded draft-board appearance and is not added as an invented pick.", "Known spelling variants and nicknames are normalized explicitly. This analysis measures observed draft-board appearances, not an owner's private preferences or complete in-season roster history."],
    },
    winsTrades: {
      observations, pearson: correlation.r, sampleSize: correlation.n,
      cohort: "Eight continuing franchises; one aggregated point per franchise from Graph!A4:C11.",
      units: { trades: "As-recorded cumulative trade participation count from Graph column B.", wins: "Recorded regular-season wins summed over Graph year labels 2018–2024; the workbook does not identify these as weekly matchup wins or NBA game wins.", observation: "One franchise, aggregated across years." },
      winsYears: winsYearColumns.map((entry) => entry.season), tradeYears: null,
      recordedWorkbookCorrelation: recordedCorrelation,
      correlationMatchesWorkbook: correlation.r !== null && recordedCorrelation !== null && Math.abs(correlation.r - recordedCorrelation) < 1e-9,
      limitations: ["This reproduces the Graph tab as recorded, including its formula problems; no corrected or causal estimate is asserted.", "The trade formulas count the entire trade ledger, while wins cover 2018–2024. The periods are not aligned; annual trade counts are unavailable in Graph.", "Graph!B6 subtracts Edwin appearances and omits Julian; several other rows subtract manual adjustments. Alias changes also limit comparability.", "Eight aggregate observations are descriptive. Positive correlation does not show that making trades causes wins."],
    },
    awards: [
      { id: "fish-on-heater", title: "Fish on heater", metric: "most_original_first_overall_draft_slots", status: "available",
        winners: fishWinners, coverage: "2018–2025; original owners are explicit in 2022–2025 and reconstructed from owner annotations in 2018–2021.",
        explanation: "Most original No. 1 draft positions, before any pick trades. Ties share the award. The 2018 No. 1 recipient was James via Cars; the original slot belongs to Cars.",
        inferredSeasons: [2018, 2019, 2020, 2021], evidence: allSeasonOrders.filter((entry) => entry.position === 1) },
      { id: "luckbox", title: "Luckbox", metric: "top_four_original_draft_slots_after_prior_season_playoffs", status: "insufficient-data",
        winners: [], coverage: "Draft years 2018–2025 need prior-season playoff qualification for 2017–2024.",
        explanation: "Awaiting playoff history. The workbook contains generic playoff/non-playoff lottery odds, but no franchise-by-year playoff qualification records. Unknown is not zero.",
        neededSeasons: draftYears.map((draftYear) => ({ draftYear, priorSeasonYear: draftYear - 1, missing: "Franchise playoff qualification in the season feeding this draft" })) },
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: outputPath, selections: selections.length, bySeason: coverageBySeason, winsTradesPearson: correlation, fishWinners, unresolvedRows }, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAnalytics(process.argv[2] ?? ".local/workbook.json", process.argv[3] ?? "data/analytics.json");
}
