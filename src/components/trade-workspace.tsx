'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { emptyTradeDraft, hasTradeDraftChanges, isTradeComposerDraft, serializeTradeDraft, type TradeComposerDraft, type ObligationKind, type TradeCategory, type TradeDraftLeg } from '@/lib/trade-workspace';
import { AccountButton, type LeagueAccount } from './league-account';
import styles from './trade-workspace.module.css';
import { workflowDraftKey, workflowDrafts } from '@/lib/workflow-drafts';
import { useWorkflowDraft } from './use-workflow-draft';
import { buildTradePickInventory, type TradePickInventory } from '@/lib/trade-pick-inventory';
import { isValidKeeperPaymentAllocation, keeperPaymentOptions, type PaymentAssignment } from '@/lib/keeper-payment-options';
import { PaymentAllocationFields, paymentAssignments, paymentInput, paymentKey, paymentStatusEligible } from './keeper-payment-editor';
import { tradeLedgerLabel } from '@/lib/live-trade-ledger';

type Transfer = { from_franchise_id: string; to_franchise_id: string };
type Obligation = Transfer & { id: string; kind: ObligationKind; terms: string; due_at: string | null; status: 'open' | 'fulfilled' | 'waived'; resolution_note: string | null };
type LiveTrade = {
  id: string; category: TradeCategory; status: 'proposed' | 'finalized' | 'cancelled';
  terms: string; cancelled_at: string | null; cancellation_reason: string | null; corrects_trade_id: string | null; created_at: string; review_deadline: string; application_mode: 'live' | 'record_only';
  trade_participants: { franchise_id: string }[];
  trade_player_transfers: (Transfer & { player_id: number; espn_status: string })[];
  trade_pick_transfers: (Transfer & { pick_id: string })[];
  trade_obligations: Obligation[];
};
const obligationLabels: Record<ObligationKind, string> = {
  loan_return: 'Loan return', conditional_pick: 'Conditional pick', espn_action: 'ESPN action', other: 'Other obligation',
};
const playerTradePause = 'Player trades are paused after keeper reveal until draft rosters are finalized.';
function playerTradesPaused(account: LeagueAccount) {
  const finalized = account.live?.phase === 'in_season' && Boolean(account.live.draftFinalizedAt);
  return Boolean(account.live?.keepersRevealedAt || account.live?.phase === 'in_season') && !finalized;
}
function reusableTradePickIds(account: LeagueAccount) {
  return new Set(account.live?.draftStarted === false ? account.live.revealedKeepers.filter(keeper => account.data.picks.some(pick => pick.id === keeper.pickId && pick.season === account.data.season)).map(keeper => keeper.pickId) : []);
}
function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not set';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json().catch(() => null) as { message?: string } | null;
  if (!response.ok) throw new Error(result?.message || (response.status === 401 ? 'Sign in again to continue.' : response.status === 403 ? 'Your league role does not allow this action.' : 'The trade service could not complete this request.'));
  if (!result) throw new Error('The trade service returned an unexpected response. Refresh records to check the outcome.');
  return result as T;
}

