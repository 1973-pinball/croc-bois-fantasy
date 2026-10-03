import { z } from 'zod';

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const matrix = z.array(z.array(z.number().min(0).max(1)).length(8)).length(8);
const weights = z.array(z.number().int().positive()).length(8);
export const draftLotteryActionSchema = z.object({ action: z.literal('generate'), seasonId: uuid }).strict();
export const draftLotterySchema = z.object({
  seasonId: uuid, phase: z.enum(['setup', 'keeper_selection', 'draft_ready', 'in_season', 'archived']),
  ready: z.boolean(), unavailableReason: z.string().nullable(), hasRun: z.boolean(),
  standings: z.array(z.object({ franchiseId: uuid, espnTeamId: z.number().int().positive(), managerLabel: z.string(), displayName: z.string(), priorTeamName: z.string(),
    regularSeasonPlace: z.number().int().min(1).max(8), finalPlace: z.number().int().min(1).max(8),
    record: z.object({ wins: z.number().int().nonnegative(), losses: z.number().int().nonnegative(), ties: z.number().int().nonnegative(), percentage: z.number().min(0).max(1) }), playoffQualified: z.boolean() })),
  source: z.object({ priorEspnSeasonId: z.number().int(), sha256: hash, url: z.string().url(), capturedAt: z.string(), description: z.string() }).nullable(),
  managerSource: z.object({ espnSeasonId: z.number().int(), sha256: hash, url: z.string().url(), capturedAt: z.string(), description: z.string() }).nullable(),
  algorithm: z.object({ id: z.literal('weighted-without-replacement-v1'), pythonSource: z.string().nullable(), pythonSourceSha256: hash.nullable(), pythonSourceLabel: z.string().nullable(), typeScriptSource: z.string().nullable(), sourceSha256: hash.nullable(), databaseSource: z.string(), databaseSourceSha256: hash }),
  odds: z.object({ franchiseIds: z.array(uuid).length(8), weights, marginalMatrix: matrix }).nullable(),
  result: z.object({
    id: uuid, drawnAt: z.string(), priorityOrder: z.array(uuid).length(8),
    sourceSha256: hash, pythonSourceSha256: hash, algorithmSourceSha256: hash, databaseSourceSha256: hash,
    audit: z.object({ algorithm: z.literal('weighted-without-replacement-v1'), franchiseIds: z.array(uuid).length(8), weights, marginalMatrix: matrix,
      steps: z.array(z.object({ priority: z.number().int().min(1).max(8), remainingTotal: z.number().int().positive(), ticket: z.number().int().nonnegative(),
        selectedFranchiseId: uuid, entropyUuid: uuid, discardedEntropyDraws: z.number().int().nonnegative() })).length(8) }),
  }).nullable(),
});
export type DraftLotteryState = z.infer<typeof draftLotterySchema>;
