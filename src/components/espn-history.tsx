'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import localHistory from '../../data/playoff-history.json';
import { validatePlayoffSeason, type PlayoffHistory } from '@/lib/playoff-history';
import type { LeagueAccount } from './league-account';
import styles from './espn-history.module.css';

type PublicHistory = { history: PlayoffHistory; source: 'supabase'; completedThrough: number; status: { lastSuccessfulAt: string | null } };
export interface EspnSyncStatus {
  configured: boolean;
  needsConnection: boolean;
  running: boolean;
  lastSuccess: string | null;
  failedYears: { seasonId: number; code: string; message: string }[];
  coveredYears: number[];
  pendingYears: number[];
  message?: string;
  attemptedYears?: number[];
  savedYears?: number[];
}

const emptyHistory: PlayoffHistory = { version: 1, leagueId: localHistory.leagueId, seasons: [], statsOnlySeasons: [] };
const snapshotThrough = Math.max(...localHistory.seasons.map(season => season.espnSeasonId));
const fallbackHistory: PlayoffHistory = {
  ...emptyHistory,
  // The local record is a clearly labelled outage fallback, never a substitute for an empty database.
  seasons: (localHistory as PlayoffHistory).seasons.filter(season => season.espnSeasonId === 2026),
};
const validYear = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 2000 && value <= 2100;
const validDate = (value: unknown): value is string | null => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
class HistoryRequestFailure extends Error {}

function publicHistory(value: unknown): PublicHistory {
  if (!object(value) || value.source !== 'supabase' || !object(value.history) || !object(value.status) || !validDate(value.status.lastSuccessfulAt) || !validYear(value.completedThrough) || value.completedThrough < 2025 || value.completedThrough > Math.max(snapshotThrough, new Date().getUTCFullYear())) throw new Error('Unexpected history response.');
  const history = value.history as unknown as PlayoffHistory;
  if (history.version !== 1 || history.leagueId !== emptyHistory.leagueId || !Array.isArray(history.seasons) || history.statsOnlySeasons !== undefined && !Array.isArray(history.statsOnlySeasons)) throw new Error('Unexpected history coverage.');
  const years = new Set<number>();
  for (const season of history.seasons) {
    validatePlayoffSeason(season);
    if (season.source.leagueId !== history.leagueId || years.has(season.espnSeasonId)) throw new Error('Conflicting history coverage.');
    years.add(season.espnSeasonId);
  }
  const statsYears = new Set<number>();
  for (const season of history.statsOnlySeasons || []) {
    if (!validYear(season.espnSeasonId) || season.draftYear !== season.espnSeasonId || season.priorSeasonStartYear !== season.espnSeasonId - 1 || season.qualificationStatus !== 'unverified' || !Array.isArray(season.participants) || season.participants.length < 2 || statsYears.has(season.espnSeasonId) || season.source?.leagueId !== history.leagueId) throw new Error('Unexpected season statistics.');
    statsYears.add(season.espnSeasonId);
    const franchises = new Set<string>();
    const teams = new Set<number>();
    for (const team of season.participants) {
      if (!Number.isSafeInteger(team.espnTeamId) || team.espnTeamId < 1 || !/^[1-9]\d*$/.test(team.franchiseId) || franchises.has(team.franchiseId) || teams.has(team.espnTeamId) || team.regularSeasonWins !== undefined && (!Number.isSafeInteger(team.regularSeasonWins) || team.regularSeasonWins < 0)) throw new Error('Unexpected franchise statistics.');
      franchises.add(team.franchiseId); teams.add(team.espnTeamId);
    }
  }
  return value as unknown as PublicHistory;
}

function syncStatus(value: unknown): EspnSyncStatus {
  if (!object(value) || typeof value.configured !== 'boolean' || typeof value.needsConnection !== 'boolean' || typeof value.running !== 'boolean' || !validDate(value.lastSuccess) || !Array.isArray(value.coveredYears) || !value.coveredYears.every(validYear) || !Array.isArray(value.pendingYears) || !value.pendingYears.every(validYear) || !Array.isArray(value.failedYears) || !value.failedYears.every(item => object(item) && validYear(item.seasonId) && typeof item.code === 'string')) throw new Error('Unexpected synchronization status.');
  return value as unknown as EspnSyncStatus;
}

