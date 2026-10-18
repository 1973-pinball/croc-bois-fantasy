import { fetchDraftAdvisorSchedule } from '@/lib/draft-advisor-schedule-server';
import { validateDraftScheduleWindow } from '@/lib/draft-advisor-schedule';
import { authenticatedClient, json } from '@/lib/supabase/http';
import { readDraftToolAccess } from '@/lib/draft-tool-access-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = await authenticatedClient();
    if ('response' in auth) return auth.response;
    const access = await readDraftToolAccess(auth.client, auth.user.id);
    if (access.unavailable) return json({ error: 'ACCESS_UNAVAILABLE', message: 'Draft Tool access could not be verified.' }, 503);
    if (!access.commissioner && !access.restricted) return json({ error: 'FORBIDDEN', message: 'Your account does not have Draft Tool access.' }, 403);
    const query = new URL(request.url).searchParams;
    const rawSeason = query.get('seasonId') ?? '';
    const seasonId = Number(rawSeason), startDate = query.get('startDate') ?? undefined;
    const scope = query.get('scope') ?? undefined;
    if (!access.commissioner && (scope !== 'season' || startDate !== undefined)) return json({ error: 'FORBIDDEN', message: 'Your Draft Tool uses the complete season schedule.' }, 403);
    if (!/^\d{4}$/.test(rawSeason) || seasonId < 2001 || seasonId > 2100) return json({ error: 'INVALID_SEASON', message: 'Choose the NBA season ending year.' }, 400);
    if ((scope !== undefined && scope !== 'week' && scope !== 'season') || (scope === 'season' && startDate !== undefined)) return json({ error: 'INVALID_WINDOW', message: 'Choose the complete season without a single-week start date.' }, 400);
    try { if (startDate !== undefined) validateDraftScheduleWindow(seasonId, startDate); }
    catch (error) { return json({ error: 'INVALID_WINDOW', message: error instanceof Error ? error.message : 'Choose a valid seven-day schedule window.' }, 400); }
    try { return json({ schedule: await fetchDraftAdvisorSchedule({ seasonId, startDate, ...(scope ? { scope } : {}) }) }); }
    catch (error) { return json({ error: 'SCHEDULE_UNAVAILABLE', message: error instanceof Error ? error.message : 'The NBA schedule is unavailable. Try again or upload a schedule file.' }, 503); }
  } catch { return json({ error: 'SCHEDULE_UNAVAILABLE', message: 'The private draft schedule could not be loaded. Try again.' }, 503); }
}
