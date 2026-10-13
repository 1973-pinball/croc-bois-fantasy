'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import catalogFile from '../../data/draft-player-catalog.json';
import settingsFile from '../../data/draft-roster-settings.json';
import eligibilityFile from '../../data/draft-roster-eligibility.json';
import type { DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import type { DraftRosterEligibility, DraftRosterSettings } from '@/lib/espn-roster-settings';
import { draftBoardSchema, type DraftBoard } from '@/lib/draft-board';
import { buildDraftAdvisor, type DraftAdvisorCandidate, type DraftAdvisorTeam } from '@/lib/draft-advisor';
import { buildDraftTeamValues } from '@/lib/draft-team-values';
import { draftAdvisorScheduleSchema, parseDraftScheduleText, type DraftAdvisorSchedule } from '@/lib/draft-advisor-schedule';
import { draftProjectionDatasetSchema, PROJECTION_SOURCES, type DraftProjectionDataset, type DraftProjectionSource } from '@/lib/draft-projections';
import { workflowDraftKey, workflowDrafts } from '@/lib/workflow-drafts';
import type { LeagueAccount } from './league-account';
import { useAdvisorBoard } from './use-advisor-board';
import { KeeperComparison } from './keeper-comparison';
import { DraftRosters } from './draft-rosters';
import styles from './commissioner-strategy.module.css';
import teamTableStyles from './draft-team-projections.module.css';

const catalog = catalogFile as DraftPlayerCatalog;
const settings = settingsFile as DraftRosterSettings;
const eligibility = eligibilityFile as DraftRosterEligibility;
export type ProjectionLibrary = Partial<Record<DraftProjectionSource, DraftProjectionDataset>>;
type DirectProjectionSource = 'espn' | 'yahoo';
const DIRECT_PROJECTION_SOURCES: { id: DirectProjectionSource; label: string }[] = [{ id: 'espn', label: 'ESPN' }, { id: 'yahoo', label: 'Yahoo' }];
const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const gain = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;
function validLibrary(value: unknown): value is ProjectionLibrary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([source, dataset]) => {
    // Retired provider entries are discarded during hydration without losing supported imports.
    if (!PROJECTION_SOURCES.some(provider => provider.id === source)) return true;
    const parsed = draftProjectionDatasetSchema.safeParse(dataset);
    return parsed.success && parsed.data.source === source && parsed.data.seasonId === catalog.espnSeasonId;
  });
}
async function readFile(file?: File): Promise<string | null> {
  if (!file) return null;
  if (file.size > 2_000_000) throw new Error('Choose a CSV or TSV file smaller than 2 MB.');
  return file.text();
}

/** Only mounted inside the authenticated commissioner view; never a public prop or API response. */
export function CommissionerStrategyTools({ account, view }: { account: LeagueAccount; view: 'draft' | 'keepers' }) {
  if (!account.commissioner || !account.session?.user) return null;
  return <StrategyWorkspace key={`${account.session.user.id}:${account.seasonId}`} account={account} view={view}/>;
}

