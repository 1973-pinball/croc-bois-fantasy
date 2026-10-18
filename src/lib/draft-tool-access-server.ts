import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import identities from '../../data/identities.json';
import { restrictedDraftToolAccess, type RestrictedDraftToolAccess } from './draft-tool-access';

type DraftToolAccess = { commissioner: boolean; restricted: RestrictedDraftToolAccess | null; unavailable: boolean };

/** Recheck the authenticated account's current authorization on every API request. */
export async function readDraftToolAccess(client: SupabaseClient, userId: string): Promise<DraftToolAccess> {
  const membership = await client.from('league_memberships').select('role').eq('league_id', identities.leagueId).eq('user_id', userId).eq('active', true).maybeSingle();
  if (membership.error) return { commissioner: false, restricted: null, unavailable: true };
  if (membership.data?.role === 'commissioner') return { commissioner: true, restricted: null, unavailable: false };
  if (membership.data?.role !== 'manager') return { commissioner: false, restricted: null, unavailable: false };
  const now = new Date().toISOString();
  const assignments = await client.from('manager_assignments').select('user_id,league_id,manager_id,franchise_id,effective_from,effective_to')
    .eq('league_id', identities.leagueId).eq('user_id', userId).lte('effective_from', now).or(`effective_to.is.null,effective_to.gt.${now}`);
  if (assignments.error) return { commissioner: false, restricted: null, unavailable: true };
  return {
    commissioner: false, unavailable: false,
    restricted: restrictedDraftToolAccess(userId, [{ league_id: identities.leagueId, role: membership.data.role }], assignments.data ?? []),
  };
}
