/* Croc Bois league history for Luckbox and overview podiums: paste this entire file into the browser console
 * on https://fantasy.espn.com while signed in to ESPN. It downloads a local
 * JSON file containing only championship-bracket, team-label, and recorded
 * win/loss/tie and final-rank fields.
 * It does not send the export to another service or include account fields.
 */
(async () => {
  'use strict';

  if (window.location.protocol !== 'https:' || window.location.hostname !== 'fantasy.espn.com') {
    throw new Error('Open the signed-in Croc Bois league on https://fantasy.espn.com before running this script.');
  }

  const leagueId = 139935;
  const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const apiOrigin = 'https://lm-api-reads.fantasy.espn.com';
  const views = ['mTeam', 'mSettings', 'mMatchupScore', 'mMatchup'];
  const envelope = { source: 'espn-browser-export', leagueId, exportedAt: new Date().toISOString(), seasons: [], failures: [] };

  class ExportFailure extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
  const label = value => typeof value === 'string' && value.trim() ? value.trim() : null;

  function endpoint(seasonId, history = false) {
    const url = new URL(history
      ? `/apis/v3/games/fba/leagueHistory/${leagueId}`
      : `/apis/v3/games/fba/seasons/${seasonId}/segments/0/leagues/${leagueId}`, apiOrigin);
    if (history) url.searchParams.set('seasonId', String(seasonId));
    for (const view of views) url.searchParams.append('view', view);
    return url;
  }

  async function fetchYear(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url.toString(), {
        method: 'GET', credentials: 'include', mode: 'cors', cache: 'no-store',
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        const explanation = response.status === 401 || response.status === 403
          ? 'ESPN did not authorize this request. Sign in normally and verify that this account can open the league.'
          : response.status === 404
            ? 'ESPN did not provide this season at this endpoint.'
            : response.status === 429
              ? 'ESPN rate-limited this request. Try again later.'
              : `ESPN returned HTTP ${response.status}.`;
        throw new ExportFailure(response.status, explanation);
      }
      const fetchedAt = new Date().toISOString();
      let payload;
      try { payload = await response.json(); }
      catch { throw new ExportFailure(response.status, 'ESPN returned a response that was not valid JSON.'); }
      return { payload, fetchedAt, url: url.toString() };
    } catch (error) {
      if (error instanceof ExportFailure) throw error;
      throw new ExportFailure(0, controller.signal.aborted
        ? 'The ESPN request timed out after 25 seconds.'
        : 'The browser could not read the ESPN response. This may be a network, cross-origin, or sign-in redirect restriction.');
    } finally { clearTimeout(timeout); }
  }

  function sanitizedSeason(result, seasonId) {
    const candidates = Array.isArray(result.payload) ? result.payload : [result.payload];
    const matches = candidates.filter(item => item && item.id === leagueId && item.seasonId === seasonId);
    if (matches.length !== 1) throw new ExportFailure(200, 'The response did not contain exactly one matching league and season. No season was inferred.');
    const raw = matches[0];
    const playoffTeamCount = raw.settings?.scheduleSettings?.playoffTeamCount;
    if (!positiveInteger(playoffTeamCount)) throw new ExportFailure(200, 'The season is missing a valid playoffTeamCount setting.');
    if (!Array.isArray(raw.teams) || raw.teams.length === 0) throw new ExportFailure(200, 'The season did not include its team list.');
    const teamIds = new Set();
    const teams = raw.teams.map(team => {
      if (!team || !positiveInteger(team.id) || teamIds.has(team.id)) throw new ExportFailure(200, 'The season contains a missing or duplicate team ID.');
      teamIds.add(team.id);
      // Older ESPN seasons use location/nickname for the fantasy team label.
      // Never use owners, primaryOwner, members, or account-profile names.
      const historicalName = [label(team.location), label(team.nickname)].filter(Boolean).join(' ');
      const exportedTeam = { id: team.id, name: label(team.name) || historicalName || null, abbrev: label(team.abbrev) };
      const overall = {};
      for (const stat of ['wins', 'losses', 'ties']) {
        const value = team.record?.overall?.[stat];
        if (Number.isFinite(value)) overall[stat] = value;
      }
      if (Object.keys(overall).length) exportedTeam.record = { overall };
      if (positiveInteger(team.playoffSeed)) exportedTeam.playoffSeed = team.playoffSeed;
      if (positiveInteger(team.rankCalculatedFinal)) exportedTeam.rankCalculatedFinal = team.rankCalculatedFinal;
      return exportedTeam;
    });
    if (playoffTeamCount > teams.length) throw new ExportFailure(200, 'The playoff count is larger than the supplied team list.');
    let schedule = [];
    let bracketFailure = null;
    try {
      if (!Array.isArray(raw.schedule)) throw new ExportFailure(200, 'The season did not include a schedule.');
      const winners = raw.schedule.filter(matchup => matchup?.playoffTierType === 'WINNERS_BRACKET');
      if (winners.length === 0) throw new ExportFailure(200, 'No WINNERS_BRACKET matchups were returned.');
      const matchupIds = new Set();
      schedule = winners.map(matchup => {
        if (!positiveInteger(matchup.id) || !positiveInteger(matchup.matchupPeriodId) || matchupIds.has(matchup.id)) throw new ExportFailure(200, 'A championship matchup has a missing or duplicate ID or matchup period.');
        matchupIds.add(matchup.id);
        const homeId = matchup.home?.teamId;
        const awayId = matchup.away?.teamId;
        if (!positiveInteger(homeId) || !positiveInteger(awayId) || homeId === awayId || !teamIds.has(homeId) || !teamIds.has(awayId)) throw new ExportFailure(200, 'A championship matchup has missing or inconsistent teams; byes or unusual brackets need manual review.');
        // Construct every object explicitly: no raw ESPN object is written to disk.
        const home = { teamId: homeId };
        const away = { teamId: awayId };
        if (Number.isFinite(matchup.home.totalPoints)) home.totalPoints = matchup.home.totalPoints;
        if (Number.isFinite(matchup.away.totalPoints)) away.totalPoints = matchup.away.totalPoints;
        const exportedMatchup = { id: matchup.id, matchupPeriodId: matchup.matchupPeriodId, playoffTierType: 'WINNERS_BRACKET', home, away };
        if (label(matchup.winner)) exportedMatchup.winner = label(matchup.winner);
        return exportedMatchup;
      });
    } catch (error) {
      if (!(error instanceof ExportFailure)) throw error;
      // Keep observed records even when no trustworthy bracket is available.
      // An empty schedule is missing evidence, not an assertion about qualifiers.
      schedule = [];
      bracketFailure = { seasonId, status: error.status, message: `${error.message} Observed team records were retained with an empty schedule; playoff qualifiers and champion need manual confirmation.` };
    }
    return {
      season: {
        id: leagueId, seasonId,
        settings: { scheduleSettings: { playoffTeamCount } }, teams, schedule,
        exportSource: { url: result.url, fetchedAt: result.fetchedAt },
      },
      bracketFailure,
    };
  }

  for (const seasonId of years) {
    try {
      let result;
      try { result = await fetchYear(endpoint(seasonId)); }
      catch (error) {
        // Historical route fallback is permitted only after a genuine HTTP 404.
        // A 401/403 is never retried through another route or authentication method.
        if (!(error instanceof ExportFailure) || error.status !== 404) throw error;
        result = await fetchYear(endpoint(seasonId, true));
      }
      const { season, bracketFailure } = sanitizedSeason(result, seasonId);
      envelope.seasons.push(season);
      if (bracketFailure) {
        envelope.failures.push(bracketFailure);
        console.warn(`Croc Bois: season ${seasonId} exported partially (${bracketFailure.status}): ${bracketFailure.message}`);
      } else {
        console.info(`Croc Bois: exported championship-bracket evidence for ESPN season ${seasonId}.`);
      }
    } catch (error) {
      const failure = { seasonId, status: error instanceof ExportFailure ? error.status : 0, message: error instanceof ExportFailure ? error.message : 'The season could not be safely extracted.' };
      envelope.failures.push(failure);
      console.warn(`Croc Bois: season ${seasonId} failed (${failure.status}): ${failure.message}`);
    }
  }

  const blob = new Blob([JSON.stringify(envelope, null, 2) + '\n'], { type: 'application/json' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = 'croc-bois-playoff-history.json';
  link.textContent = `Download Croc Bois playoff history (${envelope.seasons.length}/${years.length} seasons)`;
  Object.assign(link.style, { position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647', padding: '14px 18px', borderRadius: '8px', background: '#193c32', color: '#fffefa', font: '14px sans-serif', boxShadow: '0 2px 12px #0005' });
  document.body.appendChild(link);
  link.click();
  // Keep the blob link available until the tab closes so a blocked automatic
  // download can be started by clicking the visible link on this ESPN page.
  console.info(`Croc Bois export finished: ${envelope.seasons.length} seasons retained, ${envelope.failures.length} missing or partial seasons. Attach croc-bois-playoff-history.json. A download link is also visible on this page.`);
})();
