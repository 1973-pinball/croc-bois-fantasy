import evidence from '../../data/draft-pick-evidence.json';
import type { DraftPick, LeagueData, Team } from './types';

export interface DraftPickGridSeason {
  year: number;
  roundCount: number;
  teams: (Team & { franchiseId?: string })[];
  picks: DraftPick[];
  source: 'live' | 'archive' | 'reference';
  note?: string;
}

const aliases: Record<number, string[]> = {
  1: ['Jon', 'Jonathan', 'Jonathan Martinez'],
  2: ['Arod', 'Anthony', 'Anthony Rodriguez'],
  3: ['Wyn', 'Wyndham', 'Wyndham Batchelor', 'Wyndham Trade', 'Dr. Wyndham M Batchelor'],
  4: ['Edwin', 'Julian', 'Edwin/Julian', 'Sebastian', 'Sebastian Rodriguez'],
  5: ['Shane', 'Shane Trauthwein'],
  6: ['Justin', 'Amber', 'Justin & Amber', 'Justin Hu', 'Amber Hu'],
  7: ['James', 'James Childress'],
  8: ['Cars', 'Alex', 'Alex Carsello'],
};
const normalized = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ownerChain = (value: string) => value.split(/\bvia\b|[()]/i).map(part => part.trim()).filter(Boolean);

function historicalTeamId(name: string, teams: Team[]): number {
  const id = Object.entries(aliases).find(([, labels]) => labels.some(label => normalized(label) === normalized(name)))?.[0];
  const matching = id === undefined ? teams.find(team => [team.name, team.owner, team.shortName].some(label => normalized(label) === normalized(name))) : teams.find(team => team.id === Number(id));
  if (!matching) throw new Error(`Unresolved historical pick owner: ${name}`);
  return matching.id;
}

/** Worksheet column order, with later expansion franchises appended deterministically. */
export function orderPickGridTeams<T extends Team>(teams: readonly T[]): T[] {
  const order: readonly number[] = evidence.columnOrder;
  return [...teams].sort((a, b) => {
    const aIndex = order.indexOf(a.id), bIndex = order.indexOf(b.id);
    return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex) || a.owner.localeCompare(b.owner) || a.id - b.id;
  });
}

/** A same-round swap still matters even when every displayed count remains one. */
export function hasTransferredPicks(season: DraftPickGridSeason): boolean {
  return season.picks.some(pick => pick.originalTeamId !== pick.ownerTeamId);
}

export function partitionPickGridSeasons(seasons: readonly DraftPickGridSeason[], currentYear: number) {
  return {
    active: seasons.filter(season => season.year === currentYear || (season.year > currentYear && hasTransferredPicks(season))).sort((a, b) => a.year - b.year),
    unchangedFuture: seasons.filter(season => season.year > currentYear && !hasTransferredPicks(season)).sort((a, b) => a.year - b.year),
    historical: seasons.filter(season => season.year < currentYear).sort((a, b) => b.year - a.year),
  };
}

export function pickGridCounts(season: DraftPickGridSeason): Map<number, { total: number; rounds: number[] }> {
  const counts = new Map(season.teams.map(team => [team.id, { total: 0, rounds: Array<number>(season.roundCount).fill(0) }]));
  const seen = new Set<string>();
  for (const pick of season.picks) {
    const owner = counts.get(pick.ownerTeamId);
    if (!owner || !counts.has(pick.originalTeamId) || pick.season !== season.year || !Number.isInteger(pick.round) || pick.round < 1 || pick.round > season.roundCount || seen.has(pick.id)) throw new Error('Invalid pick inventory for this grid.');
    seen.add(pick.id); owner.total++; owner.rounds[pick.round - 1]++;
  }
  return counts;
}

/** Imported evidence only. These references never create spendable database picks. */
export function buildReferencePickGrids(data: LeagueData): DraftPickGridSeason[] {
  const result: DraftPickGridSeason[] = [];
  for (const draft of data.drafts.filter(draft => draft.year < data.season)) {
    const picks = draft.selections.map(selection => {
      const originalChain = ownerChain(selection.originalOwner || selection.owner);
      const recipientChain = ownerChain(selection.owner || selection.originalOwner);
      return {
        id: `archive-${draft.year}-${selection.pick}`, season: draft.year, round: selection.round,
        originalTeamId: historicalTeamId(originalChain.at(-1) || '', data.teams),
        ownerTeamId: historicalTeamId(recipientChain[0] || '', data.teams),
      };
    });
    const participants = new Set(picks.flatMap(pick => [pick.originalTeamId, pick.ownerTeamId]));
    const historicalLabels = new Map<number, Set<string>>();
    for (const selection of draft.selections) {
      const name = ownerChain(selection.owner || selection.originalOwner)[0] || '';
      const id = historicalTeamId(name, data.teams);
      const labels = historicalLabels.get(id) || new Set<string>();
      labels.add(name); historicalLabels.set(id, labels);
    }
    result.push({ year: draft.year, roundCount: Math.max(...picks.map(pick => pick.round)),
      teams: orderPickGridTeams(data.teams.filter(team => participants.has(team.id)).map(team => ({ ...team, owner: [...(historicalLabels.get(team.id) || [team.owner])].join(' / ') }))),
      picks, source: 'archive',
      note: `Ownership at the ${draft.year} draft, including picks spent on keepers. ${draft.year < 2022 ? 'Original owners are reconstructed from the draft’s owner annotations.' : 'Original and receiving owners come from the recorded draft columns.'} ESPN abbreviations identify the continuing franchise; owner labels reflect that draft.`,
    });
  }
  const knownYears = [...new Set(data.picks.map(pick => pick.season))];
  for (const year of knownYears) {
    const picks = data.picks.filter(pick => pick.season === year);
    result.push({ year, roundCount: Math.max(...picks.map(pick => pick.round)), teams: orderPickGridTeams(data.teams), picks, source: 'reference', note: 'Imported pick inventory. Counts include picks already spent on keepers; they are ownership totals, not remaining draft selections.' });
  }
  for (const reference of evidence.referenceSeasons) {
    if (result.some(season => season.year === reference.year)) continue;
    const teams = orderPickGridTeams(data.teams.filter(team => reference.teamIds.includes(team.id)));
    if (teams.length !== reference.teamIds.length) continue;
    result.push({ year: reference.year, roundCount: reference.roundCount, teams,
      picks: teams.flatMap(team => Array.from({ length: reference.roundCount }, (_, index) => ({ id: `reference-${reference.year}-${team.id}-${index + 1}`, season: reference.year, round: index + 1, originalTeamId: team.id, ownerTeamId: team.id }))),
      source: 'reference', note: reference.note,
    });
  }
  return result.sort((a, b) => a.year - b.year);
}

export const pickOwnershipEvidence = evidence;
