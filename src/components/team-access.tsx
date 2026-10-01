'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { LeagueAccount } from './league-account';
import styles from './team-access.module.css';

type AccessRole = 'manager' | 'co_manager';
type AccessRequest = {
  id: string; league_id: string; franchise_id: string; user_id: string;
  applicant_email: string; display_name: string; request_note: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  created_at: string; reviewed_at: string | null; review_note: string | null;
};
type AccessManager = { id: string; display_name: string; franchise_ids: string[] };
type AccessAssignment = {
  id: string; franchise_id: string; manager_id: string; user_id: string;
  role: AccessRole; effective_from: string; effective_to: string | null; display_name: string;
};
type AccessRecords = { requests: AccessRequest[]; managers: AccessManager[]; assignments: AccessAssignment[] };
type AccessAction =
  | { action: 'request'; franchiseId: string; displayName: string; note: string }
  | { action: 'cancel'; requestId: string }
  | { action: 'approve' | 'reject'; requestId: string; managerId?: string | null; role: AccessRole; note: string }
  | { action: 'revoke'; assignmentId: string; note: string };

function dateLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Date unavailable';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function activeAssignment(assignment: AccessAssignment) {
  const now = Date.now();
  return Date.parse(assignment.effective_from) <= now && (assignment.effective_to === null || Date.parse(assignment.effective_to) > now);
}
async function responseBody(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || (response.status === 401 ? 'Sign in again to manage team access.' : response.status === 403 ? 'Your account does not have permission for this team-access action.' : response.status === 409 ? 'This request has changed. Refresh team access before trying again.' : 'Team access could not be updated.'));
  if (!body) throw new Error('The team-access service returned an unexpected response. Refresh to check the latest state.');
  return body;
}

