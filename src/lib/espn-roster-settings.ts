export type EspnRosterSource = { sha256: string; url: string; capturedAt: string };
export type EspnSlotDefinition = { slotId: number; label: string; name: string; bench: boolean; reserve: boolean; lineupSlotEligible: boolean };
export type DraftRosterSettings = {
  version: 1; leagueId: number; espnSeasonId: number; source: EspnRosterSource;
  slotDefinitionsSource: EspnRosterSource; positionLimitsSource: EspnRosterSource;
  slots: { slotId: number; label: string; count: number; kind: 'normal' | 'reserve' }[];
  slotDefinitions: EspnSlotDefinition[];
  normalCapacity: number; reserveCapacity: number;
  lineupSlotCounts: Record<string, number>; positionLimits: Record<string, number>; isBenchUnlimited: boolean;
  primaryPositionLimits: { positionId: number; label: string; maximum: number | null }[];
  limitations: string[];
};
export type DraftRosterEligibility = {
  version: 1; leagueId: number; espnSeasonId: number; source: EspnRosterSource;
  players: { id: number; name: string; eligibleSlots: number[]; primaryPositionId: number | null; injuryStatus: string | null; active: boolean; poolStatus: string | null }[];
};

/** ESPN basketball abbreviations, verified against the official client constants by the builder. */
export const ESPN_LINEUP_SLOT_LABELS: Readonly<Record<number, string>> = {
  0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F',
  7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL', 12: 'BE', 13: 'IR', 14: 'INV', 15: 'ALL',
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an ESPN data object.');
  return value as Record<string, unknown>;
}
function integerMap(value: unknown, minimum: number): Record<string, number> {
  const entries = Object.entries(object(value));
  if (!entries.length || entries.some(([key, count]) => !/^(0|[1-9]\d*)$/.test(key) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < minimum)) throw new Error('Invalid ESPN numeric roster settings.');
  return Object.fromEntries(entries) as Record<string, number>;
}
function validateSource(source: EspnRosterSource) {
  const url = new URL(source.url);
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isFinite(Date.parse(source.capturedAt)) || url.protocol !== 'https:' || !['lm-api-reads.fantasy.espn.com', 'cdn1.espn.net'].includes(url.hostname) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'view')) throw new Error('Invalid ESPN source provenance.');
}
function sourceFields(source: EspnRosterSource): EspnRosterSource { return { sha256: source.sha256, url: source.url, capturedAt: source.capturedAt }; }

/** Parses facts from ESPN's literal basketball constants; never evaluates fetched JavaScript. */
export function extractEspnSlotDefinitions(client: string): EspnSlotDefinition[] {
  const constants = /e\.exports=(\[\{abbrev:"PG",active:true,bench:false,.*?\}\])/.exec(client)?.[1];
  if (!constants) throw new Error('ESPN basketball slot definitions were not found.');
  const rows = [...constants.matchAll(/\{([^{}]+)\}/g)].map(match => {
    const field = (name: string) => new RegExp(`(?:^|,)${name}:("[^"]*"|true|false|\\d+)(?:,|$)`).exec(match[1])?.[1];
    const string = (name: string) => { const value = field(name); if (!value?.startsWith('"')) throw new Error('Incomplete ESPN slot definition.'); return JSON.parse(value) as string; };
    const bool = (name: string) => { const value = field(name); if (!['true', 'false'].includes(value ?? '')) throw new Error('Incomplete ESPN slot definition.'); return value === 'true'; };
    const slotId = Number(field('id'));
    if (!Number.isSafeInteger(slotId)) throw new Error('Incomplete ESPN slot definition.');
    return { slotId, label: string('abbrev'), name: string('name'), bench: bool('bench'), reserve: bool('injuryRequired'), lineupSlotEligible: bool('lineupSlotEligible') };
  });
  if (rows.length !== 16 || new Set(rows.map(row => row.slotId)).size !== 16 || rows.some(row => ESPN_LINEUP_SLOT_LABELS[row.slotId] !== row.label)) throw new Error('ESPN basketball slot definitions changed; review their identifiers before rebuilding.');
  return rows;
}

export function verifyEspnUnlimitedPositionLimit(client: string): void {
  // ESPN's roster settings select adds its “No Limit” option with nt=-1.
  if (!client.includes('let et="rosterSettings.lineupSlotCounts";const tt=10;const nt=-1;')
    || !client.includes('title:i.formatMessage(ot.noLimit),value:nt')
    || !client.includes('rosterSettings.positionLimits')) throw new Error('ESPN position-limit sentinel requires source review.');
}

