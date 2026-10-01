'use client';

import { useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { LeaguePlayer } from '@/lib/types';
import type { LeagueAccount } from './league-account';

type Verification = 'confirmed' | 'provisional' | 'unresolved' | 'ineligible';
type ProfileReview = {
  baseRound: number | null;
  tenureYears: number | null;
  verification: Verification;
  note: string;
};

const fieldStyle: CSSProperties = { display: 'grid', gap: 8, fontSize: 12, fontWeight: 600 };
const inputStyle: CSSProperties = {
  width: '100%', minWidth: 0, minHeight: 44, padding: '10px 12px',
  border: '1px solid var(--line)', borderRadius: 6,
  background: 'var(--surface)', color: 'var(--ink)', font: 'inherit',
};
const helpStyle: CSSProperties = { fontSize: 11, fontWeight: 400, lineHeight: 1.8, color: 'var(--muted)' };
const verificationLabels: Record<Verification, string> = {
  confirmed: 'Confirmed eligible', provisional: 'Provisional', unresolved: 'Needs research', ineligible: 'Ineligible',
};

function profileVerification(player: LeaguePlayer, account: LeagueAccount): Verification {
  if (player.status === 'eligible') return 'confirmed';
  if (player.status === 'ineligible') return 'ineligible';
  return account.data.reviewItems.find(item => item.id === String(player.id))?.status === 'provisional'
    ? 'provisional' : 'unresolved';
}

function ProfileForm({ player, verification, draftRounds, disabled, saving, onSave }: {
  player: LeaguePlayer;
  verification: Verification;
  draftRounds: number;
  disabled: boolean;
  saving: boolean;
  onSave: (review: ProfileReview) => Promise<boolean>;
}) {
  const id = useId();
  const [baseRound, setBaseRound] = useState(player.baseCost === null ? '' : String(player.baseCost));
  const [tenure, setTenure] = useState(player.tenure === null ? '' : String(player.tenure));
  const [decision, setDecision] = useState<Verification>(verification);
  const [note, setNote] = useState('');
  const [validationError, setValidationError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setValidationError('');
    const cost = baseRound.trim() === '' ? null : Number(baseRound);
    const years = tenure.trim() === '' ? null : Number(tenure);
    if (cost !== null && (!Number.isInteger(cost) || cost < 1 || cost > draftRounds)) {
      setValidationError(`Enter a whole round from 1 to ${draftRounds}, or leave the cost blank if it is unknown.`); return;
    }
    if (years !== null && (!Number.isInteger(years) || years < 1 || years > 100)) {
      setValidationError('Enter a whole tenure of at least 1, or leave it blank if it is unknown. The initial season counts as year one.'); return;
    }
    if (decision === 'confirmed' && (cost === null || years === null || years >= 5)) {
      setValidationError('Confirmed eligibility needs a known cost and tenure from 1 to 4. A player at five years is ineligible under the current charter.'); return;
    }
    if (!note.trim()) { setValidationError('Add a review reason explaining the evidence behind this decision.'); return; }
    if (await onSave({ baseRound: cost, tenureYears: years, verification: decision, note: note.trim() })) setNote('');
  }

  return <form onSubmit={event => void submit(event)} style={{ marginTop: 20 }}>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ fontWeight: 700, fontSize: 13, marginBottom: 16 }}>Commissioner decision</legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: 16 }}>
        <label htmlFor={`${id}-round`} style={fieldStyle}>Base keeper round
          <input id={`${id}-round`} type="number" min={1} max={draftRounds} step={1} inputMode="numeric" value={baseRound} onChange={event => setBaseRound(event.target.value)} placeholder="Unknown" style={inputStyle} aria-describedby={`${id}-round-help`}/>
          <span id={`${id}-round-help`} style={helpStyle}>Upcoming keeper cost before the owner assigns a payment pick. Leave blank if unknown.</span>
        </label>
        <label htmlFor={`${id}-tenure`} style={fieldStyle}>Tenure in years
          <input id={`${id}-tenure`} type="number" min={1} max={100} step={1} inputMode="numeric" value={tenure} onChange={event => setTenure(event.target.value)} placeholder="Unknown" style={inputStyle} aria-describedby={`${id}-tenure-help`}/>
          <span id={`${id}-tenure-help`} style={helpStyle}>The initial season counts as year one. Five years makes a player ineligible.</span>
        </label>
      </div>
      <label htmlFor={`${id}-decision`} style={{ ...fieldStyle, marginTop: 16 }}>Verification
        <select id={`${id}-decision`} value={decision} onChange={event => setDecision(event.target.value as Verification)} style={inputStyle}>
          {Object.entries(verificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span style={helpStyle}>Provisional and unresolved profiles remain unavailable for official keeper submissions.</span>
      </label>
      <label htmlFor={`${id}-note`} style={{ ...fieldStyle, marginTop: 16 }}>Review reason
        <textarea id={`${id}-note`} rows={4} maxLength={2000} required value={note} onChange={event => setNote(event.target.value)} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.7 }} aria-describedby={`${id}-note-help`} placeholder="Explain the draft or keeper history that supports this cost, tenure, and status."/>
        <span id={`${id}-note-help`} style={helpStyle}>This reason appears on the public keeper profile. Include league evidence only; each decision is recorded in the audit trail.</span>
      </label>
      {validationError && <p className="workflow-message workflow-error" role="alert">{validationError}</p>}
      <button className="button button-green" type="submit" disabled={disabled || !note.trim()} style={{ marginTop: 18 }}>{saving ? 'Saving review…' : 'Save profile review'}</button>
    </fieldset>
  </form>;
}

