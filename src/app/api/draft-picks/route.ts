import { createClient } from '@supabase/supabase-js';
import { leagueData } from '@/lib/league-data';
import { buildReferencePickGrids } from '@/lib/draft-pick-grids';
import { buildLiveDraftPickGrids, readAllInventoryPages, type InventorySeason, type InventoryRule, type InventoryFranchise, type InventoryParticipant, type InventoryPick } from '@/lib/live-draft-pick-grids';
import { getSupabaseConfig } from '@/lib/supabase/config';
import { json, setupResponse } from '@/lib/supabase/http';

export async function GET() {
  const config = getSupabaseConfig();
  if (!config) return setupResponse();
  const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const unavailable = () => json({ configured: true, error: 'DRAFT_INVENTORY_UNAVAILABLE', message: 'The configured draft-pick inventory could not be verified. No missing picks have been replaced with assumed ownership.' }, 503);
  try {
    const league = await client.from('leagues').select('id').eq('espn_league_id', 139935).single();
    if (league.error || !league.data) return unavailable();
    const [seasons, rules, franchises] = await Promise.all([
      readAllInventoryPages<InventorySeason>((from, to) => client.from('seasons').select('id,draft_year,rule_version_id,participant_count', { count: 'exact' }).eq('league_id', league.data.id).gte('draft_year', leagueData.season).order('draft_year').order('id').range(from, to)),
      readAllInventoryPages<InventoryRule>((from, to) => client.from('rule_versions').select('id,draft_rounds', { count: 'exact' }).eq('league_id', league.data.id).order('id').range(from, to)),
      readAllInventoryPages<InventoryFranchise>((from, to) => client.from('franchises').select('id,name,espn_team_id', { count: 'exact' }).eq('league_id', league.data.id).order('id').range(from, to)),
    ]);
    if (!seasons.some(s => s.draft_year === leagueData.season)) return unavailable();
    const participants: InventoryParticipant[] = [];
    const picks: InventoryPick[] = [];
    // Bound URL size while paginating every row, including large expansion seasons.
    for (let offset = 0; offset < seasons.length; offset += 25) {
      const ids = seasons.slice(offset, offset + 25).map(s => s.id);
      const [seasonTeams, seasonPicks] = await Promise.all([
        readAllInventoryPages<InventoryParticipant>((from, to) => client.from('season_teams').select('season_id,franchise_id,display_name,draft_position', { count: 'exact' }).eq('league_id', league.data.id).in('season_id', ids).order('season_id').order('franchise_id').range(from, to)),
        readAllInventoryPages<InventoryPick>((from, to) => client.from('draft_picks').select('id,season_id,original_franchise_id,current_owner_id,round,status', { count: 'exact' }).in('season_id', ids).order('season_id').order('original_franchise_id').order('round').order('id').range(from, to)),
      ]);
      participants.push(...seasonTeams); picks.push(...seasonPicks);
    }
    const live = buildLiveDraftPickGrids({ seasons, rules, franchises, participants, picks, referenceTeams: leagueData.teams });
    const liveYears = new Set(live.map(s => s.year));
    return json({ source: 'supabase', seasons: [...buildReferencePickGrids(leagueData).filter(s => !liveYears.has(s.year)), ...live].sort((a, b) => a.year - b.year) });
  } catch { return unavailable(); }
}