/** Fetch public stored results once on mount, and again after a commissioner update. */
export function useEspnHistory() {
  const [history, setHistory] = useState<PlayoffHistory>(emptyHistory);
  const [source, setSource] = useState<'loading' | 'supabase' | 'local-fallback'>('loading');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null);
  const [completedThrough, setCompletedThrough] = useState(snapshotThrough);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const hasSavedResult = useRef(false);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    setLoading(true); setError('');
    const timeout = window.setTimeout(() => request.abort(), 15000);
    try {
      // Public data is deliberately fetched without account cookies.
      const response = await fetch('/api/history', { cache: 'no-store', credentials: 'omit', signal: request.signal });
      if (!response.ok) throw new Error('History unavailable.');
      const body = publicHistory(await response.json());
      if (current !== sequence.current) return null;
      hasSavedResult.current = true;
      setHistory(body.history); setSource('supabase'); setLastSuccessfulAt(body.status.lastSuccessfulAt); setCompletedThrough(body.completedThrough);
      return body.history;
    } catch {
      if (current !== sequence.current) return null;
      if (!hasSavedResult.current) { setHistory(fallbackHistory); setSource('local-fallback'); }
      setError(hasSavedResult.current ? 'Saved history could not be refreshed. The last successfully loaded results remain visible.' : 'Saved history is temporarily unavailable. Showing the local 2025–26 record only.');
      return null;
    } finally {
      window.clearTimeout(timeout);
      if (current === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { sequence.current++; controller.current?.abort(); };
  }, [refresh]);

  const notice = error || (source === 'loading' ? 'Loading saved ESPN history…' : source === 'supabase' ? 'ESPN history loaded from the league database.' : 'Showing the local 2025–26 record only.');
  return { history, source, loading, error, notice, lastSuccessfulAt, completedThrough, refresh };
}

export type EspnHistoryState = ReturnType<typeof useEspnHistory>;

export function EspnHistoryNotice({ history }: { history: EspnHistoryState }) {
  if (history.source === 'supabase' && !history.error && !history.loading) return null;
  return <div className={`${styles.historyNotice} ${history.error ? styles.warning : ''}`} role="status">
    <span>{history.notice}</span>
    {history.error && <button type="button" onClick={() => void history.refresh()} disabled={history.loading}>{history.loading ? 'Refreshing…' : 'Retry saved history'}</button>}
  </div>;
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No successful update yet';
}
function safeFailure(code: string) {
  if (/AUTH|PRIVATE|CONNECT|CREDENTIAL|FORBIDDEN/.test(code.toUpperCase())) return 'ESPN access needs to be connected.';
  if (/TIMEOUT|NETWORK|FETCH|RATE|HTTP|UNAVAILABLE/.test(code.toUpperCase())) return 'ESPN could not be reached. Retry later.';
  if (/PENDING|INCOMPLETE|NOT_FINISHED|NOT_COMPLETE/.test(code.toUpperCase())) return 'Complete season results are not available yet.';
  if (/VALID|IDENTITY|MAPPING|FORMAT|PARSE/.test(code.toUpperCase())) return 'These results need a data review before they can be saved.';
  return 'This season could not be updated. Its saved results are unchanged.';
}
function requestError(status: number) {
  if (status === 401) return 'Sign in again to update ESPN history.';
  if (status === 403) return 'Commissioner access is required to update ESPN history.';
  if (status === 409) return 'Another history update is already running. Refresh its status before trying again.';
  if (status === 503) return 'History updates are temporarily unavailable. Check the connection status and try again later.';
  return 'The update could not be confirmed. Refresh its status before trying again.';
}