function StrategyWorkspace({ account, view }: { account: LeagueAccount; view: 'draft' | 'keepers' }) {
  const storageKey = workflowDraftKey(account.session!.user!.id, account.seasonId, 'draft-tool');
  const [library, setLibrary] = useState<ProjectionLibrary>({});
  const libraryRef = useRef<ProjectionLibrary>({});
  const [hydrated, setHydrated] = useState(false);
  const [source, setSource] = useState<DraftProjectionSource>('espn');
  const [importSource, setImportSource] = useState<DraftProjectionSource | null>(null);
  const [text, setText] = useState('');
  const [basis, setBasis] = useState<'per-game' | 'totals'>('per-game');
  const [busy, setBusy] = useState(false);
  const [directLoading, setDirectLoading] = useState<{ source: DirectProjectionSource; mode: 'automatic' | 'manual' } | null>(null);
  const [directErrors, setDirectErrors] = useState<Partial<Record<DirectProjectionSource, string>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const automaticAttempted = useRef(new Set<DirectProjectionSource>());
  useEffect(() => {
    active.current = true;
    const saved = workflowDrafts.read(storageKey, validLibrary) ?? {};
    const cached = Object.fromEntries(Object.entries(saved).filter(([provider]) => PROJECTION_SOURCES.some(item => item.id === provider))) as ProjectionLibrary;
    if (Object.keys(cached).length !== Object.keys(saved).length) workflowDrafts.write(storageKey, cached);
    const previousFailures: Partial<Record<DirectProjectionSource, string>> = {};
    const attempted = new Set<DirectProjectionSource>();
    for (const provider of DIRECT_PROJECTION_SOURCES) {
      const failure = workflowDrafts.read(`${storageKey}:${provider.id}-import-error`, (value): value is string => typeof value === 'string') ?? '';
      if (failure) previousFailures[provider.id] = failure;
      if (cached[provider.id] || failure) attempted.add(provider.id);
    }
    libraryRef.current = cached;
    setLibrary(cached); setDirectErrors(previousFailures);
    automaticAttempted.current = attempted;
    setHydrated(true);
    return () => { active.current = false; request.current?.abort(); request.current = null; };
  }, [storageKey]);
  const save = useCallback((next: ProjectionLibrary) => {
    libraryRef.current = next;
    setLibrary(next);
    if (!workflowDrafts.write(storageKey, next)) setNotice('Imports are available for this visit. Browser storage is unavailable, so keep this page open.');
  }, [storageKey]);
  const importData = useCallback(async (provider: DraftProjectionSource, direct: boolean, automatic = false) => {
    if (request.current || account.connection !== 'live') return;
    const directProvider = provider === 'espn' || provider === 'yahoo' ? provider : null;
    if (direct && !directProvider) return;
    setBusy(true); setError(''); setNotice('');
    if (direct && directProvider) {
      setDirectErrors(current => ({ ...current, [directProvider]: '' }));
      setDirectLoading({ source: directProvider, mode: automatic ? 'automatic' : 'manual' });
      automaticAttempted.current.add(directProvider);
    }
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch('/api/draft-projections', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify(direct ? { action: directProvider, seasonId: account.seasonId, ...(directProvider === 'yahoo' && !automatic ? { refresh: true } : {}) } : { action: 'import', seasonId: account.seasonId, source: provider, text, basis }) });
      const body = await response.json();
      if (!active.current || controller.signal.aborted || request.current !== controller) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) void account.reloadSession();
        throw new Error(body.message || 'The projection import could not be completed.');
      }
      const dataset = draftProjectionDatasetSchema.parse(body.dataset);
      if (dataset.source !== provider || dataset.seasonId !== catalog.espnSeasonId) throw new Error('The import returned a different source or season.');
      setNotice(`${dataset.players.length} ${dataset.sourceLabel} loaded${automatic ? ' automatically' : ''}. Saved for this browser session.`);
      save({ ...libraryRef.current, [provider]: dataset });
      if (directProvider) { workflowDrafts.remove(`${storageKey}:${directProvider}-import-error`); setDirectErrors(current => ({ ...current, [directProvider]: '' })); }
      if (!automatic) { if (!direct) setSource(provider); setText(''); setImportSource(null); }
    } catch (failure) {
      if (active.current && !controller.signal.aborted && request.current === controller) {
        const message = failure instanceof Error ? failure.message : 'The import failed.';
        if (direct && directProvider) { setDirectErrors(current => ({ ...current, [directProvider]: message })); workflowDrafts.write(`${storageKey}:${directProvider}-import-error`, message); }
        else setError(message);
      }
    } finally {
      if (active.current && request.current === controller) { request.current = null; setBusy(false); setDirectLoading(null); }
    }
  }, [account.connection, account.seasonId, account.reloadSession, basis, storageKey, save, text]);
  useEffect(() => {
    if (!hydrated || busy || account.connection !== 'live' || request.current) return;
    const next = DIRECT_PROJECTION_SOURCES.find(provider => !automaticAttempted.current.has(provider.id) && !libraryRef.current[provider.id]);
    if (!next) return;
    automaticAttempted.current.add(next.id);
    void importData(next.id, true, true);
  }, [hydrated, busy, account.connection, importData]);
  const provider = PROJECTION_SOURCES.find(item => item.id === (importSource ?? source))!;
  const projections = library[source] ?? null;
  return <div className={styles.root}>
    <div className={styles.header}><div><span className={styles.badge}>COMMISSIONER ONLY</span><h2>{view === 'draft' ? 'Your draft edge' : 'Keeper Suggestions'}</h2><p>{view === 'draft' ? 'Live rosters, category win probabilities, and two ways to find your next pick.' : 'Compare every projection source at once. Find value in your roster and a legal way to pay for it.'}</p></div><span className={styles.badge}>PRIVATE STRATEGY</span></div>
    {account.connection !== 'live' && <p className={styles.error} role="alert">Restore the league connection to import projections or record draft picks. Showing the last loaded data.</p>}
    <section className={styles.panel} aria-label="Private projection library">
      <h3>Projection library</h3><p className={styles.subtle}>ESPN and Yahoo projections load automatically when their imports are missing. Saved imports are shared by Draft Tool and Keeper Suggestions for your account and season in this browser session. Upload Basketball Monster once here to use it in both tools. Estimates and recommendations stay private to Commissioner Tools.</p>
      {DIRECT_PROJECTION_SOURCES.map(item => {
        const loading = directLoading?.source === item.id ? directLoading.mode : null;
        const failure = directErrors[item.id];
        const imported = library[item.id];
        return <div key={item.id}>
          <div className={styles.status}><strong>{item.label} projections</strong><span role="status">{loading ? loading === 'automatic' ? `Loading ${item.label} projections automatically…` : `Refreshing ${item.label} projections…` : imported ? `${imported.sourceLabel} · ${imported.players.length} players saved · updated ${new Date(imported.importedAt).toLocaleString()}` : failure ? `${item.label} import needs a retry.` : automaticAttempted.current.has(item.id) ? `No ${item.label} import saved.` : account.connection === 'live' ? `Waiting to import ${item.label} automatically…` : 'Waiting for the league connection.'}</span><button type="button" className="button button-subtle" disabled={!hydrated || busy || account.connection !== 'live'} onClick={() => void importData(item.id, true)}>{loading ? `Loading ${item.label} projections…` : failure ? `Retry ${item.label} projections` : imported ? `Refresh ${item.label} projections` : `Load ${item.label} projections`}</button></div>
          {failure && <p className={styles.error} role="alert">{item.label} projections could not be loaded: {failure} {imported ? `Your saved ${item.label} import is still available.` : `Retry ${item.label} or import a projection table below.`}</p>}
        </div>;
      })}
      {view === 'draft' ? <div className={styles.toolbar}><label>Projection source<select value={source} onChange={event => setSource(event.target.value as DraftProjectionSource)}>{PROJECTION_SOURCES.map(item => <option value={item.id} key={item.id}>{item.label}{library[item.id] ? ' · imported' : ' · import needed'}</option>)}</select></label><button type="button" className="button button-subtle" disabled={!hydrated || busy} onClick={() => { setImportSource(source); setText(''); }}>Import {PROJECTION_SOURCES.find(item => item.id === source)!.label.replace(/ projections$/, '')} CSV / TSV</button>{projections && <button type="button" className="text-button" disabled={busy} onClick={() => { const next = { ...libraryRef.current }; delete next[source]; save(next); }}>Remove this import</button>}</div> : <div className={styles.sourceCards}>{PROJECTION_SOURCES.map(item => <div key={item.id} className={styles.sourceCard}><strong>{item.label}</strong><span>{library[item.id] ? `${library[item.id]!.players.length} players · ${new Date(library[item.id]!.importedAt).toLocaleString()}` : 'No projections imported'}</span><button type="button" disabled={!hydrated || busy} onClick={() => { setImportSource(item.id); setText(''); }}>Import CSV / TSV</button></div>)}</div>}
      {view === 'draft' && projections && <p className={styles.subtle}>{projections.players.length} players · {projections.seasonId - 1}–{String(projections.seasonId).slice(-2)} · imported {new Date(projections.importedAt).toLocaleString()}</p>}
      {importSource && <div className={styles.importer}>
        <h4>{provider.label}</h4><p className={styles.subtle}>{provider.help} <a href={provider.url} target="_blank" rel="noreferrer">Open source ↗</a></p>
        <div className={styles.toolbar}><label>CSV / TSV file<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" disabled={busy} onChange={async event => { try { const value = await readFile(event.target.files?.[0]); if (active.current && value !== null) setText(value); } catch (failure) { setError((failure as Error).message); } }}/></label><label>Projection basis<select value={basis} disabled={busy} onChange={event => setBasis(event.target.value as typeof basis)}><option value="per-game">Per game averages</option><option value="totals">Season totals (GP required)</option></select></label></div>
        <label className={styles.field}>Or paste the projection table<textarea rows={5} value={text} disabled={busy} maxLength={2_000_000} onChange={event => setText(event.target.value)} placeholder="Player,GP,PTS,REB,AST,STL,BLK,TO,3PM,FGM,FGA,FTM,FTA"/></label>
        <p className={styles.subtle}>Include full player names or ESPN IDs, all nine categories, and shooting attempts. Player identity and missing columns are checked before use. Source ranks do not replace ESPN’s draft display order.</p>
        <div className={styles.actions}><button className="button button-green" disabled={busy || !text.trim() || account.connection !== 'live'} onClick={() => void importData(importSource, false)}>{busy ? 'Importing…' : 'Import table'}</button><button className="text-button" disabled={busy} onClick={() => { setImportSource(null); setText(''); }}>Close importer</button></div>
      </div>}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.subtle} role="status">{notice}</p>}
      {Object.entries(library).some(([, data]) => data.warnings.length > 0) && <details className={styles.methodology}><summary>Import coverage and source notes</summary>{Object.entries(library).map(([key, data]) => data.warnings.length > 0 && <div key={key}><strong>{data.sourceLabel}</strong><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>)}</details>}
    </section>
    {view === 'draft' ? <DraftAdvisorView account={account} projections={projections}/> : <KeeperComparison account={account} library={library}/>}
  </div>;
}

