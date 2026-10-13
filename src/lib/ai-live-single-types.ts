import type { AiGameDay, AiMatchup, AiPlayer, AiStats, AiStanding, AiPeriodResult } from './ai-league-types';
import type { AiOwnerSnapshot } from './ai-owner-types';
import type { AiSingleTeamIdentity, AiSingleTeamScenario } from './ai-single-team-types';

export type AiLiveOwner = { teamId: string; roster: number[]; lineup: { playerId: number; slot: number }[] };
export type AiLiveOwnerDay = { date: string; capturedAt: string; snapshotId: string; owners: AiLiveOwner[] };
export type AiLiveSingleScenario = Omit<AiSingleTeamScenario, 'status'> & {
  status: 'preseason' | 'active' | 'complete' | 'needs_data';
  cooldown: Record<string, string>; totals: { date: string; stats: AiStats }[];
};
export type AiLiveSingleState = {
  version: 1; season: 2027; status: 'awaiting_draft' | 'preseason' | 'active' | 'complete' | 'needs_data';
  message: string; createdAt: string; updatedAt: string; error: string | null;
  firstDate: string; lastDate: string; forecastAsOf: string | null;
  teams: AiSingleTeamIdentity[]; draftOrder: string[]; matchups: AiMatchup[];
  ownerDraft: AiOwnerSnapshot['draft']; draftCapturedAt: string | null;
  players: AiPlayer[]; initialPlayers: AiPlayer[]; scenarios: AiLiveSingleScenario[];
  locks: (AiLiveOwnerDay & { startsAt: string; empty: boolean })[]; previousOwners: AiLiveOwner[];
  ownerTotals: { date: string; snapshotId: string; teams: { teamId: string; stats: AiStats }[] }[];
  scoredDates: string[]; missedDates: string[]; verifiedPeriods: number[]; baselineIssues: string[];
  baseline: { standings: AiStanding[]; results: AiPeriodResult[] };
  limitations: string[];
};
export type AiLiveSingleFeed = {
  capturedAt: string; forecastAsOf?: string; players: AiPlayer[]; matchups: AiMatchup[]; firstDate: string; lastDate: string;
  ownerDraft: AiOwnerSnapshot['draft']; draftOrder: string[];
  days: { game: AiGameDay; owners: AiLiveOwnerDay }[];
  officialScores: { period: number; teamId: string; categories: Record<string, number> }[];
};
