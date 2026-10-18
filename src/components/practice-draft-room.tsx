'use client';

import { useEffect, useReducer, useState, type CSSProperties } from 'react';
import catalogFile from '../../data/draft-player-catalog.json';
import { draftOverallPick, type DraftBoard } from '@/lib/draft-board';
import { compareDraftCatalogPlayers, type DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import { franchiseColorStyle } from '@/lib/franchise-colors';
import { updatePracticeDraft, type PracticeDraft, type PracticeDraftAccess, type PracticeDraftAction } from '@/lib/practice-draft';
import { DraftRosters } from './draft-rosters';
import styles from './live-draft-board.module.css';

const catalog = catalogFile as DraftPlayerCatalog;
const players = [...catalog.players].sort(compareDraftCatalogPlayers);

function PracticeGrid({ board }: { board: DraftBoard }) {
  const teams = [...board.teams].sort((a, b) => (a.draftPosition ?? Infinity) - (b.draftPosition ?? Infinity));
  const teamName = (id: string | null) => teams.find(team => team.franchiseId === id)?.displayName ?? '';
  return <div className={styles.boardScroll} tabIndex={0} aria-label="Practice draft grid; scroll to see all rounds and slots">
    <div className={styles.grid} style={{ '--teams': teams.length } as CSSProperties} role="table" aria-label="Practice draft board by original slot" aria-rowcount={board.roundCount + 1} aria-colcount={teams.length + 1}>
      <div className={styles.boardRow} role="row"><div className={styles.corner} role="columnheader">ROUND</div>{teams.map((team, index) => <div key={team.franchiseId} role="columnheader" className={`${styles.columnHeader} ${styles.ownerColor}`} style={franchiseColorStyle(team.franchiseId)}><span>SLOT {index + 1}</span><strong>{team.displayName}</strong></div>)}</div>
      {Array.from({ length: board.roundCount }, (_, index) => {
        const round = index + 1;
        return <div key={round} className={styles.boardRow} role="row"><div className={styles.round} role="rowheader">{String(round).padStart(2, '0')}<small aria-hidden="true">{board.draftFormat === 'linear' || round % 2 ? '→' : '←'}</small></div>{teams.map((team, slot) => {
          const overall = draftOverallPick(round, slot + 1, teams.length, board.draftFormat);
          const pick = board.picks.find(item => item.overallPick === overall);
          const keeper = pick?.status === 'keeper', drafted = pick?.status === 'selected', next = pick?.id === board.nextPickId;
          return <div key={team.franchiseId} role="cell" style={franchiseColorStyle(pick?.currentOwnerId)} className={`${styles.cell} ${styles.ownerColor} ${keeper ? styles.keeperCell : drafted ? styles.draftedCell : ''} ${next ? styles.nextCell : ''}`}>
            <span className={styles.pickLabel}><b>{round}.{String(overall - (round - 1) * teams.length).padStart(2, '0')}</b><span>#{overall}</span></span>
            <strong className={pick?.playerName ? '' : styles.emptyPick}>{pick?.playerName || (next ? board.clock.status === 'running' ? 'Practice turn' : 'Up next' : 'Available')}</strong>
            <div className={styles.cellFooter}><span>{teamName(pick?.currentOwnerId ?? null)}</span>{keeper ? <b className={styles.keeperBadge}>Kept</b> : drafted ? <b className={styles.draftedBadge}>Drafted</b> : next ? <b className={styles.nextBadge}>Next</b> : null}{pick && pick.currentOwnerId !== pick.originalFranchiseId && <small className={styles.via}>via {teamName(pick.originalFranchiseId)}</small>}</div>
          </div>;
        })}</div>;
      })}
    </div>
  </div>;
}

/** Deliberately isolated from live controls, API requests, queues, and browser storage. */
export function PracticeDraftRoom({ initial, access, onExit }: { initial: PracticeDraft; access: PracticeDraftAccess; onExit: () => void }) {
  const [{ practice, error }, dispatch] = useReducer((previous: { practice: PracticeDraft; error: string }, request: { action: PracticeDraftAction; access: PracticeDraftAccess; time: number }) => {
    try {
      const next = updatePracticeDraft(previous.practice, request.action, request.access, players, request.time);
      return next === previous.practice && request.action.type === 'tick' ? previous : { practice: next, error: '' };
    } catch (failure) { return { ...previous, error: failure instanceof Error ? failure.message : 'The practice action could not be completed.' }; }
  }, { practice: initial, error: '' });
  const [now, setNow] = useState(Date.now());
  const [duration, setDuration] = useState(String(initial.board.clock.durationSeconds));
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('all');
  const [selected, setSelected] = useState<{ playerId: number; pickId: string } | null>(null);
  const [view, setView] = useState<'players' | 'rosters'>('players');
  const { board } = practice;
  useEffect(() => {
    if (board.clock.status !== 'running') return;
    const interval = window.setInterval(() => {
      const time = Date.now(); setNow(time);
      dispatch({ action: { type: 'tick' }, access, time });
    }, 250);
    return () => window.clearInterval(interval);
  }, [board.clock.status, access.userId, access.commissioner, access.connection, access.seasonId]);
  useEffect(() => { setSelected(null); }, [board.nextPickId]);

  function act(action: PracticeDraftAction) {
    const time = Date.now(); setNow(time);
    dispatch({ action, access, time });
    if (action.type === 'reset') { setDuration(String(practice.baseline.clock.durationSeconds)); setSelected(null); }
  }
  const current = board.picks.find(pick => pick.id === board.nextPickId);
  const occupied = new Set(board.picks.map(pick => pick.playerId));
  const matches = players.filter(player => player.selectable && !occupied.has(player.id) && player.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (position === 'all' || player.eligiblePositions.some(item => item === position)));
  const visible = matches.slice(0, 200);
  const candidate = players.find(player => player.id === selected?.playerId);
  const remaining = board.clock.status === 'running' && board.clock.deadlineAt ? Math.max(0, Math.ceil((Date.parse(board.clock.deadlineAt) - now) / 1000)) : Math.ceil(board.clock.remainingSeconds ?? 0);
  const ready = board.clock.status === 'waiting';
  const running = board.clock.status === 'running';
  const paused = board.clock.status === 'paused';

  return <section className={`panel ${styles.panel} ${styles.practicePanel}`} aria-labelledby="practice-draft-title">
    <div className="panel-header"><div><p className="eyebrow">COMMISSIONER · LOCAL PRACTICE</p><h2 id="practice-draft-title">Practice draft</h2></div><button type="button" className="button button-subtle" onClick={onExit}>Exit practice</button></div>
    <div className={styles.practiceBanner}><strong>Practice only · your official draft is unchanged</strong><p>Copied from live board revision {practice.baseline.revision}. Pretend picks stay in this tab. Reset restores this starting snapshot, including keepers and traded pick ownership. Closing, leaving, or reloading discards practice.</p><p>This rehearses the board, roster display, and local timer. Shared accounts, saved queues, server timing, and draft trades require separate checks.</p></div>
    <div className={styles.summary}><div><strong>{current ? `Practice pick ${current.overallPick} · ${board.teams.find(team => team.franchiseId === current.currentOwnerId)?.displayName}` : 'Practice board complete'}</strong><p>The timer chooses the highest available captured ESPN rank when it expires. Private team queues are not used.</p></div><dl><div><dt>Keepers</dt><dd>{board.picks.filter(pick => pick.status === 'keeper').length}</dd></div><div><dt>Pretend picks</dt><dd>{practice.practicePickIds.length}</dd></div><div><dt>Available</dt><dd>{board.picks.filter(pick => pick.status === 'available').length}</dd></div></dl></div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <p className={styles.success} role="status">{practice.message}</p>
    <div className={styles.layout}><div className={styles.boardArea}>
      <div className={styles.clockPanel}><div className={styles.clockReadout}><span>Practice clock · {board.clock.status}</span><strong aria-label={`${remaining} seconds remaining`}>{board.clock.status === 'completed' ? 'DONE' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}</strong></div><div className={styles.clockControls}>
        {ready && <form className={styles.timerSetting} onSubmit={event => { event.preventDefault(); act({ type: 'configure', seconds: Number(duration) }); }}><label htmlFor="practice-duration">Seconds per practice pick<input id="practice-duration" type="number" min={10} max={600} step={1} value={duration} onChange={event => setDuration(event.target.value)}/></label><button type="submit" className="button button-subtle">Set timer</button></form>}
        <button type="button" className="button button-green" disabled={!ready && !running && !paused} onClick={() => act({ type: ready ? 'start' : running ? 'pause' : 'resume' })}>{ready ? 'START PRACTICE' : running ? 'PAUSE PRACTICE' : paused ? 'RESUME PRACTICE' : 'PRACTICE COMPLETE'}</button>
        <button type="button" className="button button-subtle" onClick={() => act({ type: 'reset' })}>Reset practice</button>
      </div><p className={styles.clockHelp}>Local timer · {board.clock.durationSeconds} seconds per pick. Returning after a background pause advances at most one pretend pick.</p></div>
      <div className={styles.legend}><span><i className={styles.keeperSwatch}/>Kept</span><span><i className={styles.draftedSwatch}/>Drafted</span><span><i className={styles.nextSwatch}/>Next practice pick</span><small>{board.draftFormat === 'snake' ? 'Snake' : 'Linear'} · {board.roundCount} rounds</small></div>
      <PracticeGrid board={board}/>
    </div><aside className={styles.sidePanel} aria-label="Practice draft tools">
      <div className={styles.workspaceSwitch} role="group" aria-label="Practice draft view"><button type="button" aria-pressed={view === 'players'} onClick={() => setView('players')}>Practice players</button><button type="button" aria-pressed={view === 'rosters'} onClick={() => setView('rosters')}>Practice rosters</button></div>
      {view === 'rosters' ? <div className={styles.sidePanelBody}><DraftRosters compact mode="practice" board={board} preferredFranchiseId={current?.currentOwnerId ?? undefined}/></div> : <div className={styles.sidePanelBody}><section className={styles.playerPanel} aria-labelledby="practice-player-title"><p className="eyebrow">PRETEND SELECTIONS</p><h3 id="practice-player-title">Available players</h3>
        <label className={styles.field}>Find a practice player<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the player pool"/></label>
        <label className={styles.field}>Position<select value={position} onChange={event => setPosition(event.target.value)}><option value="all">All positions</option>{['PG', 'SG', 'SF', 'PF', 'C'].map(item => <option key={item}>{item}</option>)}</select></label>
        <label className={styles.field}>Choose a practice player<select value={selected?.playerId ?? ''} onChange={event => setSelected(event.target.value && current ? { playerId: Number(event.target.value), pickId: current.id } : null)} disabled={!current}><option value="">Select an available player</option>{visible.map(player => <option key={player.id} value={player.id}>{player.rank === null ? 'NR' : `#${player.rank}`} · {player.name}</option>)}</select></label>
        {candidate && <div className={styles.candidate}><strong>{candidate.name}</strong><span>{candidate.primaryPosition ?? '—'} · {candidate.nbaTeam}</span></div>}
        <div className={styles.pickActions}><strong>{current ? `Practice pick ${current.overallPick} · ${board.teams.find(team => team.franchiseId === current.currentOwnerId)?.displayName}` : 'All practice picks filled'}</strong>{!running && current && <p>{ready ? 'Start practice to select a player.' : 'Resume practice to select a player.'}</p>}<button type="button" className="button button-green" disabled={!running || !selected || selected.pickId !== current?.id || occupied.has(selected.playerId)} onClick={() => { if (selected) act({ type: 'pick', ...selected }); }}>Record pretend pick</button><button type="button" className="button button-subtle" disabled={!practice.practicePickIds.length} onClick={() => act({ type: 'undo' })}>Undo last pretend pick</button></div>
        <div className={styles.poolHeading}><span>{visible.length} of {matches.length} available matches</span><span>ESPN rank</span></div><div className={styles.playerList}>{visible.map(player => <button key={player.id} type="button" className={`${styles.playerRow} ${selected?.playerId === player.id ? styles.chosenPlayer : ''}`} aria-pressed={selected?.playerId === player.id} disabled={!current} onClick={() => { if (current) setSelected({ playerId: player.id, pickId: current.id }); }}><span className={styles.rank}>{player.rank ?? '—'}</span><span className={styles.playerInfo}><strong>{player.name}</strong><small>{player.primaryPosition ?? '—'} · {player.nbaTeam}</small></span></button>)}{!visible.length && <p className={styles.footnote}>No available players match.</p>}</div><p className={styles.footnote}>Top 200 matches. Search by name for the full captured pool.</p>
      </section></div>}
    </aside></div>
  </section>;
}
