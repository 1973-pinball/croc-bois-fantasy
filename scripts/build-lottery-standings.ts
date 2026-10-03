import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import identities from '../data/identities.json';
import league from '../data/league.json';
import { extractLotteryStandings, type ReviewedLotteryManager } from '../src/lib/lottery-standings';

/** Commissioner-confirmed current labels, in regular-season last-to-first order (2026-10-03). */
export const reviewedManagers2026: ReviewedLotteryManager[] = [
  { espnTeamId: 3, managerLabel: 'Wyndham', espnFirstName: 'Wyndham' },
  { espnTeamId: 4, managerLabel: 'Sebastian', espnFirstName: 'Sebastian' },
  { espnTeamId: 5, managerLabel: 'Shane', espnFirstName: 'Shane' },
  { espnTeamId: 8, managerLabel: 'Alex', espnFirstName: 'Alex' },
  { espnTeamId: 1, managerLabel: 'Jon', espnFirstName: 'Jonathan' },
  { espnTeamId: 2, managerLabel: 'Arod', espnFirstName: 'Anthony' },
  { espnTeamId: 6, managerLabel: 'Amber', espnFirstName: 'Amber' },
  { espnTeamId: 7, managerLabel: 'James', espnFirstName: 'James' },
];

/** Publishes only verified standings and source references; never changes database history or draft order. */
export async function buildLotteryStandings(inputDirectory = '.local/lottery-verification', outputFile = 'data/lottery-standings.json') {
  if (league.season !== 2026) throw new Error('Review the current manager labels for this draft year before rebuilding lottery inputs.');
  async function readSource(season: number) {
    const raw = await readFile(path.join(inputDirectory, `espn-${season}.json`));
    const source = JSON.parse(await readFile(path.join(inputDirectory, `espn-${season}.source.json`), 'utf8'));
    if (createHash('sha256').update(raw).digest('hex') !== source.sha256) throw new Error('Lottery standings source hash mismatch.');
    return { raw: JSON.parse(raw.toString('utf8')), source };
  }
  const prior = await readSource(league.season);
  const currentSeason = await readSource(league.season + 1);
  const mapping = identities.franchises as Record<string, string>;
  if (Object.keys(mapping).length !== league.teams.length) throw new Error('Current identity map and participants disagree.');
  const standings = extractLotteryStandings(prior.raw, prior.source, {
    leagueId: 139935, draftYear: league.season,
    currentParticipants: league.teams.map(team => ({ espnTeamId: team.id, franchiseId: mapping[String(team.id)] })),
    reviewedManagers: reviewedManagers2026, currentSeason,
  });
  if (JSON.stringify([...standings.standings].reverse().map(team => team.espnTeamId)) !== JSON.stringify(reviewedManagers2026.map(manager => manager.espnTeamId))) throw new Error('Regular-season order does not match the commissioner-reviewed last-to-first manager list.');
  await writeFile(outputFile, `${JSON.stringify(standings, null, 2)}\n`);
  return { draftYear: standings.draftYear, participants: standings.standings.length, playoffQualifiers: standings.standings.filter(team => team.playoffQualified).length, sha256: standings.source.sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLotteryStandings(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify(result)), error => { console.error(error instanceof Error ? error.message : 'Lottery standings extraction failed.'); process.exitCode = 1; });
}
