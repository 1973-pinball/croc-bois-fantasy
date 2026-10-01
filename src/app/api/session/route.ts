import { createClient } from '@/lib/supabase/server';
import { json, setupResponse } from '@/lib/supabase/http';

export async function GET() {
  const client = await createClient();
  if (!client) return setupResponse();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return json({ configured: true, user: null, memberships: [], assignments: [] });
  const now = new Date().toISOString();
  const [memberships, assignments] = await Promise.all([
    client.from('league_memberships').select('league_id, role').eq('user_id', data.user.id).eq('active', true),
    client.from('manager_assignments').select('franchise_id,league_id,role,effective_from,effective_to').eq('user_id', data.user.id).lte('effective_from', now).or(`effective_to.is.null,effective_to.gt.${now}`),
  ]);
  if (memberships.error || assignments.error) return json({ error: 'DATABASE_SETUP_REQUIRED', message: 'Apply the Supabase migrations before using league accounts.' }, 503);
  const activeManagementLeagues = new Set(memberships.data.filter((m) => ['manager','commissioner'].includes(m.role)).map((m) => m.league_id));
  return json({ configured: true, user: { id: data.user.id, email: data.user.email }, memberships: memberships.data, assignments: assignments.data.filter((a) => activeManagementLeagues.has(a.league_id)) });
}
