'use client';

import { useId, useState } from 'react';
import { isValidKeeperPaymentAllocation, keeperPaymentOptions, type KeeperPaymentOptionsInput, type PaymentAssignment } from '@/lib/keeper-payment-options';
import type { DraftPick } from '@/lib/types';
import type { KeeperSubmission, LeagueAccount } from './league-account';
import styles from './keeper-payment-editor.module.css';

export const paymentStatusEligible = (submission: KeeperSubmission) => ['submitted', 'approved', 'locked'].includes(submission.status);
export const paymentAssignments = (submission: KeeperSubmission): PaymentAssignment[] => submission.keeper_assignments.map(item => ({ playerId: Number(item.player_id), pickId: item.pick_id }));
export const paymentKey = (assignments: PaymentAssignment[]) => JSON.stringify([...assignments].sort((a, b) => a.playerId - b.playerId).map(item => [item.playerId, item.pickId]));

export function paymentInput(account: LeagueAccount, submission: KeeperSubmission, teamId: number, picks: DraftPick[] = account.data.picks, reusablePickIds = submission.keeper_assignments.map(item => item.pick_id)): KeeperPaymentOptionsInput {
  return {
    season: account.data.season, teamId, picks,
    keepers: submission.keeper_assignments.map(item => ({ playerId: Number(item.player_id), pickId: item.pick_id, baseRound: item.base_round_at_submission ?? null })),
    usedPickIds: [...(account.live?.usedPickIds || []), ...account.submissions.filter(item => ['approved', 'locked'].includes(item.status)).flatMap(item => item.keeper_assignments.map(assignment => assignment.pick_id))],
    reusablePickIds,
  };
}

export function PaymentAllocationFields({ account, input, assignments, disabled, onChange }: {
  account: LeagueAccount; input: KeeperPaymentOptionsInput; assignments: PaymentAssignment[]; disabled: boolean; onChange: (assignments: PaymentAssignment[]) => void;
}) {
  const id = useId();
  const model = keeperPaymentOptions(input, assignments);
  const label = (pickId: string) => {
    const pick = input.picks.find(item => item.id === pickId);
    return pick ? `${pick.season} round ${pick.round} · originally ${account.data.teams.find(team => team.id === pick.originalTeamId)?.shortName || 'League team'}` : 'Pick unavailable';
  };
  return <div className={styles.rows}>
    <p className={styles.help}>Keeper players stay fixed. Each choice keeps the entire payment allocation valid; another payment may move with it. Review every row before saving.</p>
    {input.keepers.map(keeper => {
      const selected = assignments.find(item => item.playerId === keeper.playerId)?.pickId || '';
      const options = model.options[keeper.playerId] || [];
      const available = options.some(option => option.pickId === selected);
      return <label className={styles.field} key={keeper.playerId} htmlFor={`${id}-${keeper.playerId}`}>
        <strong>{account.data.players.find(player => player.id === keeper.playerId)?.name || `Player ${keeper.playerId}`}</strong>
        <span className={styles.help}>Submitted cost: {keeper.baseRound ? `round ${keeper.baseRound}` : 'unavailable'} · saved payment: {label(keeper.pickId)}</span>
        <select id={`${id}-${keeper.playerId}`} aria-label={`Payment pick for ${account.data.players.find(player => player.id === keeper.playerId)?.name || keeper.playerId}`} value={selected} disabled={disabled || !options.length} onChange={event => { const option = options.find(item => item.pickId === event.target.value); if (option) onChange(option.assignments); }}>
          {!available && <option value={selected} disabled>{label(selected)} · unavailable for this allocation</option>}
          {options.map(option => <option key={option.pickId} value={option.pickId}>{label(option.pickId)}</option>)}
        </select>
        {selected !== keeper.pickId && <span className={styles.change}>Payment changed: {label(selected)}</span>}
      </label>;
    })}
    {!model.assignments && <p className="workflow-message workflow-error" role="alert">No valid payment allocation is available with these picks. Refresh records or adjust the proposed pick transfers.</p>}
    {model.assignments && !isValidKeeperPaymentAllocation(input, assignments) && <button type="button" className="button button-subtle" disabled={disabled} onClick={() => onChange(model.assignments!)}>Use available valid payments</button>}
  </div>;
}