function useTeamAccess(account: LeagueAccount, allowed = true) {
  const userId = account.session?.user?.id;
  const readable = Boolean(allowed && userId && account.connection === 'live');
  const [result, setResult] = useState<{ userId: string; records: AccessRecords } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const busyRef = useRef(false);
  const requestSequence = useRef(0);
  const lastRefresh = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!readable || !userId) return null;
    const sequence = ++requestSequence.current;
    setLoading(true); setLoadError('');
    try {
      const body = await responseBody(await fetch('/api/team-access', { cache: 'no-store', credentials: 'same-origin', signal }));
      if (!Array.isArray(body.requests) || !Array.isArray(body.managers) || !Array.isArray(body.assignments)) throw new Error('The team-access record list is incomplete. Refresh before continuing.');
      if (signal?.aborted || sequence !== requestSequence.current) return null;
      setResult({ userId, records: body }); lastRefresh.current = Date.now();
      return body as AccessRecords;
    } catch (failure) {
      if (!signal?.aborted && sequence === requestSequence.current) setLoadError(failure instanceof Error ? failure.message : 'Team access could not be loaded.');
      return null;
    } finally { if (!signal?.aborted && sequence === requestSequence.current) setLoading(false); }
  }, [readable, userId]);

  const refresh = useCallback(async () => {
    const [records, session] = await Promise.all([load(), account.reloadSession()]);
    const succeeded = Boolean(records && session);
    setNeedsRefresh(!succeeded);
    if (succeeded) setActionError('');
    else if (!session) setActionError('Your account access could not be refreshed. Refresh before making another change.');
    return succeeded;
  }, [load, account.reloadSession]);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setNeedsRefresh(false); setActionError(''); setNotice('');
    if (readable) void load(controller.signal);
    return () => { controller.abort(); requestSequence.current++; };
  }, [load, readable]);

  useEffect(() => {
    if (!readable) return;
    const onFocus = () => {
      if (!busyRef.current && Date.now() - lastRefresh.current > 30000) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [readable, refresh]);

  const records = readable && result && result.userId === userId ? result.records : null;
  const disabled = !readable || !records || loading || Boolean(loadError) || Boolean(busy) || Boolean(account.actionBusy) || needsRefresh;
  async function write(body: AccessAction, key: string, message: string) {
    if (disabled || busyRef.current) return false;
    busyRef.current = true; setBusy(key); setActionError(''); setNotice('');
    let saved = false;
    try {
      await responseBody(await fetch('/api/team-access', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      saved = true; setNotice(message);
      if (!await refresh()) setActionError('The change was saved, but current access could not be refreshed. Refresh before making another change.');
      return true;
    } catch (failure) {
      setNeedsRefresh(true);
      setActionError(saved ? 'The change was saved. Refresh to confirm current access before continuing.' : `${failure instanceof Error ? failure.message : 'The action could not be completed.'} Refresh to check its current status before retrying.`);
      return saved;
    } finally { busyRef.current = false; setBusy(null); }
  }
  return { records, readable, loading, loadError, actionError, notice, busy, disabled, needsRefresh, refresh, write };
}

function AccessFeedback({ access }: { access: ReturnType<typeof useTeamAccess> }) {
  return <>{access.loading && <p className={styles.help} role="status">Loading team access…</p>}{access.notice && <p className="workflow-message workflow-success" role="status">{access.notice}</p>}{access.loadError && <p className="workflow-message workflow-error" role="alert">{access.loadError} Changes are paused until team access is refreshed.</p>}{access.actionError && <p className="workflow-message workflow-error" role="alert">{access.actionError}</p>}{access.needsRefresh && <p className={styles.help}>Refresh the latest team-access records before continuing.</p>}</>;
}

function AccessRequestForm({ account, access, initialRequest, excludedTeams }: {
  account: LeagueAccount; access: ReturnType<typeof useTeamAccess>; initialRequest?: AccessRequest; excludedTeams: number[];
}) {
  const id = useId();
  const [franchiseId, setFranchiseId] = useState(initialRequest?.franchise_id || '');
  const [displayName, setDisplayName] = useState(initialRequest?.display_name || account.session?.user?.displayName || '');
  const [note, setNote] = useState('');
  const choices = account.data.teams.filter(team => !excludedTeams.includes(team.id));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim() || !choices.some(team => account.franchiseId(team.id) === franchiseId)) return;
    if (await access.write({ action: 'request', franchiseId, displayName: displayName.trim(), note: note.trim() }, 'request', 'Request sent to the commissioner. Team controls become available after approval.')) setNote('');
  }
  if (choices.length === 0) return null;
  return <form className={styles.form} onSubmit={event => void submit(event)}>
    <fieldset className={styles.fieldset} disabled={access.disabled}>
      <div className={styles.fields}><div className={styles.field}><label htmlFor={`${id}-team`}>Your franchise</label><select id={`${id}-team`} required value={franchiseId} onChange={event => setFranchiseId(event.target.value)}><option value="">Choose the team you manage</option>{choices.map(team => <option key={team.id} value={account.franchiseId(team.id)}>{team.shortName} · {team.name} ({team.owner})</option>)}</select></div><div className={styles.field}><label htmlFor={`${id}-name`}>Your display name</label><input id={`${id}-name`} required maxLength={100} autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} aria-describedby={`${id}-name-help`}/><small id={`${id}-name-help`}>Your league display name becomes public when a new manager identity is approved.</small></div></div>
      <div className={styles.field}><label htmlFor={`${id}-note`}>Note to the commissioner, optional</label><textarea id={`${id}-note`} rows={3} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="For example, I co-manage this team with…"/></div>
      <div className={styles.actions}><button type="submit" className="button button-green" disabled={access.disabled || !franchiseId || !displayName.trim()}>{access.busy === 'request' ? 'Sending request…' : 'Request team access'}</button></div>
      <p className={styles.help}>The commissioner connects your Google account to a manager identity. Your request and note are visible to you and the commissioner.</p>
    </fieldset>
  </form>;
}

