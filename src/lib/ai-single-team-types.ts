import type { AiLineup, AiMatchup, AiPeriodResult, AiPlayer, AiStanding, AiStats } from './ai-league-types';
import type { AiOwnerSnapshot } from './ai-owner-types';

export type AiSingleTeamOfficialAdjustment = {
  season: number; period: number; teamId: string; stat: keyof AiStats;
  reconstructed: number; official: number; reason: string;
};

export type AiSingleTeamDay = {
  date: string; startsAt: string; complete: boolean; snapshotId: string; season?: number; scoringPeriodId?: number;
  availablePlayerIds: number[]; scheduledPlayerIds: number[]; stats: { playerId: number; stats: AiStats }[];
  owners: { teamId: string; roster: number[]; lineup: { slot: number; playerId: number }[]; stats: AiStats; complete: boolean }[];
};
export type AiSingleTeamInput = {
  season: number; firstDate: string; lastDate: string; forecastAsOf: string;
  players: AiPlayer[]; matchups: AiMatchup[]; days: AiSingleTeamDay[];
  officialScores: { period: number; teamId: string; categories: Record<string, number> }[];
  actualChampion: string | null; limitations: string[];
  ownerDraft?: AiOwnerSnapshot['draft'];
  expectedRegularRecords?: { teamId: string; wins: number; losses: number; ties: number }[];
  officialAdjustments?: AiSingleTeamOfficialAdjustment[];
  /** Actual draft order when verified; otherwise the engine documents its stable franchise-ID fallback. */
  draftOrder?: string[];
};
export type AiSingleTeamIdentity = { id: string; name: string; shortName: string; color: string };
export type AiSingleTeamDecision = {
  id: string; date: string; teamId: string; kind: 'draft' | 'initial_drop' | 'forced_return' | 'add_drop' | 'lineup';
  playerIds: number[]; droppedId?: number; claimedByTeamId?: string; overallPick?: number; round?: number; snapshotId: string; reason: string;
};
export type AiSingleTeamLineup = AiLineup & { snapshotId: string };
export type AiSingleTeamScenario = {
  teamId: string; mode: 'post_draft' | 'redraft'; status: 'complete' | 'incomplete'; message: string;
  actualOpeningRoster: number[]; initialRoster: number[]; finalRoster: number[]; initialCuts: number[];
  forcedReturns: number; acquisitions: number; acquisitionsByPeriod: Record<string, number>;
  results: AiPeriodResult[]; standings: AiStanding[]; champion: string | null;
  decisions: AiSingleTeamDecision[]; lineups: AiSingleTeamLineup[]; scoredDates: string[]; snapshotIds: string[];
};
export type AiSingleTeamReport = {
  version: 1; season: number; label: string; createdAt: string; status: 'complete' | 'incomplete';
  teams: AiSingleTeamIdentity[];
  baseline: {
    verified: boolean; issues: string[]; results: AiPeriodResult[]; standings: AiStanding[];
    champion: string | null; scoredDates: string[];
  };
  scenarios: AiSingleTeamScenario[];
  coverage: { firstDate: string; lastDate: string; expectedDates: number; verifiedDates: number; officialPeriods: number; snapshotIds: string[] };
  limitations: string[];
  officialAdjustments: AiSingleTeamOfficialAdjustment[];
};
