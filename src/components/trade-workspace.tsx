'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { serializeTradeDraft, type ObligationKind, type TradeCategory, type TradeDraftLeg } from '@/lib/trade-workspace';
import { AccountButton, type LeagueAccount } from './league-account';
import identities from '../../data/identities.json';
import styles from './trade-workspace.module.css';

type Transfer = { from_franchise_id: string; to_franchise_id: string };
type Obligation = Transfer & { id: string; kind: ObligationKind; terms: string; due_at: string | null; status: 'open' | 'fulfilled' | 'waived'; resolution_note: string | null };
type LiveTrade = {
  id: string; category: TradeCategory; status: 'proposed' | 'finalized' | 'cancelled';
  terms: string; created_at: string; review_deadline: string; application_mode: 'live' | 'record_only';
  trade_participants: { franchise_id: string }[];
  trade_player_transfers: (Transfer & { player_id: number; espn_status: string })[];
  trade_pick_transfers: (Transfer & { pick_id: string })[];
  trade_obligations: Obligation[];
};
const obligationLabels: Record<ObligationKind, string> = {
  loan_return: 'Loan return', conditional_pick: 'Conditional pick', espn_action: 'ESPN action', other: 'Other obligation',
};
function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not set';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(result?.message || (response.status === 401 ? 'Sign in again to continue.' : response.status === 403 ? 'Your league role does not allow this action.' : 'The trade service could not complete this request.'));
  if (!result) throw new Error('The trade service returned an unexpected response. Reload records to check the outcome.');
  return result as T;
}

