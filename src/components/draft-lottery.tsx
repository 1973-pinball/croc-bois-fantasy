'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { draftLotterySchema, type DraftLotteryState } from '@/lib/draft-lottery';
import type { LeagueAccount } from './league-account';
import { LotteryReveal, lotteryRevealSeconds, useLotteryRevealTimer, type LotteryPresentation } from './lottery-reveal';
import { ShareLotteryResults } from './share-lottery-results';
import styles from './draft-lottery.module.css';

function dateLabel(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : value;
}

export function DraftLottery({ account }: { account: LeagueAccount }) {
  // Private results must never survive a change of season, account, or league role.
  const scope = `${account.seasonId}:${account.live?.phase}:${account.session?.user?.id || 'public'}:${account.commissioner}:${account.connection}`;
  return <LotteryPanel key={scope} account={account}/>;
}

function LotteryPanel({ account }: { account: LeagueAccount }) {
  const id = useId();
  const [lottery, setLottery] = useState<DraftLotteryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [presentation, setPresentation] = useState<LotteryPresentation | null>(null);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const presentationRef = useRef<HTMLDivElement>(null);
  const live = account.connection === 'live';
  const commissioner = Boolean(account.session?.user && account.commissioner && !accessBlocked);
  const seasonId = account.seasonId;
  const reloadSession = account.reloadSession;

  const read = useCallback(async (response: Response) => {
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        setAccessBlocked(true);
        setLottery(current => current ? { ...current, result: null } : null);
        void reloadSession();
      }
      throw new Error(body?.message || 'The lottery service is unavailable. Refresh to check the saved state.');
    }
    const parsed = draftLotterySchema.safeParse(body?.lottery);
    if (!parsed.success || parsed.data.seasonId !== seasonId) throw new Error('The lottery response could not be verified. Refresh before continuing.');
    return parsed.data;
  }, [seasonId, reloadSession]);

  const refresh = useCallback(async () => {
    if (!live || busyRef.current) return;
    const current = ++sequence.current;
    setLoading(true); setError('');
    try {
      const next = await read(await fetch('/api/draft-lottery?seasonId=' + encodeURIComponent(seasonId), { cache: 'no-store', credentials: 'same-origin' }));
      if (current !== sequence.current) return;
      setLottery(next); setNeedsRefresh(false); setLastChecked(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (failure) {
      if (current === sequence.current) { setError(failure instanceof Error ? failure.message : 'The lottery could not be loaded.'); setNeedsRefresh(true); }
    } finally { if (current === sequence.current) setLoading(false); }
  }, [live, read, seasonId]);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { sequence.current++; window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const presentationId = presentation?.resultId;
  const presentationStart = presentation?.startedAt;
  useEffect(() => {
    if (presentationId) presentationRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [presentationId, presentationStart]);
  useLotteryRevealTimer(presentation, setPresentation);

  async function generate() {
    if (!commissioner || !live || busyRef.current || loading || needsRefresh || !lottery?.ready || lottery.hasRun) return;
    busyRef.current = true; setBusy(true); setError('');
    const current = ++sequence.current;
    try {
      const next = await read(await fetch('/api/draft-lottery', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate', seasonId }) }));
      if (current !== sequence.current) return;
      if (!next.hasRun || !next.result) throw new Error('The saved result could not be verified. Refresh to check whether the official draw completed.');
      setLottery(next); setNeedsRefresh(false);
      setPresentation({ resultId: next.result.id, startedAt: performance.now(), elapsed: 0 });
    } catch (failure) {
      if (current === sequence.current) {
        setNeedsRefresh(true);
        setError((failure instanceof Error ? failure.message : 'The draw could not be confirmed.') + ' Refresh lottery before taking another action.');
      }
    } finally { busyRef.current = false; if (current === sequence.current) setBusy(false); }
  }

  const result = commissioner ? lottery?.result : null;
  const showingDraw = Boolean(result && presentation?.resultId === result.id);
  const revealedCount = showingDraw ? lotteryRevealSeconds.filter(time => time <= presentation!.elapsed).length : result?.priorityOrder.length || 0;
  const animating = showingDraw && revealedCount < 8;
  const teamName = (franchiseId: string) => {
    const team = lottery?.standings.find(item => item.franchiseId === franchiseId);
    return team ? `${team.managerLabel} · ${team.displayName}` : 'Unknown franchise';
  };
  const seasonLabel = lottery?.source ? `${lottery.source.priorEspnSeasonId - 1}–${String(lottery.source.priorEspnSeasonId).slice(-2)}` : 'Prior season';
  const inputManagers = lottery?.odds?.franchiseIds.map(franchiseId => lottery.standings.find(team => team.franchiseId === franchiseId)?.managerLabel);
  const pythonInputs = lottery?.odds && inputManagers?.every(Boolean)
    ? `managers = ${JSON.stringify(inputManagers)}\nweights = ${JSON.stringify(lottery.odds.weights)}\nprobabilities = ${JSON.stringify(lottery.odds.weights.map(weight => weight / lottery.odds!.weights.reduce((total, value) => total + value, 0)))}\n\norder = np.random.choice(managers, len(managers), p=probabilities, replace=False)`
    : null;
  return <section className={`panel ${styles.panel}`} aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><p className="eyebrow">DRAFT-SLOT CHOICE PRIORITY</p><h2 id={`${id}-title`}>Draft-slot choice lottery</h2></div><button type="button" className="text-button" aria-label="Refresh lottery" disabled={!live || loading || busy} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <div className={styles.body}>
      <p className={styles.intro}>The lottery sets who chooses a draft slot first. Each franchise then chooses its slot; only the published slots control the draft board.</p>
      <ol className={styles.steps} aria-label="Lottery to draft order"><li>Draw choice priority</li><li>Record chosen slots</li><li>Publish draft order</li></ol>
      <p className={styles.help}><a className="text-button" href="/?view=draft&draftView=live&order=edit">{commissioner ? 'Record chosen slots in the draft order editor' : 'View the published draft slots'} →</a>{lastChecked && <span className={styles.lastChecked}>Lottery last checked {lastChecked}</span>}</p>
      {!live && <p className={styles.notice}>Connect to live league records to view the verified lottery inputs and saved state.</p>}
      {loading && !lottery && <p role="status" className={styles.help}>Loading standings and lottery inputs…</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {lottery && <>
        <div className={styles.overview}>
          <div><h3>{seasonLabel} regular-season standings</h3><p className={styles.help}>Regular-season places and category W–L–T records are from ESPN. Playoff qualification determines the starting weight.</p>
            {lottery.standings.length ? <table className={styles.standings}><caption className={styles.srOnly}>{seasonLabel} regular-season standings and lottery groups</caption><thead><tr><th scope="col">Place</th><th scope="col">Manager & franchise</th><th scope="col" className={styles.standingRecord}>W–L–T</th><th scope="col">Group</th></tr></thead><tbody>{[...lottery.standings].sort((a, b) => a.regularSeasonPlace - b.regularSeasonPlace).map(team => <tr key={team.franchiseId}><td>{team.regularSeasonPlace}</td><th scope="row"><span className={styles.standingManager}>{team.managerLabel}</span>{' '}<span className={styles.standingFranchise}>{team.priorTeamName}</span>{team.priorTeamName !== team.displayName && <small>Now {team.displayName}</small>}</th><td className={styles.standingRecord}>{team.record.wins}–{team.record.losses}–{team.record.ties}</td><td><span className={team.playoffQualified ? styles.playoff : styles.nonPlayoff}>{team.playoffQualified ? 'Playoff' : 'Non-playoff'}</span></td></tr>)}</tbody></table> : <p className={styles.notice}>Verified prior-season standings are not available for this season.</p>}
          </div>
          <div className={styles.actionCard}>
            <span className={styles.stateLabel}>{lottery.hasRun ? 'OFFICIAL DRAW SAVED' : 'ONE OFFICIAL DRAW'}</span>
            <h3>{lottery.hasRun ? 'Choice order is saved.' : 'Who gets first choice?'}</h3>
            <p>Each franchise receives one choice priority. Teams are drawn one at a time using their starting weights. After each draw, that team is removed and the remaining weights determine the next choice.</p>
            {lottery.hasRun ? <p className={styles.privateNote}>The saved choice order is visible here only to the commissioner. Share Lottery Results creates a replay link for anyone with the link. Draft slots have not been assigned by this draw.</p> : <>
              <p>Generating saves one official result with its audit record. This panel cannot reroll it or publish draft slots.</p>
              {lottery.unavailableReason && <p className={styles.notice}>{lottery.unavailableReason}</p>}
              {commissioner ? <button type="button" className="button button-green" disabled={!live || !lottery.ready || loading || busy || needsRefresh || Boolean(error)} onClick={() => void generate()}>{busy ? 'Saving official draw…' : 'Draw choice priority'}</button> : <p className={styles.privateNote}>Only a signed-in commissioner can generate the official choice order.</p>}
            </>}
            {accessBlocked && <p className={styles.notice}>Your commissioner access needs to be checked again. Refresh your account before continuing.</p>}
          </div>
        </div>
        {result && <div className={styles.result}><div className={styles.resultHeading}><div><p className="eyebrow">SAVED · COMMISSIONER ONLY</p><h3>Official choice priority</h3></div><p>Drawn {dateLabel(result.drawnAt)}</p></div><p className={styles.help}>Priority 1 chooses a draft slot first. These numbers are not assigned draft slots.</p>
          {!animating && <div className={styles.replayControls}><button type="button" className="button button-subtle" onClick={() => setPresentation({ resultId: result.id, startedAt: performance.now(), elapsed: 0, replay: true })}>Replay saved animation</button><p>Reveals the same saved choice order. No new lottery is run.</p></div>}
          <ShareLotteryResults key={result.id} seasonId={seasonId} drawnAt={result.drawnAt} disabled={!live || loading || busy || needsRefresh || Boolean(error)} onAccessDenied={() => { setAccessBlocked(true); setLottery(current => current ? { ...current, result: null } : null); setPresentation(null); setError('Your commissioner access needs to be checked again. Refresh your account before continuing.'); void reloadSession(); }}/>
          {showingDraw && <LotteryReveal containerRef={presentationRef} visibleNames={result.priorityOrder.slice(0, revealedCount).map(teamName)} elapsed={presentation!.elapsed} replay={presentation?.replay} note={presentation?.replay ? 'Replaying the saved result. The choice order has not changed.' : 'The official draw is already saved. This animation reveals that result.'} onSkip={() => setPresentation(null)}/>}
          <ol className={styles.priorityList} aria-label="Official draft-slot choice priority">{result.priorityOrder.slice(0, revealedCount).map((franchiseId, index) => <li key={franchiseId}><span>{index + 1}</span><strong>{teamName(franchiseId)}</strong></li>)}</ol>
          {!animating && <details className={styles.details}><summary>Saved draw audit</summary><dl className={styles.audit}><div><dt>Draw ID</dt><dd>{result.id}</dd></div><div><dt>Standings SHA-256</dt><dd>{result.sourceSha256}</dd></div><div><dt>Original Python source SHA-256</dt><dd>{result.pythonSourceSha256}</dd></div><div><dt>TypeScript source SHA-256</dt><dd>{result.algorithmSourceSha256}</dd></div><div><dt>Database source SHA-256</dt><dd>{result.databaseSourceSha256}</dd></div></dl><p className={styles.help}>The audit records each sequential draw, its remaining total weight, selected franchise, and random ticket.</p><pre tabIndex={0} aria-label="Saved lottery audit JSON"><code>{JSON.stringify(result.audit, null, 2)}</code></pre></details>}
        </div>}
        {lottery.odds && <details className={styles.details}><summary>View every team’s choice-priority odds</summary><p className={styles.help}>Columns are choice priorities, from first choice to eighth choice. First-choice odds come from the starting weights. Later odds are calculated from the sequential draw without replacement, before any team is drawn; they are not separately assigned probabilities. Percentages are rounded to four decimal places.</p><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Choice-priority odds"><table className={styles.odds}><thead><tr><th scope="col">Franchise</th><th scope="col">Weight</th>{lottery.odds.marginalMatrix.map((_, priority) => <th key={priority} scope="col">{priority + 1}</th>)}</tr></thead><tbody>{lottery.odds.franchiseIds.map((franchiseId, column) => <tr key={franchiseId}><th scope="row">{teamName(franchiseId)}</th><td>{lottery.odds!.weights[column]}</td>{lottery.odds!.marginalMatrix.map((row, priority) => <td key={priority}>{Number((row[column] * 100).toFixed(4))}%</td>)}</tr>)}</tbody></table></div></details>}
        <details className={styles.details}><summary>View the actual lottery source code</summary><p className={styles.help}>Algorithm: {lottery.algorithm.id}. The original Python defines the weighted draw without replacement. TypeScript calculates the displayed odds and supports replay; the database executes the official draw with secure randomness and saves its audit.</p>{pythonInputs && <><h4>Current season · verified Python inputs</h4><p className={styles.help}>Current managers in the saved configuration’s draw order. Starting probabilities are each weight divided by the total weight.</p><pre tabIndex={0} aria-label="Current season verified Python inputs"><code>{pythonInputs}</code></pre></>}{lottery.algorithm.pythonSource && <><h4>Original Python · lottery method</h4><p className={styles.help}>{lottery.algorithm.pythonSourceLabel}</p><p className={styles.hash}>SHA-256: {lottery.algorithm.pythonSourceSha256}</p><pre tabIndex={0} aria-label="Original lottery Python source"><code>{lottery.algorithm.pythonSource}</code></pre></>}{lottery.algorithm.typeScriptSource ? <><h4>TypeScript · derived odds and replay</h4><p className={styles.hash}>SHA-256: {lottery.algorithm.sourceSha256}</p><pre tabIndex={0} aria-label="Lottery TypeScript source"><code>{lottery.algorithm.typeScriptSource}</code></pre></> : <p className={styles.notice}>Verified lottery weights are not configured for this season.</p>}<h4>Database SQL · official draw and persistence</h4><p className={styles.hash}>SHA-256: {lottery.algorithm.databaseSourceSha256}</p><pre tabIndex={0} aria-label="Lottery database source"><code>{lottery.algorithm.databaseSource}</code></pre></details>
        {lottery.source && <details className={styles.details}><summary>Standings source & verification</summary><p className={styles.help}>{lottery.source.description}</p><dl className={styles.audit}><div><dt>Source</dt><dd><a href={lottery.source.url} target="_blank" rel="noreferrer">ESPN {seasonLabel} season data</a></dd></div><div><dt>Captured</dt><dd>{dateLabel(lottery.source.capturedAt)}</dd></div><div><dt>Source SHA-256</dt><dd>{lottery.source.sha256}</dd></div></dl>{lottery.managerSource && <><h4>Current manager & team names</h4><p className={styles.help}>{lottery.managerSource.description}</p><dl className={styles.audit}><div><dt>Source</dt><dd><a href={lottery.managerSource.url} target="_blank" rel="noreferrer">ESPN {lottery.managerSource.espnSeasonId - 1}–{String(lottery.managerSource.espnSeasonId).slice(-2)} team identities</a></dd></div><div><dt>Captured</dt><dd>{dateLabel(lottery.managerSource.capturedAt)}</dd></div><div><dt>Source SHA-256</dt><dd>{lottery.managerSource.sha256}</dd></div></dl></>}</details>}
      </>}
    </div>
  </section>;
}
