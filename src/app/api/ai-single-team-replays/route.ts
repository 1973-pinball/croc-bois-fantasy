import report from '../../../../data/ai-single-team-replays.json';
import { readAiLeague } from '@/lib/ai-league-service';
import { json } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // The artifact is server-only. Honor the same anonymous visibility policy
    // as the saved league before returning any historical experiment results.
    const saved = await readAiLeague();
    if (!saved.runs.some(run => run.season === 2026)) {
      return json({ error: 'REPLAY_UNAVAILABLE', message: 'The historical replay is not available.' }, 404);
    }
    if (report.status !== 'complete' || !report.baseline.verified) {
      return json({ error: 'REPLAY_UNVERIFIED', message: 'The historical replay has not completed verification.' }, 503);
    }
    return json(report);
  } catch {
    return json({ error: 'REPLAY_UNAVAILABLE', message: 'The saved one-team replays could not be loaded. Please try again.' }, 503);
  }
}