function TradeComposer({ account, disabled, saving, onLog }: {
  account: LeagueAccount; disabled: boolean; saving: boolean;
  onLog: (category: TradeCategory, terms: string, legs: TradeDraftLeg[]) => Promise<boolean>;
}) {
  const id = useId();
  const nextKey = useRef(0);
  const [category, setCategory] = useState<TradeCategory>('advanced');
  const [terms, setTerms] = useState('');
  const [legs, setLegs] = useState<TradeDraftLeg[]>([]);
  const [kind, setKind] = useState<'player' | 'pick' | 'obligation'>('player');
  const [fromTeam, setFromTeam] = useState('');
  const [toTeam, setToTeam] = useState('');
  const [assetId, setAssetId] = useState('');
  const [obligationKind, setObligationKind] = useState<ObligationKind>('loan_return');
  const [obligationTerms, setObligationTerms] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState('');
  const teamName = (teamId: number) => account.data.teams.find(t => t.id === teamId)?.shortName || 'League team';
  const pickLabel = (pickId: string) => {
    const pick = account.data.picks.find(p => p.id === pickId);
    return pick ? `${pick.season} round ${pick.round} · originally ${teamName(pick.originalTeamId)}` : 'Pick unavailable';
  };
  const choices = kind === 'player'
    ? account.data.players.filter(p => p.teamId === Number(fromTeam) && !legs.some(l => l.kind === 'player' && l.playerId === p.id)).map(p => ({ value: String(p.id), label: p.name }))
    : account.data.picks.filter(p => p.ownerTeamId === Number(fromTeam) && !account.live?.usedPickIds?.includes(p.id) && !legs.some(l => l.kind === 'pick' && l.pickId === p.id)).map(p => ({ value: p.id, label: pickLabel(p.id) }));

  function addEntry() {
    setError('');
    if (!fromTeam || !toTeam || fromTeam === toTeam) { setError('Choose different sending and receiving teams.'); return; }
    if (legs.length >= 100) { setError('A trade can contain up to 100 entries.'); return; }
    const common = { key: String(++nextKey.current), fromTeamId: Number(fromTeam), toTeamId: Number(toTeam) };
    let leg: TradeDraftLeg;
    if (kind === 'obligation') {
      if (!obligationTerms.trim()) { setError('Describe the obligation before adding it.'); return; }
      if (dueAt && !Number.isFinite(new Date(dueAt).getTime())) { setError('Choose a valid due date or leave it blank.'); return; }
      leg = { ...common, kind, obligationKind, terms: obligationTerms.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null };
    } else {
      if (!choices.some(choice => choice.value === assetId)) { setError(`Choose a ${kind} currently owned by the sending team.`); return; }
      leg = kind === 'player' ? { ...common, kind, playerId: Number(assetId) } : { ...common, kind, pickId: assetId };
    }
    setLegs(current => [...current, leg]); setAssetId(''); setObligationTerms(''); setDueAt('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (disabled) return;
    if (assetId || obligationTerms.trim() || dueAt) { setError('Add the entry currently in the editor, or clear it, before logging the trade.'); return; }
    if (await onLog(category, terms, legs)) { setLegs([]); setTerms(''); setFromTeam(''); setToTeam(''); }
  }
  return <form className={styles.form} onSubmit={event => void submit(event)}>
    <fieldset className={styles.fieldset} disabled={disabled}>
      <div className={styles.fields}>
        <label className={styles.field} htmlFor={`${id}-category`}>Trade category<select id={`${id}-category`} value={category} onChange={event => {
          const next = event.target.value as TradeCategory;
          if (next === 'player_only' && legs.some(l => l.kind !== 'player')) { setError('Remove pick and obligation entries before changing to Player only.'); return; }
          setCategory(next); if (next === 'player_only') { setKind('player'); setAssetId(''); setObligationTerms(''); setDueAt(''); }
        }}><option value="advanced">Advanced · players, picks & obligations</option><option value="player_only">Player only</option></select></label>
      </div>
      <div className={styles.entry}>
        <h4>Add a transfer or obligation</h4>
        <div className={styles.fields}>
          <label className={styles.field} htmlFor={`${id}-kind`}>Entry type<select id={`${id}-kind`} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setAssetId(''); setObligationTerms(''); setDueAt(''); }}><option value="player">Player</option>{category === 'advanced' && <><option value="pick">Draft pick</option><option value="obligation">Obligation</option></>}</select></label>
          <label className={styles.field} htmlFor={`${id}-from`}>{kind === 'obligation' ? 'Responsible team' : 'Sending team'}<select id={`${id}-from`} value={fromTeam} onChange={event => { setFromTeam(event.target.value); setAssetId(''); }}><option value="">Choose team</option>{account.data.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className={styles.field} htmlFor={`${id}-to`}>Receiving team<select id={`${id}-to`} value={toTeam} onChange={event => setToTeam(event.target.value)}><option value="">Choose team</option>{account.data.teams.filter(t => String(t.id) !== fromTeam).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        </div>
        <div className={styles.stack} style={{ marginTop: 15 }}>
          {kind !== 'obligation' ? <label className={styles.field} htmlFor={`${id}-asset`}>{kind === 'player' ? 'Player' : 'Draft pick'}<select id={`${id}-asset`} value={assetId} onChange={event => setAssetId(event.target.value)} disabled={!fromTeam || disabled}><option value="">{!fromTeam ? 'Choose a sending team first' : choices.length ? `Choose ${kind}` : `No available ${kind === 'player' ? 'players' : 'picks'}`}</option>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label> : <>
            <div className={styles.fields}><label className={styles.field} htmlFor={`${id}-obligation`}>Obligation type<select id={`${id}-obligation`} value={obligationKind} onChange={event => setObligationKind(event.target.value as ObligationKind)}>{Object.entries(obligationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field} htmlFor={`${id}-due`}>Due date, optional<input id={`${id}-due`} type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)}/><small>Uses your local time zone.</small></label></div>
            <label className={styles.field} htmlFor={`${id}-obligation-terms`}>Obligation terms<textarea id={`${id}-obligation-terms`} rows={3} maxLength={10000} value={obligationTerms} onChange={event => setObligationTerms(event.target.value)} placeholder="Describe who must do what, including conditions or the loan return."/></label>
          </>}
        </div>
        <div className={styles.actions}><button className="button button-subtle" type="button" onClick={addEntry}>Add entry</button><button className="text-button" type="button" onClick={() => { setAssetId(''); setObligationTerms(''); setDueAt(''); setError(''); }}>Clear entry</button></div>
      </div>
      {legs.length > 0 && <ul className={styles.legs}>{legs.map(leg => <li key={leg.key}><span><strong>{teamName(leg.fromTeamId)} → {teamName(leg.toTeamId)}</strong><br/>{leg.kind === 'player' ? account.data.players.find(p => p.id === leg.playerId)?.name || 'Player unavailable' : leg.kind === 'pick' ? pickLabel(leg.pickId) : `${obligationLabels[leg.obligationKind]}: ${leg.terms}${leg.dueAt ? ` · due ${dateLabel(leg.dueAt)}` : ''}`}</span><button className={styles.remove} type="button" onClick={() => setLegs(current => current.filter(item => item.key !== leg.key))} aria-label={`Remove entry from ${teamName(leg.fromTeamId)} to ${teamName(leg.toTeamId)}`}>Remove</button></li>)}</ul>}
      <label className={styles.field} htmlFor={`${id}-terms`} style={{ marginTop: 18 }}>Overall trade terms, optional<textarea id={`${id}-terms`} rows={3} maxLength={10000} value={terms} onChange={event => setTerms(event.target.value)} placeholder="Record the agreement and any context needed for review."/><small>Use the obligation entries above for commitments that need a resolution later.</small></label>
      {error && <p className="workflow-message workflow-error" role="alert">{error}</p>}
      <div className={styles.actions}><button className="button button-green" type="submit" disabled={disabled || legs.length === 0}>{saving ? 'Logging trade…' : 'Log trade for review'}</button></div>
      <p className={styles.draftNote}>Logging starts the 24-hour review period. Ownership changes only when the commissioner finalizes the trade. ESPN actions must also be completed in ESPN.</p>
    </fieldset>
  </form>;
}

