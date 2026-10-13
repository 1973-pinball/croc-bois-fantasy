import identities from '../../../../data/identities.json';
import { fetchDraftAdvisorSchedule } from '@/lib/draft-advisor-schedule-server';
import { validateDraftScheduleWindow } from '@/lib/draft-advisor-schedule';
import { authenticatedClient, json } from '@/lib/supabase/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = await authenticatedClient();
    if ('response' in auth) return auth.response;
    const membership = await auth.client.from('league_memberships').select('role').eq('league_id', identities.leagueId).eq('user_id', auth.user.id).eq('active', true).maybeSingle();
    if (membership.error) return json({ error: 'ACCESS_UNAVAILABLE', message: 'Commissioner access could not be verified.' }, 503);
    if (membership.data?.role !== 'commissioner') return json({ error: 'FORBIDDEN', message: 'Only the commissioner can use the private draft advisor.' }, 403);
    const query = new URL(request.url).searchParams;
    const rawSeason = query.get('seasonId') ?? '';
    const seasonId = Number(rawSeason), startDate = query.get('startDate') ?? undefined;
    if (!/^\d{4}$/.test(rawSeason) || seasonId < 2001 || seasonId > 2100) return json({ error: 'INVALID_SEASON', message: 'Choose the NBA season ending year.' }, 400);
    try { if (startDate !== undefined) validateDraftScheduleWindow(seasonId, startDate); }
    catch (error) { return json({ error: 'INVALID_WINDOW', message: error instanceof Error ? error.message : 'Choose a valid seven-day schedule window.' }, 400); }
    try { return json({ schedule: await fetchDraftAdvisorSchedule({ seasonId, startDate }) }); }
    catch (error) { return json({ error: 'SCHEDULE_UNAVAILABLE', message: error instanceof Error ? error.message : 'The NBA schedule is unavailable. Try again or upload a schedule file.' }, 503); }
  } catch { return json({ error: 'SCHEDULE_UNAVAILABLE', message: 'The private draft schedule could not be loaded. Try again.' }, 503); }
}
