import { orderPickGridTeams, type DraftPickGridSeason } from './draft-pick-grids';
import type { Team } from './types';

export type InventorySeason = { id: string; draft_year: number; rule_version_id: string; participant_count: number };
export type InventoryRule = { id: string; draft_rounds: number };
export type InventoryFranchise = { id: string; name: string; espn_team_id: number | null };
export type InventoryParticipant = { season_id: string; franchise_id: string; display_name: string; draft_position: number | null };
export type InventoryPick = { id: string; season_id: string; original_franchise_id: string; current_owner_id: string; round: number; status: string };
export { readAllRows as readAllInventoryPages } from './supabase/pagination';
export type { QueryPage as InventoryPage } from './supabase/pagination';

export function buildLiveDraftPickGrids(input: {
  seasons: InventorySeason[]; rules: InventoryRule[]; franchises: InventoryFranchise[];
  participants: InventoryParticipant[]; picks: InventoryPick[]; referenceTeams?: Team[];
}): DraftPickGridSeason[] {
  const fail = (message: string): never => { throw new Error(message); };
  const franchiseById = new Map(input.franchises.map(f => [f.id, f]));
  if (franchiseById.size !== input.franchises.length) fail('Duplicate franchise identity');
  const handles = new Map<string, number>();
  const occupied = new Set<number>();
  for (const franchise of input.franchises) {
    if (franchise.espn_team_id === null) continue;
    if (!Number.isSafeInteger(franchise.espn_team_id) || occupied.has(franchise.espn_team_id)) fail('Duplicate or invalid ESPN team identity');
    handles.set(franchise.id, franchise.espn_team_id); occupied.add(franchise.espn_team_id);
  }
  let nextHandle = -1;
  for (const franchise of [...input.franchises].sort((a, b) => a.id.localeCompare(b.id))) {
    if (handles.has(franchise.id)) continue;
    while (occupied.has(nextHandle)) nextHandle--;
    handles.set(franchise.id, nextHandle); occupied.add(nextHandle); nextHandle--;
  }
  const rules = new Map(input.rules.map(r => [r.id, r]));
  const seasons = new Map(input.seasons.map(s => [s.id, s]));
  if (rules.size !== input.rules.length || seasons.size !== input.seasons.length || new Set(input.seasons.map(s => s.draft_year)).size !== seasons.size) fail('Duplicate rule or season identity');
  if (input.picks.some(p => !seasons.has(p.season_id)) || input.participants.some(p => !seasons.has(p.season_id))) fail('Inventory includes an unexpected season');
  if (new Set(input.picks.map(p => p.id)).size !== input.picks.length) fail('Duplicate pick UUID');

  return [...input.seasons].sort((a, b) => a.draft_year - b.draft_year).map(season => {
    const roundCount = rules.get(season.rule_version_id)?.draft_rounds;
    if (!roundCount || !Number.isInteger(roundCount) || roundCount < 1 || roundCount > 30) return fail('Season draft rounds are not configured');
    if (!Number.isInteger(season.draft_year) || season.draft_year < 2000 || season.draft_year > 2200 || !Number.isInteger(season.participant_count) || season.participant_count < 2 || season.participant_count > 100) return fail('Season configuration is invalid');
    const participants = input.participants.filter(p => p.season_id === season.id);
    const participantsById = new Map(participants.map(p => [p.franchise_id, p]));
    if (participants.length !== season.participant_count || participantsById.size !== participants.length) return fail('Season participant registration is incomplete');
    const teams: (Team & { franchiseId: string })[] = orderPickGridTeams(participants.map(participant => {
      const franchise = franchiseById.get(participant.franchise_id);
      const handle = handles.get(participant.franchise_id);
      if (!franchise || handle === undefined || !participant.display_name.trim()) return fail('Season participant identity is missing');
      const reference = input.referenceTeams?.find(t => t.id === franchise.espn_team_id);
      return { id: handle, franchiseId: franchise.id, name: participant.display_name, shortName: reference?.shortName || participant.display_name, owner: reference?.owner || 'Manager assignment pending', managers: reference?.managers || [], color: reference?.color || '#689c60' };
    }));
    const picks = input.picks.filter(p => p.season_id === season.id);
    if (picks.length !== season.participant_count * roundCount) return fail('Season draft-pick inventory is incomplete');
    const coordinates = new Set<string>();
    const projected = picks.map(pick => {
      if (!pick.id || !participantsById.has(pick.original_franchise_id) || !participantsById.has(pick.current_owner_id)) return fail('Pick references a team outside its season');
      if (!Number.isInteger(pick.round) || pick.round < 1 || pick.round > roundCount || !['available', 'used'].includes(pick.status)) return fail('Pick round or status is invalid');
      const coordinate = `${pick.original_franchise_id}:${pick.round}`;
      if (coordinates.has(coordinate)) return fail('Duplicate original pick coordinate');
      coordinates.add(coordinate);
      return { id: pick.id, season: season.draft_year, round: pick.round, originalTeamId: handles.get(pick.original_franchise_id)!, ownerTeamId: handles.get(pick.current_owner_id)! };
    }).sort((a, b) => a.round - b.round || a.originalTeamId - b.originalTeamId);
    return { year: season.draft_year, roundCount, teams, picks: projected, source: 'live', note: 'Current ownership from the league database. Original pick identities are preserved; used picks remain in the inventory. ESPN abbreviations and manager labels identify the current franchises; column order is independent of the draft lottery.' };
  });
}