export function KeeperPaymentEditor({ account, teamId }: { account: LeagueAccount; teamId: number }) {
  const submission = account.submissionFor(teamId);
  if (!account.canManageTeam(teamId) || !submission || !paymentStatusEligible(submission) || !submission.keeper_assignments.length) return null;
  return <ScopedKeeperPaymentEditor key={`${account.session?.user?.id}:${account.seasonId}:${submission.id}`} account={account} teamId={teamId} submission={submission}/>;
}

function ScopedKeeperPaymentEditor({ account, teamId, submission }: { account: LeagueAccount; teamId: number; submission: KeeperSubmission }) {
  const id = useId();
  const [edit, setEdit] = useState<{ revision: number; assignments: PaymentAssignment[] } | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const input = paymentInput(account, submission, teamId);
  const stale = Boolean(edit && edit.revision !== submission.revision);
  const unavailable = account.connection !== 'live' || account.live?.draftStarted !== false || !['keeper_selection', 'draft_ready'].includes(account.live?.phase || '') || !account.submissionsLoaded || account.loadingSubmissions || Boolean(account.actionBusy) || account.reloadRequired;
  const dirty = Boolean(edit && paymentKey(edit.assignments) !== paymentKey(paymentAssignments(submission)));
  const valid = Boolean(edit && isValidKeeperPaymentAllocation(input, edit.assignments));
  function begin() { setEdit({ revision: submission.revision, assignments: paymentAssignments(submission) }); setNote(''); setNotice(''); }
  async function save() {
    if (!edit || unavailable || stale || !dirty || !valid || note.trim().length < 5) return;
    const saved = await account.runAction({ action: 'reassign_payments', submissionId: submission.id, expectedRevision: edit.revision, assignments: edit.assignments, note: note.trim() });
    if (saved) { setEdit(null); setNote(''); setNotice('Payment picks saved. Keeper players and submission status are unchanged.'); }
  }
  return <section className={styles.editor} aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Change payment picks</h3>
    <p className={styles.help}>Owners, co-managers, and the commissioner can update valid payment picks after the deadline and reveal, until the live draft starts.</p>
    {account.live?.draftStarted && <p role="status">Payment changes are closed because the live draft has started.</p>}
    {!edit ? <button type="button" className="button button-subtle" disabled={unavailable} onClick={begin}>Change payment picks</button> : <>
      <p className={styles.help}>Editing saved revision {edit.revision} · {submission.status}. Your keeper players cannot be added or removed here.</p>
      {stale && <p className="workflow-message workflow-error" role="alert">Saved keepers changed to revision {submission.revision}. Your unsaved choices are preserved. Load current payments before continuing.</p>}
      <PaymentAllocationFields account={account} input={input} assignments={edit.assignments} disabled={unavailable || stale} onChange={assignments => setEdit({ ...edit, assignments })}/>
      <label className={styles.field} htmlFor={`${id}-note`}>Reason for payment changes<textarea id={`${id}-note`} rows={2} minLength={5} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} disabled={unavailable || stale}/><span className={styles.help}>Required · at least 5 characters. Recorded with this revision.</span></label>
      <div className={styles.actions}><button type="button" className="button button-green" disabled={unavailable || stale || !dirty || !valid || note.trim().length < 5} onClick={() => void save()}>Save payment picks</button><button type="button" className="button button-subtle" disabled={Boolean(account.actionBusy)} onClick={() => { setEdit(null); setNote(''); }}>Cancel payment changes</button><button type="button" className="text-button" disabled={Boolean(account.actionBusy) || account.loadingSubmissions} onClick={() => void account.refreshOfficial().then(records => { const latest = records?.find(item => item.id === submission.id); if (latest) { setEdit({ revision: latest.revision, assignments: paymentAssignments(latest) }); setNote(''); } })}>Load current payments</button></div>
      {account.actionError && <p className="workflow-message workflow-error" role="alert">{account.actionError}</p>}
    </>}
    {notice && <p className="workflow-message workflow-success" role="status">{notice}</p>}
  </section>;
}
