import { z } from 'zod';

const uuid = z.string().uuid();
export const paymentAssignmentSchema = z.object({ playerId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), pickId: uuid }).strict();
export const keeperPaymentSchema = z.object({
  submissionId: uuid,
  expectedRevision: z.number().int().positive(),
  assignments: z.array(paymentAssignmentSchema).max(30),
}).strict();
export const paymentNoteSchema = z.string().trim().min(5, 'Enter a reason of at least 5 characters.').max(2000);
export const reassignPaymentsSchema = keeperPaymentSchema.extend({ action: z.literal('reassign_payments'), note: paymentNoteSchema }).strict();
export const finalizeTradeSchema = z.object({
  tradeId: uuid,
  keeperPayments: z.array(keeperPaymentSchema).max(30).default([]),
  note: paymentNoteSchema.optional(),
  overrideReview: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  if ((value.overrideReview || value.keeperPayments.length > 0) && !value.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Explain the early finalization or keeper payment changes.' });
  if (new Set(value.keeperPayments.map(k => k.submissionId)).size !== value.keeperPayments.length) ctx.addIssue({ code: 'custom', path: ['keeperPayments'], message: 'Include each keeper submission only once.' });
});

export function paymentRpcAssignments(assignments: z.infer<typeof paymentAssignmentSchema>[]) {
  return assignments.map(a => ({ player_id: a.playerId, pick_id: a.pickId }));
}
