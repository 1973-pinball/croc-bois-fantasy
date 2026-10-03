import type { Team } from './types';

/** Current account labels; historical written terms must stay verbatim. */
export function managerLabel(team: Pick<Team, 'managers' | 'owner'>) {
  return team.managers.filter(Boolean).join(' · ') || team.owner;
}

export function seasonLabel(draftYear: number) {
  return `${draftYear}–${String(draftYear + 1).slice(-2)}`;
}
