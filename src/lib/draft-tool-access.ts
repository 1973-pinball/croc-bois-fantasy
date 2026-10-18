import identities from '../../data/identities.json';

// This is the commissioner-verified manager identity, never a Google profile name
// or a general permission for everyone who happens to manage the same franchise.
export const DRAFT_TOOL_MANAGER_ID = '88d5f255-be2f-49dc-846f-84bea4326a0f';
export const DRAFT_TOOL_USER_ID = 'e9cf452d-090c-472f-891b-f732759fe500';
export const DRAFT_TOOL_FRANCHISE_ID = identities.franchises['4'];
export type RestrictedDraftToolAccess = { franchiseId: string };
type Membership = { league_id: string; role: string };
type Assignment = {
  user_id: string | null; league_id: string; manager_id: string; franchise_id: string;
  effective_from: string | null; effective_to: string | null;
};

/** Memberships must already be filtered to active rows for this verified user. */
export function restrictedDraftToolAccess(userId: string, memberships: Membership[], assignments: Assignment[], now = Date.now()): RestrictedDraftToolAccess | null {
  if (userId !== DRAFT_TOOL_USER_ID) return null;
  if (!memberships.some(item => item.league_id === identities.leagueId && item.role === 'manager')) return null;
  const assigned = assignments.some(item => item.user_id === userId
    && item.league_id === identities.leagueId
    && item.manager_id === DRAFT_TOOL_MANAGER_ID
    && item.franchise_id === DRAFT_TOOL_FRANCHISE_ID
    && item.effective_from !== null && Date.parse(item.effective_from) <= now
    && (item.effective_to === null || Date.parse(item.effective_to) > now));
  return assigned ? { franchiseId: DRAFT_TOOL_FRANCHISE_ID } : null;
}
