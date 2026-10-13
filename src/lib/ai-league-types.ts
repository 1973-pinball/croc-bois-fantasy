/** Public, provider-neutral state for the isolated League Lab experiment. */
import type { AiOwnerSnapshot } from './ai-owner-types';
import type { AiLiveSingleState } from './ai-live-single-types';
export type AiStats = { pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; three: number; fgm: number; fga: number; ftm: number; fta: number };
export type AiPlayer = { id: number; name: string; nbaTeamId: number; slots: number[]; rank: number | null; forecast: AiStats; injury: string | null };
export type AiTeam = { id: string; name: string; shortName: string; color: string; roster: number[] };
export type AiMatchup = { id: string; period: number; home: string; away: string; start: string; end: string; playoff: boolean };
export type AiGameDay = { date: string; startsAt: string; playerIds: number[]; stats: { playerId: number; stats: AiStats }[]; complete: boolean };
export type AiDecision = { id: string; date: string; teamId: string; kind: 'draft' | 'add_drop' | 'lineup'; playerIds: number[]; droppedId?: number; reason: string };
export type AiLineup = { date: string; teamId: string; slots: { slot: number; playerId: number }[]; decidedAt: string };
export type AiPeriodResult = { matchupId: string; period: number; home: string; away: string; homeStats: AiStats; awayStats: AiStats; homeWins: number; awayWins: number; ties: number; complete: boolean; playoff: boolean };
export type AiStanding = { teamId: string; wins: number; losses: number; ties: number; matchupWins: number; matchupLosses: number; matchupTies: number; played: number };
export type AiLeagueRun = {
  version: 1; season: number; label: string; mode: 'live' | 'replay'; policy: string;
  status: 'preseason' | 'active' | 'complete' | 'needs_data'; message: string;
  createdAt: string; updatedAt: string; dataThrough: string | null; calendarEnd?: string; draftOrder: string[];
  players: AiPlayer[]; initialPlayers?: AiPlayer[]; forecastAsOf?: string; teams: AiTeam[]; matchups: AiMatchup[];
  decisions: AiDecision[]; lineups: AiLineup[]; results: AiPeriodResult[]; standings: AiStanding[];
  scoredDates: string[]; missedDates?: string[]; waiverAvailable: Record<string, string>; acquisitions: Record<string, number>;
  champion: string | null; limitations: string[];
  actual?: AiOwnerSnapshot;
  liveSingles?: AiLiveSingleState;
};
export type AiLeagueFeed = {
  season: number; capturedAt: string; players: AiPlayer[]; matchups: AiMatchup[];
  forecastAsOf?: string;
  firstDate: string | null; lastDate: string | null; currentDate: string;
  days: AiGameDay[]; limitations: string[];
};
export type AiLeagueResponse = { runs: AiLeagueRun[]; refresh: { lastAttempt: string | null; error: string | null; automatic: boolean } };
