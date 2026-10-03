export const portalViews = ['overview', 'my-team', 'teams', 'keepers', 'draft', 'trades', 'lab', 'charter', 'commissioner', 'audit'] as const;
export type PortalView = typeof portalViews[number];
export type DraftView = 'live' | 'ownership' | 'archive';
export type RosterSort = { column: 'player' | 'team' | 'cost' | 'tenure'; direction: 'ascending' | 'descending' };

export function readPortalLocation(search: string, hash = '', defaultView: PortalView = 'overview') {
  const params = new URLSearchParams(search);
  const requested = params.get('view');
  const view: PortalView = portalViews.includes(requested as PortalView) && requested !== 'audit' ? requested as PortalView : hash.startsWith('#charter-') ? 'charter' : defaultView;
  const team = Number(params.get('team'));
  const [column, direction] = (params.get('sort') || '').split(':');
  return {
    view,
    teamId: Number.isSafeInteger(team) && team !== 0 ? team : null,
    search: params.get('roster') || '',
    tradeSearch: params.get('trade') || '',
    allTeams: params.get('all') === '1',
    draftView: (['live', 'ownership', 'archive'].includes(params.get('draftView') || '') ? params.get('draftView') : 'live') as DraftView,
    draftYear: /^\d{4}$/.test(params.get('year') || '') ? params.get('year')! : null,
    openOrderEditor: params.get('order') === 'edit',
    sort: { column: ['player', 'team', 'cost', 'tenure'].includes(column) ? column : 'player', direction: direction === 'descending' ? direction : 'ascending' } as RosterSort,
  };
}

export function portalHref(search: string, patch: Record<string, string | number | boolean | null>) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '' || value === false) params.delete(key);
    else params.set(key, value === true ? '1' : String(value));
  }
  if (params.get('view') === 'audit') return '/audit';
  return '/?' + params.toString();
}
