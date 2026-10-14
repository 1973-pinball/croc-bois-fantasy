import { z } from 'zod';

const teams = { fromFranchiseId: z.string().uuid(), toFranchiseId: z.string().uuid() };
const differentTeams = (leg: { fromFranchiseId: string; toFranchiseId: string }) => leg.fromFranchiseId !== leg.toFranchiseId;
export const liveDraftTradeSchema = z.object({
  seasonId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  players: z.array(z.object({ playerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ...teams }).strict().refine(differentTeams, 'Choose different sending and receiving teams.')).max(100),
  picks: z.array(z.object({ pickId: z.string().uuid(), ...teams }).strict().refine(differentTeams, 'Choose different sending and receiving teams.')).max(100),
  note: z.string().trim().min(5, 'Describe the draft trade in at least five characters.').max(2000),
}).strict().superRefine((value, context) => {
  if (value.players.length + value.picks.length < 1 || value.players.length + value.picks.length > 100) context.addIssue({ code: 'custom', message: 'Include between 1 and 100 players and picks.' });
  if (new Set(value.players.map(player => player.playerId)).size !== value.players.length) context.addIssue({ code: 'custom', path: ['players'], message: 'A player can appear only once in a trade.' });
  if (new Set(value.picks.map(pick => pick.pickId)).size !== value.picks.length) context.addIssue({ code: 'custom', path: ['picks'], message: 'A pick can appear only once in a trade.' });
});
export type LiveDraftTradeInput = z.infer<typeof liveDraftTradeSchema>;
