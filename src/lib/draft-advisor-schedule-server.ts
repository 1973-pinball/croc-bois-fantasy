import { aiEasternDate, extractAiNbaSchedule } from './ai-league-feed';
import { draftAdvisorScheduleSchema, draftScheduleEndDate, normalizeNbaTeam, validateDraftScheduleWindow, type DraftAdvisorSchedule } from './draft-advisor-schedule';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The NBA schedule response is incomplete.');
  return value as Json;
}

export function parseEspnDraftSchedule(payload: unknown, options: { seasonId: number; startDate?: string; fetchedAt?: string; today?: string }): DraftAdvisorSchedule {
  const rawTeams = object(object(payload).settings).proTeams;
  if (!Array.isArray(rawTeams)) throw new Error('The NBA schedule has no verified teams.');
  const teams = new Map<number, string>();
  for (const raw of rawTeams) {
    const team = object(raw);
    if (team.id === 0) continue;
    if (typeof team.id !== 'number' || !Number.isInteger(team.id) || team.id < 1 || team.id > 30 || typeof team.abbrev !== 'string' || teams.has(team.id)) throw new Error('The NBA schedule has invalid or duplicate teams.');
    const abbreviation = normalizeNbaTeam(team.abbrev);
    if (!abbreviation) throw new Error('The NBA schedule has an unknown team abbreviation.');
    teams.set(team.id, abbreviation);
  }
  if (teams.size !== 30 || new Set(teams.values()).size !== 30) throw new Error('The NBA schedule does not include all 30 teams.');
  const nbaGames = extractAiNbaSchedule(payload);
  if (nbaGames.some(game => game.date < `${options.seasonId - 1}-07-01` || game.date > `${options.seasonId}-06-30` || !teams.has(game.home) || !teams.has(game.away))) throw new Error('The NBA schedule does not match the requested season.');
  const firstDate = nbaGames[0].date, lastDate = nbaGames.at(-1)!.date;
  const today = options.today ?? aiEasternDate(new Date());
  const futureDate = nbaGames.find(game => game.date >= today)?.date;
  const startDate = options.startDate ?? futureDate ?? firstDate;
  const window = validateDraftScheduleWindow(options.seasonId, startDate, draftScheduleEndDate(startDate));
  if (window.startDate < firstDate || window.endDate > lastDate) throw new Error(`ESPN's published NBA schedule covers ${firstDate} through ${lastDate}. Select a complete seven-day window in that range or upload a schedule.`);
  const selected = nbaGames.filter(game => game.date >= window.startDate && game.date <= window.endDate);
  if (!selected.length) throw new Error('No NBA games are published for this seven-day window. Select another window or upload a schedule.');
  const totals = new Map<number, number>();
  for (const game of nbaGames) for (const team of [game.home, game.away]) totals.set(team, (totals.get(team) ?? 0) + 1);
  const warnings = ['Schedule recommendations use published games in this seven-day window; future postponements, NBA Cup additions and player availability can change them.'];
  if (Math.min(...[...teams.keys()].map(team => totals.get(team) ?? 0)) < 82) warnings.push('ESPN has not published 82 games for every team. Unscheduled NBA Cup or makeup fixtures are not included.');
  if (!options.startDate && !futureDate) warnings.push('This season has no remaining published games. The opening schedule week is shown for review.');
  return draftAdvisorScheduleSchema.parse({
    ...window, fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    games: selected.flatMap(game => [game.home, game.away].map(team => ({ date: game.date, team: teams.get(team)! }))).sort((a, b) => a.date.localeCompare(b.date) || a.team.localeCompare(b.team)),
    sourceLabel: 'ESPN published NBA schedule', warnings,
  });
}

/** Fixed public ESPN origin only: no league cookies, caller-supplied URLs or redirects. */
export async function fetchDraftAdvisorSchedule(options: { seasonId: number; startDate?: string }): Promise<DraftAdvisorSchedule> {
  if (!Number.isInteger(options.seasonId) || options.seasonId < 2001 || options.seasonId > 2100) throw new Error('Select a valid NBA season ending year.');
  if (options.startDate) validateDraftScheduleWindow(options.seasonId, options.startDate);
  let response: Response;
  try {
    response = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${options.seasonId}?view=proTeamSchedules_wl`, {
      headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12_000),
    });
  } catch { throw new Error('ESPN could not be reached. Try again or upload a schedule CSV/TSV.'); }
  if (!response.ok) throw new Error('ESPN could not provide the NBA schedule. Try again or upload a schedule CSV/TSV.');
  const length = Number(response.headers.get('content-length'));
  if (length > 8_000_000) throw new Error('The NBA schedule response is unexpectedly large.');
  const text = await response.text();
  if (!text.length || text.length > 8_000_000) throw new Error('The NBA schedule response is incomplete or unexpectedly large.');
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error('ESPN returned an unreadable NBA schedule. Upload a CSV/TSV or try again.'); }
  return parseEspnDraftSchedule(payload, options);
}
