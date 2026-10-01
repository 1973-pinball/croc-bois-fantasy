import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Value = string | number | boolean | null;
interface Cell { cell: string; column: number; value: Value }
interface Workbook { sha256: string; sheets: {name: string;rows: {row: number;cells: Cell[]}[]}[] }

function argument(flag: string, fallback: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index+1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

// Only columns read by audit-keepers.ts. No owner columns, trade prose, formulas,
// formatting, workbook relationships, account metadata, or unrelated sheets.
const columns: Record<string, number[]> = {
  'Player_Pick_Costs': [6,7,8,9],
  '2023 Draft': [1,2,5,11,12,13,14,15,16],
  '2024 Draft': [1,2,5,12,13,14,15],
  '2024 Draft V2': [10,11,12,13,14],
  '2025 Draft': [1,2,5,23,25],
};
const workbook = JSON.parse(await readFile(argument('--workbook','.local/workbook.json'),'utf8')) as Workbook;
if (!/^[a-f0-9]{64}$/i.test(workbook.sha256)) throw new Error('The source workbook must have a SHA256 provenance hash.');
const sanitizedWorkbook: Workbook = {
  sha256: workbook.sha256,
  sheets: Object.entries(columns).map(([name, keep]) => {
    const source = workbook.sheets.find((s) => s.name === name);
    if (!source) throw new Error(`Required audit sheet is missing: ${name}`);
    return { name, rows: source.rows.map((row) => ({row:row.row,cells:row.cells.filter((cell) => keep.includes(cell.column)).map(({cell,column,value}) => ({cell,column,value}))})).filter((row) => row.cells.length>0) };
  }),
};
const sourceCosts = JSON.parse(await readFile(argument('--costs','keeper_costs_2025_source.json'),'utf8')) as {rows:{source_row:number;player:string;keeper_cost_2025:Value;tenure_before_2025_draft:number|null}[]};
const costs = { rows: sourceCosts.rows.map(({source_row,player,keeper_cost_2025,tenure_before_2025_draft}) => ({source_row,player,keeper_cost_2025,tenure_before_2025_draft})) };
const sourceRoster = JSON.parse(await readFile(argument('--rosters','croc_bois_139935_2025-26_migration.json'),'utf8')) as {teams:{team_id:number;roster:{entries:{player_id:number;full_name:string}[]}}[]};
const rosters = {teams:sourceRoster.teams.map((team) => ({team_id:team.team_id,roster:{entries:team.roster.entries.map(({player_id,full_name}) => ({player_id,full_name}))}}))};
const markedText = await readFile(argument('--marked-draft','.local/marked-2025-draft.tsv'),'utf8');
const markedRows = markedText.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/).slice(1).map((line,index) => {
  const fields = line.split('\t');
  if (!Number.isInteger(Number(fields[0])) || !fields[4]?.trim()) throw new Error(`Invalid marked draft row ${index+2}`);
  // Retain six-column positions consumed by the audit, leaving owner cells empty.
  return [fields[0],fields[1],'','',fields[4],fields[5]?.trim() ?? ''].join('\t');
});
const markedDraft = ['Round\tPick\tUnused original owner\tUnused actual owner\tPlayer\tKept',...markedRows].join('\n')+'\n';
const files: Record<string,string> = {
  'workbook.json':JSON.stringify(sanitizedWorkbook,null,2)+'\n',
  'keeper-costs-2025.json':JSON.stringify(costs,null,2)+'\n',
  'rosters.json':JSON.stringify(rosters,null,2)+'\n',
  'marked-2025-draft.tsv':markedDraft,
};
const outputDirectory = argument('--output-dir','data/audit-inputs');
await mkdir(outputDirectory,{recursive:true});
for (const [name,content] of Object.entries(files)) await writeFile(path.join(outputDirectory,name),content,'utf8');
const manifest = {
  schemaVersion:1,
  purpose:'Minimal public inputs for the historical keeper audit; not a full workbook or ESPN account export.',
  originalWorkbookSha256:workbook.sha256,
  workbookColumns:columns,
  rawCostRows:costs.rows.length,
  rosterTeams:rosters.teams.length,
  rosterPlayers:rosters.teams.reduce((count,team) => count+team.roster.entries.length,0),
  markedDraftRows:markedRows.length,
  omitted:['Workbook formulas and formatting','Owner/manager names and account identifiers','Trade prose and unrelated workbook sheets','ESPN member objects, credentials, acquisition metadata, and local source paths'],
  files:Object.entries(files).map(([name,content]) => ({name,sha256:createHash('sha256').update(content).digest('hex'),bytes:Buffer.byteLength(content)})),
};
await writeFile(path.join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
console.log(JSON.stringify({files:manifest.files,rawCostRows:manifest.rawCostRows,rosterTeams:manifest.rosterTeams,rosterPlayers:manifest.rosterPlayers,markedDraftRows:manifest.markedDraftRows},null,2));