export function KeeperProfileReview({ account }: { account: LeagueAccount }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [teamId, setTeamId] = useState('all');
  const [reviewOnly, setReviewOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { data } = account;
  const candidates = data.players.filter(player =>
    (!reviewOnly || player.status === 'review') &&
    (teamId === 'all' || player.teamId === Number(teamId)) &&
    player.name.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => a.name.localeCompare(b.name));
  // Keep a just-reviewed player visible even when they leave the review queue.
  const selected = data.players.find(player => player.id === selectedId) || candidates[0];
  const verification = selected ? profileVerification(selected, account) : 'unresolved';
  const team = data.teams.find(item => item.id === selected?.teamId);
  const protectedSubmission = account.commissioner && selected ? account.submissions.find(submission =>
    ['approved', 'locked'].includes(submission.status) && submission.keeper_assignments.some(item => Number(item.player_id) === selected.id),
  ) : undefined;
  const live = account.connection === 'live' && Boolean(account.live);
  const commissioner = Boolean(account.session?.user && account.commissioner);
  const seasonEditable = Boolean(live && account.live && !account.live.keepersRevealedAt && ['setup', 'keeper_selection'].includes(account.live.phase));
  const busy = saving || refreshing || Boolean(account.actionBusy) || account.loadingSubmissions;
  const editingDisabled = !commissioner || !seasonEditable || !account.submissionsLoaded || Boolean(protectedSubmission) || account.reloadRequired || refreshRequired || busy;
  const draftRounds = Math.max(1, ...data.picks.map(pick => pick.round));

  let accessMessage = '';
  if (!live) accessMessage = account.connection === 'loading'
    ? 'Checking the live league connection. Profile reviews are read-only until it is ready.'
    : account.connection === 'error'
      ? 'Live records are unavailable. These profiles are read-only until the connection is restored.'
      : 'Historical preview — read-only. Connect the live league and sign in as commissioner to record profile reviews.';
  else if (!commissioner) accessMessage = 'Keeper profiles are public. Sign in with commissioner access to record a review.';
  else if (!seasonEditable) accessMessage = 'Keeper profiles are frozen for this season. Reviews close when keepers are revealed or the season moves beyond keeper selection.';
  else if (protectedSubmission?.status === 'locked') accessMessage = 'This player belongs to a locked keeper submission. Their profile is frozen.';
  else if (protectedSubmission) accessMessage = 'This player belongs to an approved submission. Return that submission with a note before changing the profile.';
  else if (!account.submissionsLoaded || account.loadingSubmissions) accessMessage = 'Loading submission approvals before enabling profile changes.';
  else if (account.reloadRequired || refreshRequired) accessMessage = 'Reload the latest records before making another decision.';

  async function refresh() {
    setRefreshing(true); setError('');
    try {
      const refreshed = await account.refreshOfficial();
      setRefreshRequired(refreshed === null);
      if (refreshed === null) setError('The latest profiles and approvals could not be loaded. Editing remains paused.');
    } catch { setRefreshRequired(true); setError('The latest profiles and approvals could not be loaded. Editing remains paused.'); }
    finally { setRefreshing(false); }
  }

  async function saveReview(review: ProfileReview) {
    if (editingDisabled || !selected || !account.live || savingRef.current) return false;
    savingRef.current = true; setSaving(true); setError(''); setNotice('');
    // Pin the displayed player before refreshing: confirmation can remove them from the queue.
    setSelectedId(selected.id);
    let saved = false;
    try {
      const response = await fetch('/api/keeper-profiles', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId: account.live.seasonId, playerId: selected.id, ...review }),
      });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) {
        if (response.status === 401) throw new Error('Your session has expired. Sign in again before saving this review.');
        if (response.status === 403) throw new Error('Commissioner access is required to save this review.');
        throw new Error(result?.message || 'The review could not be saved. Check the fields and reload the latest records before trying again.');
      }
      saved = true;
      setNotice(`Review saved for ${selected.name}.`);
      // Refresh both the public profile and private approval guards after a successful write.
      const refreshed = await account.refreshOfficial();
      setRefreshRequired(refreshed === null);
      if (refreshed === null) setError('Your review was saved, but the latest records could not be loaded. Reload records to continue.');
      return true;
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('Your review was saved, but the latest records could not be loaded. Reload records to continue.'); return true; }
      setError(failure instanceof Error ? failure.message : 'The review could not be saved. Your edits remain in the form.');
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }

  function selectPlayer(playerId: number) {
    setSelectedId(playerId); setError(''); setNotice('');
  }

  return <section className="panel" aria-labelledby={`${id}-title`}>
    <div className="panel-header" style={{ flexWrap: 'wrap', gap: 16 }}>
      <div><p className="eyebrow">KEEPER ELIGIBILITY</p><h2 id={`${id}-title`}>Review player profiles</h2></div>
      <span className="small muted">{data.players.filter(player => player.status === 'review').length} awaiting verification</span>
    </div>
    <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
      <p style={helpStyle}>Resolve uncertain keeper costs and tenure before approving submissions. Owners choose which of their picks pays for each eligible keeper.</p>
      {accessMessage && <p role="status" style={{ ...helpStyle, marginTop: 12, color: 'var(--ink)' }}>{accessMessage}</p>}
      {notice && <p className="workflow-message workflow-success" role="status">{notice}</p>}
      {error && <p className="workflow-message workflow-error" role="alert">{error}</p>}
      {commissioner && <button className="text-button" type="button" style={{ marginTop: 12 }} disabled={busy} onClick={() => void refresh()}>{refreshing ? 'Reloading records…' : 'Reload profiles and approvals'}</button>}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
      <div style={{ padding: 24, minWidth: 0 }}>
        <label htmlFor={`${id}-search`} style={fieldStyle}>Find a player
          <input id={`${id}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search player names" style={inputStyle} disabled={saving}/>
        </label>
        <label htmlFor={`${id}-team`} style={{ ...fieldStyle, marginTop: 14 }}>Team
          <select id={`${id}-team`} value={teamId} onChange={event => setTeamId(event.target.value)} style={inputStyle} disabled={saving}>
            <option value="all">All teams</option>
            {data.teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 12, margin: '16px 0' }}>
          <input type="checkbox" checked={reviewOnly} onChange={event => setReviewOnly(event.target.checked)} disabled={saving}/>Only profiles needing review
        </label>
        <p className="small muted" style={{ marginBottom: 10 }} aria-live="polite">{candidates.length} {candidates.length === 1 ? 'profile' : 'profiles'} shown</p>
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 6 }} aria-label="Player profiles">
          {candidates.length === 0 && <p style={{ ...helpStyle, padding: 16 }}>No profiles match these filters. Clear the search or include verified players.</p>}
          {candidates.map(player => <button key={player.id} type="button" disabled={saving} aria-pressed={selected?.id === player.id} onClick={() => selectPlayer(player.id)} style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '13px 14px',
            borderBottom: '1px solid var(--line)', background: selected?.id === player.id ? 'var(--green-light)' : 'var(--surface)',
          }}>
            <strong style={{ display: 'block', fontSize: 12, lineHeight: 1.6 }}>{player.name}</strong>
            <span style={helpStyle}>{data.teams.find(item => item.id === player.teamId)?.shortName || 'League team'} · {verificationLabels[profileVerification(player, account)]}</span>
          </button>)}
        </div>
      </div>
      <div style={{ padding: 24, minWidth: 0, background: '#f7f8f0' }}>
        {selected ? <>
          <p className="eyebrow">SELECTED PROFILE · {team?.shortName || 'LEAGUE TEAM'}</p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, margin: '10px 0 16px' }}>
            <h3 style={{ fontSize: 20, lineHeight: 1.4 }}>{selected.name}</h3>
            <span className={`status status-${selected.status}`}>{verificationLabels[verification]}</span>
          </div>
          <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '14px 32px', fontSize: 12, margin: '0 0 18px' }}>
            <div><dt style={helpStyle}>Recorded base cost</dt><dd style={{ margin: '4px 0 0', fontWeight: 600 }}>{selected.baseCost === null ? 'Unknown' : `Round ${selected.baseCost}`}</dd></div>
            <div><dt style={helpStyle}>Recorded tenure</dt><dd style={{ margin: '4px 0 0', fontWeight: 600 }}>{selected.tenure === null ? 'Unknown' : `${selected.tenure} ${selected.tenure === 1 ? 'year' : 'years'}`}</dd></div>
          </dl>
          <p style={{ ...helpStyle, overflowWrap: 'anywhere' }}>{selected.reason || 'No review evidence has been recorded.'}</p>
          {commissioner && live && <ProfileForm
            key={JSON.stringify([account.live?.seasonId, selected.id, selected.baseCost, selected.tenure, verification, selected.reason])}
            player={selected} verification={verification} draftRounds={draftRounds} disabled={editingDisabled} saving={saving} onSave={saveReview}
          />}
        </> : <p style={helpStyle}>Select a player to inspect their keeper cost and history.</p>}
      </div>
    </div>
  </section>;
}