function Recommendation({ candidate, fit, schedule }: { candidate: DraftAdvisorCandidate | null; fit?: boolean; schedule: boolean }) {
  return <section className={`${styles.panel} ${styles.recommendation}`}><span className={styles.eyebrow}>{fit ? 'Schedule + roster fit' : 'Maximum category win rate'}</span><h3>{candidate?.player.name ?? 'No recommendation yet'}</h3>{candidate ? <><p className={styles.subtle}>ESPN #{candidate.player.rank ?? '—'} · {candidate.player.eligiblePositions.join(' / ')} · {candidate.player.nbaTeam}</p><p className={styles.subtle}>{fit ? `${pct(candidate.scheduleWinRate)} ${schedule ? 'scheduled' : 'equal-game'} category win rate` : `${pct(candidate.categoryWinRate)} projected category win rate`} · <strong className={styles.gain}>{gain(fit ? candidate.scheduleGain : candidate.categoryGain)}</strong></p>{fit && <p className={styles.subtle}>Fit score {pct(candidate.fitScore)} · roster adjustment {gain(candidate.fitAdjustment)}. Fit score includes a roster preference and is not a win probability.</p>}<ul>{candidate.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></> : <p className={styles.subtle}>A recommendation needs imported projections, comparable opponent rosters, and an open roster slot. Check coverage and draft assumptions above.</p>}</section>;
}

function AllTeamProjections({ teams, franchiseId }: { teams: DraftAdvisorTeam[]; franchiseId: string }) {
  const rankedTeams = [...teams].sort((a, b) => (b.categoryWinRate ?? -1) - (a.categoryWinRate ?? -1) || a.displayName.localeCompare(b.displayName) || a.franchiseId.localeCompare(b.franchiseId));
  return <section className={styles.panel} aria-labelledby="all-team-projections-title">
    <h3 id="all-team-projections-title">All-team projections</h3>
    <p className={styles.subtle}>Every live roster, ranked by overall category win rate against the rest of the league. Overall is the expected share of the nine categories won, not the chance of winning a matchup. Your selected team is highlighted.</p>
    <p className={styles.subtle}>Equal games: 3.5 games per player per week, adjusted for projected availability. FG% and FT% use total makes / attempts. Lower TO is better. These estimates compare drafted players so far; uneven roster sizes affect the results.</p>
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="All-team projections, scroll horizontally to compare all categories">
      <table className={teamTableStyles.table}>
        <caption>Category cells show <strong>win chance</strong> above weekly production. — means projections, shooting attempts, or comparable opponents are unavailable.</caption>
        <thead><tr><th scope="col">Team / projection coverage</th><th scope="col">Overall win rate<small>Share of categories won</small></th>{catalog.categories.map(category => <th key={category.id} scope="col">{category.label}{category.lowerIsBetter ? ' ↓' : ''}<small>Win chance / production</small></th>)}</tr></thead>
        <tbody>{rankedTeams.map(team => {
          const selected = team.franchiseId === franchiseId;
          return <tr key={team.franchiseId} className={selected ? teamTableStyles.selected : undefined}>
            <th scope="row"><strong>{team.displayName}</strong>{selected && <span className={teamTableStyles.selectedBadge}>Selected team</span>}<small>{team.roster.totalPlayers}/{team.roster.normalCapacity} roster slots · {team.coverage.projected}/{team.coverage.total} projected</small>{team.coverage.missing.length > 0 && <small className={teamTableStyles.missing}>{team.coverage.missing.length} missing projection{team.coverage.missing.length === 1 ? '' : 's'}</small>}</th>
            <td className={teamTableStyles.overall}><strong>{pct(team.categoryWinRate)}</strong><small>{team.roster.totalPlayers === 0 ? 'No players drafted' : team.categoryWinRate === null ? 'Incomplete comparison' : 'Across all 9 categories'}</small></td>
            {catalog.categories.map(category => {
              const estimate = team.categories.find(item => item.id === category.id);
              const probability = estimate?.winProbability ?? null;
              const production = estimate?.projectedValue ?? null;
              return <td key={category.id}>
                <strong className={probability === null ? undefined : probability >= 0.6 ? teamTableStyles.favored : probability <= 0.4 ? teamTableStyles.underdog : undefined} title={`${category.label} category win chance${estimate ? ` against ${estimate.opponentsCompared} comparable teams` : ''}`}>{pct(probability)}</strong>
                <small aria-label={`${category.label} projected weekly production`}>{production === null ? '—' : [19, 20].includes(category.id) ? pct(production) : production.toFixed(1)}</small>
              </td>;
            })}
          </tr>;
        })}{!rankedTeams.length && <tr><td colSpan={catalog.categories.length + 2}>Team projections appear when a compatible draft board is loaded.</td></tr>}</tbody>
      </table>
    </div>
  </section>;
}

function AllTeamCategoryValues({ teams, franchiseId }: { teams: DraftAdvisorTeam[]; franchiseId: string }) {
  const report = useMemo(() => buildDraftTeamValues(teams), [teams]);
  const names = new Map(teams.map(team => [team.franchiseId, team.displayName]));
  const rankedTeams = [...report.teams].sort((a, b) => {
    if (a.value === null && b.value !== null) return 1;
    if (a.value !== null && b.value === null) return -1;
    return (b.value ?? 0) - (a.value ?? 0) || (names.get(a.franchiseId) ?? a.franchiseId).localeCompare(names.get(b.franchiseId) ?? b.franchiseId);
  });
  const columns = report.teams[0]?.categories ?? [];
  const formatValue = (value: number | null) => value === null ? '—' : `${value > 0 && value.toFixed(2) !== '0.00' ? '+' : ''}${Math.abs(value) < 0.005 ? '0.00' : value.toFixed(2)}`;
  return <section className={styles.panel} aria-labelledby="all-team-category-values-title">
    <h3 id="all-team-category-values-title">Category values · z-scores</h3>
    <p className={styles.subtle}>Compare strengths and weaknesses across current rosters in standard deviations. Each category centers on 0; positive values are stronger and negative values are weaker. Value is the sum of all nine category scores, calculated from the selected projection source and current league rosters.</p>
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="All-team category values, scroll horizontally to compare all categories">
      <table className={`${teamTableStyles.table} ${teamTableStyles.valuesTable}`}>
        <caption>Equal-game weekly projections · higher is better, including toV · — means a category cannot be compared.</caption>
        <thead><tr><th scope="col">Team</th><th scope="col">Value<small>Sum of 9 scores</small></th>{columns.map(category => <th key={category.id} scope="col"><abbr title={`${category.label} category value`}>{category.valueLabel}</abbr></th>)}</tr></thead>
        <tbody>{rankedTeams.map(team => <tr key={team.franchiseId} className={team.franchiseId === franchiseId ? teamTableStyles.selected : undefined}>
          <th scope="row"><strong>{names.get(team.franchiseId) ?? team.franchiseId}</strong>{team.franchiseId === franchiseId && <span className={teamTableStyles.selectedBadge}>Selected team</span>}</th>
          <td><strong className={team.value === null ? undefined : team.value > 0 ? teamTableStyles.favored : team.value < 0 ? teamTableStyles.underdog : undefined}>{formatValue(team.value)}</strong></td>
          {team.categories.map(category => <td key={category.id}><strong className={category.zValue === null ? undefined : category.zValue > 0 ? teamTableStyles.favored : category.zValue < 0 ? teamTableStyles.underdog : undefined}>{formatValue(category.zValue)}</strong></td>)}
        </tr>)}{!rankedTeams.length && <tr><td colSpan={columns.length + 2}>Category values appear when a compatible draft board is loaded.</td></tr>}</tbody>
      </table>
    </div>
    <details className={styles.methodology}><summary>How category values are calculated</summary><ul>{report.methodology.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
  </section>;
}

function DraftAdvisorView({ account, projections }: { account: LeagueAccount; projections: DraftProjectionDataset | null }) {
  const live = useAdvisorBoard(account.seasonId, account.connection === 'live');
  const [choice, setChoice] = useState('');
  const [schedule, setSchedule] = useState<DraftAdvisorSchedule | null>(null);
  const [startDate, setStartDate] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState('');
  const [ranking, setRanking] = useState<'espn' | 'fit'>('espn');
  const request = useRef<AbortController | null>(null);
  const autoScheduleAttempted = useRef(false);
  const { connection, reloadSession } = account;
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const ownFranchiseId = live.board?.teams.find(team => team.espnTeamId !== null && account.ownTeamIds.includes(team.espnTeamId))?.franchiseId;
  const franchiseId = live.board?.teams.find(team => team.franchiseId === choice)?.franchiseId ?? ownFranchiseId ?? live.board?.teams[0]?.franchiseId ?? '';
  const report = useMemo(() => live.board ? buildDraftAdvisor({ board: live.board, catalog, settings, eligibility, projections, franchiseId, schedule }) : null, [live.board, projections, franchiseId, schedule]);
  const loadSchedule = useCallback(async (date = '') => {
    if (request.current || connection !== 'live') return;
    setScheduleBusy(true); setScheduleError('');
    const controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch(`/api/draft-schedule?seasonId=${catalog.espnSeasonId}${date ? `&startDate=${encodeURIComponent(date)}` : ''}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const body = await response.json();
      if (!response.ok) { if ([401, 403].includes(response.status)) void reloadSession(); throw new Error(body.message || 'The schedule could not be loaded.'); }
      const next = draftAdvisorScheduleSchema.parse(body.schedule);
      if (next.seasonId !== catalog.espnSeasonId) throw new Error('The NBA schedule belongs to another season.');
      if (!controller.signal.aborted) { setSchedule(next); setStartDate(next.startDate); }
    } catch (failure) { if (!controller.signal.aborted) setScheduleError(failure instanceof Error ? failure.message : 'The schedule could not be loaded.'); }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setScheduleBusy(false); }
  }, [connection, reloadSession]);
  useEffect(() => {
    if (connection !== 'live' || autoScheduleAttempted.current) return;
    // Defer past effect setup so development remount checks do not leave an aborted first load.
    const timer = window.setTimeout(() => { autoScheduleAttempted.current = true; void loadSchedule(); }, 0);
    return () => window.clearTimeout(timer);
  }, [connection, loadSchedule]);
  const selected = report?.selectedTeam;
  const candidates = ranking === 'fit' ? report?.fitRanking : report?.topAvailable;
  return <>
    <section className={styles.panel} aria-label="Draft analysis controls"><div className={styles.status}><strong>Live draft connection</strong><span>{live.checkedAt ? `Checked ${new Date(live.checkedAt).toLocaleTimeString()} · revision ${live.board?.revision} · refreshes every 2 seconds` : 'Loading draft board…'}</span><button type="button" className="text-button" disabled={live.refreshing || account.connection !== 'live'} onClick={() => void live.refresh()}>Refresh now</button></div>
      {live.error && <p className={styles.error} role="alert">{live.error} Recommendations below use the last successful refresh.</p>}
      <div className={styles.toolbar}><label>My draft team<select value={franchiseId} onChange={event => setChoice(event.target.value)}>{live.board?.teams.map(team => <option key={team.franchiseId} value={team.franchiseId}>{team.displayName}</option>)}</select></label><label>Schedule week starts<input type="date" value={startDate} onChange={event => setStartDate(event.target.value)}/></label><button type="button" className="button button-subtle" disabled={scheduleBusy || account.connection !== 'live'} onClick={() => void loadSchedule(startDate)}>{scheduleBusy ? 'Loading ESPN…' : schedule ? 'Refresh ESPN schedule' : 'Load ESPN schedule'}</button></div>
      <p className={styles.subtle}>The NBA schedule loads automatically from ESPN when you open Draft Tool. It helps compare scheduled games and crowded lineup days for the schedule-and-roster-fit recommendation.</p>
      <p className={styles.subtle} aria-live="polite">{schedule ? `${schedule.startDate} through ${schedule.endDate} · ${schedule.sourceLabel} · daily active-slot congestion included.` : scheduleBusy ? 'Loading the next published seven-day schedule from ESPN…' : 'No schedule loaded. Roster-fit recommendations currently use equal games for every NBA team. Use Load ESPN schedule to include scheduled games.'}</p>
      {scheduleError && <p className={styles.error} role="alert">{scheduleError}{schedule ? ` The loaded window remains ${schedule.startDate}–${schedule.endDate}.` : ''}</p>}
      <details className={styles.methodology}><summary>Other schedule options</summary><p>No upload is needed for ESPN. To use a custom schedule, import CSV/TSV with headers date,team and one row per NBA team playing each day in the selected seven-day window.</p><label className={styles.field}>Schedule CSV / TSV<input type="file" accept=".csv,.tsv,.txt" disabled={scheduleBusy} onChange={async event => { try { const text = await readFile(event.target.files?.[0]); if (text !== null) { setSchedule(parseDraftScheduleText(text, { seasonId: catalog.espnSeasonId, startDate })); setScheduleError(''); } } catch (failure) { setScheduleError((failure as Error).message); } }}/></label>{schedule && <button className="text-button" type="button" disabled={scheduleBusy} onClick={() => { setSchedule(null); setScheduleError(''); }}>Use equal games instead</button>}</details>
    </section>
    {report?.warnings.length ? <details className={styles.notice} open={!report.available}><summary>Projection coverage and draft assumptions ({report.warnings.length})</summary><ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
    {report && !report.available && <p className={styles.notice}>{report.unavailableReason}</p>}
    {selected && <section className={styles.panel}><h3>{selected.displayName} · projected category win rate</h3><p className={styles.subtle}>Current drafted roster against every other team. Each category is equally weighted; these are model estimates for the players selected so far.</p><div className={styles.metrics}><div className={styles.metric}><strong>{pct(selected.categoryWinRate)}</strong><span>Expected share of categories won · equal games</span></div><div className={styles.metric}><strong>{pct(selected.scheduleWinRate)}</strong><span>{schedule ? 'Expected share with the loaded schedule' : 'Equal-game estimate · no schedule loaded'}</span></div><div className={styles.metric}><strong>{selected.roster.totalPlayers} / {selected.roster.normalCapacity}</strong><span>Roster slots · {selected.coverage.projected}/{selected.coverage.total} players have projections</span></div></div><div className={styles.categories}>{selected.categories.map(category => <div key={category.id} className={styles.category}><span>{category.label}{category.lowerIsBetter ? ' ↓' : ''}</span><strong>{pct(category.winProbability)}</strong><progress aria-label={`${category.label} estimated category win probability`} value={category.winProbability ?? 0} max={1}/><small>{category.projectedValue === null ? 'No projection' : [19, 20].includes(category.id) ? pct(category.projectedValue) : `${category.projectedValue.toFixed(1)} / week`}</small></div>)}</div></section>}
    {report && <AllTeamProjections teams={report.teams} franchiseId={franchiseId}/>}
    {report && <AllTeamCategoryValues teams={report.teams} franchiseId={franchiseId}/>}
    <div className={styles.recommendations}><Recommendation candidate={report?.categoryRecommendation ?? null} schedule={Boolean(schedule)}/><Recommendation candidate={report?.fitRecommendation ?? null} fit schedule={Boolean(schedule)}/></div>
    <section className={styles.panel}><h3>{ranking === 'espn' ? 'Next 15 available · ESPN order' : 'Top 15 · schedule and roster fit'}</h3><div className={styles.toolbar}><label>Player ranking<select value={ranking} onChange={event => setRanking(event.target.value as typeof ranking)}><option value="espn">ESPN rankings</option><option value="fit">Schedule + roster fit</option></select></label></div><p className={styles.subtle}>Recommendations consider all {report?.evaluatedCandidates ?? 0} evaluated players and may fall outside ESPN’s next 15. Gains are percentage points (pp); lower turnovers are better.</p><div className={styles.tableWrap}><table className={[styles.table, styles.candidateTable].join(" ")}><thead><tr><th>Player / ESPN rank</th><th>Position</th><th>Category win rate</th><th>Gain</th><th>Usable / scheduled games</th><th>Fit score</th></tr></thead><tbody>{candidates?.map(candidate => <tr key={candidate.player.id}><td><strong>#{candidate.player.rank ?? '—'} {candidate.player.name}</strong><small>{candidate.player.nbaTeam}{candidate.hasProjection ? '' : ' · missing projection'}{candidate.blocked ? ' · not recommended' : ''}</small></td><td>{candidate.player.eligiblePositions.join(' / ')}</td><td>{pct(candidate.categoryWinRate)}</td><td className={(candidate.categoryGain ?? 0) < 0 ? styles.negative : styles.gain}>{gain(candidate.categoryGain)}</td><td>{candidate.usableGames ?? '—'} / {candidate.scheduledGames ?? '—'}</td><td>{pct(candidate.fitScore)}<small>{candidate.reasons.join(' ')}</small></td></tr>)}{!candidates?.length && <tr><td colSpan={6}>Available candidates appear after the draft board loads.</td></tr>}</tbody></table></div></section>
    {live.board && <RecordDraftPick account={account} board={live.board} stale={Boolean(live.error)} accept={live.accept} refresh={live.refresh}/>}
    {live.board && <DraftRosters board={live.board} preferredFranchiseId={ownFranchiseId}/>}
    {report && <section className={styles.panel}><h3>Category matchups</h3><p className={styles.subtle}>{selected?.displayName ?? 'Your team'} against each opponent, using equal games. Blank values mean projections or shot attempts are missing.</p><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Opponent</th>{catalog.categories.map(category => <th key={category.id}>{category.label}</th>)}<th>Category win rate</th></tr></thead><tbody>{report.matchups.map(matchup => <tr key={matchup.franchiseId}><td>{matchup.displayName}</td>{matchup.categories.map(category => <td key={category.id}>{pct(category.winProbability)}</td>)}<td><strong>{pct(matchup.categoryWinRate)}</strong></td></tr>)}</tbody></table></div></section>}
    {report && <details className={`${styles.panel} ${styles.methodology}`}><summary>How these estimates work</summary><ul>{report.methodology.map((item, index) => <li key={index}>{item}</li>)}</ul><p>NBA teams, ESPN ranks, and position eligibility use the player catalog captured {new Date(catalog.fetchedAt).toLocaleDateString()}. Schedule recommendations cover the selected week, not the whole fantasy season.</p></details>}
  </>;
}

function RecordDraftPick({ account, board, stale, accept, refresh }: { account: LeagueAccount; board: DraftBoard; stale: boolean; accept: (board: DraftBoard) => void; refresh: () => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<{ playerId: number; pickId: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const next = board.picks.find(pick => pick.id === board.nextPickId);
  const occupied = new Set(board.picks.filter(pick => pick.status !== 'available').flatMap(pick => pick.playerId === null ? [] : [pick.playerId]));
  const players = catalog.players.filter(player => player.selectable && !occupied.has(player.id) && player.name.toLowerCase().includes(query.trim().toLowerCase()));
  const canRecord = !stale && account.connection === 'live' && board.orderComplete && Boolean(board.keepersRevealedAt) && board.phase === 'draft_ready' && Boolean(next) && !busy;
  const selectionCurrent = selection?.pickId === next?.id && selection?.revision === board.revision;
  async function record() {
    if (!canRecord || !selection || !selectionCurrent || pending.current) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/draft-board', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'record', seasonId: board.seasonId, expectedRevision: selection.revision, pickId: selection.pickId, playerId: selection.playerId }) });
      const body = await response.json();
      if (!active.current) return;
      if (!response.ok) { if ([401, 403].includes(response.status)) void account.reloadSession(); void refresh(); throw new Error(body.message || 'The pick was not recorded.'); }
      const saved = draftBoardSchema.parse(body.board);
      if (saved.seasonId !== board.seasonId) throw new Error('The board response belongs to another season.');
      accept(saved); setSelection(null); setQuery(''); setMessage('Pick recorded. Every roster and recommendation has updated.'); void account.reloadLeague();
    } catch (failure) { if (active.current) setMessage((failure as Error).message); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <details className={styles.panel}><summary>Record the next draft pick</summary><p className={styles.subtle}>This records an official pick on the public draft board. Your projections and recommendations remain private. <a href="/?view=draft&draftView=live" target="_blank" rel="noreferrer">Open draft room for clock controls, corrections, or undo ↗</a></p><p className={styles.subtle}>{next ? `Next: pick ${next.overallPick ?? '—'}, round ${next.round} · ${board.teams.find(team => team.franchiseId === next.currentOwnerId)?.displayName ?? 'Owner pending'}` : 'No next pick available.'}</p><div className={styles.toolbar}><label>Find player<input value={query} onChange={event => { setQuery(event.target.value); setSelection(null); }} placeholder="Search all available players"/></label><label>Player to record<select value={selection?.playerId ?? ''} onChange={event => setSelection(next && event.target.value ? { playerId: Number(event.target.value), pickId: next.id, revision: board.revision } : null)}><option value="">Select player</option>{players.map(player => <option value={player.id} key={player.id}>#{player.rank ?? '—'} {player.name}</option>)}</select></label><button type="button" className="button button-green" disabled={!canRecord || !selectionCurrent || !selection} onClick={() => void record()}>{busy ? 'Recording…' : 'Record on public board'}</button></div>{selection && !selectionCurrent && <p className={styles.notice}>The draft board changed. Select the player again to confirm the current pick.</p>}{!canRecord && !busy && <p className={styles.subtle}>Recording opens once draft order and keeper reveal are complete and the season is draft-ready.</p>}{message && <p role="status" className={styles.notice}>{message}</p>}</details>;
}
