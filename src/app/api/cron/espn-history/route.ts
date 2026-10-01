import { cronAuthorized } from '@/lib/espn-history-sync-core';
import { HistoryServiceError, synchronizeHistory } from '@/lib/espn-history-sync';
import { json } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return json({ error: 'UNAUTHORIZED', message: 'Scheduled history access was not authorized.' }, 401);
  try { return json(await synchronizeHistory()); }
  catch (error) { return error instanceof HistoryServiceError ? json({ error: error.code, message: error.message }, error.status) : json({ error: 'HISTORY_UNAVAILABLE', message: 'Scheduled ESPN history refresh could not be completed.' }, 503); }
}
