import type { HistoricalDraft, LeaguePlayer } from './types';

export type LiveKeeperProfile = {
  player_id: number; base_round: number | null; tenure_years: number | null; verification: string; explanation: string;
};
export type FinalizedDraftSelection = {
  player_id: number; franchise_id: string; round: number; overall_pick: number | null; was_keeper: boolean | null;
  source_metadata: { original_franchise_id?: string; [key: string]: unknown };
  players: { full_name: string } | null;
};

/** Keep the eligibility pool intact before finalization; afterward use only the recorded draft and its next-season profiles. */
export function buildLiveLeaguePlayers(input: {
  ownership: readonly { player_id: number; franchise_id: string }[];
  profiles: readonly LiveKeeperProfile[];
  names: ReadonlyMap<number, string>;
  roster: readonly { player_id: number; lineup_slot: number; snapshot_id: string }[];
  snapshotId: string;
  teamIds: ReadonlyMap<string, number>;
  previewPlayers: readonly LeaguePlayer[];
  finalizedDraft: readonly FinalizedDraftSelection[] | null;
}): LeaguePlayer[] {
  const profiles = new Map(input.profiles.map(profile => [profile.player_id, profile]));
  const slots = new Map(input.roster.filter(row => row.snapshot_id === input.snapshotId).map(row => [row.player_id, row.lineup_slot]));
  const preview = new Map(input.previewPlayers.map(player => [player.id, player]));
  const history = new Map(input.finalizedDraft?.map(row => [row.player_id, row]));
  return input.ownership.map(owned => {
    const profile = profiles.get(owned.player_id), prior = preview.get(owned.player_id), draft = history.get(owned.player_id);
    const name = input.names.get(owned.player_id), teamId = input.teamIds.get(owned.franchise_id), slot = slots.get(owned.player_id);
    if (!name || teamId === undefined || slot === undefined) throw new Error('The current roster is missing its player, team, or snapshot entry.');
    if (input.finalizedDraft !== null && (!profile || !draft || typeof draft.was_keeper !== 'boolean')) {
      throw new Error('The finalized roster is missing its draft history or next-season keeper profile.');
    }
    return {
      id: owned.player_id, name, teamId,
      baseCost: profile?.base_round ?? null, tenure: profile?.tenure_years ?? null,
      status: profile?.verification === 'confirmed' ? 'eligible' : profile?.verification === 'ineligible' ? 'ineligible' : 'review',
      reason: profile?.explanation ?? 'Keeper history requires commissioner verification.',
      wasKept: input.finalizedDraft !== null ? draft!.was_keeper! : prior?.wasKept ?? false,
      previousRound: input.finalizedDraft !== null ? draft!.round : prior?.previousRound ?? null,
      rosterSlot: slot === -1 ? 'Unassigned' : slot === 12 ? 'Bench' : slot === 13 ? 'IR' : input.finalizedDraft !== null ? 'Active' : prior?.rosterSlot ?? 'Active',
    };
  });
}

/** Finalized history keeps the drafting/paying owner even if the player was traded before finalization. */
export function mergeFinalizedDraftArchive(archive: readonly HistoricalDraft[], year: number, rows: readonly FinalizedDraftSelection[], franchiseNames: ReadonlyMap<string, string>, expectedCount: number): HistoricalDraft[] {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || rows.length !== expectedCount || new Set(rows.map(row => row.player_id)).size !== expectedCount) {
    throw new Error('The finalized draft history is incomplete.');
  }
  const selections = [...rows].sort((a, b) => (a.overall_pick ?? Infinity) - (b.overall_pick ?? Infinity)).map((row, index) => {
    const originalOwner = franchiseNames.get(row.source_metadata.original_franchise_id ?? ''), owner = franchiseNames.get(row.franchise_id);
    if (row.overall_pick !== index + 1 || !Number.isSafeInteger(row.round) || row.round < 1 || !originalOwner || !owner || !row.players?.full_name || typeof row.was_keeper !== 'boolean') {
      throw new Error('The finalized draft history is missing its pick, owner, player, or keeper classification.');
    }
    return { round: row.round, pick: row.overall_pick, originalOwner, owner, player: row.players.full_name, kept: row.was_keeper };
  });
  return [...archive.filter(draft => draft.year !== year), { year, selections }].sort((a, b) => a.year - b.year);
}
