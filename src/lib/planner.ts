import { validateKeeperAssignments } from "../domain/keepers";
import { leagueData } from "./league-data";
import type { LeagueData } from "./types";
export interface PlannerAssignment { playerId: number; pickId: string }
export function validatePlanner(teamId: number, assignments: PlannerAssignment[], data: LeagueData = leagueData): string[] {
  const leagueData = data;
  const result = validateKeeperAssignments({
    season: leagueData.season, franchiseId: String(teamId),
    assignments: assignments.map(a=>({playerId:String(a.playerId),pickId:a.pickId})),
    candidates: leagueData.players.map(p=>({
      playerId:String(p.id),franchiseId:String(p.teamId),
      cycle:{playerId:String(p.id),lastSeason:leagueData.season - 1,tenureYears:p.tenure,nextKeeperRound:p.baseCost,
        source:p.wasKept?"keeper" as const:p.previousRound===null?"undrafted" as const:"fresh-draft" as const,
        firstRoundDraftIneligible:!p.wasKept&&p.previousRound===1}
    })),
    picks:leagueData.picks.map(p=>({id:p.id,season:p.season,round:p.round,
      originalFranchiseId:String(p.originalTeamId),ownerFranchiseId:String(p.ownerTeamId)}))
  });
  const names=new Map(leagueData.players.map(p=>[String(p.id),p.name]));
  const issues=result.issues.map(i=>(i.playerId?names.get(i.playerId)+": ":"")+i.message);
  for(const a of assignments) {
    const player=leagueData.players.find(p=>p.id===a.playerId);
    if(player?.status==="review")issues.push(player.name+": provisional history needs commissioner verification before submission.");
  }
  return [...new Set(issues)];
}
