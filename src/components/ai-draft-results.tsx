'use client';

import { useId, useState, type CSSProperties } from 'react';
import type { AiLeagueRun } from '@/lib/ai-league-types';
import type { LeagueData } from '@/lib/types';
import styles from './ai-draft-results.module.css';

const POSITION: Record<number, string> = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' };

export function AiDraftResults({ run, league, teamId, onTeamChange }: {
  run: AiLeagueRun; league: LeagueData; teamId: string; onTeamChange: (id: string) => void;
}) {
  const heading = useId();
  const [view, setView] = useState<'board' | 'list'>('board');
  const [round, setRound] = useState('all');
  const players = new Map([...run.players, ...(run.initialPlayers ?? [])].map(player => [player.id, player]));
  const order = run.draftOrder.filter(id => run.teams.some(team => team.id === id));
  const picks = run.decisions.filter(decision => decision.kind === 'draft').flatMap(decision => decision.playerIds.map(playerId => ({ teamId: decision.teamId, playerId, reason: decision.reason }))).map((pick, index) => ({ ...pick, overall: index + 1, round: Math.floor(index / Math.max(1, order.length)) + 1 }));
  const rounds = [...new Set(picks.map(pick => pick.round))];
  const selectedRound = round === 'all' || !rounds.includes(Number(round)) ? 'all' : Number(round);
  const shownRounds = rounds.filter(value => selectedRound === 'all' || selectedRound === value);
  const shownPicks = picks.filter(pick => selectedRound === 'all' || selectedRound === pick.round);
  const name = (id: string) => league.teams.find(team => String(team.id) === id)?.name ?? run.teams.find(team => team.id === id)?.name ?? id;
  const color = (id: string) => league.teams.find(team => String(team.id) === id)?.color ?? run.teams.find(team => team.id === id)?.color ?? '#386d54';
  const playerName = (id: number) => players.get(id)?.name ?? `Player ${id}`;
  const positions = (id: number) => players.get(id)?.slots.filter(slot => POSITION[slot]).map(slot => POSITION[slot]).join(' / ') || 'Position unavailable';
  return <section className={styles.section} aria-labelledby={heading}>
    <div className={styles.heading}><div><p className={styles.eyebrow}>EVERY PICK, EVERY FRANCHISE</p><h3 id={heading}>AI draft results</h3><p>The original {run.season - 1}–{String(run.season).slice(-2)} simulation draft, preserved as players move during the season.</p></div><span className={styles.count}><strong>{picks.length}</strong> picks · {rounds.length} rounds · {order.length} teams</span></div>
    {picks.length ? <>
      <div className={styles.toolbar}><div className={styles.views} aria-label="AI draft results view"><button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Draft board</button><button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>Pick list</button></div><label>Round<select aria-label="AI draft round" value={selectedRound} onChange={event => setRound(event.target.value)}><option value="all">All rounds</option>{rounds.map(value => <option key={value} value={value}>Round {value}</option>)}</select></label></div>
      {view === 'board' ? <div className={styles.scroll} tabIndex={0} role="region" aria-label="Complete AI draft board"><table className={styles.board}><caption className="visually-hidden">AI draft results by round and franchise. Columns remain in first-round order; even rounds reverse the pick order.</caption><thead><tr><th scope="col">Round</th>{order.map((id, index) => <th scope="col" key={id} className={id === teamId ? styles.selected : undefined} style={{ '--team-color': color(id) } as CSSProperties}><button type="button" aria-pressed={id === teamId} aria-label={`Highlight ${name(id)} AI draft`} onClick={() => onTeamChange(id)}><span>Draft slot {index + 1}</span>{name(id)}</button></th>)}</tr></thead><tbody>{shownRounds.map(value => <tr key={value}><th scope="row"><strong>{value}</strong><span aria-label={value % 2 ? 'Left to right' : 'Right to left'}>{value % 2 ? '→' : '←'}</span></th>{order.map(id => {
        const pick = picks.find(item => item.round === value && item.teamId === id);
        return <td key={id} className={id === teamId ? styles.selected : undefined}>{pick ? <><span className={styles.pickNumber}>#{pick.overall}</span><strong>{playerName(pick.playerId)}</strong><small>{positions(pick.playerId)}</small></> : <span className={styles.pending}>Not recorded</span>}</td>;
      })}</tr>)}</tbody></table></div> : <div className={styles.scroll} tabIndex={0} role="region" aria-label="Complete AI draft pick list"><table className={styles.list}><caption className="visually-hidden">AI draft selections in overall pick order</caption><thead><tr><th scope="col">Pick</th><th scope="col">Player</th><th scope="col">Franchise</th></tr></thead><tbody>{shownPicks.map(pick => <tr key={pick.overall} className={pick.teamId === teamId ? styles.selected : undefined}><th scope="row">#{pick.overall}<span>Round {pick.round}</span></th><td><strong>{playerName(pick.playerId)}</strong><small>{positions(pick.playerId)}</small></td><td><button type="button" onClick={() => onTeamChange(pick.teamId)} aria-label={`Highlight ${name(pick.teamId)} AI draft`}><i style={{ background: color(pick.teamId) }}/>{name(pick.teamId)}</button></td></tr>)}</tbody></table></div>}
      <p className={styles.note}>{shownPicks.length} of {picks.length} picks shown. Snake order reverses each round. Select a franchise to highlight its picks and update the owner comparison below.<span className={styles.mobileHint}> Swipe across the board, or use Pick list for a compact view.</span></p>
    </> : <div className={styles.empty}>AI draft selections will appear here when this season’s draft is saved.</div>}
  </section>;
}
