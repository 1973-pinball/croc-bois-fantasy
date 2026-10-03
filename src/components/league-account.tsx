'use client';

import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { leagueData as previewData } from '@/lib/league-data';
import type { LeagueData } from '@/lib/types';
import { ownTeamIds as currentOwnTeamIds } from '@/lib/team-access';
import { hasKeeperDraftConflict, type KeeperDraft } from '@/lib/keeper-draft';
import { workflowDrafts } from '@/lib/workflow-drafts';
import identityData from '../../data/identities.json';

const identities = identityData as { leagueId: string; seasonId: string; franchises: Record<string, string>; picks: Record<string, string> };
type PlannerAssignment = { playerId: number; pickId: string };
type Session = {
  configured: boolean;
  googleSignInEnabled?: boolean;
  user: { id: string; email?: string; displayName?: string } | null;
  memberships: { league_id: string; role: string }[];
  assignments: { franchise_id: string; league_id: string; role: string; effective_from: string; effective_to: string | null }[];
};
export type KeeperSubmission = {
  id: string; franchise_id: string; revision: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'locked';
  review_note?: string | null;
  keeper_assignments: { player_id: number; pick_id: string }[];
};
type LiveLeague = {
  configured: true; source: 'supabase'; seasonId: string;
  phase: string; participantCount: number; keepersRevealedAt: string | null; tradingOpenedAt: string | null;
  keeperDeadline?: string | null; draftAt?: string | null; seasonTimeZone?: string | null; scheduleRevision?: number;
  franchiseIds: Record<string, string>; data: LeagueData;
  draftOrder?: number[]; usedPickIds?: string[];
  revealedKeepers: { playerId: number; teamId: number; pickId: string; baseRound: number; paymentRound: number }[];
};
type Action = 'save' | 'submit' | 'approve' | 'reject' | 'lock';
type SaveBody = { action: 'save'; seasonId: string; franchiseId: string; expectedRevision: number; assignments: PlannerAssignment[] };
type TransitionBody = { action: Exclude<Action, 'save'>; submissionId: string; expectedRevision: number; note?: string };
class RequestFailure extends Error { constructor(message: string, public status: number) { super(message); } }

async function readResponse<T>(response: Response): Promise<T> {
  let body: { message?: string; error?: string };
  try { body = await response.json(); } catch { throw new RequestFailure('The league service returned an unexpected response. Please try again.', response.status); }
  if (!response.ok) throw new RequestFailure(body.message || (response.status === 401 ? 'Sign in again to continue.' : 'The league service could not complete this request.'), response.status);
  return body as T;
}

