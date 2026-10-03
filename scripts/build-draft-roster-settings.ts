/** Read-only ESPN refresh: node --import tsx scripts/build-draft-roster-settings.ts --fetch
 *  Omit --fetch to rebuild the allowlisted artifacts from the ignored private captures.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { extractDraftRosterEligibility, extractDraftRosterSettings, extractEspnSlotDefinitions, verifyEspnUnlimitedPositionLimit, type EspnRosterSource } from '../src/lib/espn-roster-settings';

const directory = '.local/draft-roster-source';
const endpoint = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/139935';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function capture(name: string, url: string, headers: Record<string, string> = {}, filter?: unknown) {
  const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`ESPN ${name} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text.length || text.length > 30_000_000) throw new Error('Unexpected ESPN response size.');
  const source = { sha256: hash(text), url, capturedAt: new Date().toISOString(), ...(filter ? { filter } : {}) };
  await writeFile(`${directory}/${name}.raw`, text);
  await writeFile(`${directory}/${name}.source.json`, JSON.stringify(source, null, 2) + '\n');
  return text;
}

if (process.argv.includes('--fetch')) {
  await mkdir(directory, { recursive: true });
  const envFile = await readFile('.env.espn.local', 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  const env = { ...parseEnv(envFile.replace(/^\uFEFF/, '')), ...process.env };
  if (!env.ESPN_S2 || !(env.ESPN_SWID ?? env.SWID)) throw new Error('ESPN connection unavailable.');
  const headers = { Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID ?? env.SWID}`, Accept: 'application/json' };
  await capture('settings', `${endpoint}?view=mSettings&view=mRoster`, headers);
  const filter = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS', 'ONTEAM'] }, limit: 2000, offset: 0,
    sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'STANDARD' },
    filterStatsForTopScoringPeriodIds: { value: 5, additionalValue: ['002027', '102027', '002026', '012026'] } } };
  await capture('players', `${endpoint}?view=kona_player_info`, { ...headers, 'x-fantasy-filter': JSON.stringify(filter) }, filter);
  // Labels and the -1 No Limit sentinel come from ESPN's actual public UI code.
  // Download as text only; no fetched JavaScript is executed.
  const page = await capture('settings-page', 'https://fantasy.espn.com/basketball/league/settings?leagueId=139935&seasonId=2027');
  const scripts = [...page.matchAll(/<script[^>]*src=["']([^"']+)/g)].map(match => new URL(match[1], 'https://fantasy.espn.com'));
  const main = scripts.find(url => /\/static\/commons\/main-[^/]+\.js$/.test(url.pathname));
  const settings = scripts.find(url => url.pathname.endsWith('/page/basketball/league/settings.js'));
  if (!main || !settings || [main, settings].some(url => url.protocol !== 'https:' || url.hostname !== 'cdn1.espn.net' || !url.pathname.startsWith('/kona/'))) throw new Error('Expected official ESPN basketball client sources.');
  await capture('slots-client', main.href);
  await capture('settings-client', settings.href);
}

async function verified(name: string): Promise<{ text: string; source: EspnRosterSource }> {
  const text = await readFile(`${directory}/${name}.raw`, 'utf8');
  const metadata = JSON.parse(await readFile(`${directory}/${name}.source.json`, 'utf8')) as EspnRosterSource;
  if (metadata.sha256 !== hash(text)) throw new Error(`The ${name} capture does not match its recorded hash.`);
  return { text, source: { sha256: metadata.sha256, url: metadata.url, capturedAt: metadata.capturedAt } };
}
const [settingsRaw, playersRaw, slotsClient, settingsClient] = await Promise.all(['settings', 'players', 'slots-client', 'settings-client'].map(verified));
const definitions = extractEspnSlotDefinitions(slotsClient.text);
verifyEspnUnlimitedPositionLimit(settingsClient.text);
const settings = extractDraftRosterSettings(JSON.parse(settingsRaw.text), settingsRaw.source, definitions, slotsClient.source, settingsClient.source);
const eligibility = extractDraftRosterEligibility(JSON.parse(playersRaw.text), playersRaw.source);
const catalog = JSON.parse(await readFile('data/draft-player-catalog.json', 'utf8')) as { players: { id: number }[] };
const frozen = JSON.parse(await readFile('data/league.json', 'utf8')) as { players: { id: number }[] };
const ids = new Set(eligibility.players.map(player => player.id));
const missingCatalog = catalog.players.filter(player => !ids.has(player.id));
const missingFrozen = frozen.players.filter(player => !ids.has(player.id));
if (missingCatalog.length || missingFrozen.length) throw new Error(`ESPN eligibility is incomplete: ${missingCatalog.length} catalog players and ${missingFrozen.length} frozen roster players are missing. Preserve the previous artifacts until resolved.`);
await writeFile('data/draft-roster-settings.json', JSON.stringify(settings, null, 2) + '\n');
await writeFile('data/draft-roster-eligibility.json', JSON.stringify(eligibility, null, 2) + '\n');
console.log(JSON.stringify({ slots: settings.slots.map(slot => `${slot.label}:${slot.count}`), normalCapacity: settings.normalCapacity, reserveCapacity: settings.reserveCapacity,
  eligibilityPlayers: eligibility.players.length, coveredCatalog: catalog.players.length, coveredFrozenRoster: frozen.players.length, capturedAt: settings.source.capturedAt,
  settingsSha256: settings.source.sha256, eligibilitySha256: eligibility.source.sha256 }));
