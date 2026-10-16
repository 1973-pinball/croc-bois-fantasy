import type { DraftAdvisorInput, DraftAdvisorReport } from './draft-advisor';
import type { DraftForecastReport } from './draft-forecast';

export type DraftForecastMode = 'completed' | 'current';
export type DraftForecastRequestInput = DraftAdvisorInput & { espnRanks?: { id: number; rank: number }[]; scenarios?: number };
export type DraftForecastWorkerRequest = { id: number; mode: DraftForecastMode; input: DraftForecastRequestInput };
export type DraftForecastWorkerResponse = { id: number; type: 'progress'; completed: number; total: number }
  | { id: number; type: 'result'; report: DraftAdvisorReport | DraftForecastReport }
  | { id: number; type: 'error'; message: string };

/** Clock reads and clock-only revisions do not change the draft evidence used by the model. */
export function draftForecastRequestKey(input: DraftForecastRequestInput, mode: DraftForecastMode): string {
  const { clock: _clock, revision: _revision, ...ledger } = input.board;
  return JSON.stringify({ mode, ...input, board: { ...ledger,
    teams: [...ledger.teams].sort((a, b) => a.franchiseId.localeCompare(b.franchiseId)),
    picks: [...ledger.picks].sort((a, b) => a.id.localeCompare(b.id)),
  }, espnRanks: input.espnRanks ? [...input.espnRanks].sort((a, b) => a.id - b.id) : undefined });
}
