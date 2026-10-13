import { z } from 'zod';

const NBA_TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS'] as const;
const NBA_TEAM_SET = new Set<string>(NBA_TEAMS);
const ALIASES: Record<string, string> = { BRK: 'BKN', GS: 'GSW', NO: 'NOP', NOR: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX' };

/** All providers resolve to the abbreviations in the ESPN draft catalog. */
export function normalizeNbaTeam(value: string): string | null {
  const team = value.trim().toUpperCase();
  const result = ALIASES[team] ?? team;
  return NBA_TEAM_SET.has(result) ? result : null;
}

export function isDraftScheduleDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function draftScheduleEndDate(startDate: string): string {
  if (!isDraftScheduleDate(startDate)) throw new Error('Use a valid schedule date in YYYY-MM-DD format.');
  return new Date(Date.parse(`${startDate}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
}

export function validateDraftScheduleWindow(seasonId: number, startDate: string, endDate = draftScheduleEndDate(startDate)) {
  if (!Number.isInteger(seasonId) || seasonId < 2001 || seasonId > 2100) throw new Error('The NBA season must be its ending year.');
  if (!isDraftScheduleDate(startDate) || !isDraftScheduleDate(endDate) || draftScheduleEndDate(startDate) !== endDate) throw new Error('Select a consecutive seven-day schedule window.');
  if (startDate < `${seasonId - 1}-07-01` || endDate > `${seasonId}-06-30`) throw new Error('The schedule window is outside the selected NBA season.');
  return { seasonId, startDate, endDate };
}

const dateSchema = z.string().refine(isDraftScheduleDate, 'Use a valid calendar date.');
export const draftAdvisorScheduleSchema = z.object({
  seasonId: z.number().int().min(2001).max(2100),
  fetchedAt: z.iso.datetime(),
  startDate: dateSchema,
  endDate: dateSchema,
  games: z.array(z.object({ date: dateSchema, team: z.enum(NBA_TEAMS) })).min(1).max(210),
  sourceLabel: z.string().min(1).max(150),
  warnings: z.array(z.string().max(500)).max(20),
}).superRefine((schedule, context) => {
  try { validateDraftScheduleWindow(schedule.seasonId, schedule.startDate, schedule.endDate); }
  catch { context.addIssue({ code: 'custom', message: 'The schedule window is invalid.' }); }
  if (schedule.games.some(game => game.date < schedule.startDate || game.date > schedule.endDate)) context.addIssue({ code: 'custom', message: 'The schedule contains games outside its selected window.' });
  if (new Set(schedule.games.map(game => `${game.date}:${game.team}`)).size !== schedule.games.length) context.addIssue({ code: 'custom', message: 'The schedule repeats a team on the same date.' });
});

export type DraftAdvisorSchedule = z.infer<typeof draftAdvisorScheduleSchema>;
export type DraftScheduleImportOptions = { seasonId: number; startDate: string; endDate?: string; fetchedAt?: string };

function readTable(text: string): string[][] {
  if (text.length > 2_000_000) throw new Error('Schedule files must be smaller than 2 MB.');
  const input = text.replace(/^\uFEFF/, '');
  const delimiter = input.slice(0, input.search(/[\r\n]/) < 0 ? undefined : input.search(/[\r\n]/)).includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closedQuote = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (char === '"') {
      if (cell.trim() || closedQuote) throw new Error('The schedule contains malformed CSV quoting.');
      cell = ''; quoted = true;
    } else if (char === delimiter || char === '\n' || char === '\r') {
      row.push(cell.trim()); cell = ''; closedQuote = false;
      if (char !== delimiter) {
        if (row.some(value => value !== '')) rows.push(row);
        row = [];
        if (char === '\r' && input[index + 1] === '\n') index += 1;
      }
    } else {
      if (closedQuote && char.trim()) throw new Error('The schedule contains text after a quoted CSV value.');
      cell += char;
    }
  }
  if (quoted) throw new Error('The schedule contains an unclosed quoted value.');
  row.push(cell.trim());
  if (row.some(value => value !== '')) rows.push(row);
  if (rows.length < 2 || rows.length > 10_001) throw new Error('Include a header and between 1 and 10,000 schedule rows.');
  return rows;
}

/** One date/team row per scheduled team-game; a game therefore has two rows. */
export function parseDraftScheduleText(text: string, options: DraftScheduleImportOptions): DraftAdvisorSchedule {
  const window = validateDraftScheduleWindow(options.seasonId, options.startDate, options.endDate);
  const [rawHeaders, ...rows] = readTable(text);
  const headers = rawHeaders.map(value => value.toLowerCase().replace(/[\s_-]/g, ''));
  const dateIndexes = headers.flatMap((header, index) => ['date', 'gamedate'].includes(header) ? [index] : []);
  const teamIndexes = headers.flatMap((header, index) => ['team', 'nbateam', 'teamabbreviation', 'abbreviation'].includes(header) ? [index] : []);
  if (dateIndexes.length !== 1 || teamIndexes.length !== 1) throw new Error('Include exactly one date column (YYYY-MM-DD) and one team column (NBA abbreviation).');
  const seen = new Set<string>();
  const games: DraftAdvisorSchedule['games'] = [];
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) throw new Error(`Schedule row ${index + 2} has the wrong number of columns.`);
    const date = row[dateIndexes[0]], team = normalizeNbaTeam(row[teamIndexes[0]]);
    if (!isDraftScheduleDate(date)) throw new Error(`Schedule row ${index + 2} needs a valid date in YYYY-MM-DD format.`);
    if (date < `${options.seasonId - 1}-07-01` || date > `${options.seasonId}-06-30`) throw new Error(`Schedule row ${index + 2} belongs to another NBA season.`);
    if (!team) throw new Error(`Schedule row ${index + 2} has an unrecognized NBA team.`);
    const key = `${date}:${team}`;
    if (seen.has(key)) throw new Error(`Schedule row ${index + 2} repeats ${team} on ${date}.`);
    seen.add(key);
    if (date >= window.startDate && date <= window.endDate) games.push({ date, team: team as DraftAdvisorSchedule['games'][number]['team'] });
  }
  if (!games.length) throw new Error('The file has no games in the selected seven-day window. Choose another window or schedule file.');
  return draftAdvisorScheduleSchema.parse({
    ...window, fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    games: games.sort((a, b) => a.date.localeCompare(b.date) || a.team.localeCompare(b.team)),
    sourceLabel: 'Uploaded NBA schedule (CSV/TSV)',
    warnings: ['Upload a complete NBA schedule for this window: omitted teams and dates are treated as having no games. Uploaded fixtures are not independently verified.'],
  });
}
