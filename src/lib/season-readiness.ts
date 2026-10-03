import { z } from 'zod';

export function isSeasonTimeZone(value: string): boolean {
  if (value !== 'UTC' && (!value.includes('/') || /^(posix|right)\//.test(value))) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Enter a valid date and time.');
const timeZone = z.string().trim().min(1).max(100).refine(isSeasonTimeZone, 'Choose an IANA timezone, such as America/New_York or UTC.');
const note = z.string().trim().min(1).max(2000);
export const seasonActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open_keeper_selection'), seasonId: uuid, note }).strict(),
  z.object({ action: z.literal('update_schedule'), seasonId: uuid, expectedRevision: z.number().int().min(0), keeperDeadline: timestamp.nullable(), draftAt: timestamp.nullable(), seasonTimeZone: timeZone.nullable(), note }).strict(),
]).superRefine((value, context) => {
  if (value.action !== 'update_schedule') return;
  if ((value.keeperDeadline || value.draftAt) && !value.seasonTimeZone) context.addIssue({ code: 'custom', path: ['seasonTimeZone'], message: 'Choose the season timezone before saving dates.' });
  if (value.keeperDeadline && value.draftAt && Date.parse(value.keeperDeadline) > Date.parse(value.draftAt)) context.addIssue({ code: 'custom', path: ['draftAt'], message: 'The draft cannot be before the keeper deadline.' });
});

const count = z.number().int().nonnegative();
export const seasonReadinessSchema = z.object({
  seasonId: uuid, leagueId: uuid,
  phase: z.enum(['setup', 'keeper_selection', 'draft_ready', 'in_season', 'archived']),
  participantCount: count, registeredCount: count, hasFrozenSnapshot: z.boolean(),
  inventoryComplete: z.boolean(), totalPickCount: count, expectedTotalPickCount: count,
  keeperDeadline: timestamp.nullable(), draftAt: timestamp.nullable(), seasonTimeZone: timeZone.nullable(), scheduleRevision: count,
  tradingOpenedAt: timestamp.nullable(), keepersRevealedAt: timestamp.nullable(),
  teams: z.array(z.object({
    franchiseId: uuid, displayName: z.string(), status: z.enum(['missing', 'draft', 'submitted', 'approved', 'rejected', 'locked']), revision: count.nullable(),
    activeManagerCount: count, pendingAccessCount: count, playerCount: count,
    profileCounts: z.object({ confirmed: count, provisional: count, unresolved: count, ineligible: count, missing: count }).strict(),
    pickCount: count, originalPickCount: count, expectedPickCount: count,
  }).strict()),
}).strict();

export type SeasonReadiness = z.infer<typeof seasonReadinessSchema>;
export type SeasonReadinessTeam = SeasonReadiness['teams'][number];
