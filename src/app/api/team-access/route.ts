import identities from '../../../../data/identities.json';
import { teamAccessActionSchema } from '@/lib/team-access';
import { authenticatedClient, json, readJson, rpcError, sameOrigin } from '@/lib/supabase/http';
import { readAllRows } from '@/lib/supabase/pagination';

type AssignmentRow = { id: string; franchise_id: string; manager_id: string; user_id: string | null; role: string; effective_from: string | null; effective_to: string | null };
type ManagerRow = { id: string; display_name: string };

export async function GET() {
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  const leagueId = identities.leagueId;
  const membership = await auth.client.from('league_memberships').select('role').eq('league_id', leagueId).eq('user_id', auth.user.id).eq('active', true).maybeSingle();
  if (membership.error) return rpcError(membership.error);
  const commissioner = membership.data?.role === 'commissioner';
  try {
  const [requests, rows, managers] = await Promise.all([
    readAllRows((from, to) => auth.client.from('team_access_requests').select('id,league_id,franchise_id,user_id,applicant_email,display_name,request_note,status,created_at,reviewed_at,review_note,manager_id,assignment_id,assigned_role,cancelled_at', { count: 'exact' }).eq('league_id', leagueId).order('created_at', { ascending: false }).order('id').range(from, to)),
    readAllRows<AssignmentRow>((from, to) => auth.client.from('manager_assignments').select('id,franchise_id,manager_id,user_id,role,effective_from,effective_to', { count: 'exact' }).eq('league_id', leagueId).order('id').range(from, to)),
    readAllRows<ManagerRow>((from, to) => auth.client.from('managers').select('id,display_name', { count: 'exact' }).eq('league_id', leagueId).order('display_name').order('id').range(from, to)),
  ]);
  const names = new Map(managers.map(item => [item.id, item.display_name]));
  const now = Date.now();
  return json({
    requests,
    managers: commissioner ? managers.map(manager => ({ ...manager, franchise_ids: [...new Set(rows.filter(item => item.manager_id === manager.id).map(item => item.franchise_id))] })) : [],
    assignments: rows.filter(item => item.user_id && item.effective_from && (item.effective_to === null || (Date.parse(item.effective_to) > now && Date.parse(item.effective_to) > Date.parse(item.effective_from)))).map(item => ({ ...item, display_name: names.get(item.manager_id) || 'League manager' })),
  });
  } catch { return json({ error: 'TEAM_ACCESS_UNAVAILABLE', message: 'The complete team-access records could not be loaded. Refresh before making changes.' }, 503); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: 'INVALID_ORIGIN', message: 'Use the league app to change team access.' }, 403);
  const auth = await authenticatedClient();
  if ('response' in auth) return auth.response;
  let parsed;
  try { parsed = teamAccessActionSchema.safeParse(await readJson(request)); } catch { return json({ error: 'INVALID_BODY', message: 'The access request could not be read.' }, 400); }
  if (!parsed.success) return json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message || 'Check your request details.' }, 400);
  const body = parsed.data;
  // Scope this app to its configured league; RPCs also enforce league permissions.
  const target = body.action === 'request'
    ? await auth.client.from('franchises').select('league_id').eq('id', body.franchiseId).maybeSingle()
    : body.action === 'revoke'
      ? await auth.client.from('manager_assignments').select('league_id').eq('id', body.assignmentId).maybeSingle()
      : await auth.client.from('team_access_requests').select('league_id').eq('id', body.requestId).maybeSingle();
  if (target.error) return rpcError(target.error);
  if (target.data?.league_id !== identities.leagueId) return json({ error: 'NOT_FOUND', message: 'This team access record is not available.' }, 404);
  const result = body.action === 'request'
    ? await auth.client.rpc('request_team_access', { p_franchise: body.franchiseId, p_display_name: body.displayName, p_note: body.note })
    : body.action === 'cancel'
      ? await auth.client.rpc('cancel_team_access', { p_request: body.requestId })
      : body.action === 'revoke'
        ? await auth.client.rpc('revoke_team_access', { p_assignment: body.assignmentId, p_note: body.note })
        : await auth.client.rpc('review_team_access', { p_request: body.requestId, p_action: body.action, p_manager: body.managerId ?? null, p_role: body.role, p_note: body.note });
  return result.error ? rpcError(result.error) : json({ request: result.data }, body.action === 'request' ? 201 : 200);
}
