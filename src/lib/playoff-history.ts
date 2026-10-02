export type FranchiseMap = Readonly<Record<string, string>>;
export type PlayoffSourceKind = 'espn-local-json' | 'espn-browser-export' | 'espn-server-sync';
export interface PlayoffProvenance {
  leagueId: number;
  sourceSha256: string;
  sourceKind?: PlayoffSourceKind;
  sourceUrl?: string;
  capturedAt?: string;
}
export interface PlayoffSeason {
  draftYear: number;
  espnSeasonId: number;
  priorSeasonStartYear: number;
  playoffTeamCount: 4;
  firstChampionshipMatchupPeriod: number;
  participants: { espnTeamId: number; franchiseId: string; qualified: boolean; regularSeasonWins?: number }[];
  qualifiedFranchiseIds: string[];
  championFranchiseId?: string;
  additionalSourceEvidence?: { kind: PlayoffSourceKind; leagueId: number; sha256: string; url?: string; capturedAt?: string; paths: string[] }[];
  source: {
    kind: PlayoffSourceKind;
    leagueId: number; sha256: string; url?: string; capturedAt?: string;
    method: 'first-complete-winners-bracket';
    paths: string[];
    matchups: { id: number; homeEspnTeamId: number; awayEspnTeamId: number; winnerEspnTeamId?: number; homePoints?: number; awayPoints?: number }[];
    championship?: { id: number; matchupPeriod: number; homeEspnTeamId: number; awayEspnTeamId: number; winnerEspnTeamId: number; method?: 'score-and-final-rank'; homePoints?: number; awayPoints?: number; homeFinalRank?: number; awayFinalRank?: number };
  };
}
export interface StatisticsOnlySeason {
  draftYear: number; espnSeasonId: number; priorSeasonStartYear: number;
  qualificationStatus: 'unverified';
  participants: { espnTeamId: number; franchiseId: string; regularSeasonWins?: number }[];
  source: { kind: PlayoffSourceKind; leagueId: number; sha256: string; url?: string; capturedAt?: string; paths: string[] };
}
export interface PlayoffHistory { version: 1; leagueId: number; seasons: PlayoffSeason[]; statsOnlySeasons?: StatisticsOnlySeason[] }
export interface OriginalDraftOrder { season: number; franchiseId: string; position: number }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
function year(value: unknown): number {
  const result = integer(value, 'ESPN seasonId');
  if (result < 2000 || result > 2100) throw new Error('ESPN seasonId is outside the supported year range.');
  return result;
}
function unique<T>(values: T[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}; reconcile the source before importing.`);
}
function numericId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be a canonical numeric franchise ID.`);
  return value;
}
function sourceUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Source URL is invalid.'); }
  if (url.protocol !== 'https:' || !['fantasy.espn.com', 'lm-api-reads.fantasy.espn.com'].includes(url.hostname) || url.username || url.password || url.hash || url.port) throw new Error('Source URL must be an HTTPS ESPN URL without credentials or fragments.');
  const views = new Set(['mMatchup', 'mMatchupScore', 'mTeam', 'mSettings', 'mStandings']);
  for (const [key, content] of url.searchParams) {
    if (key === 'view' && views.has(content)) continue;
    if (['seasonId', 'leagueId'].includes(key) && /^[1-9]\d*$/.test(content)) continue;
    throw new Error('Source URL contains an unsupported query parameter; review provenance before publication.');
  }
  return url.href;
}
function wins(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Recorded regular-season wins must be a non-negative integer.');
  return value;
}
function declaredWinner(matchup: Record<string, unknown>): number | undefined {
  const side = matchup.winner === 'HOME' ? matchup.home : matchup.winner === 'AWAY' ? matchup.away : undefined;
  return side ? integer(record(side, 'Winning side').teamId, 'Winning ESPN team ID') : undefined;
}
function scoreWinner(homeId: number, awayId: number, homePoints: unknown, awayPoints: unknown) {
  if (typeof homePoints !== 'number' || typeof awayPoints !== 'number' || !Number.isFinite(homePoints) || !Number.isFinite(awayPoints) || homePoints <= 0 || awayPoints <= 0 || homePoints === awayPoints) return undefined;
  return { homePoints, awayPoints, winnerEspnTeamId: homePoints > awayPoints ? homeId : awayId };
}
function legacyScoreWinner(matchup: Record<string, unknown>) {
  const home = record(matchup.home, 'Home side'), away = record(matchup.away, 'Away side');
  const score = scoreWinner(integer(home.teamId, 'Home ESPN team ID'), integer(away.teamId, 'Away ESPN team ID'), home.totalPoints, away.totalPoints);
  if (!score) return undefined;
  const declared = declaredWinner(matchup);
  if (declared === undefined ? matchup.winner !== 'TIE' : declared !== score.winnerEspnTeamId) return undefined;
  return score;
}
function timestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Source capture time must be an ISO timestamp.');
  return new Date(value).toISOString();
}
function verifiedSourceUrl(value: string | undefined, seasonId: number, leagueId: number) {
  const url = sourceUrl(value);
  if (url) {
    const parsed = new URL(url), route = /\/seasons\/(\d+)\/segments\/\d+\/leagues\/(\d+)\/?$/.exec(parsed.pathname), history = /\/leagueHistory\/(\d+)\/?$/.exec(parsed.pathname);
    if (!route && !history) throw new Error('Source URL must identify a recognized ESPN league-season endpoint.');
    if ((route && (Number(route[1]) !== seasonId || Number(route[2]) !== leagueId)) || (history && Number(history[1]) !== leagueId) || (parsed.searchParams.has('seasonId') && Number(parsed.searchParams.get('seasonId')) !== seasonId) || (parsed.searchParams.has('leagueId') && Number(parsed.searchParams.get('leagueId')) !== leagueId)) throw new Error('Source URL year or league conflicts with the actual ESPN payload.');
  }
  return url;
}

