import { createClient } from '@/lib/supabase/server';
import { isGoogleSignInEnabled, SETUP_MESSAGE } from '@/lib/supabase/config';
import { json } from '@/lib/supabase/http';

export async function GET() {
  const client = await createClient();
  if (!client) return json({ error: 'SETUP_REQUIRED', message: SETUP_MESSAGE, configured: false, googleSignInEnabled: false }, 503);
  const googleSignInEnabled = isGoogleSignInEnabled();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return json({ configured: true, googleSignInEnabled, user: null, memberships: [], assignments: [] });
  const now = new Date().toISOString();
  const [memberships, assignments] = await Promise.all([
    client.from('league_memberships').select('league_id, role').eq('user_id', data.user.id).eq('active', true).order('league_id'),
    client.from('manager_assignments').select('franchise_id,league_id,role,effective_from,effective_to').eq('user_id', data.user.id).lte('effective_from', now).or(`effective_to.is.null,effective_to.gt.${now}`).order('league_id').order('franchise_id').order('id'),
  ]);
  if (memberships.error || assignments.error) return json({ configured: true, googleSignInEnabled, error: 'DATABASE_SETUP_REQUIRED', message: 'Apply the Supabase migrations before using league accounts.' }, 503);
  const activeManagementLeagues = new Set(memberships.data.filter((m) => ['manager','commissioner'].includes(m.role)).map((m) => m.league_id));
  const name = data.user.user_metadata?.full_name ?? data.user.user_metadata?.name;
  return json({ configured: true, googleSignInEnabled, user: { id: data.user.id, email: data.user.email, displayName: typeof name === 'string' ? name.slice(0, 100) : undefined }, memberships: memberships.data, assignments: assignments.data.filter((a) => activeManagementLeagues.has(a.league_id)) });
}
