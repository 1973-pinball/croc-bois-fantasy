import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { LeagueData } from "../src/lib/types";
const read=(p:string)=>JSON.parse(readFileSync(p,"utf8").replace(/^\uFEFF/,""));
const data=read("data/league.json") as LeagueData;
const source=read("croc_bois_139935_2025-26_migration.json");
const rawSource=read("espn_139935_2026_final_day_raw.json");
const audit=read("data/keeper-audit.json");
function id(label:string){const h=createHash("sha256").update("croc-bois:"+label).digest("hex").slice(0,32);return h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-8"+h.slice(17,20)+"-"+h.slice(20);}
const q=(v:unknown):string=>v===null||v===undefined?"null":typeof v==="number"?String(v):typeof v==="boolean"?(v?"true":"false"):"'"+String(v).replaceAll("'","''")+"'";
const j=(v:unknown)=>q(JSON.stringify(v))+"::jsonb";
const league=id("league:139935"),season=id("season:2026"),rule=id("rule:2026"),snapshot=id("roster:2026-03-29");
const franchises=Object.fromEntries(data.teams.map(t=>[String(t.id),id("franchise:"+t.id)]));
const pickIds=Object.fromEntries(data.picks.map(p=>[p.id,id("pick:"+p.id)]));
const sql:string[]=["-- Reviewed bootstrap for an EMPTY project after migrations. Never replay over live state.","begin;",`do $$ begin if exists(select 1 from public.leagues where id=${q(league)}::uuid or slug='croc-bois') then raise exception 'Croc Bois already exists. Bootstrap must not overwrite live league state.'; end if; end $$;`];
function insert(table:string,record:Record<string,unknown>,jsonColumns:string[]=[]){
 sql.push(`insert into public.${table}(${Object.keys(record).join(",")}) values(${Object.entries(record).map(([k,v])=>jsonColumns.includes(k)?j(v):q(v)).join(",")});`);
}
insert("leagues",{id:league,slug:"croc-bois",name:"Croc Bois Fantasy Basketball",espn_league_id:139935});
insert("rule_versions",{id:rule,league_id:league,version:1,rules:{draftedSeasonCounts:true,baseCostSeparateFromPayment:true,reviewHours:24,source:"Commissioner clarifications, 2026"}},["rules"]);
insert("seasons",{id:season,league_id:league,label:"2026–27",draft_year:2026,rule_version_id:rule,participant_count:data.teams.length,phase:"setup"});
for(const t of data.teams){
 insert("franchises",{id:franchises[t.id],league_id:league,name:t.name,espn_team_id:t.id});
 insert("season_teams",{season_id:season,franchise_id:franchises[t.id],league_id:league,display_name:t.name});
 for(const name of t.managers){const manager=id("manager:"+name);
 insert("managers",{id:manager,league_id:league,display_name:name});
 insert("manager_assignments",{id:id("assignment:"+t.id+":"+name),league_id:league,franchise_id:franchises[t.id],manager_id:manager,historical_note:"Imported display identity only. Commissioner must confirm dates and attach a verified auth user to grant access."});
 }
}
insert("roster_snapshots",{id:snapshot,league_id:league,season_id:season,snapshot_date:data.snapshotDate,scoring_period:160,source_sha256:source.source_evidence.authenticated_export.sha256,source_metadata:{provider:"ESPN",leagueId:139935,espnSeason:2026,sourceScoringPeriod:160,verified:true}},["source_metadata"]);
for(const p of data.players){
 const original=source.teams.find((t:any)=>t.team_id===p.teamId);
 const entry=original.roster.entries.find((r:any)=>r.player_id===p.id);
 const rawEntries=original.roster.source_json_pointer.split("/").slice(1).reduce((value:any,key:string)=>value[key],rawSource);
 const sourceIndex=rawEntries.findIndex((entry:any)=>entry.playerId===p.id);
 if(sourceIndex<0)throw new Error("Missing source roster evidence for player "+p.id);
 const projected=audit.projection2026.rows.find((r:any)=>r.espnPlayerId===p.id);
 insert("players",{id:p.id,full_name:p.name});
 insert("roster_entries",{snapshot_id:snapshot,season_id:season,franchise_id:franchises[p.teamId],player_id:p.id,lineup_slot:entry.lineup_slot_id,source_pointer:original.roster.source_json_pointer+"/"+sourceIndex});
 insert("player_ownerships",{season_id:season,player_id:p.id,franchise_id:franchises[p.teamId],source_snapshot_id:snapshot});
 const inferred=p.reason.includes("inferred")||p.previousRound===null;
 const verification=p.status==="ineligible"?"ineligible":p.status==="review"||inferred?"provisional":"confirmed";
 insert("keeper_profiles",{season_id:season,player_id:p.id,league_id:league,rule_version_id:rule,base_round:p.baseCost,tenure_years:p.tenure,verification,explanation:p.reason,source_metadata:{wasKept:p.wasKept,payment2025:p.previousRound,reviewFlags:projected?.reviewFlags??[],sourceCells:projected?.sourceCells??[],inferenceRequiresReview:inferred}},["source_metadata"]);
}
sql.push(`update public.roster_snapshots set frozen_at=now() where id=${q(snapshot)};`);
for(const p of data.picks)insert("draft_picks",{id:pickIds[p.id],season_id:season,original_franchise_id:franchises[p.originalTeamId],current_owner_id:franchises[p.ownerTeamId],round:p.round});
sql.push("-- Historical drafts/trades are included in data/league.json for source-preserving review.","-- Do not execute historical trade transfers on top of this ownership snapshot.","commit;");
mkdirSync("supabase",{recursive:true});
writeFileSync("supabase/seed.sql",sql.join("\n")+"\n");
writeFileSync("data/identities.json",JSON.stringify({leagueId:league,seasonId:season,franchises,picks:pickIds},null,2)+"\n");
console.log(JSON.stringify({leagueId:league,seasonId:season,teams:data.teams.length,players:data.players.length,picks:data.picks.length,phase:"setup"}));
