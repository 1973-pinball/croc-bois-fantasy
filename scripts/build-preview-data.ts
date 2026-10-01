import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import type { LeagueData, LeaguePlayer, HistoricalDraft, TradeRecord } from "../src/lib/types";
type Cell = { cell:string; column:number; row:number; value:unknown; formula:string|null; strike:boolean };
type Sheet = {name:string;rows:{row:number;cells:Cell[]}[]};
const read = (path:string) => JSON.parse(readFileSync(path,"utf8").replace(/^\uFEFF/,""));
const workbook = read(".local/workbook.json") as {sheets:Sheet[]};
const roster = read("croc_bois_139935_2025-26_migration.json");
const source = read("keeper_costs_2025_source.json");
const decisions = read("planning_reconciliation.json");
const oldKeepers = read("data/keeper-history-2024.json") as {Player:string;Team:string}[];
const aliases:Record<string,string> = {
 "damontissabonis":"domantassabonis","lugenzdort":"luguentzdort","nicolasclaxton":"nicclaxton",
 "cameronjohnson":"camjohnson","stephcurry":"stephencurry","giannis":"giannisantetokounmpo",
 "giannisantetokounpo":"giannisantetokounmpo","jimmybutleriii":"jimmybutler","paytonprichard":"paytonpritchard",
 "pascal sikiam":"pascalsiakam","jjj":"jarenjacksonjr"
};
function key(v:unknown) { const k=String(v??"").replace(/\s*\(.*$/,"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,""); return aliases[k]??k; }
function clean(v:unknown) { return String(v??"").replace(/\s*\(.*$/,"").trim(); }
function cell(row:{cells:Cell[]},col:number) { return row.cells.find(c=>c.column===col); }
function val(row:{cells:Cell[]},col:number) { return cell(row,col)?.value; }
const marked = readFileSync(".local/marked-2025-draft.tsv","utf8").trim().split(/\r?\n/).slice(1).map(line=>{
 const [round,pick,originalOwner,owner,player,kept] = line.split("\t");
 return {round:Number(round),pick:Number(pick),originalOwner,owner,player:clean(player),kept:kept?.trim()==="x"};
});
assert.equal(marked.length,104);
const draftMap = new Map(marked.map(p=>[key(p.player),p]));
const costs = new Map<string,{cost:number|string;tenure:number|null}>();
for (const r of source.rows) {
 const k=key(r.player), previous=costs.get(k);
 if (!previous) costs.set(k,{cost:r.keeper_cost_2025,tenure:r.tenure_before_2025_draft});
 else if (previous.tenure===null && r.tenure_before_2025_draft!==null) previous.tenure=r.tenure_before_2025_draft;
}
for (const p of ["Deni Avdija","Payton Pritchard","Andrew Wiggins","Dyson Daniels","Quentin Grimes","Josh Hart"]) {
 if (!costs.has(key(p))) costs.set(key(p),{cost:13,tenure:null});
}
const priorKept=new Set(oldKeepers.map(p=>key(p.Player)));
const provisional=new Set(["Quentin Grimes","Josh Hart"].map(key));
const players:LeaguePlayer[] = [];
for (const t of roster.teams) for (const p of t.roster.entries) {
 const k=key(p.full_name), drafted=draftMap.get(k), c=costs.get(k);
 let baseCost:number|null=null, tenure:number|null=null, status:LeaguePlayer["status"]="eligible", reason="";
 if (!drafted) { baseCost=13;tenure=1;reason="Undrafted in 2025. Initial keeper cost is round 13; season tenure shown as year 1."; }
 else if (!drafted.kept) { baseCost=drafted.round>1?drafted.round-1:null;tenure=1;reason="Fresh 2025 draft resets the keeper cycle."; if(drafted.round===1){status="ineligible";reason="Drafted in the first round in 2025.";} }
 else {
   baseCost=typeof c?.cost==="number"?c.cost-1:null;
   tenure=c?.tenure!==null&&c?.tenure!==undefined?c.tenure+1:(!priorKept.has(k)?2:null);
   reason=c?.tenure!==null&&c?.tenure!==undefined?"2025 base cost and recorded keeper tenure rolled forward.":"Tenure inferred from first retention in the supplied 2024/2025 keeper lists.";
   if(baseCost===null||tenure===null){status="review";reason="Keeper history needs commissioner review.";}
   if(tenure!==null&&tenure>=5){status="ineligible";reason="Reached five seasons of tenure in 2025–26.";}
   if(provisional.has(k)){status="review";reason="Provisional round 12. Commissioner will double-check the 2024 free-agent history.";}
 }
 players.push({id:p.player_id,name:p.full_name,teamId:t.team_id,baseCost,tenure,status,reason,wasKept:!!drafted?.kept,previousRound:drafted?.round??null,rosterSlot:p.lineup_slot_label});
}
assert.equal(players.length,111);
assert.equal(new Set(players.map(p=>p.id)).size,111);
const owners:Record<number,string>={1:"Jon",2:"Arod",3:"Wyndham",4:"Sebastian",5:"Shane",6:"Justin & Amber",7:"James",8:"Cars"};
const colors=["#14634d","#d88042","#5c6654","#637b86","#9d6446","#87714d","#596589","#8b5d74"];
const teams=roster.teams.map((t:any,i:number)=>({id:t.team_id,name:t.name,owner:owners[t.team_id],shortName:owners[t.team_id],managers:t.team_id===4?["Sebastian Rodriguez (incoming)"]:t.managers.map((m:any)=>m.first_name),color:colors[i]}));
const picks=teams.flatMap((t:any)=>Array.from({length:13},(_,i)=>({id:`2026-${t.id}-${i+1}`,season:2026,round:i+1,originalTeamId:t.id,ownerTeamId:t.id})));
for(const p of picks) { if(p.originalTeamId===2&&[3,4].includes(p.round))p.ownerTeamId=1; if(p.originalTeamId===1&&p.round===8)p.ownerTeamId=5; }
assert.equal(picks.length,104);
assert.deepEqual(teams.map((t:any)=>picks.filter((p:any)=>p.ownerTeamId===t.id).length),[14,11,13,13,14,13,13,13]);
const drafts:HistoricalDraft[]=[{year:2025,selections:marked}];
for(const year of [2024,2023,2022,2021,2020,2019,2018]) {
 const sheet=workbook.sheets.find(s=>s.name===`${year} Draft`)!;
 const selections:HistoricalDraft["selections"]=[];
 for(const row of sheet.rows) {
   const starts=year>=2022?[1]:[1,5];
   for(const start of starts) {
     const round=year===2018?Math.ceil(Number(val(row,start))/8):Number(val(row,start));
     const pick=Number(val(row,start+(year===2018?0:1)));
     if(!Number.isInteger(round)||round<1||round>13||!Number.isInteger(pick)||pick<1||pick>104)continue;
     const owner=String(val(row,start+(year===2018?1:2))??"");
     const actualOwner=year>=2022?String(val(row,4)??owner):owner;
     const rawPlayer=val(row,year>=2022?5:start+(year===2018?2:3));
     const player=clean(rawPlayer)||"Unrecorded";
     selections.push({round,pick,originalOwner:owner,owner:actualOwner,player,kept:year===2024?priorKept.has(key(player)):null});
   }
 }
 selections.sort((a,b)=>a.pick-b.pick);
 assert.equal(new Set(selections.map(p=>p.pick)).size,selections.length,`Duplicate picks ${year}`);
 drafts.push({year,selections});
}
const trades:TradeRecord[]=[];
for(const row of workbook.sheets.find(s=>s.name==="Trades")!.rows) {
 if(row.row===1)continue;
 const raw=val(row,1), numbered=typeof raw==="number"||/^\d+[a-z]?$/.test(String(raw??""));
 if(numbered) {
   const id=String(raw);
   trades.push({id,parties:[val(row,2),val(row,4)].filter(Boolean).map(String),
     summary:[val(row,2)&&`${val(row,2)} gives ${val(row,3)??""}`,val(row,4)&&`${val(row,4)} gives ${val(row,5)??""}`].filter(Boolean).join(" / "),
     notes:String(val(row,6)??""),status:["16","19"].includes(id)||row.cells.some(c=>c.strike)?"voided":"recorded"});
 } else if(trades.length && [2,3,4,5,6].some(c=>val(row,c))) {
   const t=trades[trades.length-1];
   t.summary+="\n"+[2,3,4,5].map(c=>val(row,c)).filter(Boolean).join(" — ");
   t.notes += (val(row,6)?"\n"+val(row,6):"");
   for(const col of [2,4])if(val(row,col)&&!t.parties.includes(String(val(row,col))))t.parties.push(String(val(row,col)));
 }
}
const charter=[
 {title:"League format",paragraphs:["Head-to-head categories: points, assists, rebounds, steals, blocks, field-goal percentage, free-throw percentage, three-pointers made and turnovers.","13 roster spots: 10 starters and 3 bench, plus 1 IR. Daily lineups lock at each player’s tipoff. One-day waivers and four acquisitions per matchup.","Four teams reach the playoffs. Head-to-head record breaks seeding ties. Season dates are set by the commissioner."]},
 {title:"Keepers",paragraphs:["Keepers come from the previous season’s final roster. Newly drafted first-round players cannot be kept. The drafted season counts as tenure year one; a player with five completed consecutive seasons must return to the draft.","Each retention advances the underlying cost one round earlier. Paying an earlier pick because another round is unavailable does not accelerate future cost. An undrafted player starts at round 13.","Trades and waiver moves preserve the keeper cycle. Re-entering the draft without being kept resets it. Keeper rights stay with the player.","Owners choose their payment picks. Each pick can fund one keeper. If the required round is unavailable, move to the next available earlier round. Owners cannot voluntarily overpay while a suitable later pick remains.","Submissions are private until every team is locked. Owners can edit until the commissioner locks them."]},
 {title:"Trades",paragraphs:["Players, future picks and multi-team agreements can be logged. Future-pick trades have no season cap. Record conditions, loans and options explicitly for commissioner review.","The charter provides a 24-hour review and veto by four other league members. Voting units and draft-day exceptions need commissioner confirmation before automation.","Historical voided trades remain visible without applying their transfers. Complex obligations require reconciliation. ESPN execution remains separate from this asset ledger."]},
 {title:"Draft and lottery",paragraphs:["Thirteen rounds in snake order. A lottery determines the order teams choose their draft position.","For eight teams, playoff and non-playoff groups use the charter’s published probabilities. Expansion requires an approved probability configuration, not an extrapolation of the eight-team table.","The commissioner runs the lottery on stream. Draft order is released after the keeper deadline and 24 hours before the draft. The commissioner must give an inaugural speech."]},
 {title:"League history",paragraphs:["A franchise keeps its players, picks, obligations and history when its manager changes. Edwin, Julian and incoming manager Sebastian Rodriguez represent successive ownership of one team.","This app is replacing the league workbook. Original source records and commissioner corrections are tracked separately."]}
];
const reviewItems=players.filter(p=>p.status==="review").map(p=>({id:`player-${p.id}`,player:p.name,detail:p.reason,status:"provisional" as const}));
const data:LeagueData={season:2026,snapshotDate:"2026-03-29",teams,players,picks,drafts,trades,reviewItems,charter};
mkdirSync("data",{recursive:true});
writeFileSync("data/league.json",JSON.stringify(data,null,2)+"\n");
console.log(JSON.stringify({teams:teams.length,players:players.length,picks:picks.length,trades:trades.length,drafts:drafts.map(d=>({year:d.year,picks:d.selections.length})),review:reviewItems.length}));