function ObligationResolution({ obligation, disabled, onResolve }: { obligation: Obligation; disabled: boolean; onResolve: (id: string, status: 'fulfilled' | 'waived', note: string) => Promise<boolean> }) {
  const id = useId();
  const [status, setStatus] = useState<'fulfilled' | 'waived'>('fulfilled');
  const [note, setNote] = useState('');
  return <form className={styles.resolution} onSubmit={event => { event.preventDefault(); if (!disabled && note.trim()) void onResolve(obligation.id, status, note.trim()).then(saved => { if (saved) setNote(''); }); }}>
    <label className={styles.field} htmlFor={`${id}-status`}>Resolution<select id={`${id}-status`} value={status} onChange={event => setStatus(event.target.value as typeof status)} disabled={disabled}><option value="fulfilled">Fulfilled</option><option value="waived">Waived</option></select></label>
    <label className={styles.field} htmlFor={`${id}-reason`}>Resolution reason<textarea id={`${id}-reason`} rows={2} maxLength={2000} required value={note} onChange={event => setNote(event.target.value)} disabled={disabled}/></label>
    <div><button className="button button-subtle" type="submit" disabled={disabled || !note.trim()}>Record resolution</button></div>
  </form>;
}

export function TradeWorkspace({ account }: { account: LeagueAccount }) {
  const id = useId();
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const live = account.connection === 'live' && Boolean(account.live);
  const signedIn = Boolean(account.session?.user);
  const readable = live && signedIn;
  const canLog = readable && Boolean(account.session?.memberships.some(m => m.league_id === identities.leagueId && ['manager', 'commissioner'].includes(m.role)));
  const seasonId = account.live?.seasonId;

  const loadTrades = useCallback(async (signal?: AbortSignal) => {
    if (!readable || !seasonId) return null;
    setLoading(true); setLoadError('');
    try {
      const result = await readResponse<{ trades: LiveTrade[] }>(await fetch(`/api/trades?seasonId=${encodeURIComponent(seasonId)}`, { cache: 'no-store', credentials: 'same-origin', signal }));
      if (!Array.isArray(result.trades)) throw new Error('The trade service returned an unexpected record list.');
      setTrades(result.trades); setLoaded(true); return result.trades;
    } catch (failure) {
      if (signal?.aborted) return null;
      setLoaded(false); setLoadError(failure instanceof Error ? failure.message : 'Trade records could not be loaded.'); return null;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [readable, seasonId]);

  useEffect(() => { const controller = new AbortController(); void loadTrades(controller.signal); return () => controller.abort(); }, [loadTrades, account.session?.user?.id]);
  useEffect(() => { if (!readable) return; const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, [readable]);

  async function refresh() {
    const results = await Promise.all([loadTrades(), account.reloadLeague()]);
    const succeeded = results.every(result => result !== null);
    setNeedsRefresh(!succeeded);
    return succeeded;
  }
  const disabled = !readable || !loaded || loading || Boolean(busy) || Boolean(account.actionBusy) || needsRefresh || account.live?.phase === 'archived';
  async function write(path: string, body: unknown, key: string, message: string) {
    if (disabled || busyRef.current) return false;
    busyRef.current = true; setBusy(key); setError(''); setNotice('');
    let saved = false;
    try {
      await readResponse(await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      saved = true; setNotice(message);
      if (!await refresh()) setError('The change was saved, but current records could not be reloaded. Reload before making another change.');
      return true;
    } catch (failure) {
      setNeedsRefresh(true);
      setError(saved ? 'The change was saved, but records could not be reloaded. Reload to continue.' : `${failure instanceof Error ? failure.message : 'The request could not be completed.'} Reload records to check the latest state before retrying.`);
      return saved;
    } finally { busyRef.current = false; setBusy(null); }
  }
  async function logTrade(category: TradeCategory, terms: string, legs: TradeDraftLeg[]) {
    if (!canLog || !account.live) return false;
    try {
      const body = serializeTradeDraft({ seasonId: account.live.seasonId, category, terms, legs, data: account.data, franchiseIds: account.live.franchiseIds, usedPickIds: account.live.usedPickIds || [] });
      return await write('/api/trades', body, 'log', 'Trade logged for commissioner review. The review period is at least 24 hours; ownership has not changed.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review the trade entries.'); return false; }
  }
  const teamName = (franchiseId: string) => account.data.teams.find(t => account.franchiseId(t.id) === franchiseId)?.name || 'League team';
  const pending = trades.filter(t => t.status === 'proposed' && t.application_mode === 'live');
  const finalized = trades.filter(t => t.status === 'finalized' && t.application_mode === 'live');

  function renderTrade(trade: LiveTrade) {
    const deadlineReached = Number.isFinite(Date.parse(trade.review_deadline)) && now >= Date.parse(trade.review_deadline);
    const finalizable = !disabled && account.commissioner && deadlineReached && Boolean(account.live?.tradingOpenedAt);
    return <article className={styles.record} key={trade.id}>
      <div className={styles.heading}><div><h4>{trade.trade_participants.map(p => teamName(p.franchise_id)).join(' ↔ ')}</h4><span className={styles.date}>{trade.category === 'player_only' ? 'Player only' : 'Advanced'} · logged {dateLabel(trade.created_at)}</span></div><span className={styles.status}>{trade.status === 'proposed' ? 'Pending review' : 'Finalized'}</span></div>
      <ul className={styles.moves}>
        {trade.trade_player_transfers.map(leg => <li key={`player-${leg.player_id}`}>{teamName(leg.from_franchise_id)} → {teamName(leg.to_franchise_id)}: <strong>{account.data.players.find(p => p.id === Number(leg.player_id))?.name || `Player ${leg.player_id}`}</strong></li>)}
        {trade.trade_pick_transfers.map(leg => { const pick = account.data.picks.find(p => p.id === leg.pick_id); return <li key={`pick-${leg.pick_id}`}>{teamName(leg.from_franchise_id)} → {teamName(leg.to_franchise_id)}: <strong>{pick ? `${pick.season} round ${pick.round}` : 'Draft pick'}</strong>{pick && ` (originally ${account.data.teams.find(t => t.id === pick.originalTeamId)?.name || 'League team'})`}</li>; })}
      </ul>
      {trade.terms && <p className={styles.terms}>{trade.terms}</p>}
      {trade.trade_obligations.map(obligation => <div className={styles.obligation} key={obligation.id}>
        <div className={styles.heading}><strong>{obligationLabels[obligation.kind]}</strong><span className={styles.status}>{obligation.status}</span></div>
        <p className={styles.help}>{teamName(obligation.from_franchise_id)} → {teamName(obligation.to_franchise_id)}{obligation.due_at && ` · due ${dateLabel(obligation.due_at)}`}</p>
        <p className={styles.terms}>{obligation.terms}</p>
        {obligation.resolution_note && <p className={styles.help}>Resolution: {obligation.resolution_note}</p>}
        {account.commissioner && trade.status === 'finalized' && obligation.status === 'open' && <ObligationResolution obligation={obligation} disabled={disabled} onResolve={(obligationId, status, note) => write('/api/trades/obligations', { obligationId, status, note }, obligationId, 'Obligation resolution recorded. This records completion or waiver; it does not execute a new asset transfer.')}/>}
      </div>)}
      {trade.status === 'proposed' && <>
        <p className={styles.window}>Review ends {dateLabel(trade.review_deadline)} (your local time).{!account.live?.tradingOpenedAt && ' Finalization also waits until every team has submitted keepers.'}</p>
        {account.commissioner && <div className={styles.actions}><button className="button button-green" disabled={!finalizable} onClick={() => void write('/api/trades/finalize', { tradeId: trade.id }, trade.id, 'Trade finalized. Player and pick ownership records have been updated together.')}>{busy === trade.id ? 'Finalizing…' : 'Finalize trade & update ownership'}</button></div>}
      </>}
    </article>;
  }

  return <section className="panel" aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><p className="eyebrow">CURRENT SEASON TRADES</p><h2 id={`${id}-title`}>Trade workspace</h2></div></div>
    <div className={styles.intro}>
      <p>Log multi-team agreements, review each player and pick transfer, and track loan returns or other commitments. Finalization checks current ownership and keeper commitments.</p>
      {!readable && <div className={styles.readonly} style={{ marginTop: 14 }}><p>{!live ? 'Read-only preview. Live trade actions become available after the league connection and account setup are ready.' : 'The archive below is public. Sign in with a league account to view the trade review workspace; active managers can log trades.'}</p>{!signedIn && <AccountButton account={account} className="button button-subtle" label="Sign in for league actions"/>}</div>}
      {readable && <div className={styles.actions}><button className="button button-subtle" disabled={loading || Boolean(busy) || Boolean(account.actionBusy)} onClick={() => void refresh()}>Reload trades & ownership</button></div>}
      {notice && <p className="workflow-message workflow-success" role="status">{notice}</p>}
      {error && <p className="workflow-message workflow-error" role="alert">{error}</p>}
      {loadError && <p className="workflow-message workflow-error" role="alert">{loadError} Actions are paused until records are reloaded.</p>}
      {readable && loading && <p className={styles.busy} role="status">Loading trade records…</p>}
      {needsRefresh && <p className={styles.busy}>Reload the latest records before continuing.</p>}
    </div>
    {readable && <>
      <div className={styles.body}>
        <div className={styles.toolbar}><h3>Log a new trade</h3><span className={styles.help}>Season {account.data.season}</span></div>
        {canLog ? <TradeComposer account={account} disabled={disabled} saving={busy === 'log'} onLog={logTrade}/> : <p className={styles.empty}>An active manager or commissioner membership is required to log trades.</p>}
        {account.live?.phase === 'archived' && <p className={styles.help}>This season is archived. Trade changes are disabled.</p>}
      </div>
      <div className={styles.section}>
        <h3>Pending commissioner review</h3><p className={styles.help}>These proposals have not changed ownership. You can see the proposals permitted by your team assignments; the commissioner can review every proposal.</p>
        <div className={styles.records}>{pending.map(renderTrade)}</div>
        {loaded && pending.length === 0 && <p className={styles.empty}>No pending trades are visible to your account.</p>}
        <details className={styles.history} open={finalized.some(t => t.trade_obligations.some(o => o.status === 'open'))}>
          <summary>Finalized current-season trades & obligations ({finalized.length})</summary>
          <div className={styles.records}>{finalized.map(renderTrade)}</div>
          {loaded && finalized.length === 0 && <p className={styles.empty}>No live trades have been finalized for this season.</p>}
        </details>
      </div>
    </>}
  </section>;
}
