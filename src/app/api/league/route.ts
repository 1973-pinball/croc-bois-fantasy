import { createClient } from '@supabase/supabase-js';
import { leagueData } from '@/lib/league-data';
import type { DraftPick, LeagueData, LeaguePlayer, Team } from '@/lib/types';
import { getSupabaseConfig } from '@/lib/supabase/config';
import { json, setupResponse } from '@/lib/supabase/http';
import { parseKeeperPaymentInventory } from '@/lib/keeper-payment-inventory';
import { mergeFinalizedTradeLedger, type FinalizedTradeRow } from '@/lib/live-trade-ledger';
import { readAllRows } from '@/lib/supabase/pagination';

export async function GET() {
  const config = getSupabaseConfig();
  if (!config) return setupResponse();
  // Deliberately anonymous: this public overlay never inherits a user's auth cookie.
  const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const unavailable = () => json({ configured: true, error: 'LIVE_DATA_UNAVAILABLE', message: 'The connected league data could not be loaded. Apply the migrations and reviewed bootstrap data; no cached roster has been substituted.' }, 503);
  try {
    const league = await client.from('leagues').select('id').eq('espn_league_id', 139935).single();
    if (league.error || !league.data) return unavailable();
    const seasonResult = await client.from('seasons').select('id,phase,participant_count,draft_year,keepers_revealed_at,trading_opened_at,keeper_deadline,draft_at,season_time_zone,schedule_revision').eq('league_id', league.data.id).eq('draft_year', leagueData.season).single();
    if (seasonResult.error || !seasonResult.data) return unavailable();
    const season = seasonResult.data;
    const [franchises, participation, ownership, profiles, picks, snapshots, roster, keeperRecords, draftBoard, finalizedTrades, tradeSeasons] = await Promise.all([
      client.from('franchises').select('id,espn_team_id,name').eq('league_id', league.data.id).order('id'),
      client.from('season_teams').select('franchise_id,display_name,draft_position').eq('season_id', season.id),
      client.from('player_ownerships').select('player_id,franchise_id').eq('season_id', season.id),
      client.from('keeper_profiles').select('player_id,base_round,tenure_years,verification,explanation').eq('season_id', season.id),
      client.from('draft_picks').select('id,round,original_franchise_id,current_owner_id,status').eq('season_id', season.id).order('round'),
      client.from('roster_snapshots').select('id,snapshot_date').eq('season_id', season.id).not('frozen_at', 'is', null).single(),
      client.from('roster_entries').select('player_id,lineup_slot,snapshot_id').eq('season_id', season.id),
      client.from('keeper_season_records').select('player_id,franchise_id,pick_id,base_round,actual_payment_round').eq('season_id', season.id),
      client.rpc('get_draft_board', { p_season: season.id }),
      readAllRows<FinalizedTradeRow>((from, to) => client.from('trades').select('id,season_id,status,application_mode,terms,created_at,finalized_at,trade_participants(franchise_id),trade_player_transfers(player_id,from_franchise_id,to_franchise_id,players(full_name)),trade_pick_transfers(pick_id,from_franchise_id,to_franchise_id,draft_picks(round,season_id,original_franchise_id)),trade_obligations(kind,terms,from_franchise_id,to_franchise_id,status)', { count: 'exact' }).eq('league_id', league.data.id).eq('status', 'finalized').eq('application_mode', 'live').order('created_at').order('id').range(from, to).overrideTypes<FinalizedTradeRow[], { merge: false }>()),
      readAllRows<{ id: string; draft_year: number }>((from, to) => client.from('seasons').select('id,draft_year', { count: 'exact' }).eq('league_id', league.data.id).order('draft_year').order('id').range(from, to)),
    ]);
    if ([franchises,participation,ownership,profiles,picks,snapshots,roster,keeperRecords,draftBoard].some((r) => r.error) || typeof draftBoard.data?.orderLocked !== 'boolean' || !snapshots.data || !ownership.data?.length || !participation.data?.length) return unavailable();
    const playerRows = await client.from('players').select('id,full_name').in('id', ownership.data.map((p) => p.player_id));
    if (playerRows.error || playerRows.data.length !== ownership.data.length) return unavailable();
    const profileMap = new Map(profiles.data!.map((p) => [p.player_id, p]));
    const nameMap = new Map(playerRows.data.map((p) => [p.id,p.full_name]));
    const rosterMap = new Map(roster.data!.filter((r) => r.snapshot_id === snapshots.data!.id).map((p) => [p.player_id,p.lineup_slot]));
    const participantMap = new Map(participation.data!.map((p) => [p.franchise_id,p]));
    const franchiseIds: Record<string,string> = {};
    const numericIds = new Map<string,number>();
    const teams: Team[] = franchises.data!.filter((f) => participantMap.has(f.id)).map((f,index) => {
      // Negative IDs are display-only handles for expansion teams not yet linked to ESPN.
      // The permanent database UUID remains the identity used by every write.
      const id = f.espn_team_id ?? -(index+1);
      franchiseIds[String(id)] = f.id;
      numericIds.set(f.id,id);
      const imported = leagueData.teams.find((t) => t.id === id);
      return { id, name: participantMap.get(f.id)!.display_name, owner: imported?.owner ?? 'Manager assignment pending', managers: imported?.managers ?? [], shortName: imported?.shortName ?? f.name, color: imported?.color ?? '#689c60' };
    });
    if (numericIds.size !== participation.data!.length || new Set(numericIds.values()).size !== numericIds.size) return unavailable();
    const players: LeaguePlayer[] = ownership.data.map((owned) => {
      const profile = profileMap.get(owned.player_id);
      const imported = leagueData.players.find((p) => p.id === owned.player_id);
      const slot = rosterMap.get(owned.player_id);
      return {
        id: owned.player_id, name: nameMap.get(owned.player_id)!, teamId: numericIds.get(owned.franchise_id)!,
        baseCost: profile?.base_round ?? null, tenure: profile?.tenure_years ?? null,
        status: profile?.verification === 'confirmed' ? 'eligible' : profile?.verification === 'ineligible' ? 'ineligible' : 'review',
        reason: profile?.explanation ?? 'Keeper history requires commissioner verification.',
        wasKept: imported?.wasKept ?? false, previousRound: imported?.previousRound ?? null,
        rosterSlot: slot === 12 ? 'Bench' : slot === 13 ? 'IR' : imported?.rosterSlot ?? 'Active',
      };
    });
    if (players.some((p) => p.teamId === undefined || !rosterMap.has(p.id))) return unavailable();
    const livePicks: DraftPick[] = picks.data!.map((p) => ({ id: p.id, season: season.draft_year, round: p.round, originalTeamId: numericIds.get(p.original_franchise_id)!, ownerTeamId: numericIds.get(p.current_owner_id)! }));
    if (livePicks.some((p) => p.originalTeamId === undefined || p.ownerTeamId === undefined)) return unavailable();
    const trades = mergeFinalizedTradeLedger(leagueData.trades, finalizedTrades, franchises.data!.map((franchise, index) => ({ franchiseId: franchise.id, teamId: numericIds.get(franchise.id) ?? franchise.espn_team_id ?? -(index + 1), name: participantMap.get(franchise.id)?.display_name ?? franchise.name })), tradeSeasons);
    const data: LeagueData = { ...leagueData, season: season.draft_year, snapshotDate: snapshots.data.snapshot_date, teams, players, picks: livePicks, trades,
      reviewItems: players.filter((p) => p.status === 'review').map((p) => ({ id: String(p.id), player: p.name, detail: p.reason, status: profileMap.get(p.id)?.verification === 'provisional' ? 'provisional' : 'needs-review' })),
    };
    const revealedKeepers = season.keepers_revealed_at ? keeperRecords.data!.map((k) => ({ playerId: k.player_id, teamId: numericIds.get(k.franchise_id), pickId: k.pick_id, baseRound: k.base_round, paymentRound: k.actual_payment_round })) : [];
    const paymentInventory = await client.rpc('get_keeper_payment_inventory', { p_season: season.id });
    if (paymentInventory.error) return unavailable();
    const keeperPaymentInventory = parseKeeperPaymentInventory(paymentInventory.data, season.id, season.draft_year, franchiseIds);
    return json({ configured: true, source: 'supabase', seasonId: season.id, phase: season.phase, participantCount: season.participant_count, keepersRevealedAt: season.keepers_revealed_at, tradingOpenedAt: season.trading_opened_at, franchiseIds,
      keeperPaymentInventory,
      keeperDeadline: season.keeper_deadline, draftAt: season.draft_at, seasonTimeZone: season.season_time_zone, scheduleRevision: season.schedule_revision,
      draftStarted: draftBoard.data.orderLocked,
      usedPickIds: picks.data!.filter((p) => p.status === 'used').map((p) => p.id),
      draftOrder: participation.data!.filter((p) => p.draft_position !== null).sort((a,b) => a.draft_position-b.draft_position).map((p) => numericIds.get(p.franchise_id)),
      data, players, picks: livePicks, revealedKeepers,
    });
  } catch { return unavailable(); }
}
