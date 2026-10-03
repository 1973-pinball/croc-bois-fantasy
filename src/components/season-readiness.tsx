'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { seasonReadinessSchema, isSeasonTimeZone, type SeasonReadiness } from '@/lib/season-readiness';
import { formatSeasonDate, scheduleInput, scheduleInstant } from '@/lib/season-schedule';
import type { LeagueAccount } from './league-account';
import styles from './season-readiness.module.css';

const stateLabels = { missing: 'Not saved', draft: 'Draft saved', submitted: 'Awaiting review', rejected: 'Returned to manager', approved: 'Approved · unlocked', locked: 'Locked' };

export function SeasonScheduleNotice({ account }: { account: LeagueAccount }) {
  if (account.connection !== 'live' || !account.live) return null;
  const season = account.live;
  return <details className={styles.scheduleNotice}><summary>Schedule <span>Keeper deadline & draft time</span></summary>
    <span><strong>Keeper deadline</strong> {formatSeasonDate(season.keeperDeadline, season.seasonTimeZone)}</span>
    <span><strong>Draft</strong> {formatSeasonDate(season.draftAt, season.seasonTimeZone)}</span>
    <small>Keepers remain editable until the commissioner locks your submission.</small>
  </details>;
}

function ScheduleEditor({ readiness, disabled, refresh, account, invalidateAccess }: { readiness: SeasonReadiness; disabled: boolean; refresh: () => Promise<SeasonReadiness | null>; account: LeagueAccount; invalidateAccess: () => void }) {
  const id = useId();
  const [baseRevision, setBaseRevision] = useState(readiness.scheduleRevision);
  const [zone, setZone] = useState(readiness.seasonTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [deadline, setDeadline] = useState(scheduleInput(readiness.keeperDeadline, zone));
  const [draftAt, setDraftAt] = useState(scheduleInput(readiness.draftAt, zone));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadRequired, setReloadRequired] = useState(false);
  const conflict = baseRevision !== readiness.scheduleRevision || reloadRequired;
  function acceptSchedule(next: SeasonReadiness) {
    const nextZone = next.seasonTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    setZone(nextZone); setDeadline(scheduleInput(next.keeperDeadline, nextZone)); setDraftAt(scheduleInput(next.draftAt, nextZone));
    setBaseRevision(next.scheduleRevision); setNote(''); setReloadRequired(false);
  }
  async function reload() {
    const next = await refresh();
    if (next) { acceptSchedule(next); setError(''); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || busyRef.current || conflict) return;
    setError(''); setNotice('');
    try {
      if (!isSeasonTimeZone(zone.trim())) throw new Error('Enter a time zone such as America/New_York or UTC.');
      const keeperDeadline = scheduleInstant(deadline, zone.trim());
      const draftInstant = scheduleInstant(draftAt, zone.trim());
      if (keeperDeadline && draftInstant && Date.parse(keeperDeadline) > Date.parse(draftInstant)) throw new Error('The draft must be at or after the keeper deadline.');
      if (!note.trim()) throw new Error('Add a short reason for this schedule change.');
      busyRef.current = true; setBusy(true);
      const response = await fetch('/api/season', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update_schedule', seasonId: readiness.seasonId, expectedRevision: baseRevision, keeperDeadline, draftAt: draftInstant, seasonTimeZone: zone.trim(), note: note.trim() }) });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) setReloadRequired(true);
        if (response.status === 401 || response.status === 403) invalidateAccess();
        throw new Error(result?.message || 'The schedule could not be saved.');
      }
      setNotice('Schedule saved. Dates are displayed to the league; locking remains a commissioner action.');
      setReloadRequired(true);
      const next = await refresh();
      if (next) acceptSchedule(next);
      else setError('The schedule was saved, but its latest version could not be loaded. Reload before editing again.');
      await account.reloadLeague();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The schedule could not be saved.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <details className={styles.scheduleEditor}><summary>Manage keeper deadline & draft schedule</summary>
    <form onSubmit={event => void save(event)}>
      <p className={styles.help}>Enter both times in the time zone below. Leave either date blank until it is decided. The deadline does not automatically lock submissions.</p>
      {conflict && <p className={styles.warning} role="alert">The saved schedule changed or needs refreshing. Your entries are preserved. <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void reload()}>Replace entries with saved schedule</button></p>}
      <fieldset disabled={disabled || busy || conflict} className={styles.fields}>
        <legend className={styles.srOnly}>League schedule</legend>
        <label htmlFor={`${id}-zone`}>League time zone<input id={`${id}-zone`} value={zone} onChange={event => setZone(event.target.value)} list={`${id}-zones`} required placeholder="America/New_York"/><datalist id={`${id}-zones`}><option value="America/New_York"/><option value="America/Chicago"/><option value="America/Denver"/><option value="America/Los_Angeles"/><option value="UTC"/></datalist></label>
        <label htmlFor={`${id}-deadline`}>Keeper deadline<input id={`${id}-deadline`} type="datetime-local" value={deadline} onChange={event => setDeadline(event.target.value)}/></label>
        <label htmlFor={`${id}-draft`}>Draft date & time<input id={`${id}-draft`} type="datetime-local" value={draftAt} onChange={event => setDraftAt(event.target.value)}/></label>
        <label htmlFor={`${id}-reason`} className={styles.reason}>Reason for schedule change<textarea id={`${id}-reason`} value={note} onChange={event => setNote(event.target.value)} rows={2} maxLength={2000} required/></label>
        <button type="submit" className="button button-green" disabled={!note.trim()}>{busy ? 'Saving schedule…' : 'Save league schedule'}</button>
      </fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.success} role="status">{notice}</p>}
    </form>
  </details>;
}

