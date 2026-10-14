import { z } from 'zod';

const uuid = z.string().uuid();
const playerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().min(0).max(2_147_483_647);
const note = z.string().trim().min(5, 'Explain the draft change in at least five characters.').max(2000);
const common = { seasonId: uuid, expectedRevision: revision };
export const draftActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_order'), ...common, franchiseIds: z.array(uuid).min(2).max(100), note }).strict(),
  z.object({ action: z.literal('record'), ...common, pickId: uuid, playerId, note: z.string().trim().max(2000).optional() }).strict(),
  z.object({ action: z.literal('undo'), ...common, pickId: uuid, note }).strict(),
  z.object({ action: z.literal('correct'), ...common, pickId: uuid, playerId, note }).strict(),
  z.object({ action: z.literal('configure'), ...common, durationSeconds: z.number().int().min(10).max(600) }).strict(),
  z.object({ action: z.literal('start'), ...common }).strict(),
  z.object({ action: z.literal('pause'), ...common }).strict(),
  z.object({ action: z.literal('resume'), ...common }).strict(),
  z.object({ action: z.literal('tick'), seasonId: uuid }).strict(),
]);
export type DraftAction = z.infer<typeof draftActionSchema>;

export const draftClockSchema = z.object({
  status: z.enum(['waiting', 'running', 'paused', 'completed']),
  durationSeconds: z.number().int().min(10).max(600),
  remainingSeconds: z.number().nonnegative().nullable(),
  deadlineAt: z.string().datetime({ offset: true }).nullable(),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  serverNow: z.string().datetime({ offset: true }),
});
export const draftQueueSchema = z.object({
  seasonId: uuid, franchiseId: uuid, revision,
  playerIds: z.array(playerId).max(100),
});
export type DraftQueue = z.infer<typeof draftQueueSchema>;
export const draftQueueActionSchema = z.object({
  ...common, franchiseId: uuid,
  playerIds: z.array(playerId).max(100).refine(ids => new Set(ids).size === ids.length, 'A player can appear only once in your queue.'),
}).strict();

export const draftBoardSchema = z.object({
  seasonId: uuid, draftYear: z.number().int(), phase: z.enum(['setup', 'keeper_selection', 'draft_ready', 'in_season', 'archived']),
  draftFormat: z.enum(['snake', 'linear']), roundCount: z.number().int().positive(), revision,
  keepersRevealedAt: z.string().nullable(), orderComplete: z.boolean(), orderLocked: z.boolean(), nextPickId: uuid.nullable(),
  clock: draftClockSchema,
  teams: z.array(z.object({ franchiseId: uuid, espnTeamId: z.number().int().nullable(), displayName: z.string(), draftPosition: z.number().int().positive().nullable() })),
  picks: z.array(z.object({ id: uuid, round: z.number().int().positive(), overallPick: z.number().int().positive().nullable(),
    originalFranchiseId: uuid.nullable(), currentOwnerId: uuid.nullable(), status: z.enum(['available', 'keeper', 'selected']),
    playerId: playerId.nullable(), playerName: z.string().nullable(), selectionId: uuid.nullable(),
    rosterOwnerId: uuid.nullable().optional(),
  })),
});
export type DraftBoard = z.infer<typeof draftBoardSchema>;
export type DraftBoardPick = DraftBoard['picks'][number];

/** Pick identity follows its original franchise; trades change the owner, never its slot. */
export function draftOverallPick(round: number, position: number, participants: number, format: 'snake' | 'linear' = 'snake') {
  if (![round, position, participants].every(Number.isSafeInteger) || round < 1 || participants < 2 || position < 1 || position > participants) throw new Error('Invalid draft position');
  return (round - 1) * participants + (format === 'snake' && round % 2 === 0 ? participants + 1 - position : position);
}