/** Preserve observed category results when a source cannot establish playoff qualification. */
export function extractSeasonStatistics(raw: unknown, mapping: FranchiseMap, provenance: PlayoffProvenance): StatisticsOnlySeason {
  const payload = record(raw, 'ESPN season'), leagueId = integer(payload.id, 'ESPN league ID'), seasonId = year(payload.seasonId);
  if (leagueId !== provenance.leagueId || !/^[a-f0-9]{64}$/i.test(provenance.sourceSha256)) throw new Error('Observed season statistics require a matching league and source hash.');
  integer(record(record(payload.settings, 'ESPN settings').scheduleSettings, 'ESPN schedule settings').playoffTeamCount, 'Recorded playoff-team setting');
  if (!Array.isArray(payload.teams) || payload.teams.length < 2) throw new Error('Observed season statistics need a complete participant list.');
  const paths = ['id', 'seasonId', 'teams[].id'];
  const participants: StatisticsOnlySeason['participants'] = payload.teams.map((value, index) => {
    const team = record(value, 'ESPN team'), espnTeamId = integer(team.id, 'ESPN team ID');
    const result: StatisticsOnlySeason['participants'][number] = { espnTeamId, franchiseId: numericId(mapping[String(espnTeamId)], 'Mapped franchise ID') };
    const overall = team.record && typeof team.record === 'object' ? (team.record as Record<string, unknown>).overall : undefined;
    if (overall && typeof overall === 'object' && 'wins' in overall) { result.regularSeasonWins = wins((overall as Record<string, unknown>).wins); paths.push(`teams[${index}].record.overall.wins`); }
    return result;
  }).sort((a, b) => a.espnTeamId - b.espnTeamId);
  unique(participants.map(team => team.espnTeamId), 'ESPN participant'); unique(participants.map(team => team.franchiseId), 'mapped franchise');
  const url = verifiedSourceUrl(provenance.sourceUrl, seasonId, leagueId), capturedAt = timestamp(provenance.capturedAt);
  return { draftYear: seasonId, espnSeasonId: seasonId, priorSeasonStartYear: seasonId - 1, qualificationStatus: 'unverified', participants,
    source: { kind: provenance.sourceKind || 'espn-local-json', leagueId, sha256: provenance.sourceSha256.toLowerCase(), ...(url ? { url } : {}), ...(capturedAt ? { capturedAt } : {}), paths } };
}

