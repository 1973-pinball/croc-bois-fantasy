import { aiEasternDate, extractAiNbaSchedule } from './ai-league-feed';
import { draftAdvisorScheduleSchema, draftScheduleEndDate, normalizeNbaTeam, validateDraftScheduleSeason, validateDraftScheduleWindow, type DraftAdvisorSchedule } from './draft-advisor-schedule';

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The NBA schedule response is incomplete.');
  return value as Json;
}

type RegularSeason = { startDate: string; endDate: string };
export function parseEspnRegularSeason(payload: unknown, seasonId: number): RegularSeason {
  const value = object(payload);
  if (value.year !== seasonId || value.type !== 2 || String(value.id) !== '2' || typeof value.startDate !== 'string' || typeof value.endDate !== 'string'
    || !Number.isFinite(Date.parse(value.startDate)) || !Number.isFinite(Date.parse(value.endDate)) || Date.parse(value.startDate) >= Date.parse(value.endDate)) throw new Error('ESPN’s regular-season dates could not be verified.');
  validateDraftScheduleSeason(seasonId, value.startDate.slice(0, 10), value.endDate.slice(0, 10));
  return { startDate: value.startDate, endDate: value.endDate };
}

export function parseEspnDraftSchedule(payload: unknown, options: { seasonId: number; scope?: 'week' | 'season'; startDate?: string; fetchedAt?: string; today?: string; regularSeason?: RegularSeason }): DraftAdvisorSchedule {
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
  const publishedGames = extractAiNbaSchedule(payload);
  if (publishedGames.some(game => game.date < `${options.seasonId - 1}-07-01` || game.date > `${options.seasonId}-06-30` || !teams.has(game.home) || !teams.has(game.away))) throw new Error('The NBA schedule does not match the requested season.');
  const nbaGames = options.scope === 'season' && options.regularSeason
    ? publishedGames.filter(game => Date.parse(game.startsAt) >= Date.parse(options.regularSeason!.startDate) && Date.parse(game.startsAt) <= Date.parse(options.regularSeason!.endDate))
    : publishedGames;
  if (!nbaGames.length) throw new Error('ESPN has no published games inside the verified regular season.');
  const firstDate = nbaGames[0].date, lastDate = nbaGames.at(-1)!.date;
  const today = options.today ?? aiEasternDate(new Date());
  const futureDate = nbaGames.find(game => game.date >= today)?.date;
  const startDate = options.startDate ?? futureDate ?? firstDate;
  const window = options.scope === 'season'
    ? validateDraftScheduleSeason(options.seasonId, firstDate, lastDate)
    : validateDraftScheduleWindow(options.seasonId, startDate, draftScheduleEndDate(startDate));
  if (window.startDate < firstDate || window.endDate > lastDate) throw new Error(`ESPN's published NBA schedule covers ${firstDate} through ${lastDate}. Select a complete seven-day window in that range or upload a schedule.`);
  const selected = nbaGames.filter(game => game.date >= window.startDate && game.date <= window.endDate);
  if (!selected.length) throw new Error('No NBA games are published for this seven-day window. Select another window or upload a schedule.');
  const totals = new Map<number, number>();
  for (const game of nbaGames) for (const team of [game.home, game.away]) totals.set(team, (totals.get(team) ?? 0) + 1);
  if (options.scope === 'season' && [...teams.keys()].some(team => !totals.has(team) || totals.get(team)! > 82)) throw new Error('ESPN’s full regular-season schedule has missing teams or more than 82 games for a team. Upload a verified regular-season schedule.');
  const warnings = [options.scope === 'season'
    ? 'The entire published NBA fantasy regular-season calendar is included. Recommendations average Monday–Sunday category winrates across the season, including partial opening and closing weeks, using the current rosters. They are not a fantasy playoff forecast.'
    : 'Schedule recommendations use published games in this seven-day window; future postponements, NBA Cup additions and player availability can change them.'];
  if (Math.min(...[...teams.keys()].map(team => totals.get(team) ?? 0)) < 82) warnings.push('ESPN has not published 82 games for every team. Unscheduled NBA Cup or makeup fixtures are not included.');
  if (options.scope !== 'season' && !options.startDate && !futureDate) warnings.push('This season has no remaining published games. The opening schedule week is shown for review.');
  return draftAdvisorScheduleSchema.parse({
    ...window, ...(options.scope ? { scope: options.scope } : {}), fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    games: selected.flatMap(game => [game.home, game.away].map(team => ({ date: game.date, team: teams.get(team)! }))).sort((a, b) => a.date.localeCompare(b.date) || a.team.localeCompare(b.team)),
    sourceLabel: 'ESPN published NBA schedule', warnings,
  });
}

async function publicEspnJson(url: string, limit: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  } catch { throw new Error('ESPN could not be reached. Try again or upload a schedule CSV/TSV.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error('ESPN could not provide the NBA schedule. Try again or upload a schedule CSV/TSV.'); }
  if (Number(response.headers.get('content-length')) > limit || !response.body) { await response.body?.cancel(); throw new Error('The NBA schedule response is incomplete or unexpectedly large.'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('The NBA schedule response is unexpectedly large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('ESPN returned an unreadable NBA schedule. Upload a CSV/TSV or try again.'); }
}

/** Fixed public ESPN origin only: no league cookies, caller-supplied URLs or redirects. */
export async function fetchDraftAdvisorSchedule(options: { seasonId: number; scope?: 'week' | 'season'; startDate?: string }): Promise<DraftAdvisorSchedule> {
  if (!Number.isInteger(options.seasonId) || options.seasonId < 2001 || options.seasonId > 2100) throw new Error('Select a valid NBA season ending year.');
  if (options.scope === 'season' && options.startDate !== undefined) throw new Error('A full-season schedule does not accept a single-week start date.');
  if (options.startDate) validateDraftScheduleWindow(options.seasonId, options.startDate);
  const [payload, rawSeason] = await Promise.all([
    publicEspnJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${options.seasonId}?view=proTeamSchedules_wl`, 8_000_000),
    options.scope === 'season' ? publicEspnJson(`https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/${options.seasonId}/types/2`, 100_000) : Promise.resolve(null),
  ]);
  return parseEspnDraftSchedule(payload, { ...options, ...(options.scope === 'season' ? { regularSeason: parseEspnRegularSeason(rawSeason, options.seasonId) } : {}) });
}