export function TeamAccessPanel({ account, onOpenTeam }: { account: LeagueAccount; onOpenTeam: (teamId: number) => void }) {
  const access = useTeamAccess(account);
  const [retryRequest, setRetryRequest] = useState<AccessRequest | undefined>();
  const userId = account.session?.user?.id;
  if (!userId) return null;
  const requests = (access.records?.requests || []).filter(request => request.user_id === userId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const pending = requests.filter(request => request.status === 'pending');
  const ownTeamIds = account.ownTeamIds;
  const rejected = requests.find(request => request.status === 'rejected'
    && requests.find(candidate => candidate.franchise_id === request.franchise_id)?.id === request.id
    && !ownTeamIds.some(teamId => account.franchiseId(teamId) === request.franchise_id));
  const linked = account.data.teams.filter(team => ownTeamIds.includes(team.id));
  const ownAssignments = (access.records?.assignments || []).filter(assignment => assignment.user_id === userId);
  const scheduled = ownAssignments.filter(assignment => Date.parse(assignment.effective_from) > Date.now());
  const teamName = (franchiseId: string) => { const team = account.data.teams.find(item => account.franchiseId(item.id) === franchiseId); return team ? `${team.shortName} · ${team.name}` : 'League franchise'; };

  return <section className={`panel ${styles.panel}`} aria-labelledby="your-team-access-title">
    <div className="panel-header"><div><p className="eyebrow">YOUR PLACE IN THE LEAGUE</p><h2 id="your-team-access-title">Your team access</h2></div>{access.readable && <button type="button" className="button button-subtle" disabled={access.loading || Boolean(access.busy)} onClick={() => void access.refresh()}>Refresh team access</button>}</div>
    <div className={styles.body}>
      <p className={styles.intro}>{linked.length ? 'Your account is connected to the teams below.' : 'Connect your Google account to the franchise you manage. The commissioner reviews each request before team controls are enabled.'}</p>
      {!access.readable && <p className={styles.unavailable}>Team access is temporarily unavailable while the live league connection is being restored.</p>}
      <AccessFeedback access={access}/>
      {linked.length > 0 && <div className={styles.linkedTeams}>{linked.map(team => { const assignment = ownAssignments.find(item => item.franchise_id === account.franchiseId(team.id) && activeAssignment(item)); return <div className={styles.linkedTeam} key={team.id}><span className={styles.teamMark} style={{ borderColor: team.color }}>{team.shortName}</span><div><strong>{team.name}</strong><span>{assignment?.display_name || account.session?.user?.displayName || 'Linked account'}{assignment ? ` · ${assignment.role === 'co_manager' ? 'Co-manager' : 'Manager'}` : ''}</span></div><button type="button" className="button button-green" onClick={() => onOpenTeam(team.id)} aria-label={`Open My Team for ${team.name}`}>My Team <span aria-hidden="true">→</span></button></div>; })}</div>}
      {scheduled.map(assignment => <div className={styles.requestCard} key={assignment.id}><span className={styles.status}>Scheduled access</span><h3>{teamName(assignment.franchise_id)}</h3><p className={styles.help}>Your access begins {dateLabel(assignment.effective_from)}.</p></div>)}
      {pending.map(request => <div className={styles.requestCard} key={request.id}><div className={styles.cardHeading}><div><p className="eyebrow">AWAITING COMMISSIONER REVIEW</p><h3>{teamName(request.franchise_id)}</h3></div><span className={styles.status}>Pending</span></div><p className={styles.help}>Requested as {request.display_name} · {dateLabel(request.created_at)}</p>{request.request_note && <p className={styles.note}>{request.request_note}</p>}<p className={styles.help}>You can browse the league while your request is pending. Team controls appear after approval.</p><button type="button" className="text-button" disabled={access.disabled} onClick={() => void access.write({ action: 'cancel', requestId: request.id }, request.id, 'Request cancelled. You can submit another request when you are ready.')}>{access.busy === request.id ? 'Cancelling…' : 'Cancel request'}</button></div>)}
      {!pending.length && rejected && <div className={styles.rejection}><span className={styles.status}>Request returned</span><h3>{teamName(rejected.franchise_id)}</h3><p className={styles.note}>{rejected.review_note || 'The commissioner declined this request. Check the team and display name before trying again.'}</p><button className="text-button" type="button" disabled={access.disabled} onClick={() => setRetryRequest(rejected)}>Try this request again</button></div>}
      {access.records && !pending.length && (linked.length === 0 ? <AccessRequestForm key={retryRequest?.id || 'new'} account={account} access={access} initialRequest={retryRequest} excludedTeams={ownTeamIds}/> : <details className={styles.additional}><summary>Request access to another team</summary><AccessRequestForm key={retryRequest?.id || 'new-linked'} account={account} access={access} initialRequest={retryRequest} excludedTeams={ownTeamIds}/></details>)}
    </div>
  </section>;
}

function RequestReview({ request, account, access }: { request: AccessRequest; account: LeagueAccount; access: ReturnType<typeof useTeamAccess> }) {
  const id = useId();
  const [managerId, setManagerId] = useState('');
  const [role, setRole] = useState<AccessRole>('manager');
  const [note, setNote] = useState('');
  const team = account.data.teams.find(item => account.franchiseId(item.id) === request.franchise_id);
  const managers = (access.records?.managers || []).filter(manager => manager.franchise_ids.includes(request.franchise_id));
  const validIdentity = managerId === '__new__' || managers.some(manager => manager.id === managerId);
  async function review(action: 'approve' | 'reject') {
    if (action === 'reject' && !note.trim()) return;
    if (action === 'approve' && !validIdentity) return;
    const body: AccessAction = { action, requestId: request.id, role, note: note.trim() };
    if (action === 'approve') body.managerId = managerId === '__new__' ? null : managerId;
    await access.write(body, request.id, action === 'approve' ? 'Team access approved. The manager can open My Team after refreshing their account.' : 'Request rejected with your review note.');
  }
  return <article className={styles.reviewCard} aria-label={`Team access request from ${request.display_name}`}>
    <div className={styles.cardHeading}><div><p className="eyebrow">{team?.shortName || 'TEAM ACCESS'} · {team?.name || 'League franchise'}</p><h3>{request.display_name}</h3><a className={styles.email} href={`mailto:${request.applicant_email}`}>{request.applicant_email}</a></div><span className={styles.status}>Pending</span></div>
    <p className={styles.help}>Requested {dateLabel(request.created_at)}</p>{request.request_note && <div className={styles.applicantNote}><strong>Applicant’s note</strong><p>{request.request_note}</p></div>}
    <fieldset className={styles.fieldset} disabled={access.disabled}>
      <div className={styles.fields}><div className={styles.field}><label htmlFor={`${id}-identity`}>Manager identity</label><select id={`${id}-identity`} value={managerId} onChange={event => setManagerId(event.target.value)}><option value="">Choose an identity to link</option>{managers.map(manager => <option key={manager.id} value={manager.id}>{manager.display_name} · existing manager</option>)}<option value="__new__">New manager · {request.display_name}</option></select><small>Link the existing manager to preserve league history, or create a new manager.</small></div><div className={styles.field}><label htmlFor={`${id}-role`}>Team role</label><select id={`${id}-role`} value={role} onChange={event => setRole(event.target.value as AccessRole)}><option value="manager">Manager</option><option value="co_manager">Co-manager</option></select></div></div>
      <div className={styles.field}><label htmlFor={`${id}-note`}>Review note</label><textarea id={`${id}-note`} rows={3} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} aria-describedby={`${id}-note-help`}/><small id={`${id}-note-help`}>Required to reject. The applicant can read this note.</small></div>
      <div className={styles.actions}><button type="button" className="button button-green" disabled={access.disabled || !validIdentity} onClick={() => void review('approve')}>{access.busy === request.id ? 'Saving decision…' : 'Approve team access'}</button><button type="button" className="button button-subtle" disabled={access.disabled || !note.trim()} onClick={() => void review('reject')}>Reject with note</button></div>
    </fieldset>
  </article>;
}

