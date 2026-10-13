'use client';

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { AiDecision, AiLeagueResponse, AiLeagueRun, AiStats } from '@/lib/ai-league-types';
import type { LeagueData } from '@/lib/types';
import { useQueryFilter } from './use-portal-location';
import { AiOwnerComparison } from './ai-owner-comparison';
import { AiDraftResults } from './ai-draft-results';
import { AiSingleTeamReplays } from './ai-single-team-replays';
import { AiLiveSingleTeams } from './ai-live-single-teams';
import styles from './ai-league-lab.module.css';

const SEASONS = [{ id: 2027, label: '2026–27', detail: 'Live experiment' }, { id: 2026, label: '2025–26', detail: 'Season replay' }];
const STATUS = { preseason: 'Preseason', active: 'In progress', complete: 'Complete', needs_data: 'Needs data' };
const POSITIONS: Record<number, string> = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' };
const CATEGORIES: { label: string; value: (stats: AiStats) => number | null; percent?: boolean; reverse?: boolean }[] = [
  { label: 'FG%', value: stats => stats.fga ? stats.fgm / stats.fga : null, percent: true },
  { label: 'FT%', value: stats => stats.fta ? stats.ftm / stats.fta : null, percent: true },
  { label: '3PM', value: stats => stats.three }, { label: 'PTS', value: stats => stats.pts },
  { label: 'REB', value: stats => stats.reb }, { label: 'AST', value: stats => stats.ast },
  { label: 'STL', value: stats => stats.stl }, { label: 'BLK', value: stats => stats.blk },
  { label: 'TO', value: stats => stats.tov, reverse: true },
];

function formatDate(value: string | null, includeTime = false) {
  if (!value) return 'Not yet available';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return 'Not yet available';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York', ...(includeTime ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const : {}) }).format(date);
}

function ExperimentIcon() {
  return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M17 6h14M20 6v14L9 37a4 4 0 0 0 3 6h24a4 4 0 0 0 3-6L28 20V6M15 29h18"/><path d="m20 35 3 3 6-6"/><circle cx="34" cy="14" r="2"/><circle cx="12" cy="19" r="2"/></svg>;
}

