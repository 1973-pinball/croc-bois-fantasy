import snapshot from "../../data/league.json";
import type { LeagueData } from "./types";
/** Public migration preview. Authenticated writes use Supabase, never this snapshot. */
export const leagueData = snapshot as LeagueData;
