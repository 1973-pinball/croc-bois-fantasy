import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';
import { finalizeTradeSchema, paymentRpcAssignments } from '@/lib/keeper-payment-contract';

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = finalizeTradeSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message }, 400);
  const body = parsed.data;
  const { data, error } = await auth.client.rpc('finalize_trade', {
    p_trade: body.tradeId, p_note: body.note ?? null, p_override_review: body.overrideReview,
    p_keeper_payments: body.keeperPayments.map(payment => ({ submission_id: payment.submissionId, expected_revision: payment.expectedRevision, assignments: paymentRpcAssignments(payment.assignments) })),
  });
  return error ? rpcError(error) : json({ trade: data });
}
