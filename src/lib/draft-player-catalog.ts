import { primaryPosition, type PreferenceSource, type PrimaryPosition } from './roster-position-history';
import { CATEGORY_LABELS } from './category-preferences';

export type DraftCatalogPlayer = {
  id: number; name: string; nbaTeam: string; primaryPosition: PrimaryPosition | null; eligiblePositions: PrimaryPosition[];
  rank: number | null; rankSource: 'ROTO' | null; active: boolean; selectable: boolean;
};
export type DraftPlayerCatalog = {
  version: number; leagueId: number; espnSeasonId: number; fetchedAt: string; source: PreferenceSource;
  rankingSource: { field: string; label: string; rankType: 'ROTO'; customLeagueWeighting: false; limitations: string[] };
  categories: { id: number; label: string; lowerIsBetter: boolean }[];
  coverage: { players: number; ranked: number; unranked: number; selectable: number; unsigned: number };
  players: DraftCatalogPlayer[];
};
const NBA_TEAMS: Record<number, string> = { 0: 'FA', 1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GSW', 10: 'HOU', 11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA', 15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI', 21: 'PHX', 22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WAS', 28: 'TOR', 29: 'MEM', 30: 'CHA' };
type RawPlayerCatalog = { players: { id: number; status?: string; player: { id: number; fullName: string; active?: boolean; proTeamId?: number; defaultPositionId?: number; eligibleSlots?: number[]; draftRanksByRankType?: { ROTO?: { rank?: number; rankType?: string; slotId?: number; published?: boolean } } } }[] };
type ScoringSource = { id: number; seasonId: number; settings: { scoringSettings: { scoringType: string; scoringItems: { statId: number; points?: number; isReverseItem?: boolean }[] } } };

export function compareDraftCatalogPlayers(a: DraftCatalogPlayer, b: DraftCatalogPlayer) {
  return (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name) || a.id - b.id;
}

export function extractDraftPlayerCatalog(payload: RawPlayerCatalog, league: ScoringSource, source: PreferenceSource): DraftPlayerCatalog {
  if (league.id !== 139935 || league.seasonId !== 2027 || league.settings.scoringSettings.scoringType !== 'H2H_CATEGORY' || !Array.isArray(payload.players)) throw new Error('Expected the upcoming ESPN league category player pool.');
  const ids = new Set<number>();
  let unpublishedRanks = 0;
  const players = payload.players.map(entry => {
    const player = entry.player;
    if (!Number.isSafeInteger(entry.id) || entry.id < 1 || entry.id !== player.id || typeof player.fullName !== 'string' || !player.fullName.trim() || ids.has(entry.id)) throw new Error('Invalid or duplicate ESPN catalog identity.');
    ids.add(entry.id);
    const supplied = player.draftRanksByRankType?.ROTO;
    const rank = supplied?.rankType === 'ROTO' && supplied.slotId === 0 && typeof supplied.rank === 'number' && Number.isSafeInteger(supplied.rank) && supplied.rank > 0 ? supplied.rank : null;
    if (rank !== null && supplied?.published === false) unpublishedRanks += 1;
    const active = player.active === true;
    return { id: player.id, name: player.fullName.trim(), nbaTeam: NBA_TEAMS[player.proTeamId ?? -1] ?? 'Unknown',
      primaryPosition: primaryPosition(player.defaultPositionId), eligiblePositions: [...new Set((player.eligibleSlots ?? []).flatMap(slot => { const position = primaryPosition(slot + 1); return position ? [position] : []; }))],
      rank, rankSource: rank === null ? null : 'ROTO' as const, active,
      selectable: active && ['FREEAGENT', 'WAIVERS', 'ONTEAM'].includes(entry.status ?? '') };
  }).sort(compareDraftCatalogPlayers);
  const categories = league.settings.scoringSettings.scoringItems.filter(item => item.points !== 0).map(item => ({ id: item.statId, label: CATEGORY_LABELS[item.statId] ?? `Stat ${item.statId}`, lowerIsBetter: item.isReverseItem === true }));
  return { version: 1, leagueId: league.id, espnSeasonId: league.seasonId, fetchedAt: source.capturedAt, source,
    rankingSource: { field: 'player.draftRanksByRankType.ROTO.rank', label: 'ESPN category rankings (ROTO)', rankType: 'ROTO', customLeagueWeighting: false,
      limitations: ['ESPN ROTO draft ranks are supplied category rankings, not a separately calculated custom league ranking. Unranked players follow ranked players alphabetically.',
        'Selectable means ESPN marks the player active in this league player pool; unsigned players remain included. Draft availability also depends on this app\'s keepers and completed picks.',
        ...(unpublishedRanks ? [`ESPN returned published=false on ${unpublishedRanks} supplied ROTO rank entries; these are the values available in the league player pool at capture time.`] : [])] },
    categories, coverage: { players: players.length, ranked: players.filter(player => player.rank !== null).length, unranked: players.filter(player => player.rank === null).length, selectable: players.filter(player => player.selectable).length, unsigned: players.filter(player => player.nbaTeam === 'FA').length }, players };
}

export function findDraftCatalogPlayer(catalog: DraftPlayerCatalog, id: number): DraftCatalogPlayer | null {
  return catalog.players.find(player => player.id === id) ?? null;
}
