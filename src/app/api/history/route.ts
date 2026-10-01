import { HistoryServiceError, readPublicHistory } from '@/lib/espn-history-sync';
import { json } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try { return json(await readPublicHistory()); }
  catch (error) {
    return error instanceof HistoryServiceError ? json({ error: error.code, message: error.message }, error.status) : json({ error: 'HISTORY_UNAVAILABLE', message: 'Saved ESPN history could not be loaded.' }, 503);
  }
}