function AssignmentReview({ assignment, account, access }: { assignment: AccessAssignment; account: LeagueAccount; access: ReturnType<typeof useTeamAccess> }) {
  const id = useId();
  const [note, setNote] = useState('');
  const team = account.data.teams.find(item => account.franchiseId(item.id) === assignment.franchise_id);
  return <article className={styles.assignment} aria-label={`Access assignment for ${assignment.display_name}`}><div className={styles.cardHeading}><div><h4>{assignment.display_name}</h4><p className={styles.help}>{team?.shortName || 'League franchise'} · {team?.name || ''} · {assignment.role === 'co_manager' ? 'Co-manager' : 'Manager'}</p></div><span className={styles.status}>{activeAssignment(assignment) ? 'Active' : 'Scheduled'}</span></div><p className={styles.help}>Access from {dateLabel(assignment.effective_from)}{assignment.effective_to ? ` until ${dateLabel(assignment.effective_to)}` : ''}</p><details className={styles.endAccess}><summary>End this team access</summary><form onSubmit={event => { event.preventDefault(); if (note.trim()) void access.write({ action: 'revoke', assignmentId: assignment.id, note: note.trim() }, assignment.id, 'Team access ended. Historical manager records remain available.'); }}><div className={styles.field}><label htmlFor={`${id}-reason`}>Reason for ending access</label><textarea id={`${id}-reason`} rows={2} required maxLength={2000} disabled={access.disabled} value={note} onChange={event => setNote(event.target.value)}/></div><p className={styles.help}>This removes this account’s control of this team. It does not erase the manager’s league history.</p><button type="submit" className="button button-subtle" disabled={access.disabled || !note.trim()}>{access.busy === assignment.id ? 'Ending access…' : 'End team access'}</button></form></details></article>;
}