export function useLeagueAccount() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const sessionRead = useRef(0);
  const permissionKey = useRef('');
  const permissionVersion = useRef(0);
  const [live, setLive] = useState<LiveLeague | null>(null);
  const [connection, setConnection] = useState<'loading' | 'preview' | 'live' | 'error'>('loading');
  const [lastLeagueCheckedAt, setLastLeagueCheckedAt] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [submissions, setSubmissions] = useState<KeeperSubmission[]>([]);
  const [submissionsLoaded, setSubmissionsLoaded] = useState(false);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [reloadRequired, setReloadRequired] = useState(false);
  const seasonId = live?.seasonId || identities.seasonId;
  const data = live?.data || previewData;

  const reloadLeague = useCallback(async () => {
    try {
      const response = await fetch('/api/league', { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json();
      if (response.ok && body.source === 'supabase' && body.data) { setLive(body); setLastLeagueCheckedAt(new Date().toISOString()); setConnection('live'); setConnectionError(''); return body as LiveLeague; }
      if (response.status === 503 && (body.configured === false || body.error === 'SETUP_REQUIRED')) { setConnection('preview'); setConnectionError(''); return null; }
      throw new Error('Live league records are temporarily unavailable. Official actions are paused until the connection is restored.');
    } catch (error) { setConnection('error'); setConnectionError(error instanceof Error ? error.message : 'Unable to load live league records.'); return null; }
  }, []);

  const readSubmissions = useCallback(async (requestedSeason = seasonId) => {
    const version = permissionVersion.current;
    setLoadingSubmissions(true);
    try {
      const response = await fetch('/api/keepers?seasonId=' + encodeURIComponent(requestedSeason), { cache: 'no-store', credentials: 'same-origin' });
      const result = await readResponse<{ submissions: KeeperSubmission[] }>(response);
      if (version !== permissionVersion.current) throw new Error('Your account access changed. Refresh to load current keeper submissions.');
      const records = result.submissions.map(item => ({ ...item, keeper_assignments: item.keeper_assignments || [] }));
      setSubmissions(records); setSubmissionsLoaded(true);
      return records;
    } finally { setLoadingSubmissions(false); }
  }, [seasonId]);

  const reloadSession = useCallback(async () => {
    const read = ++sessionRead.current;
    try {
      const body = await readResponse<Session>(await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' }));
      if (read !== sessionRead.current) return null;
      const key = JSON.stringify([body.user?.id, body.memberships, body.assignments]);
      if (key !== permissionKey.current) {
        permissionKey.current = key; permissionVersion.current++;
        setSubmissions([]); setSubmissionsLoaded(false);
      }
      workflowDrafts.account(body.user?.id ?? null);
      setSession(body); setSessionError('');
      if (!body.user) { setSubmissions([]); setSubmissionsLoaded(false); }
      return body;
    } catch {
      if (read === sessionRead.current) {
        permissionKey.current = ''; permissionVersion.current++;
        setSession(null); setSubmissions([]); setSubmissionsLoaded(false);
        setSessionError('Your account access could not be checked. Refresh to try again.');
      }
      return null;
    } finally { if (read === sessionRead.current) setSessionLoading(false); }
  }, []);

  useEffect(() => {
    void reloadSession(); void reloadLeague();
    const refresh = () => { if (document.visibilityState === 'visible') void reloadSession(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { sessionRead.current++; window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [reloadSession, reloadLeague]);

  useEffect(() => {
    if (!session?.user || connection !== 'live') return;
    let cancelled = false;
    void readSubmissions().catch(error => { if (!cancelled) setActionError(error instanceof Error ? error.message : 'Unable to load saved keeper submissions.'); });
    return () => { cancelled = true; };
  }, [session, connection, readSubmissions]);

  const commissioner = Boolean(session?.user && session.memberships.some(item => item.league_id === identities.leagueId && item.role === 'commissioner'));
  const ownTeamIds = session?.user ? currentOwnTeamIds(identities.leagueId, session.memberships, session.assignments, live?.franchiseIds || identities.franchises).filter(id => data.teams.some(team => team.id === id)) : [];
  function franchiseId(teamId: number) { return live?.franchiseIds[String(teamId)] || identities.franchises[String(teamId)]; }
  function canManageTeam(teamId: number) {
    if (!session?.user) return false;
    if (commissioner) return true;
    const member = session.memberships.some(item => item.league_id === identities.leagueId && item.role === 'manager');
    const now = Date.now();
    return member && session.assignments.some(item => item.league_id === identities.leagueId && item.franchise_id === franchiseId(teamId) && Date.parse(item.effective_from) <= now && (item.effective_to === null || Date.parse(item.effective_to) > now));
  }
  function officialPickId(id: string) { return identities.picks[id] || id; }
  function toPlannerAssignments(submission?: KeeperSubmission): PlannerAssignment[] {
    return (submission?.keeper_assignments || []).map(item => {
      const pick = data.picks.find(candidate => candidate.id === item.pick_id || identities.picks[candidate.id] === item.pick_id);
      return { playerId: Number(item.player_id), pickId: pick?.id || item.pick_id };
    });
  }
  function submissionFor(teamId: number) { return submissions.find(item => item.franchise_id === franchiseId(teamId)); }

  async function refreshOfficial() {
    setActionError(''); setActionNotice('');
    const refreshedLeague = await reloadLeague();
    if (!refreshedLeague) { setActionError('Live records could not be refreshed. Your unsaved selections have been left in place.'); return null; }
    try {
      const records = await readSubmissions(refreshedLeague.seasonId);
      setReloadRequired(false);
      return records;
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Unable to reload saved submissions.'); return null; }
  }

  async function runAction(body: SaveBody | TransitionBody) {
    if (connection !== 'live' || !session?.user || !submissionsLoaded || reloadRequired || actionBusy) return null;
    const version = permissionVersion.current;
    setActionBusy(body.action === 'save' ? body.franchiseId : body.submissionId);
    setActionError(''); setActionNotice('');
    try {
      const response = await fetch('/api/keepers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await readResponse<{ submission: KeeperSubmission }>(response);
      if (version !== permissionVersion.current) throw new Error('Your account access changed while saving. Reload current submissions before continuing.');
      const previous = submissions.find(item => item.franchise_id === result.submission.franchise_id);
      const saved = { ...result.submission, keeper_assignments: body.action === 'save' ? body.assignments.map(item => ({ player_id: item.playerId, pick_id: item.pickId })) : result.submission.keeper_assignments || previous?.keeper_assignments || [] };
      setSubmissions(current => [...current.filter(item => item.franchise_id !== saved.franchise_id), saved]);
      const messages: Record<Action, string> = { save: live?.phase === 'setup' ? 'Private draft saved. You can return to it anytime; submission opens after season setup.' : 'Private draft saved. Submit it when you are ready for commissioner review.', submit: 'Keepers submitted for commissioner review.', approve: 'Submission approved. The manager can still revise it until it is locked.', reject: 'Submission returned to the manager with your review note.', lock: 'Submission locked. Keepers reveal automatically when every team is locked.' };
      setActionNotice(messages[body.action]);
      const refreshedLeague = await reloadLeague();
      if (body.action === 'lock' && refreshedLeague?.keepersRevealedAt) setActionNotice('Final submission locked. Every team’s keepers and payment picks are now public.');
      return saved;
    } catch (error) {
      if (error instanceof RequestFailure && error.status === 409) setReloadRequired(true);
      setActionError(error instanceof Error ? error.message : 'The request could not be completed. Your local selections remain intact.');
      return null;
    } finally { setActionBusy(null); }
  }

  async function openKeeperSelection(note: string) {
    if (!commissioner || connection !== 'live' || live?.phase !== 'setup' || actionBusy || !note.trim()) return;
    setActionBusy('open-season'); setActionError(''); setActionNotice('');
    try {
      await readResponse(await fetch('/api/season', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'open_keeper_selection', seasonId, note: note.trim() }) }));
      setActionNotice('Keeper selection is open. Assigned managers can now submit their saved keeper drafts for review.');
      await reloadLeague();
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Keeper selection could not be opened.'); }
    finally { setActionBusy(null); }
  }

  return { data, lastLeagueCheckedAt, session, sessionLoading, sessionError, reloadSession, ownTeamIds, live, connection, connectionError, submissions, submissionsLoaded, loadingSubmissions, commissioner, actionBusy, actionError, actionNotice, reloadRequired, seasonId, canManageTeam, franchiseId, officialPickId, toPlannerAssignments, submissionFor, refreshOfficial, runAction, openKeeperSelection, reloadLeague };
}

export type LeagueAccount = ReturnType<typeof useLeagueAccount>;

export function AccountButton({ account, className = 'sign-in-button', label = 'Sign in with Google' }: { account: LeagueAccount; className?: string; label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [signingOut, setSigningOut] = useState(false);
  const [signoutError, setSignoutError] = useState('');
  async function signOut() {
    setSigningOut(true); setSignoutError('');
    try { await readResponse(await fetch('/auth/signout', { method: 'POST', credentials: 'same-origin' })); workflowDrafts.account(null); window.location.replace('/'); }
    catch { setSignoutError('Sign-out could not be completed. Please try again.'); setSigningOut(false); }
  }
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (!account.sessionLoading && account.session?.configured && account.session.googleSignInEnabled === true && !account.session.user) return;
    event.preventDefault(); dialog.current?.showModal();
  }
  return <><a className={className} href="/auth/login?next=%2F%3Fview%3Dmy-team" onClick={open}>{account.session?.user ? 'My account' : label}<span aria-hidden="true">→</span></a>
    <dialog className="account-dialog" ref={dialog} aria-labelledby={titleId}>
      <button className="dialog-close" onClick={() => dialog.current?.close()} aria-label="Close account details">×</button><p className="eyebrow">YOUR LEAGUE ACCOUNT</p>
      <h2 id={titleId}>{account.session?.user ? 'You’re signed in' : account.sessionLoading ? 'Connecting to the league…' : 'Google sign-in is coming online'}</h2>
      {account.session?.user ? <>
        <p>{account.session.user.email || 'Your Google account is connected.'}</p>
        <p>Your sign-in is remembered on this device.</p>
        {account.commissioner && <p>You have commissioner access for this league.</p>}
        <p>{account.ownTeamIds.length ? 'Your teams: ' + account.data.teams.filter(team => account.ownTeamIds.includes(team.id)).map(team => team.shortName).join(', ') + '.' : 'Request your team in My Team. The commissioner approves access before you can submit keepers or log trades.'}</p>
        <a className="button button-green" href="/?view=my-team">{account.ownTeamIds.length ? 'Open My Team' : 'Request team access'}</a>
        <details className="account-identity"><summary>Account ID for setup</summary><code>{account.session.user.id}</code><p>The commissioner uses this verified account ID when setting up initial league administration.</p></details>
      </> : <p>{account.sessionLoading ? 'Account access is being checked. Close this window and try again in a moment.' : 'League account setup is still being completed. You can explore the public archive and plan keepers locally in the meantime.'}</p>}
      <div className="account-dialog-actions"><button className="button button-green" onClick={() => dialog.current?.close()}>Back to the league</button>{account.session?.user && <button className="button button-subtle" onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button>}</div>{signoutError && <p role="alert">{signoutError}</p>}
    </dialog></>;
}

export function LeagueConnectionNotice({ account }: { account: LeagueAccount }) {
  if (account.connection === 'live') {
    const phase = account.live?.phase;
    const state = phase === 'setup' ? 'Setup · submissions closed' : phase === 'keeper_selection' ? 'Private keeper selection open' : phase === 'archived' ? 'Season archived' : phase === 'in_season' ? 'Season in progress' : account.live?.keepersRevealedAt ? 'Keepers revealed · draft preparation' : 'Keeper selection closed';
    return <div className="connection-status"><span className="connection-dot"/> Live records <span>·</span> {state}</div>;
  }
  if (account.connection === 'loading') return <div className="connection-status">Checking live league access…</div>;
  return <div className={'connection-status connection-preview' + (account.connection === 'error' ? ' connection-error' : '')} role="status"><span>{account.connection === 'error' ? (account.live ? 'Connection interrupted. Showing the last loaded records; official actions are paused.' : 'Live records are unavailable. Showing the historical preview; official actions are paused.') : 'Historical preview · live accounts and official submissions are not connected yet.'}</span>{account.connection === 'error' && <button className="text-button" onClick={() => void account.reloadLeague()}>Retry connection</button>}</div>;
}

function WorkflowFeedback({ account }: { account: LeagueAccount }) {
  return <>{account.actionError && <div className="workflow-message workflow-error" role="alert">{account.actionError}{account.reloadRequired && <p>Reload the saved version before trying again. No automatic overwrite will occur.</p>}</div>}{account.actionNotice && <div className="workflow-message workflow-success" role="status">{account.actionNotice}</div>}</>;
}

export function OfficialKeeperControls({ account, teamId, draft, onLoad, onSaved, errors }: {
  account: LeagueAccount; teamId: number; draft: KeeperDraft | undefined;
  onLoad: (assignments: PlannerAssignment[], revision: number) => void;
  onSaved: (expectedRevision: number, savedRevision: number) => void; errors: string[];
}) {
  const assignments = draft?.assignments || [];
  const current = account.submissionFor(teamId);
  const permitted = account.canManageTeam(teamId);
  const serverAssignments = account.toPlannerAssignments(current);
  const key = (items: PlannerAssignment[]) => JSON.stringify([...items].sort((a, b) => a.playerId - b.playerId).map(item => [item.playerId, account.officialPickId(item.pickId)]));
  const dirty = key(assignments) !== key(serverAssignments);
  const locked = current?.status === 'locked';
  const saveAvailable = account.connection === 'live' && !account.live?.keepersRevealedAt && ['setup', 'keeper_selection'].includes(account.live?.phase || '');
  const submitAvailable = saveAvailable && account.live?.phase === 'keeper_selection';
  const busy = Boolean(account.actionBusy) || account.loadingSubmissions;
  const conflict = account.submissionsLoaded && hasKeeperDraftConflict(draft, current?.revision ?? 0);
  const needsLoad = conflict || account.reloadRequired;
  async function reload() {
    const records = await account.refreshOfficial();
    if (records) {
      const saved = records.find(item => item.franchise_id === account.franchiseId(teamId));
      onLoad(account.toPlannerAssignments(saved), saved?.revision ?? 0);
    }
  }
  async function save() {
    if (!saveAvailable || locked || busy || needsLoad || !draft || draft.baseRevision === null) return;
    const expectedRevision = draft.baseRevision;
    const saved = await account.runAction({ action: 'save', seasonId: account.seasonId, franchiseId: account.franchiseId(teamId), expectedRevision, assignments: assignments.map(item => ({ playerId: item.playerId, pickId: account.officialPickId(item.pickId) })) });
    if (saved) onSaved(expectedRevision, saved.revision);
  }
  if (!account.session?.user) return <div className="official-keeper-controls"><p>Sign in to save a private draft and submit it for commissioner review.</p><AccountButton account={account} className="button button-outline-light" label="Continue with Google"/></div>;
  if (!permitted) return <div className="official-keeper-controls"><p>This roster is a local preview. Select a team you currently manage to use official keeper submissions.</p></div>;
  return <div className="official-keeper-controls">
    <div className="official-status"><span>{account.live?.phase === 'setup' ? 'PRIVATE KEEPER DRAFT' : 'KEEPER SUBMISSION'}</span><strong>{current ? current.status + ' · revision ' + current.revision : 'No saved draft yet'}</strong></div>
    {current?.review_note && <p className="commissioner-note">Commissioner note: {current.review_note}</p>}
    {!saveAvailable && <p>{account.connection !== 'live' ? 'Official actions are paused until live league records are available.' : 'Keeper selection has closed for this season.'}</p>}
    {saveAvailable && !submitAvailable && <p>You can save and reload your private draft during setup. Submit for review opens when the commissioner opens keeper selection.</p>}
    {account.loadingSubmissions && <p role="status">Loading your saved submission…</p>}
    {locked && <p>The commissioner has locked this submission. Local changes will not alter your official keepers.</p>}
    {conflict && !busy && <div className="workflow-message workflow-error" role="alert"><strong>Saved keepers changed</strong><p>{draft?.baseRevision === null || !draft ? 'This local plan has not loaded the saved keeper draft.' : `This plan is based on revision ${draft.baseRevision}; the saved draft is now revision ${current?.revision ?? 0}.`} Your local selections are preserved. Load the latest saved draft to replace them before saving or submitting.</p></div>}
    {dirty && !locked && !conflict && <p className="unsaved-notice">You have local changes. Save them before submitting.</p>}
    <WorkflowFeedback account={account}/>
    <div className="official-buttons">
      <button className="button button-outline-light" onClick={() => void reload()} disabled={busy}>{needsLoad ? 'Replace local selections with saved draft' : 'Load saved draft'}</button>
      {!locked && <>
        <button className="button button-orange" onClick={() => void save()} disabled={!saveAvailable || !account.submissionsLoaded || !draft || draft.baseRevision === null || busy || needsLoad || errors.length > 0}>{account.actionBusy === account.franchiseId(teamId) ? 'Saving…' : 'Save private draft'}</button>
        <button className="button button-cream" onClick={() => submitAvailable && !needsLoad && current && draft?.baseRevision !== null && draft?.baseRevision !== undefined && void account.runAction({ action: 'submit', submissionId: current.id, expectedRevision: draft.baseRevision })} disabled={!submitAvailable || !account.submissionsLoaded || busy || needsLoad || dirty || !current || !['draft', 'rejected'].includes(current.status) || errors.length > 0}>Submit for review</button>
      </>}
    </div>
    <p className="official-privacy-note">Only assigned managers and the commissioner can see your selections before the league reveal. Saving a revision after approval requires a new review.</p>
  </div>;
}

export function OfficialReviewPanel({ account }: { account: LeagueAccount }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [openingNote, setOpeningNote] = useState('');
  if (!account.session?.user || !account.commissioner) return null;
  const editable = account.connection === 'live' && account.live?.phase === 'keeper_selection' && account.submissionsLoaded && !account.reloadRequired && !account.actionBusy && !account.loadingSubmissions;
  return <section className="panel official-review-panel"><div className="panel-header"><div><p className="eyebrow">PRIVATE COMMISSIONER WORKSPACE</p><h2>Official keeper submissions</h2></div><button className="text-button" disabled={account.loadingSubmissions || Boolean(account.actionBusy)} onClick={() => void account.refreshOfficial()}>{account.loadingSubmissions ? 'Refreshing…' : 'Refresh'}</button></div><div className="official-review-intro"><p>Review each team’s selected players and payment picks. Approve first, then lock after the deadline. The final lock reveals every team together.</p><WorkflowFeedback account={account}/>{account.live?.phase === 'setup' && <div className="open-season-controls"><h3>Ready to open keeper selection?</h3><p>Confirm that you have reviewed the league roster, pick ownership, and keeper rules before opening submissions.</p><label htmlFor="season-opening-note">Commissioner review note</label><textarea id="season-opening-note" rows={2} maxLength={2000} value={openingNote} onChange={event => setOpeningNote(event.target.value)}/><button className="button button-green" disabled={account.connection !== 'live' || Boolean(account.actionBusy) || !openingNote.trim()} onClick={() => void account.openKeeperSelection(openingNote)}>{account.actionBusy === 'open-season' ? 'Opening selections…' : 'Open keeper selection'}</button></div>}</div>{account.loadingSubmissions && <p className="empty-state" role="status">Loading official submissions…</p>}{!account.loadingSubmissions && account.submissions.length === 0 && <p className="empty-state">No saved keeper submissions are available for this season.</p>}{account.submissions.map(submission => {
    const team = account.data.teams.find(item => account.franchiseId(item.id) === submission.franchise_id);
    const finalLock = submission.status === 'approved' && account.data.teams.length > 0 && account.data.teams.length === account.live?.participantCount && account.data.teams.every(item => item.id === team?.id || account.submissionFor(item.id)?.status === 'locked');
    const keeperCount = account.submissions.reduce((total, item) => total + item.keeper_assignments.length, 0);
    return <article className="official-submission" key={submission.id}><div className="official-submission-heading"><h3>{team?.name || 'League team'}</h3><span className={'status status-' + submission.status}>{submission.status} · revision {submission.revision}</span></div><div className="review-keeper-picks">{submission.keeper_assignments.length === 0 ? <p>No keepers selected.</p> : submission.keeper_assignments.map(item => { const player = account.data.players.find(candidate => candidate.id === Number(item.player_id)); const pick = account.data.picks.find(candidate => account.officialPickId(candidate.id) === item.pick_id); return <div key={item.player_id}><strong>{player?.name || 'Player ' + item.player_id}</strong><span>{pick ? 'Round ' + pick.round + ' · originally ' + (account.data.teams.find(candidate => candidate.id === pick.originalTeamId)?.shortName || 'Unknown') : 'Pick unavailable in current records'}</span></div>; })}</div>{submission.review_note && <p className="review-previous-note">Previous note: {submission.review_note}</p>}{['submitted', 'approved'].includes(submission.status) && <><label className="review-note-label" htmlFor={'review-note-' + submission.id}>Review note <span>(required when returning a submission)</span></label><textarea id={'review-note-' + submission.id} rows={2} maxLength={2000} value={notes[submission.id] || ''} onChange={event => setNotes(previous => ({ ...previous, [submission.id]: event.target.value }))}/><div className="review-action-buttons">{submission.status === 'submitted' && <button className="button button-green" disabled={!editable} onClick={() => void account.runAction({ action: 'approve', submissionId: submission.id, expectedRevision: submission.revision, note: notes[submission.id] || undefined })}>Approve keepers</button>}<button className="button button-subtle" disabled={!editable || !(notes[submission.id] || '').trim()} onClick={() => void account.runAction({ action: 'reject', submissionId: submission.id, expectedRevision: submission.revision, note: notes[submission.id] })}>Return with note</button>{submission.status === 'approved' && <button className="button button-orange" disabled={!editable} onClick={() => void account.runAction({ action: 'lock', submissionId: submission.id, expectedRevision: submission.revision })}>{finalLock ? 'Lock final team and reveal keepers' : 'Lock keepers'}</button>}</div>{finalLock && <p className="workflow-message" role="status">Final lock: this reveals {keeperCount} keepers across all {account.data.teams.length} teams, including their payment picks, to the league. Every other team is already locked.</p>}</>}{submission.status === 'locked' && <p className="locked-note">Locked. This selection is preserved for the league reveal.</p>}{account.actionBusy === submission.id && <p role="status" className="small">Recording your decision…</p>}</article>;
  })}</section>;
}
