import { readAiLeague } from '@/lib/ai-league-service';
import { json } from '@/lib/supabase/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return json(await readAiLeague()); }
  catch { return json({ error: 'SIMULATION_UNAVAILABLE', message: 'Saved simulation results could not be loaded. Please try again.' }, 503); }
}