export function SeasonReadinessPanel({ account }: { account: LeagueAccount }) {
  const id = useId();
  const [readiness, setReadiness] = useState<SeasonReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const allowed = Boolean(account.session?.user && account.commissioner && account.connection === 'live');
  const seasonId = account.seasonId;
  const userId = account.session?.user?.id;
  const reloadSession = account.reloadSession;
  const invalidateAccess = useCallback(() => { sequence.current++; setReadiness(null); setLoading(false); void reloadSession(); }, [reloadSession]);
  const refresh = useCallback(async () => {
    if (!allowed) return null;
    const read = ++sequence.current; setLoading(true); setError('');
    try {
      const response = await fetch('/api/season?seasonId=' + encodeURIComponent(seasonId), { cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && read === sequence.current) invalidateAccess();
        throw new Error(result?.message || 'The season overview could not be loaded.');
      }
      const parsed = seasonReadinessSchema.safeParse(result?.readiness);
      if (!parsed.success || parsed.data.seasonId !== seasonId) throw new Error('The season overview could not be verified. Reload before making changes.');
      if (read !== sequence.current) return null;
      setReadiness(parsed.data); return parsed.data;
    } catch (failure) { if (read === sequence.current) setError(failure instanceof Error ? failure.message : 'The season overview is unavailable.'); return null; }
    finally { if (read === sequence.current) setLoading(false); }
  }, [allowed, seasonId, userId, invalidateAccess]);
  useEffect(() => {
    if (allowed) void refresh(); else setReadiness(null);
    return () => { sequence.current++; };
  }, [allowed, refresh, account.submissions, account.session, account.live]);
  if (!account.session?.user || !account.commissioner) return null;
  const teams = readiness?.teams || [];
  const submitted = teams.filter(team => ['submitted', 'approved', 'locked'].includes(team.status)).length;
  const locked = teams.filter(team => team.status === 'locked').length;
  const unreviewed = teams.reduce((sum, team) => sum + team.profileCounts.provisional + team.profileCounts.unresolved + team.profileCounts.missing, 0);
  return <section className={`panel ${styles.panel}`} aria-labelledby={`${id}-title`}>
    <div className="panel-header"><div><p className="eyebrow">COMMISSIONER · SEASON READINESS</p><h2 id={`${id}-title`}>Every team, every step</h2></div><button type="button" className="text-button" disabled={!allowed || loading || Boolean(account.actionBusy)} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh season overview'}</button></div>
    <div className={styles.body}><p className={styles.help}>Track every participating franchise, including teams that have not saved a draft. Individual selections stay in the private review workspace below.</p>
      {!allowed && <p className={styles.warning}>Connect to live league records to inspect season readiness.</p>}
      {error && <p className={styles.error} role="alert">{error} {readiness && 'The last loaded overview may be out of date.'}</p>}
      {loading && !readiness && <p role="status">Loading all participating teams…</p>}
      {readiness && <>
        <dl className={styles.facts}><div><dt>Submitted for review</dt><dd>{submitted} / {readiness.participantCount}</dd></div><div><dt>Locked for reveal</dt><dd>{locked} / {readiness.participantCount}</dd></div><div><dt>Profiles needing verification</dt><dd>{unreviewed}</dd></div><div><dt>Teams with account access</dt><dd>{teams.filter(team => team.activeManagerCount > 0).length} / {readiness.participantCount}</dd></div></dl>
        <dl className={styles.dates}><div><dt>Keeper deadline</dt><dd>{formatSeasonDate(readiness.keeperDeadline, readiness.seasonTimeZone)}</dd></div><div><dt>Draft</dt><dd>{formatSeasonDate(readiness.draftAt, readiness.seasonTimeZone)}</dd></div></dl>
        {(!readiness.hasFrozenSnapshot || !readiness.inventoryComplete || readiness.registeredCount !== readiness.participantCount) && <p className={styles.warning}>Season setup needs attention: {!readiness.hasFrozenSnapshot && 'a frozen eligibility snapshot is missing. '}{!readiness.inventoryComplete && `The pick inventory is incomplete (${readiness.totalPickCount} of ${readiness.expectedTotalPickCount} expected picks). `}{readiness.registeredCount !== readiness.participantCount && `${readiness.registeredCount} of ${readiness.participantCount} participating teams are registered.`}</p>}
        <div className="table-wrap"><table className={`data-table ${styles.table}`}><caption className={styles.srOnly}>Submission, onboarding, and keeper-profile readiness for each participating team</caption><thead><tr><th scope="col">Team</th><th scope="col">Submission</th><th scope="col">Account access</th><th scope="col">Profile review</th><th scope="col">Pick holdings</th></tr></thead><tbody>{teams.map(team => {
          const reviews = team.profileCounts.provisional + team.profileCounts.unresolved + team.profileCounts.missing;
          return <tr key={team.franchiseId}><th scope="row">{team.displayName}</th><td data-label="Submission"><span className={styles.status}>{stateLabels[team.status]}</span>{team.revision !== null && <small>Revision {team.revision}</small>}</td><td data-label="Account access">{team.activeManagerCount ? `${team.activeManagerCount} assigned` : 'No active manager'}{team.pendingAccessCount > 0 && <small>{team.pendingAccessCount} awaiting approval</small>}</td><td data-label="Profile review">{reviews ? `${reviews} need verification` : 'All profiles reviewed'}<small>{team.profileCounts.confirmed} eligible · {team.profileCounts.ineligible} ineligible</small></td><td data-label="Pick holdings">{team.pickCount} held<small>{team.originalPickCount} / {team.expectedPickCount} original picks recorded</small></td></tr>;
        })}</tbody></table></div>
        <p className={styles.help}>Trades can change how many picks a team holds. Inventory completeness checks each pick’s original franchise and round. A team may submit an empty keeper list.</p>
        <ScheduleEditor key={`${userId}:${readiness.seasonId}`} readiness={readiness} disabled={!allowed || loading || Boolean(error) || Boolean(account.actionBusy) || readiness.phase === 'archived'} refresh={refresh} account={account} invalidateAccess={invalidateAccess}/>
      </>}
    </div>
  </section>;
}