function TradeComposer({ account, inventory, disabled, saving, onLog }: {
  account: LeagueAccount; inventory: TradePickInventory | null; disabled: boolean; saving: boolean;
  onLog: (category: TradeCategory, terms: string, legs: TradeDraftLeg[], correctsTradeId: string | null) => Promise<boolean>;
}) {
  const id = useId();
  const draftKey = workflowDraftKey(account.session!.user!.id, account.seasonId, 'trade');
  const { draft, updateDraft, discardDraft, clearSubmittedDraft, persisted } = useWorkflowDraft(draftKey, emptyTradeDraft(playerTradesPaused(account)), isTradeComposerDraft);
  const { category, terms, legs, kind, fromTeam, toTeam, assetId, obligationKind, obligationTerms, dueAt } = draft;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const setCategory = (value: TradeComposerDraft['category']) => updateDraft({ category: value });
  const setTerms = (value: TradeComposerDraft['terms']) => updateDraft({ terms: value });
  const setKind = (value: TradeComposerDraft['kind']) => updateDraft({ kind: value });
  const setFromTeam = (value: TradeComposerDraft['fromTeam']) => updateDraft({ fromTeam: value });
  const setToTeam = (value: TradeComposerDraft['toTeam']) => updateDraft({ toTeam: value });
  const setAssetId = (value: TradeComposerDraft['assetId']) => updateDraft({ assetId: value });
  const setObligationKind = (value: TradeComposerDraft['obligationKind']) => updateDraft({ obligationKind: value });
  const setObligationTerms = (value: TradeComposerDraft['obligationTerms']) => updateDraft({ obligationTerms: value });
  const setDueAt = (value: TradeComposerDraft['dueAt']) => updateDraft({ dueAt: value });
  const setLegs = (value: TradeDraftLeg[] | ((current: TradeDraftLeg[]) => TradeDraftLeg[])) => updateDraft({ legs: typeof value === 'function' ? value(legs) : value });
  const [error, setError] = useState('');
  const pickYear = draft.pickYear || String(account.data.season);
  const picks = inventory?.picks ?? [];
  const reusable = reusableTradePickIds(account);
  const playersPaused = playerTradesPaused(account);
  const blockedPlayerLegs = playersPaused && legs.some(leg => leg.kind === 'player');
  const blockedCategory = playersPaused && category === 'player_only';
  const teamName = (teamId: number) => account.data.teams.find(t => t.id === teamId)?.shortName || 'League team';
  const pickLabel = (pickId: string) => {
    const pick = picks.find(p => p.id === pickId);
    return pick ? `${pick.season} round ${pick.round} · originally ${teamName(pick.originalTeamId)}${reusable.has(pick.id) ? ' · keeper payment; reassignment required' : ''}` : 'Pick unavailable';
  };
  const choices = kind === 'player'
    ? account.data.players.filter(p => p.teamId === Number(fromTeam) && !legs.some(l => l.kind === 'player' && l.playerId === p.id)).map(p => ({ value: String(p.id), label: p.name }))
    : picks.filter(p => p.season === Number(pickYear) && p.ownerTeamId === Number(fromTeam) && (!inventory?.usedPickIds.includes(p.id) || reusable.has(p.id)) && !legs.some(l => l.kind === 'pick' && l.pickId === p.id)).map(p => ({ value: p.id, label: pickLabel(p.id) }));

  function addEntry() {
    setError('');
    if (disabled) return;
    if (playersPaused && kind === 'player') { setError(`${playerTradePause} Choose Draft pick or Obligation to add an entry.`); return; }
    if (!fromTeam || !toTeam || fromTeam === toTeam) { setError('Choose different sending and receiving teams.'); return; }
    if (legs.length >= 100) { setError('A trade can contain up to 100 entries.'); return; }
    const common = { key: crypto.randomUUID(), fromTeamId: Number(fromTeam), toTeamId: Number(toTeam) };
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
    if (blockedPlayerLegs) { setError(`${playerTradePause} Remove the player entries before logging this trade. Your existing entries have been kept.`); return; }
    if (blockedCategory) { setError('Choose Advanced to log pick transfers or obligations during the player-trade pause.'); return; }
    if (assetId || obligationTerms.trim() || dueAt) { setError('Add the entry currently in the editor, or clear it, before logging the trade.'); return; }
    if (await onLog(category, terms, legs, draft.correctsTradeId)) clearSubmittedDraft(draft);
  }
  return <form className={styles.form} onSubmit={event => void submit(event)}>
    <p className={styles.help} role="status">{hasTradeDraftChanges(draft) ? persisted ? 'Private draft saved in this tab. You can visit another section or refresh and return. It is cleared when you sign out or close this tab.' : 'Private draft kept while this page stays open. Browser storage is unavailable; refreshing or closing this tab may lose it.' : 'Your private draft is saved in this tab as you type. Logging submits it for review.'}</p>
    {draft.correctsTradeId && <p className={styles.help}>Revises a withdrawn proposal. Logging this draft starts a new 24-hour review period.</p>}
    {hasTradeDraftChanges(draft) && <div className={styles.actions}>{confirmDiscard ? <><span className={styles.help}>Discard all unsent entries and terms?</span><button className="button button-subtle" type="button" disabled={saving} onClick={() => { discardDraft(); setConfirmDiscard(false); setError(''); }}>Discard private draft</button><button className="text-button" type="button" onClick={() => setConfirmDiscard(false)}>Keep editing</button></> : <button className="text-button" type="button" disabled={saving} onClick={() => setConfirmDiscard(true)}>Discard draft…</button>}</div>}
    <fieldset className={styles.fieldset} disabled={disabled}>
      <div className={styles.fields}>
        <label className={styles.field} htmlFor={`${id}-category`}>Trade category<select id={`${id}-category`} value={category} onChange={event => {
          const next = event.target.value as TradeCategory;
          if (playersPaused && next === 'player_only') { setError(playerTradePause); return; }
          if (next === 'player_only' && legs.some(l => l.kind !== 'player')) { setError('Remove pick and obligation entries before changing to Player only.'); return; }
          setCategory(next); if (next === 'player_only') { setKind('player'); setAssetId(''); setObligationTerms(''); setDueAt(''); }
        }}><option value="advanced">{playersPaused ? 'Advanced · picks & obligations' : 'Advanced · players, picks & obligations'}</option><option value="player_only" disabled={playersPaused}>{playersPaused ? 'Player only · paused' : 'Player only'}</option></select></label>
      </div>
      {blockedCategory && <p className={styles.help} role="status">Choose Advanced to log pick transfers or obligations during the player-trade pause.</p>}
      <div className={styles.entry}>
        <h4>Add a transfer or obligation</h4>
        <div className={styles.fields}>
          <label className={styles.field} htmlFor={`${id}-kind`}>Entry type<select id={`${id}-kind`} value={kind} onChange={event => { if (playersPaused && event.target.value === 'player') { setError(playerTradePause); return; } setKind(event.target.value as typeof kind); setAssetId(''); setObligationTerms(''); setDueAt(''); }}><option value="player" disabled={playersPaused}>{playersPaused ? 'Player · paused' : 'Player'}</option>{category === 'advanced' && <><option value="pick">Draft pick</option><option value="obligation">Obligation</option></>}</select></label>
          <label className={styles.field} htmlFor={`${id}-from`}>{kind === 'obligation' ? 'Responsible team' : 'Sending team'}<select id={`${id}-from`} value={fromTeam} onChange={event => { setFromTeam(event.target.value); setAssetId(''); }}><option value="">Choose team</option>{account.data.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className={styles.field} htmlFor={`${id}-to`}>Receiving team<select id={`${id}-to`} value={toTeam} onChange={event => setToTeam(event.target.value)}><option value="">Choose team</option>{account.data.teams.filter(t => String(t.id) !== fromTeam).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        </div>
        <div className={styles.stack} style={{ marginTop: 15 }}>
          {kind === 'pick' && <label className={styles.field} htmlFor={`${id}-pick-year`}>Draft year<select id={`${id}-pick-year`} value={pickYear} onChange={event => updateDraft({ pickYear: event.target.value, assetId: '' })}>{(inventory?.years ?? [account.data.season]).map(year => <option key={year} value={year}>{year} draft</option>)}</select><small>Add one entry from each draft year to record a cross-year pick swap.</small></label>}
          {kind !== 'obligation' ? <label className={styles.field} htmlFor={`${id}-asset`}>{kind === 'player' ? 'Player' : 'Draft pick'}<select id={`${id}-asset`} value={assetId} onChange={event => setAssetId(event.target.value)} disabled={!fromTeam || disabled || (playersPaused && kind === 'player')}><option value="">{!fromTeam ? 'Choose a sending team first' : choices.length ? `Choose ${kind}` : `No available ${kind === 'player' ? 'players' : 'picks'}`}</option>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label> : <>
            <div className={styles.fields}><label className={styles.field} htmlFor={`${id}-obligation`}>Obligation type<select id={`${id}-obligation`} value={obligationKind} onChange={event => setObligationKind(event.target.value as ObligationKind)}>{Object.entries(obligationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field} htmlFor={`${id}-due`}>Due date, optional<input id={`${id}-due`} type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)}/><small>Uses your local time zone.</small></label></div>
            <label className={styles.field} htmlFor={`${id}-obligation-terms`}>Obligation terms<textarea id={`${id}-obligation-terms`} rows={3} maxLength={10000} value={obligationTerms} onChange={event => setObligationTerms(event.target.value)} placeholder="Describe who must do what, including conditions or the loan return."/></label>
          </>}
        </div>
        {playersPaused && kind === 'player' && <p className={styles.help}>Player entries are paused. Choose Advanced, then Draft pick or Obligation, to continue. Clear or change the entry type to discard an unfinished player selection.</p>}
        <div className={styles.actions}><button className="button button-subtle" type="button" disabled={playersPaused && kind === 'player'} onClick={addEntry}>Add entry</button><button className="text-button" type="button" onClick={() => { setAssetId(''); setObligationTerms(''); setDueAt(''); setError(''); }}>Clear entry</button></div>
      </div>
      {legs.length > 0 && <ul className={styles.legs}>{legs.map(leg => <li key={leg.key}><span><strong>{teamName(leg.fromTeamId)} → {teamName(leg.toTeamId)}</strong><br/>{leg.kind === 'player' ? account.data.players.find(p => p.id === leg.playerId)?.name || 'Player unavailable' : leg.kind === 'pick' ? pickLabel(leg.pickId) : `${obligationLabels[leg.obligationKind]}: ${leg.terms}${leg.dueAt ? ` · due ${dateLabel(leg.dueAt)}` : ''}`}</span><button className={styles.remove} type="button" onClick={() => setLegs(current => current.filter(item => item.key !== leg.key))} aria-label={`Remove entry from ${teamName(leg.fromTeamId)} to ${teamName(leg.toTeamId)}`}>Remove</button></li>)}</ul>}
      {blockedPlayerLegs && <p className="workflow-message" role="status">Your draft entries have been kept. Remove the player entries before logging this trade; player transfers are paused until draft rosters are finalized.</p>}
      <label className={styles.field} htmlFor={`${id}-terms`} style={{ marginTop: 18 }}>Overall trade terms, optional<textarea id={`${id}-terms`} rows={3} maxLength={10000} value={terms} onChange={event => setTerms(event.target.value)} placeholder="Record the agreement and any context needed for review."/><small>Use the obligation entries above for commitments that need a resolution later.</small></label>
      {error && <p className="workflow-message workflow-error" role="alert">{error}</p>}
      <div className={styles.actions}><button className="button button-green" type="submit" disabled={disabled || legs.length === 0 || blockedPlayerLegs || blockedCategory}>{saving ? 'Logging trade…' : 'Log trade for review'}</button></div>
      <p className={styles.draftNote}>Logging starts the default 24-hour review. The commissioner can finalize early with a recorded reason. Ownership changes on finalization; ESPN actions must also be completed in ESPN.</p>
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

function TradeWithdrawal({ disabled, busy, onWithdraw }: { disabled: boolean; busy: boolean; onWithdraw: (reason: string) => Promise<boolean> }) {
  const id = useId();
  const [reason, setReason] = useState('');
  return <details className={styles.history}>
    <summary>Withdraw pending trade</summary>
    <form className={styles.resolution} onSubmit={event => { event.preventDefault(); if (!disabled && reason.trim().length >= 5) void onWithdraw(reason.trim()).then(saved => { if (saved) setReason(''); }); }}>
      <p className={styles.help}>Use this to record a withdrawn agreement or correct a logging error. Ownership stays unchanged and the proposal remains in the withdrawal history. A revised proposal starts a new 24-hour review period.</p>
      <label className={styles.field} htmlFor={`${id}-reason`}>Withdrawal reason<textarea id={`${id}-reason`} rows={2} minLength={5} maxLength={2000} required value={reason} onChange={event => setReason(event.target.value)} disabled={disabled} aria-describedby={`${id}-help`}/><small id={`${id}-help`}>Required · at least 5 characters. Visible to managers who can access this trade.</small></label>
      <div><button className="button button-subtle" type="submit" disabled={disabled || reason.trim().length < 5}>{busy ? 'Withdrawing…' : 'Withdraw and retain record'}</button></div>
    </form>
  </details>;
}

type TradePaymentChange = { submissionId: string; expectedRevision: number; assignments: PaymentAssignment[] };
type TradeFinalizationBody = { tradeId: string; keeperPayments?: TradePaymentChange[]; note?: string; overrideReview?: boolean };

function TradeFinalization({ account, trade, disabled, deadlineReached, busy, onFinalize }: {
  account: LeagueAccount; trade: LiveTrade; disabled: boolean; deadlineReached: boolean; busy: boolean; onFinalize: (body: TradeFinalizationBody) => Promise<boolean>;
}) {
  const id = useId();
  const [edits, setEdits] = useState<Record<string, TradePaymentChange> | null>(null);
  const [note, setNote] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const teamId = (franchise: string) => account.data.teams.find(team => account.franchiseId(team.id) === franchise)?.id;
  const currentTransfers = trade.trade_pick_transfers.filter(leg => account.data.picks.some(pick => pick.id === leg.pick_id && pick.season === account.data.season));
  const affected = new Set(currentTransfers.flatMap(leg => [leg.from_franchise_id, leg.to_franchise_id]));
  const submissions = account.keeperDeadlinePassed ? account.submissions.filter(submission => affected.has(submission.franchise_id) && paymentStatusEligible(submission) && submission.keeper_assignments.length) : [];
  const reusable = submissions.flatMap(submission => submission.keeper_assignments.map(assignment => assignment.pick_id));
  const prospectivePicks = account.data.picks.map(pick => {
    const transfer = currentTransfers.find(leg => leg.pick_id === pick.id);
    return transfer ? { ...pick, ownerTeamId: teamId(transfer.to_franchise_id) ?? -1 } : pick;
  });
  const groups = submissions.map(submission => {
    const input = paymentInput(account, submission, teamId(submission.franchise_id) ?? -1, prospectivePicks, reusable);
    const saved = paymentAssignments(submission);
    const edit = edits?.[submission.id];
    const assignments = edit?.assignments || saved;
    return { submission, input, saved, assignments, edit, valid: isValidKeeperPaymentAllocation(input, assignments), changed: paymentKey(saved) !== paymentKey(assignments) };
  });
  const stale = Boolean(edits && (groups.some(group => group.edit?.expectedRevision !== group.submission.revision) || Object.keys(edits).some(key => !groups.some(group => group.submission.id === key))));
  const changes = groups.filter(group => group.changed).map(group => group.edit!);
  const valid = groups.every(group => group.valid);
  const paymentsAvailable = Boolean(account.live?.keeperPaymentInventory) && account.live?.draftStarted === false && ['keeper_selection', 'draft_ready'].includes(account.live?.phase || '') && account.submissionsLoaded && !account.loadingSubmissions && !account.reloadRequired;
  const blocked = disabled || stale || !valid || (currentTransfers.length > 0 && (!account.submissionsLoaded || account.loadingSubmissions)) || (changes.length > 0 && !paymentsAvailable);
  const reasonValid = note.trim().length >= 5 && note.trim().length <= 2000;
  function beginPayments() {
    setEdits(Object.fromEntries(groups.map(group => [group.submission.id, { submissionId: group.submission.id, expectedRevision: group.submission.revision, assignments: keeperPaymentOptions(group.input).assignments || group.saved }])));
  }
  async function finalize(early: boolean) {
    if (blocked || (!deadlineReached && !early)) return;
    if ((early || changes.length > 0) && !reasonValid) {
      setReasonError(true);
      noteRef.current?.focus();
      return;
    }
    setReasonError(false);
    const body: TradeFinalizationBody = { tradeId: trade.id, ...(changes.length ? { keeperPayments: changes } : {}), ...((early || changes.length) ? { note: note.trim() } : {}), ...(early ? { overrideReview: true } : {}) };
    if (await onFinalize(body)) { setEdits(null); setNote(''); }
  }
  return <div className={styles.stack}>
    {groups.length > 0 && <details className={styles.history} open={Boolean(edits) || !valid}>
      <summary>Keeper payment picks for this trade</summary>
      <p className={styles.help}>The selected players stay fixed. Replacement payments must have belonged to the team at the keeper deadline and remain with it after this swap. Later-acquired picks cannot pay keeper costs. Changes are saved atomically with this trade.</p>
      {!valid && <p className="workflow-message workflow-error" role="alert">This swap needs valid replacement payment picks before it can be finalized.</p>}
      {stale && <p className="workflow-message workflow-error" role="alert">A keeper submission changed while you were editing. Your choices are preserved. Reload the payment plan from current records before finalizing.</p>}
      {!edits ? <button type="button" className="button button-subtle" disabled={disabled || !paymentsAvailable} onClick={beginPayments}>Review replacement payment picks</button> : <>
        {groups.map(group => <div className={styles.entry} key={group.submission.id}>
          <h4>{account.data.teams.find(team => account.franchiseId(team.id) === group.submission.franchise_id)?.name || 'League team'} · revision {group.edit?.expectedRevision}</h4>
          <PaymentAllocationFields account={account} input={group.input} assignments={group.assignments} disabled={disabled || stale || !paymentsAvailable} onChange={assignments => setEdits(current => ({ ...current, [group.submission.id]: { submissionId: group.submission.id, expectedRevision: group.edit!.expectedRevision, assignments } }))}/>
        </div>)}
        <div className={styles.actions}><button type="button" className="button button-subtle" disabled={disabled || !paymentsAvailable} onClick={beginPayments}>Reload payment plan from current records</button><button type="button" className="text-button" disabled={disabled} onClick={() => setEdits(null)}>Discard payment edits</button></div>
      </>}
      {!paymentsAvailable && <p className={styles.help}>{account.live?.draftStarted ? 'Payment changes are closed because the live draft has started.' : 'Refresh official keeper records to prepare payment changes.'}</p>}
    </details>}
    {(!deadlineReached || changes.length > 0) && <>
      <label className={styles.field} htmlFor={`${id}-note`}>Finalization reason (required)<textarea ref={noteRef} id={`${id}-note`} rows={2} minLength={5} maxLength={2000} required placeholder={!deadlineReached ? 'Why are you finalizing this trade before review ends?' : 'Why are the keeper payment picks changing?'} value={note} onChange={event => { setNote(event.target.value); if (event.target.value.trim().length >= 5) setReasonError(false); }} disabled={disabled} aria-invalid={reasonError || undefined} aria-describedby={`${id}-note-help${reasonError ? ` ${id}-note-error` : ''}`}/><small id={`${id}-note-help`}>Enter a reason of at least 5 characters, then finalize. Your reason is saved with the trade.</small></label>
      {reasonError && <p id={`${id}-note-error`} className="workflow-message workflow-error" role="alert">Enter a finalization reason of at least 5 characters above to continue.</p>}
    </>}
    <div className={styles.actions}>
      <button type="button" className={`button ${deadlineReached ? 'button-green' : 'button-orange'}`} disabled={blocked} onClick={() => void finalize(!deadlineReached)}>{busy ? 'Finalizing…' : deadlineReached ? 'Finalize trade & update ownership' : 'Finalize early & update ownership'}</button>
    </div>
    {!deadlineReached && <p className={styles.help}>As commissioner, you can finalize now. Add a reason above to end the review early and update ownership.</p>}
  </div>;
}

export function TradeWorkspace({ account }: { account: LeagueAccount }) {
  const scope = JSON.stringify([account.session?.user?.id, account.commissioner, [...account.ownTeamIds].sort((a, b) => a - b), account.live?.seasonId]);
  return <ScopedTradeWorkspace key={scope} account={account}/>;
}

function ScopedTradeWorkspace({ account }: { account: LeagueAccount }) {
  const id = useId();
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [inventory, setInventory] = useState<TradePickInventory | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [composerVersion, setComposerVersion] = useState(0);
  const composerHeading = useRef<HTMLHeadingElement>(null);
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
  const canLog = readable && (account.commissioner || account.ownTeamIds.length > 0);
  const seasonId = account.live?.seasonId;
  const playersPaused = playerTradesPaused(account);

  const loadTrades = useCallback(async (signal?: AbortSignal) => {
    if (!readable || !seasonId) return null;
    setLoading(true); setLoadError('');
    try {
      const [result, pickResponse] = await Promise.all([
        fetch(`/api/trades?seasonId=${encodeURIComponent(seasonId)}`, { cache: 'no-store', credentials: 'same-origin', signal }).then(response => readResponse<{ trades: LiveTrade[] }>(response)),
        fetch('/api/draft-picks', { cache: 'no-store', credentials: 'same-origin', signal }).then(response => readResponse<unknown>(response)),
      ]);
      if (!Array.isArray(result.trades)) throw new Error('The trade service returned an unexpected record list.');
      const liveInventory = buildTradePickInventory(pickResponse, account.data.season, account.live!.franchiseIds);
      if (signal?.aborted) return null;
      setInventory(liveInventory);
      setTrades(result.trades); setLoaded(true); setLastChecked(new Date().toISOString()); return result.trades;
    } catch (failure) {
      if (signal?.aborted) return null;
      setLoaded(false); setLoadError(failure instanceof Error ? failure.message : 'Trade records could not be loaded.'); return null;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [readable, seasonId, account.data.season, account.live?.franchiseIds]);

  useEffect(() => { const controller = new AbortController(); void loadTrades(controller.signal); return () => controller.abort(); }, [loadTrades, account.session?.user?.id]);
  useEffect(() => { if (!readable) return; const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, [readable]);

  async function refresh() {
    const results = await Promise.all([loadTrades(), account.refreshOfficial()]);
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
      if (!await refresh()) setError('The change was saved, but current records could not be refreshed. Refresh before making another change.');
      return true;
    } catch (failure) {
      setNeedsRefresh(true);
      setError(saved ? 'The change was saved, but records could not be refreshed. Refresh to continue.' : `${failure instanceof Error ? failure.message : 'The request could not be completed.'} Refresh records to check the latest state before retrying.`);
      return saved;
    } finally { busyRef.current = false; setBusy(null); }
  }
  async function logTrade(category: TradeCategory, terms: string, legs: TradeDraftLeg[], correctsTradeId: string | null) {
    if (!canLog || !account.live || !inventory) return false;
    if (playersPaused && (category === 'player_only' || legs.some(leg => leg.kind === 'player'))) { setError(`${playerTradePause} Remove player entries and choose Advanced to log picks or obligations.`); return false; }
    try {
      const reusable = reusableTradePickIds(account);
      const body = serializeTradeDraft({ seasonId: account.live.seasonId, category, terms, legs, data: { ...account.data, picks: inventory.picks }, franchiseIds: account.live.franchiseIds, usedPickIds: inventory.usedPickIds.filter(pickId => !reusable.has(pickId)), draftYear: account.data.season, pickParticipantIds: inventory.participantIdsByYear });
      return await write('/api/trades', { ...body, ...(correctsTradeId ? { correctsTradeId } : {}) }, 'log', 'Trade logged for a 24-hour review. The commissioner can finalize early with a recorded reason. Ownership has not changed.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review the trade entries.'); return false; }
  }
  const teamName = (franchiseId: string) => account.data.teams.find(t => account.franchiseId(t.id) === franchiseId)?.name || 'League team';
  const pending = trades.filter(t => t.status === 'proposed' && t.application_mode === 'live');
  const finalized = trades.filter(t => t.status === 'finalized' && t.application_mode === 'live');
  const withdrawn = trades.filter(t => t.status === 'cancelled' && t.application_mode === 'live');

  function reviseTrade(trade: LiveTrade) {
    if (!account.commissioner || disabled || !account.session?.user) return;
    const key = workflowDraftKey(account.session.user.id, account.seasonId, 'trade');
    const existing = workflowDrafts.read(key, isTradeComposerDraft);
    if (existing && hasTradeDraftChanges(existing)) {
      setError('You already have a private trade draft. Log or discard it before creating a revised draft.');
      composerHeading.current?.focus(); composerHeading.current?.scrollIntoView({ block: 'start' }); return;
    }
    const teamId = (franchise: string) => account.data.teams.find(team => account.franchiseId(team.id) === franchise)?.id;
    const legs: TradeDraftLeg[] = [];
    for (const transfer of trade.trade_player_transfers) {
      const from = teamId(transfer.from_franchise_id), to = teamId(transfer.to_franchise_id);
      if (from === undefined || to === undefined) { setError('A team in this trade is unavailable in the current season. Start a new draft with the current teams.'); return; }
      legs.push({ key: crypto.randomUUID(), kind: 'player', fromTeamId: from, toTeamId: to, playerId: Number(transfer.player_id) });
    }
    for (const transfer of trade.trade_pick_transfers) {
      const from = teamId(transfer.from_franchise_id), to = teamId(transfer.to_franchise_id);
      if (from === undefined || to === undefined) { setError('A team in this trade is unavailable in the current season. Start a new draft with the current teams.'); return; }
      legs.push({ key: crypto.randomUUID(), kind: 'pick', fromTeamId: from, toTeamId: to, pickId: transfer.pick_id });
    }
    for (const transfer of trade.trade_obligations) {
      const from = teamId(transfer.from_franchise_id), to = teamId(transfer.to_franchise_id);
      if (from === undefined || to === undefined) { setError('A team in this trade is unavailable in the current season. Start a new draft with the current teams.'); return; }
      legs.push({ key: crypto.randomUUID(), kind: 'obligation', fromTeamId: from, toTeamId: to, obligationKind: transfer.kind, terms: transfer.terms, dueAt: transfer.due_at });
    }
    workflowDrafts.write(key, { ...emptyTradeDraft(playersPaused), category: trade.category, terms: trade.terms, legs, correctsTradeId: trade.id });
    setComposerVersion(version => version + 1); setError(''); setNotice('Revised private draft created. Review every entry against current ownership, then log it for a new review period.');
    composerHeading.current?.focus(); composerHeading.current?.scrollIntoView({ block: 'start' });
  }

  function renderTrade(trade: LiveTrade) {
    const deadlineReached = Number.isFinite(Date.parse(trade.review_deadline)) && now >= Date.parse(trade.review_deadline);
    const playerTransferPaused = playersPaused && trade.trade_player_transfers.length > 0;
    const ledgerTrade = account.data.trades.find(record => record.id === trade.id);
    return <article className={styles.record} key={trade.id} id={`trade-${trade.id}`}>
      <div className={styles.heading}><div><h4>{ledgerTrade?.ledgerNumber !== undefined && `Trade ${tradeLedgerLabel(ledgerTrade)} · `}{trade.trade_participants.map(p => teamName(p.franchise_id)).join(' ↔ ')}</h4><span className={styles.date}>{trade.category === 'player_only' ? 'Player only' : 'Advanced'} · logged {dateLabel(trade.created_at)} · record {trade.id.slice(0, 8)}</span></div><span className={styles.status}>{trade.status === 'proposed' ? 'Pending review' : trade.status === 'cancelled' ? 'Withdrawn' : 'Finalized'}</span></div>
      {trade.corrects_trade_id && <p className={styles.help}>Revision of withdrawn proposal {trade.corrects_trade_id.slice(0, 8)}. The original is retained in withdrawal history.</p>}
      {trade.status === 'cancelled' && <p className={styles.window}>Withdrawn by the commissioner {dateLabel(trade.cancelled_at)}. Reason: {trade.cancellation_reason || 'No reason was recorded in the historical record.'} Ownership was not changed.</p>}
      <ul className={styles.moves}>
        {trade.trade_player_transfers.map(leg => <li key={`player-${leg.player_id}`}>{teamName(leg.from_franchise_id)} → {teamName(leg.to_franchise_id)}: <strong>{account.data.players.find(p => p.id === Number(leg.player_id))?.name || `Player ${leg.player_id}`}</strong></li>)}
        {trade.trade_pick_transfers.map(leg => { const pick = inventory?.picks.find(p => p.id === leg.pick_id); return <li key={`pick-${leg.pick_id}`}>{teamName(leg.from_franchise_id)} → {teamName(leg.to_franchise_id)}: <strong>{pick ? `${pick.season} round ${pick.round}` : 'Draft pick'}</strong>{pick && ` (originally ${account.data.teams.find(t => t.id === pick.originalTeamId)?.name || 'League team'})`}</li>; })}
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
        <p className={styles.window}>Review ends {dateLabel(trade.review_deadline)} (your local time). Keeper submissions are not required for trade finalization.</p>
        {playerTransferPaused && <p className={styles.window}>{playerTradePause} This proposal stays pending and cannot be finalized during the pause.</p>}
        {account.commissioner && <TradeFinalization account={account} trade={trade} disabled={disabled || playerTransferPaused} deadlineReached={deadlineReached} busy={busy === trade.id} onFinalize={body => write('/api/trades/finalize', body, trade.id, 'Trade finalized. Ownership transfers, keeper payment changes, and obligations have been recorded.')}/>}
        {account.commissioner && <TradeWithdrawal disabled={disabled} busy={busy === `withdraw-${trade.id}`} onWithdraw={reason => write('/api/trades/withdraw', { tradeId: trade.id, reason }, `withdraw-${trade.id}`, 'Trade withdrawn. The reason and original terms are retained; ownership has not changed.')}/>}
      </>}
      {trade.status === 'cancelled' && account.commissioner && <div className={styles.actions}><button className="button button-subtle" type="button" disabled={disabled} onClick={() => reviseTrade(trade)}>Create revised private draft</button></div>}
    </article>;
  }

  return <section className="panel" aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><p className="eyebrow">CURRENT SEASON TRADES</p><h2 id={`${id}-title`}>Trade workspace</h2></div></div>
    <div className={styles.intro}>
      <p>Log multi-team agreements, review each player and pick transfer, and track loan returns or other commitments. Finalization checks current ownership and keeper commitments.</p>
      {live && playersPaused && <p className="workflow-message" role="status">{playerTradePause} Pick transfers and obligations remain available under the usual trade rules.</p>}
      {!readable && <div className={styles.readonly} style={{ marginTop: 14 }}><p>{account.connection === 'error' ? 'The live league connection is unavailable. Private drafts are retained; refresh league records to restore official actions.' : !live ? 'Read-only preview. Live trade actions become available after the league connection and account setup are ready.' : 'The archive below is public. Sign in with a league account to view the trade review workspace; active managers can log trades.'}</p>{!signedIn && <AccountButton account={account} className="button button-subtle" label="Sign in for league actions"/>}</div>}
      {readable && <div className={styles.actions}><button className="button button-subtle" disabled={loading || Boolean(busy) || Boolean(account.actionBusy)} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>}
      {lastChecked && <p className={styles.help}>Trade records last checked {dateLabel(lastChecked)} (your local time).</p>}
      {notice && <p className="workflow-message workflow-success" role="status">{notice}</p>}
      {error && <p className="workflow-message workflow-error" role="alert">{error}</p>}
      {loadError && <p className="workflow-message workflow-error" role="alert">{loadError} Actions are paused until records are refreshed.</p>}
      {readable && loading && <p className={styles.busy} role="status">Loading trade records…</p>}
      {needsRefresh && <p className={styles.busy}>Refresh the latest records before continuing.</p>}
    </div>
    {readable && <>
      <div className={styles.body}>
        <div className={styles.toolbar}><h3 ref={composerHeading} tabIndex={-1}>Draft a new trade</h3><span className={styles.help}>Season {account.data.season}</span></div>
        {canLog ? <TradeComposer key={composerVersion} account={account} inventory={inventory} disabled={disabled} saving={busy === 'log'} onLog={logTrade}/> : <p className={styles.empty}>An active manager or commissioner membership is required to log trades.</p>}
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
        <details className={styles.history}>
          <summary>Withdrawn current-season trades ({withdrawn.length})</summary>
          <p className={styles.help}>Original terms and withdrawal reasons remain available to the commissioner and participating managers. Only pending trades can be withdrawn.</p>
          <div className={styles.records}>{withdrawn.map(renderTrade)}</div>
          {loaded && withdrawn.length === 0 && <p className={styles.empty}>No withdrawn trades are visible to your account.</p>}
        </details>
      </div>
    </>}
  </section>;
}
