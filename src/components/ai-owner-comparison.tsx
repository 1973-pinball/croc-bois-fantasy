'use client';

import { useId, useMemo } from 'react';
import { compareAiOwners, type AiComparedDraftPlayer, type AiComparedRecord } from '@/lib/ai-owner-comparison';
import type { AiLeagueRun } from '@/lib/ai-league-types';
import type { LeagueData } from '@/lib/types';
import styles from './ai-owner-comparison.module.css';

const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0';
const record = (value: AiComparedRecord) => `${value.wins}–${value.losses}–${value.ties}`;

export function AiOwnerComparison({ run, league, teamId, onTeamChange }: {
  run: AiLeagueRun; league: LeagueData; teamId: string; onTeamChange: (id: string) => void;
}) {
  const headingId = useId();
  const comparison = useMemo(() => compareAiOwners(run, league), [run, league]);
  const team = comparison.teams.find(item => item.teamId === teamId) ?? comparison.teams[0];
  const { biggestGain, biggestDecrease, biggestAcquisitionGap, biggestDraftDeparture } = comparison.headline;
  const highlights = [
    ...(biggestGain ? [{ ...biggestGain, title: 'Biggest increase in category wins', value: signed(biggestGain.delta), detail: `${comparison.completedPeriods} matched regular-season periods` }] : []),
    ...(biggestDecrease ? [{ ...biggestDecrease, title: 'Biggest decrease in category wins', value: signed(biggestDecrease.delta), detail: `${comparison.completedPeriods} matched regular-season periods` }] : []),
    ...(biggestAcquisitionGap ? [{ ...biggestAcquisitionGap, title: 'Biggest difference in pickups', value: signed(biggestAcquisitionGap.delta), detail: 'AI pickups minus actual owner pickups' }]
      : biggestDraftDeparture ? [{ ...biggestDraftDeparture, title: 'Biggest departure in the draft', value: String(biggestDraftDeparture.count), detail: 'AI selections absent from that owner’s draft' }] : []),
  ];
  const available = comparison.draftAvailable || comparison.categoriesAvailable || comparison.acquisitionsAvailable;
  return <section className={styles.comparison} aria-labelledby={headingId}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>TWO VERSIONS OF THE SAME FRANCHISE</p><h3 id={headingId}>AI vs. the actual owners</h3><p className={styles.intro}>See who they drafted, how often they made pickups, and where the category results changed most.</p></div></div>
    {highlights.length > 0 && <div className={styles.highlights}>{highlights.map(item => <button type="button" key={item.title} className={styles.highlight} aria-pressed={team?.teamId === item.teamId} onClick={() => onTeamChange(item.teamId)}><span>{item.title}</span><strong>{item.value}</strong><b>{item.teamName}</b><small>{item.detail}</small><span className={styles.explore}>Explore this franchise →</span></button>)}</div>}
    {team && <div className={styles.teamHeading}><div><h4>{team.name}</h4><p>{team.historicalOwner ? `Actual draft owner: ${team.historicalOwner}` : 'Follow the same franchise in both versions of the season.'}</p></div><label>Compare franchise<select aria-label="Compare AI with actual owner for franchise" value={team.teamId} onChange={event => onTeamChange(event.target.value)}>{comparison.teams.map(item => <option key={item.teamId} value={item.teamId}>{item.name}</option>)}</select></label></div>}
    {!available ? <div className={styles.pending}><strong>Waiting for the actual season</strong><p>The AI draft is ready. Owner comparisons will appear as the actual {run.season - 1}–{String(run.season).slice(-2)} draft and completed matchup records become available. No earlier season is substituted.</p></div> : team && <>
      <div className={styles.summary}>
        <div><span>DRAFT AGREEMENT</span><strong>{team.draft.available ? team.draft.complete ? `${team.draft.sharedCount} of ${team.draft.aiPicks} players` : `${team.draft.sharedCount} confirmed matches` : 'Draft pending'}</strong><p>{team.draft.available ? team.draft.complete ? `Chosen by both. ${team.draft.departureCount} AI picks differed from the owner’s board.` : 'The owner draft coverage is incomplete; draft differences remain pending.' : 'A verified owner draft is needed to compare selections.'}</p></div>
        <div><span>REGULAR-SEASON CATEGORY RECORD</span><strong>{team.categories ? `${signed(team.categories.winsDelta)} category wins` : 'Results pending'}</strong><p>{team.categories ? <>Owner {record(team.categories.owner)} → AI {record(team.categories.ai)}<br/>{team.categories.periods.length} matching completed periods · W–L–T</> : 'Results need the same completed periods on both sides.'}</p></div>
        <div><span>PICKUP ACTIVITY</span><strong>{team.acquisitions ? `${team.acquisitions.ai} AI / ${team.acquisitions.owner} owner` : 'Pickup comparison pending'}</strong><p>{team.acquisitions ? `${team.acquisitions.delta === 0 ? 'The same number of pickups' : `${Math.abs(team.acquisitions.delta)} ${team.acquisitions.delta < 0 ? 'fewer' : 'more'} AI pickups`} across ${team.acquisitions.periods.length} matching completed periods.` : 'Actual pickup counts are compared only for matching completed periods.'}</p></div>
      </div>
      {team.categories && <div className={styles.categorySection}><div className={styles.subheading}><h5>Where the results changed most</h5><span>Category wins · Owner → AI</span></div><div className={styles.categories}>{team.categories.biggestSwings.slice(0, 3).map(category => <div className={styles.category} key={category.id}><div className={styles.categoryTitle}><b>{category.label}</b><strong>{signed(category.winsDelta)} wins</strong></div><div className={styles.barRow}><span>Owner</span><div className={styles.barTrack}><i style={{ width: `${category.owner.wins / team.categories!.periods.length * 100}%` }}/></div><b>{category.owner.wins}</b></div><div className={styles.barRow}><span>AI</span><div className={styles.barTrack}><i style={{ width: `${category.ai.wins / team.categories!.periods.length * 100}%` }}/></div><b>{category.ai.wins}</b></div></div>)}</div><details className={styles.receipts}><summary>All nine category records</summary><div className={styles.tableScroll}><table><caption className="visually-hidden">Actual and simulated category records for {team.name}, matching completed regular-season periods</caption><thead><tr><th scope="col">Category</th><th scope="col">Owner W–L–T</th><th scope="col">AI W–L–T</th><th scope="col">Win change</th></tr></thead><tbody>{team.categories.rows.map(category => <tr key={category.id}><th scope="row">{category.label}</th><td>{record(category.owner)}</td><td>{record(category.ai)}</td><td>{signed(category.winsDelta)}</td></tr>)}</tbody></table></div></details></div>}
      {team.draft.available && team.draft.complete && <div className={styles.draftSection}><div className={styles.subheading}><h5>The earliest draft choices that differed</h5><span>{team.draft.aiOnly.length} AI-only · {team.draft.ownerOnly.length} owner-only</span></div><p className={styles.draftIntro}>The highest picks on each board that the other side did not select for this franchise. Real keepers are marked; their pick is the keeper cost.</p><DraftDifferences ai={team.draft.aiOnly.slice(0, 3)} owner={team.draft.ownerOnly.slice(0, 3)}/>{(team.draft.aiOnly.length > 3 || team.draft.ownerOnly.length > 3) && <details className={styles.receipts}><summary>Show the remaining draft differences</summary><DraftDifferences ai={team.draft.aiOnly.slice(3)} owner={team.draft.ownerOnly.slice(3)}/></details>}<p className={styles.shared}><strong>Both chose: </strong>{team.draft.shared.length ? team.draft.shared.map(player => player.name).join(' · ') : 'No shared players in the recorded draft.'}</p></div>}
    </>}
    <p className={styles.note}>This compares two whole-league scenarios. The AI starts with a fresh draft and different pick order; owners used their real keepers and traded picks. A result difference does not measure the effect of a single decision.</p>
    <details className={styles.receipts}><summary>Comparison sources & coverage</summary>{comparison.limitations.map((item, index) => <p key={index}>{item}</p>)}<p>Actual daily lineups and player-by-player transaction histories are not imported. Pickup counts describe activity; they do not identify a specific missed add or start.</p></details>
    {run.actual?.capturedAt && <p className={styles.coverage}>Owner data captured {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/New_York' }).format(new Date(run.actual.capturedAt))}. Current owners may differ from the owner recorded on the historical draft.</p>}
  </section>;
}

function DraftDifferences({ ai, owner }: { ai: AiComparedDraftPlayer[]; owner: AiComparedDraftPlayer[] }) {
  return <div className={styles.draftColumns}>{[{ title: 'AI drafted', players: ai }, { title: 'Owner drafted or kept', players: owner }].map(side => <div className={styles.draftColumn} key={side.title}><h5>{side.title}</h5>{side.players.length ? <ol>{side.players.map(player => <li key={`${player.overallPick}:${player.name}`}><div><strong>{player.name}</strong><span>Overall pick {player.overallPick}</span></div>{player.keeper === true && <small>Keeper</small>}</li>)}</ol> : <p>No different picks in this part of the board.</p>}</div>)}</div>;
}