export function AiLeagueLab({ league }: { league: LeagueData }) {
  const [seasonParam, setSeason] = useQueryFilter('labAiSeason', '2027');
  const season = seasonParam === '2026' ? 2026 : 2027;
  const [response, setResponse] = useState<AiLeagueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const request = useRef<AbortController | null>(null);
  const titleId = useId();
  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    if (alive.current) setLoading(true);
    try {
      const result = await fetch('/api/ai-league', { cache: 'no-store', signal: controller.signal });
      if (!result.ok) throw new Error('The saved experiment could not be loaded. Try refreshing again.');
      const value = await result.json() as AiLeagueResponse;
      if (!value || !Array.isArray(value.runs) || !value.refresh) throw new Error('The experiment response is incomplete. Try refreshing again.');
      if (alive.current && !controller.signal.aborted) { setResponse(value); setError(null); }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The saved experiment could not be loaded.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (alive.current) setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = window.setInterval(visible, 60_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      request.current?.abort(); request.current = null;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);
  const run = response?.runs.find(item => item.season === season);
  const state = run ? STATUS[run.status] : loading ? 'Loading experiment' : 'Awaiting experiment';
  return <section className={styles.experiment} aria-labelledby={titleId}>
    <div className={styles.hero}><div className={styles.heroCopy}><p className={styles.eyebrow}>{season === 2026 ? 'THREE REPLAY EXPERIMENTS' : 'THREE LIVE EXPERIMENTS'}</p><h2 id={titleId}>What changes when AI takes over?</h2><p>Automate the whole league, one team after the real draft, or one team from its draft onward. {season === 2026 ? 'Explore each version of the 2025–26 season.' : 'Follow each version of 2026–27 as real games are played. The one-team variations begin after the real draft.'}</p></div><div className={styles.heroMark}><ExperimentIcon/><span>ONE LEAGUE.<br/>THREE VARIATIONS.</span></div></div>
    <div className={styles.toolbar}><div className={styles.seasons} aria-label="AI experiment season">{SEASONS.map(item => <button key={item.id} type="button" aria-pressed={season === item.id} onClick={() => setSeason(String(item.id))}><strong>{item.label}</strong><span>{item.detail}</span></button>)}</div><button className={styles.refresh} type="button" onClick={() => void load()} disabled={loading}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5"/></svg>{loading ? 'Checking…' : 'Refresh results'}</button></div>
    <div className={styles.statusStrip}><span className={`${styles.status} ${run?.status === 'needs_data' ? styles.needsData : ''}`}><i/>{state}</span><p>{run?.season === 2026 && run.status === 'complete' ? 'The saved 2025–26 season is available. Choose a replay variation below.' : run?.message ? `Whole-league AI: ${run.message}` : (loading ? 'Loading the saved season and its decision record.' : 'This season will appear when its source data and saved run are available.')}</p></div>
    {(error || response?.refresh.error) && <p className={styles.error} role="status">{error || response?.refresh.error}{run ? ' The last saved experiment is still shown.' : ''}</p>}
    {run ? <SeasonRun key={season} run={run} league={league}/> : <div className={styles.empty}><ExperimentIcon/><h3>{loading ? 'Opening the experiment' : 'The results need a starting point'}</h3><p>{loading ? 'The saved draft, standings, and decision trail will appear here.' : 'No scored games or champion are available for this season yet. Refresh to check for a saved run.'}</p></div>}
    <div className={styles.freshness}><span>{run ? <>Saved <time dateTime={run.updatedAt}>{formatDate(run.updatedAt, true)}</time></> : 'No saved season loaded'}{run?.dataThrough && <> · Results through <time dateTime={run.dataThrough}>{formatDate(run.dataThrough)}</time></>}{response?.refresh.lastAttempt && <> · Source check <time dateTime={response.refresh.lastAttempt}>{formatDate(response.refresh.lastAttempt, true)}</time></>}</span><span>{response?.refresh.automatic ? 'Automatic source updates enabled' : 'Showing saved experiment data'} · Page checks every minute while visible</span></div>
  </section>;
}

function SeasonRun({ run, league }: { run: AiLeagueRun; league: LeagueData }) {
  const [portalTeam] = useQueryFilter('team', run.teams[0]?.id ?? '');
  const [teamParam, setTeam] = useQueryFilter('labAiTeam', run.teams.some(team => team.id === portalTeam) ? portalTeam : run.teams[0]?.id ?? '');
  const [variationParam, setVariation] = useQueryFilter('labAiVariation', 'all');
  const variation = variationParam === 'post_draft' || variationParam === 'redraft' ? variationParam : 'all';
  const [rosterView, setRosterView] = useState<'current' | 'draft'>('current');
  const [kind, setKind] = useState<'all' | AiDecision['kind']>('all');
  const [page, setPage] = useState(1);
  const teamId = run.teams.some(team => team.id === teamParam) ? teamParam : run.teams[0]?.id;
  const team = run.teams.find(item => item.id === teamId);
  const name = (id: string) => league.teams.find(item => String(item.id) === id)?.name ?? run.teams.find(item => item.id === id)?.name ?? id;
  const shortName = (id: string) => league.teams.find(item => String(item.id) === id)?.shortName ?? run.teams.find(item => item.id === id)?.shortName ?? id;
  const color = (id: string) => league.teams.find(item => String(item.id) === id)?.color ?? run.teams.find(item => item.id === id)?.color ?? '#386d54';
  const playerMap = new Map(run.players.map(player => [player.id, player]));
  const playerName = (id: number) => playerMap.get(id)?.name ?? `Player ${id}`;
  const completedPeriods = new Set(run.results.filter(result => result.complete).map(result => result.period)).size;
  const drafted = run.decisions.filter(decision => decision.kind === 'draft');
  const picks = drafted.flatMap((decision, index) => decision.teamId === teamId ? decision.playerIds.map(id => ({ id, pick: index + 1 })) : []);
  const roster = rosterView === 'draft' ? picks : (team?.roster ?? []).map(id => ({ id, pick: picks.find(pick => pick.id === id)?.pick ?? null }));
  const decisions = run.decisions.filter(decision => decision.teamId === teamId && (kind === 'all' || decision.kind === kind)).slice().reverse();
  const pageCount = Math.max(1, Math.ceil(decisions.length / 6));
  const currentPage = Math.min(page, pageCount);
  const standings = run.standings.slice().sort((a, b) => {
    const rate = (item: typeof a) => (item.wins + item.ties / 2) / (item.wins + item.losses + item.ties || 1);
    return rate(b) - rate(a) || b.wins - a.wins || name(a.teamId).localeCompare(name(b.teamId));
  });
  if (variation !== 'all') return <><ReplayVariations value={variation} onChange={setVariation}/>{run.season === 2027 ? <AiLiveSingleTeams key={variation} mode={variation} run={run} league={league} teamId={teamId ?? ''} onTeamChange={setTeam}/> : <AiSingleTeamReplays mode={variation} run={run} league={league} teamId={teamId ?? ''} onTeamChange={setTeam}/>}</>;
  return <>
    <ReplayVariations value={variation} onChange={setVariation}/>
    {run.status === 'complete' && run.champion && <div className={styles.champion}><span>SIMULATED CHAMPION</span><strong>{name(run.champion)}</strong><p>The winner of this completed experiment.</p></div>}
    <div className={styles.metrics}><div><strong>{drafted.length}</strong><span>draft decisions</span></div><div><strong>{run.scoredDates.length}</strong><span>days scored</span></div><div><strong>{completedPeriods}</strong><span>completed periods</span></div><div><strong>{run.decisions.filter(decision => decision.kind === 'add_drop').length}</strong><span>roster moves</span></div></div>
    <AiDraftResults run={run} league={league} teamId={teamId ?? ''} onTeamChange={id => { setTeam(id); setPage(1); }}/>
    <AiOwnerComparison run={run} league={league} teamId={teamId ?? ''} onTeamChange={id => { setTeam(id); setPage(1); }}/>
    <div className={styles.standingsSection}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>THE RACE</p><h3>Category standings</h3></div><span>Completed regular-season matchups</span></div><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="AI category standings"><table className={styles.standings}><caption className="visually-hidden">Simulated regular-season category wins, losses, ties, and completed matchups. Sorted by category win rate; this is not a playoff seed.</caption><thead><tr><th scope="col">Franchise</th><th scope="col">W</th><th scope="col">L</th><th scope="col">T</th><th scope="col">Win rate</th><th scope="col">Played</th></tr></thead><tbody>{standings.map(row => {
      const total = row.wins + row.losses + row.ties;
      return <tr key={row.teamId}><th scope="row"><button type="button" onClick={() => { setTeam(row.teamId); setPage(1); }} aria-label={`Show ${name(row.teamId)} roster and decisions`}><i style={{ background: color(row.teamId) }}/><span>{name(row.teamId)}</span></button></th><td>{row.played ? row.wins : '—'}</td><td>{row.played ? row.losses : '—'}</td><td>{row.played ? row.ties : '—'}</td><td>{total ? `${((row.wins + row.ties / 2) / total * 100).toFixed(1)}%` : '—'}</td><td>{row.played}</td></tr>;
    })}</tbody></table></div><p className={styles.note}>{standings.some(row => row.played) ? 'Each category is one decision. Ties receive half credit in win rate. In-progress matchups enter these standings only after completion.' : 'No completed regular-season matchups yet. The draft can be explored below; standings begin when verified games are scored.'}</p></div>
    <Matchups run={run} name={name} shortName={shortName}/>
    <div className={styles.teamSection}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>SHOW YOUR WORK</p><h3>Inside an automated team</h3></div><label>Franchise<select value={teamId ?? ''} onChange={event => { setTeam(event.target.value); setPage(1); }}>{run.teams.map(item => <option value={item.id} key={item.id}>{name(item.id)}</option>)}</select></label></div>
      {team ? <div className={styles.teamWorkspace}><div className={styles.roster} style={{ '--team-color': color(team.id) } as CSSProperties}><div className={styles.rosterHeader}><span className={styles.teamBadge}>{shortName(team.id)}</span><div><h4>{name(team.id)}</h4><p>Draft position {run.draftOrder.includes(team.id) ? `#${run.draftOrder.indexOf(team.id) + 1}` : 'unavailable'} · {team.roster.length} rostered</p></div></div><div className={styles.rosterTabs} aria-label="Roster view"><button type="button" aria-pressed={rosterView === 'current'} onClick={() => setRosterView('current')}>Current roster</button><button type="button" aria-pressed={rosterView === 'draft'} onClick={() => setRosterView('draft')}>Draft picks</button></div><ul className={styles.playerList}>{roster.map(item => {
        const player = playerMap.get(item.id);
        const positions = player?.slots.filter(slot => slot >= 0 && slot <= 4).map(slot => POSITIONS[slot]).join(' / ');
        return <li key={item.id}><div><strong>{playerName(item.id)}</strong><span>{positions || 'Position unavailable'}{rosterView === 'draft' && !team.roster.includes(item.id) ? ' · Left roster' : ''}</span></div><small>{item.pick ? `Pick ${item.pick}` : 'Acquired'}</small></li>;
      })}</ul>{!roster.length && <p className={styles.note}>No {rosterView === 'draft' ? 'draft picks' : 'roster players'} recorded yet.</p>}</div>
      <div className={styles.decisions}><div className={styles.decisionsHeading}><h4>Decision trail</h4><label className="visually-hidden" htmlFor={`ai-decision-filter-${run.season}`}>Filter decisions</label><select id={`ai-decision-filter-${run.season}`} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setPage(1); }}><option value="all">All decisions</option><option value="draft">Draft</option><option value="lineup">Lineups</option><option value="add_drop">Adds & drops</option></select></div><ol className={styles.timeline}>{decisions.slice((currentPage - 1) * 6, currentPage * 6).map(decision => <li key={decision.id}><div className={styles.decisionMeta}><span>{decision.kind === 'draft' ? 'Draft pick' : decision.kind === 'lineup' ? 'Daily lineup' : 'Add / drop'}</span><time dateTime={decision.date}>{formatDate(decision.date)}</time></div><strong>{decision.kind === 'lineup' ? `${decision.playerIds.length} players selected` : decision.playerIds.map(playerName).join(', ')}</strong>{decision.droppedId !== undefined && <span className={styles.dropped}>Dropped {playerName(decision.droppedId)}</span>}<p>{decision.reason}</p>{decision.kind === 'lineup' && <details className={styles.lineupDetails}><summary>View lineup</summary><p>{decision.playerIds.map(playerName).join(' · ')}</p></details>}</li>)}</ol>{!decisions.length && <div className={styles.quietState}><p>{kind === 'all' ? 'No decisions recorded yet.' : `No ${kind === 'add_drop' ? 'adds or drops' : kind === 'lineup' ? 'lineups' : 'draft picks'} recorded yet.`}</p><span>Each saved decision appears with the players involved and its reason.</span></div>}{decisions.length > 0 && <div className={styles.pagination}><span>{(currentPage - 1) * 6 + 1}–{Math.min(currentPage * 6, decisions.length)} of {decisions.length}</span><div><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} aria-label="Previous decisions">Previous</button><button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} aria-label="Next decisions">Next</button></div></div>}</div></div> : <p className={styles.note}>Team rosters will appear after the experiment is initialized.</p>}
    </div>
    <details className={styles.methodology}><summary><span>How this experiment works</span><span aria-hidden="true">+</span></summary><div className={styles.methodologyBody}><div><h4>A fresh draft, for everybody</h4><p>All franchises start with a fresh redraft from one shared player pool. Real keepers and official roster moves are not carried into this experiment. Every simulated action stays in League Lab.</p></div><div><h4>An automated numerical manager</h4><p>Each manager scores expected contributions across all nine categories. The draft also fills position needs; daily lineups maximize expected value within eligible slots. Pickups balance the current lineup gain against the value of the players kept. Each decision records its reason.</p><p className={styles.policy}>Policy: {run.policy}</p></div><div><h4>Actual games, simulated ownership</h4><p>Verified player results score the simulated lineups. All players lock at the first NBA tipoff each day, and this baseline uses no IR slots. FG% and FT% use total makes divided by total attempts; fewer turnovers wins TO. A champion appears only after the experiment completes.</p></div><div><h4>Draft order</h4><ol className={styles.draftOrder}>{run.draftOrder.map(id => <li key={id}>{name(id)}</li>)}</ol>{!run.draftOrder.length && <p>No draft order saved.</p>}</div>{run.limitations.length > 0 && <div className={styles.limitations}><h4>Coverage & assumptions</h4><ul>{run.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</div></details>
  </>;
}

function ReplayVariations({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = [
    { value: 'all', title: 'Whole league AI', detail: 'AI drafts and manages all eight teams' },
    { value: 'post_draft', title: 'One team · after draft', detail: 'Real opening roster, then AI management' },
    { value: 'redraft', title: 'One team · draft + season', detail: 'AI redrafts and manages one franchise' },
  ];
  return <div className={styles.variations} role="group" aria-label="Replay variation">{options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}><strong>{option.title}</strong><span>{option.detail}</span></button>)}</div>;
}