export function CommissionerTeamAccess({ account }: { account: LeagueAccount }) {
  const access = useTeamAccess(account, account.commissioner);
  const id = useId();
  if (!account.commissioner || !account.session?.user) return null;
  const pending = (access.records?.requests || []).filter(request => request.status === 'pending');
  const assignments = access.records?.assignments || [];
  return <section className={`panel ${styles.panel}`} aria-labelledby={`${id}-title`}><div className="panel-header"><div><p className="eyebrow">COMMISSIONER · PRIVATE</p><h2 id={`${id}-title`}>Team access requests</h2></div>{access.readable && <button type="button" className="button button-subtle" disabled={access.loading || Boolean(access.busy)} onClick={() => void access.refresh()}>Refresh access requests</button>}</div><div className={styles.body}><p className={styles.intro}>Match a Google account to the right manager and franchise. Co-managers can share a team; access changes keep historical identities intact.</p>{!access.readable && <p className={styles.unavailable}>The live league connection is required to review account access.</p>}<AccessFeedback access={access}/><div className={styles.sectionHeading}><h3>Pending review</h3><span>{pending.length}</span></div>{access.records && !pending.length && <p className={styles.empty}>No team-access requests are waiting for review.</p>}<div className={styles.stack}>{pending.map(request => <RequestReview key={request.id} request={request} account={account} access={access}/>)}</div><div className={styles.sectionHeading}><h3>Active & scheduled assignments</h3><span>{assignments.length}</span></div><div className={styles.assignmentList}>{assignments.map(assignment => <AssignmentReview key={assignment.id} assignment={assignment} account={account} access={access}/>)}</div>{access.records && !assignments.length && <p className={styles.empty}>No active or scheduled account assignments.</p>}</div></section>;
}
