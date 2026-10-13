import 'server-only';
import { createClient } from '@supabase/supabase-js';
import identities from '../../data/identities.json';
import fallback from '../../data/ai-league.json';
import { leagueData } from './league-data';
import { getSupabaseConfig } from './supabase/config';
import { validatedEspnCookies } from './espn-history-sync-core';
import { fetchAiLeagueFeed } from './ai-league-feed';
import { fetchAiOwnerSnapshot } from './ai-owner-source';
import { createAiLeagueRun, advanceAiLeagueRun } from './ai-league-engine';
import { easternDate, refreshDates } from './ai-league-refresh';
import { advanceLiveSingles, createLiveSingles, liveSingleRefreshDates } from './ai-live-single-engine';
import { fetchLiveSingleOwners, liveDraftEvidence } from './ai-live-single-source';
import type { AiLeagueRun, AiLeagueResponse, AiLeagueFeed } from './ai-league-types';

const FAILURE = 'The latest data refresh could not finish. Previously saved decisions and results have been retained.';
const OWNER_FAILURE = 'The latest actual-owner comparison could not be refreshed. Saved owner evidence is retained when available; missing comparisons are not treated as zero.';
function client(write = false) {
  const config = getSupabaseConfig(), key = write ? process.env.SUPABASE_SECRET_KEY : config?.key;
  if (!config || !key) return null;
  return createClient(config.url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) }) } });
}
export async function readAiLeague(): Promise<AiLeagueResponse> {
  const db = client();
  if (!db) return structuredClone(fallback) as AiLeagueResponse;
  const [runs, refresh] = await Promise.all([
    db.from('ai_league_runs').select('payload').eq('league_id', identities.leagueId).order('season', { ascending: false }),
    db.from('ai_league_refresh').select('attempted_at,error').eq('league_id', identities.leagueId).maybeSingle(),
  ]);
  if (runs.error || refresh.error) throw new Error('Saved simulation updates are temporarily unavailable.');
  return { runs: runs.data.map(row => row.payload as AiLeagueRun), refresh: { lastAttempt: refresh.data?.attempted_at ?? null, error: refresh.data?.error ?? null, automatic: Boolean(process.env.CRON_SECRET && process.env.SUPABASE_SECRET_KEY) } };
}