function Matchups({ run, name, shortName }: { run: AiLeagueRun; name: (id: string) => string; shortName: (id: string) => string }) {
  const periods = [...new Set(run.matchups.map(matchup => matchup.period))].sort((a, b) => a - b);
  const latestActivity = [...run.scoredDates, ...run.lineups.map(lineup => lineup.date)].sort().at(-1);
  const defaultPeriod = run.matchups.find(matchup => latestActivity && matchup.start <= latestActivity && matchup.end >= latestActivity)?.period ?? periods[0];
  const [selected, setSelected] = useState<number | null>(null);
  const period = selected !== null && periods.includes(selected) ? selected : defaultPeriod;
  const matchups = run.matchups.filter(matchup => matchup.period === period);
  return <div className={styles.matchupsSection}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>HEAD TO HEAD</p><h3>Matchup board</h3></div>{periods.length > 0 && <label>Period<select value={period} onChange={event => setSelected(Number(event.target.value))}>{periods.map(item => <option key={item} value={item}>Period {item}{run.matchups.some(matchup => matchup.period === item && matchup.playoff) ? ' · Playoffs' : ''}</option>)}</select></label>}</div>
    {matchups.length > 0 ? <div className={styles.matchupGrid}>{matchups.map(matchup => {
      const scored = run.scoredDates.some(date => date >= matchup.start && date <= matchup.end);
      const result = scored ? run.results.find(item => item.matchupId === matchup.id) : undefined;
      return <article className={styles.matchup} key={matchup.id}><div className={styles.matchupMeta}><span>{result ? result.complete ? 'Final' : 'In progress' : 'Scheduled'}{matchup.playoff ? ' · Playoffs' : ''}</span><span>{formatDate(matchup.start)} – {formatDate(matchup.end)}</span></div><div className={styles.matchupScore}><strong title={name(matchup.home)}>{shortName(matchup.home)}</strong><span>{result ? `${result.homeWins} – ${result.awayWins}` : 'vs'}</span><strong title={name(matchup.away)}>{shortName(matchup.away)}</strong></div>{result ? <><p className={styles.matchupCaption}>{result.ties} tied {result.ties === 1 ? 'category' : 'categories'}{!result.complete ? ' · Provisional score' : ''}</p><details className={styles.categoryDetails}><summary>All nine categories</summary><table><caption className="visually-hidden">{name(matchup.home)} versus {name(matchup.away)} category totals</caption><thead><tr><th scope="col">Category</th><th scope="col">{shortName(matchup.home)}</th><th scope="col">{shortName(matchup.away)}</th></tr></thead><tbody>{CATEGORIES.map(category => {
        const home = category.value(result.homeStats), away = category.value(result.awayStats);
        const format = (value: number | null) => value === null ? '—' : category.percent ? `${(value * 100).toFixed(1)}%` : String(value);
        const homeLeads = home !== null && away !== null && (category.reverse ? home < away : home > away);
        const awayLeads = home !== null && away !== null && (category.reverse ? away < home : away > home);
        return <tr key={category.label}><th scope="row">{category.label}</th><td className={homeLeads ? styles.leading : undefined}>{format(home)}{homeLeads && <span className="visually-hidden">, leading</span>}</td><td className={awayLeads ? styles.leading : undefined}>{format(away)}{awayLeads && <span className="visually-hidden">, leading</span>}</td></tr>;
      })}</tbody></table></details></> : <p className={styles.matchupCaption}>Awaiting verified game results</p>}</article>;
    })}</div> : <div className={styles.quietState}><p>The matchup calendar is not available yet.</p><span>The board fills in when this season’s schedule is captured.</span></div>}
  </div>;
}
