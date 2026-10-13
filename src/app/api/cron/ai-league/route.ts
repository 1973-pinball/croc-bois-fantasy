import { synchronizeAiLeague } from '@/lib/ai-league-service';
import { cronAuthorized } from '@/lib/espn-history-sync-core';
import { json } from '@/lib/supabase/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) return json({ error: 'UNAUTHORIZED' }, 401);
  try { const result = await synchronizeAiLeague(); return json(result, result.errors.length ? 503 : 200); }
  catch { return json({ error: 'SIMULATION_REFRESH_FAILED', message: 'Saved simulation results have been retained.' }, 503); }
}