/** Only the authenticated cron and trusted maintenance CLI call this writer. */
export async function synchronizeAiLeague(options: { seasons?: number[]; maxDays?: number } = {}) {
  const db = client(true);
  if (!db) throw new Error('The existing league server connection is required.');
  const seasons = options.seasons ?? [2027, 2026], limit = options.maxDays ?? 3;
  if (seasons.some(s => s !== 2027 && s !== 2026) || new Set(seasons).size !== seasons.length || !Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error('Invalid simulation refresh request.');
  const now = new Date(), timestamp = now.toISOString(), today = easternDate(now);
  const connection = validatedEspnCookies(process.env.ESPN_S2, process.env.ESPN_SWID);
  const cookies = connection ? { espnS2: connection.s2, swid: connection.swid } : undefined;
  const teams = leagueData.teams.map(t => ({ id: String(t.id), name: t.name, shortName: t.shortName, color: t.color }));
  const saved: number[] = [], errors: number[] = [];
  for (const season of seasons) {
    try {
      const read = await db.from('ai_league_runs').select('payload,revision').eq('league_id', identities.leagueId).eq('season', season).maybeSingle();
      if (read.error) throw new Error('State unavailable');
      let run = read.data?.payload as AiLeagueRun | undefined;
      let initial: AiLeagueFeed | undefined;
      let latestFeed: AiLeagueFeed | undefined;
      if (run?.status === 'complete' && run.actual) {
        const verified = run.actual.draft !== null && run.actual.categories !== null && run.actual.acquisitions !== null;
        // A complete historical comparison is immutable. Retry a partially
        // available source on a later day without replaying the simulation.
        if ((season === 2026 || run.liveSingles?.status === 'complete') && (verified || easternDate(new Date(run.actual.capturedAt)) === today)) continue;
      }
      if (!run) {
        initial = await fetchAiLeagueFeed({ season, dates: [], replay: season === 2026, cookies });
        run = createAiLeagueRun(initial, teams, new Date().toISOString());
      }
      let stalled = false;
      if (run.status !== 'complete') {
        const dates = refreshDates(run, today, limit);
        const previousScored = run.scoredDates.length;
        const feed = initial && !dates.length ? initial : await fetchAiLeagueFeed({ season, dates, replay: season === 2026, cookies });
        latestFeed = feed;
        run = advanceAiLeagueRun(run, feed, new Date().toISOString());
        stalled = run.mode === 'replay' && dates.length > 0 && run.scoredDates.length === previousScored;
      }
      try {
        run.actual = await fetchAiOwnerSnapshot(season, cookies, new Map(run.players.map(player => [player.id, player.name])));
        run.limitations = run.limitations.filter(message => message !== OWNER_FAILURE);
      } catch {
        if (!run.limitations.includes(OWNER_FAILURE)) run.limitations.push(OWNER_FAILURE);
      }
      if (season === 2027 && run.liveSingles?.status !== 'complete') {
        try {
          const metadata = latestFeed ?? await fetchAiLeagueFeed({ season, dates: [], replay: false, cookies });
          if (!metadata.firstDate || !metadata.lastDate) throw new Error('Live calendar unavailable');
          run.liveSingles ??= createLiveSingles({ firstDate: metadata.firstDate, lastDate: metadata.lastDate, matchups: metadata.matchups }, teams, new Date().toISOString());
          // Retain original published draft evidence once this experiment starts.
          let evidence = { ownerDraft: run.liveSingles.ownerDraft, draftOrder: run.liveSingles.draftOrder };
          if (!evidence.ownerDraft) {
            const currentSeason = await db.from('seasons').select('id').eq('league_id', identities.leagueId).eq('draft_year', 2026).single();
            if (currentSeason.error || !currentSeason.data) throw new Error('Official draft unavailable');
            const board = await db.rpc('get_draft_board', { p_season: currentSeason.data.id });
            if (board.error) throw new Error('Official draft unavailable');
            evidence = liveDraftEvidence(board.data, new Map(metadata.players.map(player => [player.id, player.name])));
          }
          const dates = evidence.ownerDraft ? liveSingleRefreshDates(run.liveSingles, today) : [];
          const missing = dates.filter(date => !metadata.days.some(day => day.date === date));
          const extra = missing.length ? await fetchAiLeagueFeed({ season, dates: missing, replay: false, cookies }) : null;
          const feed: AiLeagueFeed = { ...metadata, capturedAt: new Date().toISOString(), days: [...metadata.days, ...(extra?.days ?? [])].filter(day => dates.includes(day.date)) };
          const owners = await fetchLiveSingleOwners(feed, cookies);
          run.liveSingles = advanceLiveSingles(run.liveSingles, { ...feed, firstDate: metadata.firstDate, lastDate: metadata.lastDate, ...evidence, ...owners }, new Date().toISOString());
        } catch {
          if (run.liveSingles) run.liveSingles.error = 'The one-team source refresh could not finish. Previously saved lineups and results have been retained.';
          errors.push(season);
        }
      }
      const row = { league_id: identities.leagueId, season, payload: run, updated_at: new Date().toISOString(), revision: (read.data?.revision ?? 0) + 1 };
      const persist = async () => read.data
        ? await db.from('ai_league_runs').update(row).eq('league_id', identities.leagueId).eq('season', season).eq('revision', read.data.revision).select('season')
        : await db.from('ai_league_runs').insert(row).select('season');
      let write = await persist();
      if (write.error?.code === '40001' && /missed first tipoff/.test(write.error.message) && run.liveSingles) {
        // A slow commit must not retroactively certify the computed decision.
        // Keep the all-AI update, retain the last one-team state, and record the gap.
        const attempted = run.liveSingles;
        const prior = (read.data?.payload as AiLeagueRun | undefined)?.liveSingles;
        const missed = attempted.locks.filter(lock => !lock.empty && !(prior?.locks.some(saved => saved.date === lock.date)) && Date.parse(lock.startsAt) <= Date.now()).map(lock => lock.date);
        run.liveSingles = prior ? structuredClone(prior) : createLiveSingles(attempted, teams, new Date().toISOString());
        run.liveSingles.missedDates = [...new Set([...run.liveSingles.missedDates, ...missed])].sort();
        run.liveSingles.status = 'needs_data';
        run.liveSingles.message = 'The database received a new lineup after first tipoff. That decision was rejected and the date remains a coverage gap.';
        run.liveSingles.updatedAt = new Date().toISOString();
        errors.push(season);
        write = await persist();
      }
      if (write.error || write.data?.length !== 1) throw new Error('Concurrent update; retained previous state');
      saved.push(season);
      if (stalled) errors.push(season);
    } catch { errors.push(season); }
  }
  const health = await db.from('ai_league_refresh').upsert({ league_id: identities.leagueId, attempted_at: timestamp, error: errors.length ? `${errors.map(s => `${s - 1}–${String(s).slice(-2)}`).join(', ')}: ${FAILURE}` : null });
  if (health.error) throw new Error('Refresh status could not be saved.');
  return { saved, errors, attemptedAt: timestamp };
}
