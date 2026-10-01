import { z } from 'zod';

const uuid = z.string().uuid();
const note = z.string().trim().max(2000).default('');
export const teamAccessActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), franchiseId: uuid, displayName: z.string().trim().min(1).max(100), note }).strict(),
  z.object({ action: z.literal('cancel'), requestId: uuid }).strict(),
  z.object({ action: z.enum(['approve', 'reject']), requestId: uuid, managerId: uuid.nullable().optional(), role: z.enum(['manager', 'co_manager']).default('manager'), note }).strict(),
  z.object({ action: z.literal('revoke'), assignmentId: uuid, note: z.string().trim().min(1).max(2000) }).strict(),
]).refine(body => body.action !== 'reject' || body.note.length > 0, { message: 'Include a reason when declining access.', path: ['note'] });

type Membership = { league_id: string; role: string };
type Assignment = { league_id: string; franchise_id: string; effective_from: string; effective_to: string | null };

// Commissioner permission over every team is distinct from their own franchise.
export function ownTeamIds(leagueId: string, memberships: Membership[], assignments: Assignment[], franchiseIds: Record<string, string>, now = Date.now()) {
  if (!memberships.some(item => item.league_id === leagueId && ['manager', 'commissioner'].includes(item.role))) return [];
  const current = new Set(assignments.filter(item => item.league_id === leagueId && Date.parse(item.effective_from) <= now && (item.effective_to === null || Date.parse(item.effective_to) > now)).map(item => item.franchise_id));
  return Object.entries(franchiseIds).filter(([, id]) => current.has(id)).map(([id]) => Number(id));
}