/** The payload's ending year feeds the draft in that same calendar year. */
export function extractPlayoffSeason(raw: unknown, mapping: FranchiseMap, provenance: PlayoffProvenance): PlayoffSeason {
  const payload = record(raw, 'ESPN season');
  const leagueId = integer(payload.id, 'ESPN league ID');
  if (leagueId !== provenance.leagueId) throw new Error('ESPN payload league ID does not match the expected league.');
  const seasonId = year(payload.seasonId);
  if (!/^[a-f0-9]{64}$/i.test(provenance.sourceSha256)) throw new Error('A source-file SHA256 hash is required.');
  const settings = record(record(payload.settings, 'ESPN settings').scheduleSettings, 'ESPN schedule settings');
  if (settings.playoffTeamCount !== 4) throw new Error('Only a verified four-team championship bracket is supported; this format needs review.');
  if (!Array.isArray(payload.teams) || payload.teams.length < 4) throw new Error('The complete season participant list is required.');
  const statPaths: string[] = [];
  const participants: PlayoffSeason['participants'] = payload.teams.map((value, index) => {
    const team = record(value, 'ESPN team');
    const teamId = integer(team.id, 'ESPN team ID');
    const franchiseId = numericId(mapping[String(teamId)], `Mapping for ESPN team ${teamId}`);
    const result: PlayoffSeason['participants'][number] = { espnTeamId: teamId, franchiseId, qualified: false };
    const overall = team.record && typeof team.record === 'object' ? (team.record as Record<string, unknown>).overall : undefined;
    if (overall && typeof overall === 'object' && 'wins' in overall) {
      result.regularSeasonWins = wins((overall as Record<string, unknown>).wins);
      statPaths.push(`teams[${index}].record.overall.wins`);
    }
    return result;
  }).sort((a, b) => a.espnTeamId - b.espnTeamId);
  unique(participants.map(team => team.espnTeamId), 'ESPN participant');
  unique(participants.map(team => team.franchiseId), 'mapped franchise');
  if (!Array.isArray(payload.schedule)) throw new Error('A championship schedule is required.');
  const championship = payload.schedule.flatMap((value, index) => {
    const matchup = record(value, 'ESPN matchup');
    if (matchup.playoffTierType !== 'WINNERS_BRACKET') return [];
    return [{ index, matchup, period: integer(matchup.matchupPeriodId, 'Championship matchup period') }];
  });
  if (championship.length === 0) throw new Error('No championship bracket is recorded; standings and final ranks cannot substitute for it.');
  const firstPeriod = Math.min(...championship.map(matchup => matchup.period));
  const firstRound = championship.filter(matchup => matchup.period === firstPeriod);
  if (firstRound.length !== 2) throw new Error('The first championship round must have exactly two complete games; byes or unusual formats need review.');
  const matchups: PlayoffSeason['source']['matchups'] = firstRound.map(({ matchup }) => ({
    id: integer(matchup.id, 'Championship matchup ID'),
    homeEspnTeamId: integer(record(matchup.home, 'Home side').teamId, 'Home ESPN team ID'),
    awayEspnTeamId: integer(record(matchup.away, 'Away side').teamId, 'Away ESPN team ID'),
    ...(declaredWinner(matchup) !== undefined ? { winnerEspnTeamId: declaredWinner(matchup) } : {}),
  }));
  unique(matchups.map(matchup => matchup.id), 'championship matchup');
  const qualifiers = matchups.flatMap(matchup => [matchup.homeEspnTeamId, matchup.awayEspnTeamId]);
  unique(qualifiers, 'first-round championship participant');
  if (qualifiers.length !== 4 || qualifiers.some(id => !participants.some(team => team.espnTeamId === id))) throw new Error('Championship participants must be four known, distinct season teams.');
  participants.forEach(team => { team.qualified = qualifiers.includes(team.espnTeamId); });
  const result: PlayoffSeason = {
    draftYear: seasonId, espnSeasonId: seasonId, priorSeasonStartYear: seasonId - 1,
    playoffTeamCount: 4, firstChampionshipMatchupPeriod: firstPeriod, participants,
    qualifiedFranchiseIds: participants.filter(team => team.qualified).map(team => team.franchiseId).sort((a, b) => Number(a) - Number(b)),
    source: {
      kind: provenance.sourceKind || 'espn-local-json', leagueId, sha256: provenance.sourceSha256.toLowerCase(),
      method: 'first-complete-winners-bracket',
      paths: ['id', 'seasonId', 'settings.scheduleSettings.playoffTeamCount', 'teams[].id', ...statPaths, ...firstRound.map(({ index }) => `schedule[${index}].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}`)],
      matchups: matchups.sort((a, b) => a.id - b.id),
    },
  };
  const finalists = matchups.flatMap(matchup => matchup.winnerEspnTeamId === undefined ? [] : [matchup.winnerEspnTeamId]);
  if (finalists.length === 2 && new Set(finalists).size === 2) {
    const finals = championship.filter(({ matchup, period }) => {
      if (period <= firstPeriod) return false;
      const home = matchup.home && typeof matchup.home === 'object' ? (matchup.home as Record<string, unknown>).teamId : undefined;
      const away = matchup.away && typeof matchup.away === 'object' ? (matchup.away as Record<string, unknown>).teamId : undefined;
      return typeof home === 'number' && typeof away === 'number' && home !== away && finalists.includes(home) && finalists.includes(away);
    });
    if (finals.length === 1) {
      const final = finals[0], winner = declaredWinner(final.matchup);
      if (winner !== undefined) {
        result.championFranchiseId = participants.find(team => team.espnTeamId === winner)!.franchiseId;
        result.source.championship = { id: integer(final.matchup.id, 'Final matchup ID'), matchupPeriod: final.period, homeEspnTeamId: integer(record(final.matchup.home, 'Final home side').teamId, 'Final home team'), awayEspnTeamId: integer(record(final.matchup.away, 'Final away side').teamId, 'Final away team'), winnerEspnTeamId: winner };
        result.source.paths.push(`schedule[${final.index}].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner}`);
      }
    }
  }
  // Some legacy ESPN seasons label completed 5–4 category games TIE. Require a
  // complete score-based bracket AND official final ranks; scores alone are insufficient.
  if (!result.championFranchiseId) {
    const scoredSemis = firstRound.map(({ matchup }) => legacyScoreWinner(matchup));
    const scoredFinalists = scoredSemis.flatMap(game => game ? [game.winnerEspnTeamId] : []);
    const later = championship.filter(game => game.period > firstPeriod);
    const ranks = payload.teams.map(value => { const team = record(value, 'ESPN team'); return { id: team.id, rank: team.rankCalculatedFinal }; });
    const completeRanks = ranks.every(team => typeof team.rank === 'number' && Number.isSafeInteger(team.rank) && team.rank >= 1 && team.rank <= ranks.length) && new Set(ranks.map(team => team.rank)).size === ranks.length;
    if (scoredFinalists.length === 2 && new Set(scoredFinalists).size === 2 && later.length === 1 && completeRanks) {
      const final = later[0], home = record(final.matchup.home, 'Final home side'), away = record(final.matchup.away, 'Final away side');
      const homeId = integer(home.teamId, 'Final home team'), awayId = integer(away.teamId, 'Final away team');
      const score = legacyScoreWinner(final.matchup), homeRank = ranks.find(team => team.id === homeId)?.rank, awayRank = ranks.find(team => team.id === awayId)?.rank;
      if (score && homeId !== awayId && scoredFinalists.includes(homeId) && scoredFinalists.includes(awayId) && [homeRank, awayRank].includes(1) && [homeRank, awayRank].includes(2) && ranks.find(team => team.id === score.winnerEspnTeamId)?.rank === 1) {
        result.championFranchiseId = participants.find(team => team.espnTeamId === score.winnerEspnTeamId)!.franchiseId;
        result.source.championship = { id: integer(final.matchup.id, 'Final matchup ID'), matchupPeriod: final.period, homeEspnTeamId: homeId, awayEspnTeamId: awayId, ...score, method: 'score-and-final-rank', homeFinalRank: homeRank as number, awayFinalRank: awayRank as number };
        firstRound.forEach(({ matchup, index }, i) => {
          Object.assign(result.source.matchups.find(game => game.id === matchup.id)!, scoredSemis[i]);
          result.source.paths.push(`schedule[${index}].{home.totalPoints,away.totalPoints}`);
        });
        result.source.paths.push(`schedule[${final.index}].{id,matchupPeriodId,playoffTierType,home.teamId,away.teamId,winner,home.totalPoints,away.totalPoints}`, 'teams[].rankCalculatedFinal');
      }
    }
  }
  const url = verifiedSourceUrl(provenance.sourceUrl, seasonId, leagueId), capturedAt = timestamp(provenance.capturedAt);
  if (url) result.source.url = url;
  if (capturedAt) result.source.capturedAt = capturedAt;
  return result;
}