export function extractDraftRosterSettings(payload: unknown, source: EspnRosterSource, definitions: EspnSlotDefinition[], slotDefinitionsSource: EspnRosterSource, positionLimitsSource: EspnRosterSource): DraftRosterSettings {
  [source, slotDefinitionsSource, positionLimitsSource].forEach(validateSource);
  const data = object(payload);
  if (data.id !== 139935 || data.seasonId !== 2027) throw new Error('Expected ESPN league 139935, season 2027.');
  const roster = object(object(data.settings).rosterSettings);
  const lineupSlotCounts = integerMap(roster.lineupSlotCounts, 0);
  const positionLimits = integerMap(roster.positionLimits, -1);
  if (typeof roster.isBenchUnlimited !== 'boolean') throw new Error('Missing ESPN bench setting.');
  const slots = Object.entries(lineupSlotCounts).filter(([, count]) => count > 0).map(([id, count]) => {
    const definition = definitions.find(slot => slot.slotId === Number(id));
    if (!definition?.lineupSlotEligible) throw new Error('A configured ESPN slot is unknown or cannot hold a player.');
    return { slotId: definition.slotId, label: definition.label, count, kind: definition.reserve ? 'reserve' as const : 'normal' as const };
  }).sort((a, b) => a.slotId - b.slotId);
  if (!slots.length) throw new Error('The ESPN roster has no configured slots.');
  const primaryPositionLimits = [1, 2, 3, 4, 5].map(positionId => {
    const raw = positionLimits[String(positionId)];
    if (raw === undefined) throw new Error('Missing ESPN primary-position limit.');
    return { positionId, label: ESPN_LINEUP_SLOT_LABELS[positionId - 1], maximum: raw === -1 ? null : raw };
  });
  return { version: 1, leagueId: data.id, espnSeasonId: data.seasonId, source: sourceFields(source), slotDefinitionsSource: sourceFields(slotDefinitionsSource), positionLimitsSource: sourceFields(positionLimitsSource),
    slots, slotDefinitions: definitions, normalCapacity: slots.filter(slot => slot.kind === 'normal').reduce((sum, slot) => sum + slot.count, 0),
    reserveCapacity: slots.filter(slot => slot.kind === 'reserve').reduce((sum, slot) => sum + slot.count, 0),
    lineupSlotCounts, positionLimits, isBenchUnlimited: roster.isBenchUnlimited, primaryPositionLimits,
    limitations: [
      'Slot counts describe the configured ESPN lineup and bench layout. They are not primary-position roster maximums or a draft transaction validator.',
      'Position maximums apply to the ESPN primary position only. A null maximum is ESPN’s No Limit setting (-1 in the raw settings).',
      'The raw isBenchUnlimited setting is preserved without interpreting it as additional draft slots.',
      'IR is shown separately. eligibleSlots includes IR even for healthy players; IR eligibility also depends on ESPN’s current injury designation. No player is automatically placed on IR.',
      'Settings and player eligibility are dated ESPN captures. Rebuild from ESPN to reflect later changes.',
    ] };
}

export function extractDraftRosterEligibility(payload: unknown, source: EspnRosterSource): DraftRosterEligibility {
  validateSource(source);
  const url = new URL(source.url);
  if (url.hostname !== 'lm-api-reads.fantasy.espn.com' || !url.pathname.endsWith('/games/fba/seasons/2027/segments/0/leagues/139935') || !url.searchParams.getAll('view').includes('kona_player_info')) throw new Error('Expected the upcoming ESPN league player-pool source.');
  const data = object(payload);
  if (!Array.isArray(data.players) || data.players.length === 0 || data.players.length >= 2000) throw new Error('Missing or potentially truncated ESPN player pool.');
  const seen = new Set<number>();
  const players = data.players.map(raw => {
    const entry = object(raw), player = object(entry.player);
    if (typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id < 1 || player.id !== entry.id || seen.has(entry.id)) throw new Error('Invalid or duplicate ESPN player identity.');
    seen.add(entry.id);
    if (typeof player.fullName !== 'string' || !player.fullName.trim() || !Array.isArray(player.eligibleSlots)
      || !player.eligibleSlots.length || player.eligibleSlots.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || !(id in ESPN_LINEUP_SLOT_LABELS))
      || new Set(player.eligibleSlots).size !== player.eligibleSlots.length || typeof player.active !== 'boolean') throw new Error('Missing or unknown ESPN player slot eligibility.');
    if (player.defaultPositionId !== undefined && (!Number.isSafeInteger(player.defaultPositionId) || Number(player.defaultPositionId) < 1 || Number(player.defaultPositionId) > 5)) throw new Error('Invalid ESPN primary position.');
    if (player.injuryStatus !== undefined && typeof player.injuryStatus !== 'string') throw new Error('Invalid ESPN injury status.');
    if (entry.status !== undefined && typeof entry.status !== 'string') throw new Error('Invalid ESPN player-pool status.');
    return { id: entry.id, name: player.fullName.trim(), eligibleSlots: [...player.eligibleSlots] as number[],
      primaryPositionId: typeof player.defaultPositionId === 'number' ? player.defaultPositionId : null,
      injuryStatus: typeof player.injuryStatus === 'string' ? player.injuryStatus : null, active: player.active,
      poolStatus: typeof entry.status === 'string' ? entry.status : null };
  }).sort((a, b) => a.id - b.id);
  return { version: 1, leagueId: 139935, espnSeasonId: 2027, source: sourceFields(source), players };
}
