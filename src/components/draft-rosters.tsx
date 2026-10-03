'use client';

import { useId, useMemo, useState } from 'react';
import settingsFile from '../../data/draft-roster-settings.json';
import eligibilityFile from '../../data/draft-roster-eligibility.json';
import type { DraftBoard } from '@/lib/draft-board';
import { buildDraftRosters, type DraftRosterSlot } from '@/lib/draft-roster';
import type { DraftRosterEligibility, DraftRosterSettings } from '@/lib/espn-roster-settings';
import { franchiseColorStyle } from '@/lib/franchise-colors';
import styles from './draft-rosters.module.css';

const settings = settingsFile as DraftRosterSettings;
const eligibility = eligibilityFile as DraftRosterEligibility;
const reserveLabels = new Set(settings.slots.filter(slot => slot.kind === 'reserve').map(slot => slot.label));

function RosterSlot({ slot, reserve = false }: { slot: DraftRosterSlot; reserve?: boolean }) {
  const player = slot.player;
  const labels = player?.eligibleLabels.filter(label => !reserveLabels.has(label)) ?? [];
  return <li className={styles.slot}>
    <span className={styles.slotLabel}>{slot.label}{slot.ordinal > 1 && <small>{slot.ordinal}</small>}</span>
    {player ? <div className={styles.player}><div className={styles.playerHeading}><strong>{player.name}</strong><span className={`${styles.badge} ${player.status === 'keeper' ? styles.kept : ''}`}>{player.status === 'keeper' ? 'KEPT' : 'DRAFTED'}</span></div><p>Eligible: {labels.length ? labels.join(' / ') : 'Not available from ESPN'}</p></div> : <span className={styles.empty}>{reserve ? 'Separate reserve slot' : 'Lineup slot unfilled'}</span>}
  </li>;
}

export function DraftRosters({ board, preferredFranchiseId }: { board: DraftBoard; preferredFranchiseId?: string }) {
  const id = useId();
  const [choice, setChoice] = useState(preferredFranchiseId || board.teams[0]?.franchiseId || '');
  const summary = useMemo(() => buildDraftRosters(board, settings, eligibility), [board]);
  const selectedId = board.teams.some(team => team.franchiseId === choice) ? choice : board.teams[0]?.franchiseId;
  const team = summary.teams.find(item => item.franchiseId === selectedId);
  const pendingOrder = !board.orderComplete;
  const pendingKeepers = !board.keepersRevealedAt;
  const issues = [...new Set([...summary.issues, ...(team?.issues || [])])];
  const seasonLabel = `${settings.espnSeasonId - 1}–${String(settings.espnSeasonId).slice(-2)}`;
  return <section className={`panel ${styles.panel}`} aria-labelledby={`${id}-title`}>
    <div className={styles.header}><div><h2 id={`${id}-title`}>Draft rosters</h2><p>Public keepers and draft selections, fitted to ESPN’s roster slots.</p></div><label className={styles.teamSelect} style={franchiseColorStyle(selectedId)}>View team<select value={selectedId || ''} onChange={event => setChoice(event.target.value)}>{board.teams.map(item => <option key={item.franchiseId} value={item.franchiseId}>{item.displayName}</option>)}</select></label></div>
    <div className={styles.body}>
      {(pendingOrder || pendingKeepers) && <p className={styles.notice}>{pendingOrder ? 'Draft order is pending. Rosters fill here once the order is published, keepers are revealed, and draft picks are recorded.' : 'Public keepers appear here after keeper reveal. Recorded draft picks then fill the remaining lineup slots.'} Counts show only players currently visible on the public board.</p>}
      {!summary.available && <p className={styles.notice}>{summary.unavailableReason || 'Verified ESPN roster settings are not available for this season.'}</p>}
      {summary.available && team && <>
        <div className={styles.teamSummary} style={franchiseColorStyle(team.franchiseId)}><h3>{team.displayName}</h3><div className={styles.total} aria-label={`${team.totalPlayers} visible players; ${team.normalCapacity} configured roster slots`}><strong>{team.totalPlayers}</strong><span>players · {team.normalCapacity} slots</span></div><dl className={styles.summaryCounts}><div><dt>kept</dt><dd>{pendingOrder || pendingKeepers ? '—' : team.keptPlayers}</dd></div><div><dt>drafted</dt><dd>{pendingOrder ? '—' : team.draftedPlayers}</dd></div><div><dt>unfilled</dt><dd>{team.slots.filter(slot => !slot.player).length}</dd></div></dl></div>
        <dl className={styles.slotCounts} aria-label="ESPN lineup slots filled and configured">{team.slotCounts.filter(slot => slot.kind === 'normal').map(slot => <div key={slot.slotId}><dt>{slot.label}</dt><dd>{slot.filled}/{slot.total}</dd></div>)}</dl>
        <p className={styles.help}>Filled / configured slots. This is a suggested fit using ESPN eligibility; it does not set your ESPN lineup. Slot counts are not per-position draft limits.</p>
        {team.overflow > 0 && <p className={styles.notice}>{team.overflow} {team.overflow === 1 ? 'player over' : 'players over'} the {team.normalCapacity} regular slots.</p>}
        <ul className={styles.slots} aria-label="Suggested ESPN lineup">{team.slots.map(slot => <RosterSlot key={slot.key} slot={slot}/>)}</ul>
        {team.unplaced.length > 0 && <div className={styles.unplaced}><h4>{team.unplaced.length} {team.unplaced.length === 1 ? 'player without' : 'players without'} a suggested slot</h4><ul aria-label="Players without a suggested slot">{team.unplaced.map(item => <li key={item.player.id}><strong>{item.player.name}</strong>{' '}<span className={`${styles.badge} ${item.player.status === 'keeper' ? styles.kept : ''}`}>{item.player.status === 'keeper' ? 'KEPT' : 'DRAFTED'}</span><br/>Eligible: {item.player.eligibleLabels.filter(label => !reserveLabels.has(label)).join(' / ') || 'Not available from ESPN'}<br/>{item.message}</li>)}</ul></div>}
        {team.reserveSlots.length > 0 && <div className={styles.ir}><h4>Reserve · separate from {team.normalCapacity} roster slots</h4><p className={styles.help}>IR placement depends on ESPN injury eligibility. Draft players are not automatically assigned to IR.</p><ul className={styles.slots} aria-label="ESPN reserve slots">{team.reserveSlots.map(slot => <RosterSlot key={slot.key} slot={slot} reserve/>)}</ul></div>}
      </>}
      {issues.length > 0 && <div className={styles.unplaced}><h4>Roster information to check</h4><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
      <p className={styles.source}><a href={settings.source.url} target="_blank" rel="noreferrer">ESPN {seasonLabel} roster settings</a> · updated <time dateTime={settings.source.capturedAt}>{new Date(settings.source.capturedAt).toLocaleString()}</time><span>Player eligibility updated <time dateTime={eligibility.source.capturedAt}>{new Date(eligibility.source.capturedAt).toLocaleString()}</time>. Rosters follow the live board’s public picks and current owners.</span></p>
    </div>
  </section>;
}