/** Validate the sanitized record too, so manually changed JSON cannot silently alter qualification. */
export function validatePlayoffSeason(season: PlayoffSeason): void {
  year(season.espnSeasonId);
  if (season.draftYear !== season.espnSeasonId || season.priorSeasonStartYear !== season.espnSeasonId - 1) throw new Error('Playoff season and draft-year alignment is invalid.');
  if (season.playoffTeamCount !== 4 || !Array.isArray(season.participants) || season.participants.length < 4) throw new Error('Playoff participant coverage is incomplete.');
  integer(season.firstChampionshipMatchupPeriod, 'First championship period');
  season.participants.forEach(team => { integer(team.espnTeamId, 'ESPN team ID'); numericId(team.franchiseId, 'Franchise ID'); if (typeof team.qualified !== 'boolean') throw new Error('Qualification must be explicitly true or false.'); if (team.regularSeasonWins !== undefined) wins(team.regularSeasonWins); });
  unique(season.participants.map(team => team.espnTeamId), 'ESPN participant');
  unique(season.participants.map(team => team.franchiseId), 'mapped franchise');
  const ids = season.participants.filter(team => team.qualified).map(team => team.franchiseId).sort();
  if (ids.length !== 4 || !Array.isArray(season.qualifiedFranchiseIds) || JSON.stringify(ids) !== JSON.stringify([...season.qualifiedFranchiseIds].sort())) throw new Error('Qualified franchise IDs disagree with the four participant flags.');
  if (season.source?.method !== 'first-complete-winners-bracket' || !/^[a-f0-9]{64}$/i.test(season.source.sha256)) throw new Error('Verified championship-source provenance is required.');
  integer(season.source.leagueId, 'Source league ID');
  sourceUrl(season.source.url); timestamp(season.source.capturedAt);
  for (const evidence of season.additionalSourceEvidence || []) {
    if (evidence.leagueId !== season.source.leagueId || !/^[a-f0-9]{64}$/i.test(evidence.sha256)) throw new Error('Corroborating source provenance is invalid.');
    sourceUrl(evidence.url); timestamp(evidence.capturedAt);
  }
  if (!Array.isArray(season.source.matchups) || season.source.matchups.length !== 2) throw new Error('Two source championship matchups are required.');
  unique(season.source.matchups.map(matchup => integer(matchup.id, 'Source matchup ID')), 'source matchup');
  const bracketIds = season.source.matchups.flatMap(matchup => [integer(matchup.homeEspnTeamId, 'Source home team'), integer(matchup.awayEspnTeamId, 'Source away team')]);
  unique(bracketIds, 'source championship participant');
  const flaggedIds = season.participants.filter(team => team.qualified).map(team => team.espnTeamId).sort((a, b) => a - b);
  if (JSON.stringify([...bracketIds].sort((a, b) => a - b)) !== JSON.stringify(flaggedIds)) throw new Error('Qualification flags do not match the recorded championship participants.');
  for (const matchup of season.source.matchups) if (matchup.winnerEspnTeamId !== undefined && ![matchup.homeEspnTeamId, matchup.awayEspnTeamId].includes(matchup.winnerEspnTeamId)) throw new Error('A semifinal winner must be a participant in that semifinal.');
  if (season.championFranchiseId !== undefined || season.source.championship !== undefined) {
    const final = season.source.championship;
    const finalists = season.source.matchups.map(matchup => matchup.winnerEspnTeamId);
    if (!final || finalists.some(id => id === undefined) || final.matchupPeriod <= season.firstChampionshipMatchupPeriod || final.homeEspnTeamId === final.awayEspnTeamId || !finalists.includes(final.homeEspnTeamId) || !finalists.includes(final.awayEspnTeamId) || ![final.homeEspnTeamId, final.awayEspnTeamId].includes(final.winnerEspnTeamId) || season.participants.find(team => team.espnTeamId === final.winnerEspnTeamId)?.franchiseId !== season.championFranchiseId) throw new Error('Champion must be proven by the final between the two recorded semifinal winners.');
    if (final.method !== undefined && final.method !== 'score-and-final-rank') throw new Error('Unknown championship proof method.');
    if (final.method === 'score-and-final-rank') {
      for (const game of [...season.source.matchups, final]) {
        const score = scoreWinner(game.homeEspnTeamId, game.awayEspnTeamId, game.homePoints, game.awayPoints);
        if (!score || score.winnerEspnTeamId !== game.winnerEspnTeamId) throw new Error('Legacy championship proof needs positive, unequal scores matching every bracket winner.');
      }
      if (![final.homeFinalRank, final.awayFinalRank].includes(1) || ![final.homeFinalRank, final.awayFinalRank].includes(2) || (final.winnerEspnTeamId === final.homeEspnTeamId ? final.homeFinalRank : final.awayFinalRank) !== 1) throw new Error('Legacy championship scores must agree with official first and second place.');
    } else if ([final.homePoints, final.awayPoints, final.homeFinalRank, final.awayFinalRank, ...season.source.matchups.flatMap(game => [game.homePoints, game.awayPoints])].some(value => value !== undefined)) throw new Error('Score evidence must declare its championship proof method.');
  }
  if (!season.source.championship && season.source.matchups.some(game => game.homePoints !== undefined || game.awayPoints !== undefined)) throw new Error('Score evidence requires a complete championship proof.');
}