function CommissionerHistorySync({ history }: { history: EspnHistoryState }) {
  const [status, setStatus] = useState<EspnSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const active = useRef(true);
  const busyRef = useRef(false);
  const readSequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const lastRead = useRef(0);

  const loadStatus = useCallback(async () => {
    const current = ++readSequence.current;
    const controller = new AbortController(); requests.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true); setLoadError('');
    try {
      const response = await fetch('/api/history/sync', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new HistoryRequestFailure(requestError(response.status));
      const next = syncStatus(await response.json());
      if (!active.current || current !== readSequence.current) return null;
      setStatus(next); setNeedsRefresh(false); lastRead.current = Date.now();
      return next;
    } catch (failure) {
      if (active.current && current === readSequence.current) {
        setLoadError(failure instanceof HistoryRequestFailure ? failure.message : 'History update status could not be loaded. Refresh before continuing.');
        setNeedsRefresh(true);
      }
      return null;
    } finally {
      window.clearTimeout(timeout);
      requests.current.delete(controller);
      if (active.current && current === readSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void loadStatus();
    return () => { active.current = false; readSequence.current++; requests.current.forEach(request => request.abort()); };
  }, [loadStatus]);

  const refreshStatus = useCallback(async () => {
    const next = await loadStatus();
    if (next) { setActionError(''); await history.refresh(); }
    return next;
  }, [loadStatus, history.refresh]);

  useEffect(() => {
    const onFocus = () => {
      if (!busyRef.current && Date.now() - lastRead.current > 30000) void refreshStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshStatus]);

  async function update() {
    if (busyRef.current || loading || !status?.configured || status.needsConnection || status.running || needsRefresh) return;
    busyRef.current = true; setBusy(true); setActionError(''); setNotice('');
    const controller = new AbortController(); requests.current.add(controller);
    let succeeded = false;
    try {
      const response = await fetch('/api/history/sync', { method: 'POST', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new HistoryRequestFailure(requestError(response.status));
      const result = syncStatus(await response.json());
      if (!active.current) return;
      setStatus(result); succeeded = true;
      setNotice(result.running ? 'The update is running. Refresh status to check its progress.' : result.failedYears.length ? 'The update finished with some seasons still needing attention.' : result.pendingYears.length ? 'The available results were saved. Some seasons are still awaiting an update.' : 'ESPN history is up to date.');
      const loaded = await history.refresh();
      if (active.current && !loaded) setActionError('The update finished, but the saved history could not be reloaded. Retry saved history to see the latest results.');
    } catch (failure) {
      if (!active.current) return;
      setNeedsRefresh(true);
      setActionError(failure instanceof HistoryRequestFailure ? failure.message : 'The update could not be confirmed. Refresh its status before trying again.');
      // An interrupted response may still have saved results. Check before another write.
      await Promise.all([loadStatus(), history.refresh()]);
    } finally {
      requests.current.delete(controller);
      busyRef.current = false;
      if (active.current) { setBusy(false); if (succeeded) setNeedsRefresh(false); }
    }
  }

  const disabled = loading || busy || !status?.configured || status.needsConnection || status.running || needsRefresh || Boolean(loadError);
  const connection = !status ? loading ? 'Checking connection' : 'Status unavailable' : status.needsConnection ? 'Connection needed' : !status.configured ? 'Setup pending' : status.running || busy ? 'Updating' : 'Ready';

  return <section className={`panel ${styles.panel}`} aria-labelledby="espn-history-sync-title">
    <div className={`panel-header ${styles.heading}`}><div><p className="eyebrow">COMMISSIONER · LEAGUE RECORDS</p><h2 id="espn-history-sync-title">ESPN history</h2></div><span className={`${styles.status} ${status?.needsConnection ? styles.attention : ''}`}>{connection}</span></div>
    <div className={styles.body}>
      <p className={styles.intro}>Bring ESPN season results into the league’s saved history. Seasons from 2025 onward are checked, and previously saved results stay available if an update fails.</p>
      <dl className={styles.facts}><div><dt>Last successful update</dt><dd>{status ? dateLabel(status.lastSuccess) : 'Checking…'}</dd></div><div><dt>Saved ESPN seasons</dt><dd>{status ? status.coveredYears.length ? [...status.coveredYears].sort((a, b) => a - b).join(', ') : 'None saved yet' : 'Checking…'}</dd></div></dl>
      {status?.needsConnection && <p className={styles.connectionNotice}>ESPN access needs to be connected before these seasons can be updated. The league’s saved records remain available.</p>}
      {status && !status.configured && !status.needsConnection && <p className={styles.connectionNotice}>Automatic history updates are still being connected. You can continue viewing saved league records.</p>}
      {status?.pendingYears.length ? <p className={styles.help}>Awaiting an update: {[...status.pendingYears].sort((a, b) => a - b).join(', ')}.</p> : null}
      {status?.failedYears.length ? <div className={styles.failures}><h3>Seasons needing attention</h3><ul>{status.failedYears.map(item => <li key={item.seasonId}><strong>{item.seasonId}</strong><span>{safeFailure(item.code)}</span></li>)}</ul></div> : null}
      <div className={styles.actions}><button type="button" className="button button-green" onClick={() => void update()} disabled={disabled}>{busy ? 'Updating ESPN history…' : status?.running ? 'ESPN update in progress…' : 'Update ESPN history'}</button><button type="button" className="button button-subtle" onClick={() => void refreshStatus()} disabled={loading || busy}>{loading ? 'Checking status…' : 'Refresh status'}</button></div>
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      {needsRefresh && <p className={styles.help}>Refresh status before starting another update.</p>}
      <p className={styles.footnote}>Only commissioners can start an update. Category wins and confirmed playoff results are saved separately, so a missing bracket does not become a missing win total.</p>
    </div>
  </section>;
}

export function EspnHistorySyncPanel({ account, history }: { account: LeagueAccount; history: EspnHistoryState }) {
  if (!account.commissioner || account.sessionLoading || !account.session?.user) return null;
  // Account changes unmount private status and prevent an old response appearing in a new session.
  return <CommissionerHistorySync key={account.session.user.id} history={history}/>;
}
