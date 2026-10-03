export const PRIMARY_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'] as const;
export type PrimaryPosition = typeof PRIMARY_POSITIONS[number];
export type PreferenceSource = { sha256: string; url: string; capturedAt: string };
export type RosterPositionTeam = {
  franchiseId: string; espnTeamId: number; rosterAvailable: boolean;
  rosterPlayers: number; classifiedPlayers: number; unknownPlayers: number;
  positions: { position: PrimaryPosition; count: number }[];
};
export type RosterPositionSeason = {
  season: number; draftYear: number; source: PreferenceSource; scoringPeriodId: number | null;
  teams: RosterPositionTeam[];
};
export type RosterPositionHistory = {
  version: number; leagueId: number; coverage: { draftYears: number[]; limitations: string[] };
  seasons: RosterPositionSeason[];
};

export function primaryPosition(id: unknown): PrimaryPosition | null {
  return typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 5 ? PRIMARY_POSITIONS[id - 1] : null;
}

type RawRoster = {
  id: number; seasonId: number; scoringPeriodId?: number;
  teams: { id: number; roster?: { entries?: { playerId?: number; playerPoolEntry?: { player?: { id?: number; defaultPositionId?: number } } }[] } }[];
};

/** Counts each rostered player once at ESPN's season-scoped primary position, including bench/IR. */
export function extractRosterPositions(payload: RawRoster, source: PreferenceSource): RosterPositionSeason {
  if (payload.id !== 139935 || !Number.isSafeInteger(payload.seasonId) || !Array.isArray(payload.teams)) throw new Error('Invalid ESPN roster source identity.');
  const teamIds = new Set<number>();
  const teams = payload.teams.map(team => {
    if (!Number.isSafeInteger(team.id) || team.id < 1 || team.id > 8 || teamIds.has(team.id)) throw new Error('Unmapped or duplicate ESPN franchise.');
    teamIds.add(team.id);
    const entries = team.roster?.entries ?? [];
    const counts = new Map<PrimaryPosition, number>(PRIMARY_POSITIONS.map(position => [position, 0]));
    const playerIds = new Set<number>();
    let unknownPlayers = 0;
    for (const entry of entries) {
      const player = entry.playerPoolEntry?.player;
      const id = entry.playerId ?? player?.id;
      if (typeof id === 'number' && playerIds.has(id)) throw new Error('Duplicate player in ESPN roster snapshot.');
      if (typeof id === 'number') playerIds.add(id);
      const position = primaryPosition(player?.defaultPositionId);
      if (position === null) unknownPlayers += 1;
      else counts.set(position, counts.get(position)! + 1);
    }
    return { franchiseId: String(team.id), espnTeamId: team.id, rosterAvailable: entries.length > 0,
      rosterPlayers: entries.length, classifiedPlayers: entries.length - unknownPlayers, unknownPlayers,
      positions: PRIMARY_POSITIONS.map(position => ({ position, count: counts.get(position)! })) };
  });
  return { season: payload.seasonId, draftYear: payload.seasonId - 1, source,
    scoringPeriodId: Number.isInteger(payload.scoringPeriodId) ? payload.scoringPeriodId! : null, teams };
}

/** With no filter, uses the artifact's explicit coverage years. Missing snapshots never count as empty rosters. */
export function aggregateRosterPositions(history: RosterPositionHistory, draftYears: readonly number[] = history.coverage.draftYears) {
  const requested = [...new Set(draftYears)].sort((a, b) => a - b);
  const ids = [...new Set(history.seasons.flatMap(season => season.teams.map(team => team.franchiseId)))].sort((a, b) => Number(a) - Number(b));
  const duplicate = history.seasons.some((season, index) => history.seasons.findIndex(other => other.draftYear === season.draftYear) !== index);
  if (duplicate) throw new Error('Only one roster snapshot per recorded season may be averaged.');
  return ids.map(franchiseId => {
    const snapshots = requested.flatMap(year => {
      const team = history.seasons.find(season => season.draftYear === year)?.teams.find(team => team.franchiseId === franchiseId);
      return team?.rosterAvailable && team.rosterPlayers > 0 ? [{ year, team }] : [];
    });
    const recordedSeasons = snapshots.map(snapshot => snapshot.year);
    const rosterPlayers = snapshots.reduce((sum, { team }) => sum + team.rosterPlayers, 0);
    return { franchiseId, recordedSeasons, missingSeasons: requested.filter(year => !recordedSeasons.includes(year)), snapshotCount: snapshots.length,
      rosterPlayers, classifiedPlayers: snapshots.reduce((sum, { team }) => sum + team.classifiedPlayers, 0),
      unknownPlayers: snapshots.reduce((sum, { team }) => sum + team.unknownPlayers, 0),
      averageRosterSize: snapshots.length ? rosterPlayers / snapshots.length : null,
      positions: PRIMARY_POSITIONS.map(position => {
        const values = snapshots.map(({ team }) => ({ count: team.positions.find(row => row.position === position)?.count ?? 0, denominator: team.rosterPlayers }));
        const playerObservations = values.reduce((sum, value) => sum + value.count, 0);
        return { position, playerObservations, averageCount: snapshots.length ? playerObservations / snapshots.length : null,
          averageShare: snapshots.length ? values.reduce((sum, value) => sum + value.count / value.denominator, 0) / snapshots.length : null };
      }) };
  });
}