/** Counts are for covered years only. Missing years always suppress an overall winner. */
export function calculateLuckbox(orders: readonly OriginalDraftOrder[], seasons: readonly PlayoffSeason[], requestedDraftYears?: readonly number[]) {
  unique(seasons.map(season => season.draftYear), 'playoff season');
  seasons.forEach(validatePlayoffSeason);
  if (new Set(seasons.map(season => season.source.leagueId)).size > 1) throw new Error('Playoff seasons from different leagues cannot be combined.');
  unique(orders.map(order => `${order.season}:${order.franchiseId}`), 'draft franchise');
  unique(orders.map(order => `${order.season}:${order.position}`), 'draft position');
  for (const order of orders) { year(order.season); numericId(order.franchiseId, 'Draft franchise'); integer(order.position, 'Original draft position'); }
  const requested = requestedDraftYears ? [...requestedDraftYears] : [...new Set(orders.map(order => order.season))];
  unique(requested, 'requested draft year'); requested.forEach(year); requested.sort((a, b) => a - b);
  const coveredDraftYears: number[] = [], missingDraftYears: number[] = [];
  const missing: { draftYear: number; reason: 'playoff-qualification' | 'draft-order' }[] = [];
  const evidence: { draftYear: number; franchiseId: string; position: number; qualified: boolean; countsForAward: boolean; qualificationSourceSha256: string }[] = [];
  const counts = new Map<string, { franchiseId: string; value: number; seasons: number[] }>();
  for (const draftYear of requested) {
    const qualification = seasons.find(season => season.draftYear === draftYear);
    const entries = orders.filter(order => order.season === draftYear);
    if (!qualification || entries.length === 0) {
      missingDraftYears.push(draftYear); missing.push({ draftYear, reason: !qualification ? 'playoff-qualification' : 'draft-order' }); continue;
    }
    const participants = qualification.participants.map(team => team.franchiseId).sort();
    const actual = entries.map(order => order.franchiseId).sort();
    if (JSON.stringify(participants) !== JSON.stringify(actual) || entries.some(order => order.position > entries.length)) throw new Error(`The ${draftYear} original draft order must cover every verified participant exactly once.`);
    coveredDraftYears.push(draftYear);
    for (const order of entries) {
      const qualified = qualification.qualifiedFranchiseIds.includes(order.franchiseId);
      const countsForAward = qualified && order.position <= 4;
      const count = counts.get(order.franchiseId) || { franchiseId: order.franchiseId, value: 0, seasons: [] };
      if (countsForAward) { count.value++; count.seasons.push(draftYear); }
      counts.set(order.franchiseId, count);
      evidence.push({ draftYear, franchiseId: order.franchiseId, position: order.position, qualified, countsForAward, qualificationSourceSha256: qualification.source.sha256 });
    }
  }
  const status = requested.length > 0 && missingDraftYears.length === 0 ? 'available' as const : 'insufficient-data' as const;
  const coveredCounts = [...counts.values()].sort((a, b) => b.value - a.value || Number(a.franchiseId) - Number(b.franchiseId));
  const maximum = coveredCounts[0]?.value || 0;
  return {
    status, requestedDraftYears: requested, coveredDraftYears, missingDraftYears, missing,
    winners: status === 'available' && maximum > 0 ? coveredCounts.filter(count => count.value === maximum) : [],
    coveredCounts, evidence,
  };
}
