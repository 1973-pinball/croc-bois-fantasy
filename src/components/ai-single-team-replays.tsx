'use client';

import { useEffect, useId, useState } from 'react';
import type { AiLeagueRun, AiStanding } from '@/lib/ai-league-types';
import type { AiSingleTeamReport, AiSingleTeamScenario } from '@/lib/ai-single-team-types';
import type { LeagueData } from '@/lib/types';
import styles from './ai-single-team-replays.module.css';

const signed = (value: number) => value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0';
const record = (value?: AiStanding) => value ? `${value.wins}–${value.losses}–${value.ties}` : '—';
const dayLabel = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));

export function AiSingleTeamReplays({ mode, run, league, teamId, onTeamChange }: {
  mode: 'post_draft' | 'redraft'; run: AiLeagueRun; league: LeagueData; teamId: string; onTeamChange: (id: string) => void;
}) {
  const headingId = useId();
  const [report, setReport] = useState<AiSingleTeamReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [decisionPage, setDecisionPage] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/ai-single-team-replays', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('The saved one-team replays could not be loaded.');
      const value = await response.json() as AiSingleTeamReport;
      if (value.season !== 2026 || !Array.isArray(value.scenarios) || !value.baseline) throw new Error('The replay response is incomplete.');
      if (!controller.signal.aborted) { setReport(value); setError(null); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'The saved replays could not be loaded.'); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => { setDecisionPage(1); }, [teamId, mode]);
  const name = (id: string) => league.teams.find(team => String(team.id) === id)?.name ?? id;
  const color = (id: string) => league.teams.find(team => String(team.id) === id)?.color ?? '#547647';
  const players = new Map([...run.players, ...(run.initialPlayers ?? [])].map(player => [player.id, player.name]));
  const playerName = (id: number) => players.get(id) ?? `Player ${id}`;
  const scenarios = report?.scenarios.filter(scenario => scenario.mode === mode) ?? [];
  const selected = scenarios.find(scenario => scenario.teamId === teamId) ?? scenarios[0];
  const selectedVerified = report?.baseline.verified && selected?.status === 'complete';
  const actual = (id: string) => report?.baseline.standings.find(row => row.teamId === id);
  const simulated = (scenario: AiSingleTeamScenario) => scenario.standings.find(row => row.teamId === scenario.teamId);
  const comparable = (scenario: AiSingleTeamScenario) => report?.baseline.verified && scenario.status === 'complete' && simulated(scenario)?.played === actual(scenario.teamId)?.played;
  const changes = scenarios.filter(comparable).map(scenario => ({ scenario, delta: simulated(scenario)!.wins - actual(scenario.teamId)!.wins }));
  const biggestChanges = [
    ...changes.filter(item => item.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 1).map(item => ({ ...item, label: 'BIGGEST INCREASE' })),
    ...changes.filter(item => item.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 1).map(item => ({ ...item, label: 'BIGGEST DECREASE' })),
  ];
  const changed = selected?.decisions.filter(decision => decision.kind !== 'lineup' && decision.kind !== 'draft') ?? [];
  const drafts = selected?.decisions.filter(decision => decision.kind === 'draft') ?? [];
  const ownerPicks = new Map(run.actual?.draft?.filter(pick => pick.teamId === selected?.teamId).map(pick => [pick.overallPick, pick]) ?? []);
  const pages = Math.max(1, Math.ceil(changed.length / 8));
  const page = Math.min(decisionPage, pages);
  const playoffTeams = (scenario: AiSingleTeamScenario) => new Set(scenario.results.filter(result => result.playoff).flatMap(result => [result.home, result.away]));
  return <section className={styles.section} aria-labelledby={headingId}>
    <div className={styles.heading}><p className={styles.eyebrow}>EIGHT INDEPENDENT EXPERIMENTS · 2025–26</p><h3 id={headingId}>{mode === 'post_draft' ? 'Same opening roster. AI takes over.' : 'One AI draft. One AI manager.'}</h3><p>{mode === 'post_draft' ? 'Each franchise starts with its actual opening roster. AI handles its lineups and pickups from there.' : 'AI replaces one franchise’s selections in its recorded draft slots, then manages that team all season.'} The other seven owners keep their recorded daily rosters and lineups. Standings and playoff matchups are recalculated.</p></div>
    {mode === 'redraft' && <p className={styles.constraint}>To keep the other owners’ draft choices fixed, their recorded selections are reserved. AI chooses from the remaining players in the selected franchise’s own draft slots, including slots previously used for keepers.</p>}
    {error && <div className={styles.notice} role="status"><p>{error}</p><button type="button" onClick={() => { setError(null); setAttempt(value => value + 1); }}>Retry replays</button></div>}
    {!report && !error && <p className={styles.notice}>Loading the saved one-team experiments…</p>}
    {report && <>
      <div className={styles.coverage}><span>{report.coverage.verifiedDates} of {report.coverage.expectedDates} dates verified</span><span>{scenarios.length} separate replays in this variation</span><span>{report.baseline.verified ? 'Actual-season baseline verified' : 'Baseline verification incomplete'}</span></div>
      {(report.officialAdjustments ?? []).map(adjustment => <details className={styles.constraint} key={`${adjustment.period}-${adjustment.teamId}-${adjustment.stat}`}><summary>One documented scoring difference · official owner totals preserved</summary><p>{name(adjustment.teamId)} has {adjustment.reconstructed} {adjustment.stat === 'blk' ? 'blocks' : adjustment.stat} in the daily box scores for period {adjustment.period}; ESPN’s official matchup records {adjustment.official}. Frozen-owner results retain the official total. AI-controlled scoring and player forecasts use the unchanged daily statistics.</p></details>)}
      {!report.baseline.verified && <p className={styles.notice}>The actual-season baseline has not been fully verified. Championship and improvement claims remain unavailable.</p>}
      {biggestChanges.length > 0 && <div className={styles.highlights} aria-label="Biggest changes from actual results">{biggestChanges.map(({ scenario, delta, label }) => <button type="button" key={scenario.teamId} onClick={() => onTeamChange(scenario.teamId)}><span>{label}</span><strong>{name(scenario.teamId)}</strong><p>{signed(delta)} category wins <small>{record(actual(scenario.teamId))} → {record(simulated(scenario))}</small></p></button>)}</div>}
      <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="Single-team replay results"><table className={styles.results}><caption className="visually-hidden">Eight independent experiments. Only the named franchise is automated in each row; category records cover the regular season.</caption><thead><tr><th scope="col">The one AI franchise</th><th scope="col">Actual W–L–T</th><th scope="col">Replay W–L–T</th><th scope="col">Win change</th><th scope="col">Replay champion</th></tr></thead><tbody>{scenarios.map(scenario => <tr key={scenario.teamId} className={selected?.teamId === scenario.teamId ? styles.selected : undefined}><th scope="row"><button type="button" aria-pressed={selected?.teamId === scenario.teamId} onClick={() => onTeamChange(scenario.teamId)}><i style={{ background: color(scenario.teamId) }}/>{name(scenario.teamId)}</button></th><td>{record(actual(scenario.teamId))}</td><td>{scenario.status === 'complete' ? record(simulated(scenario)) : 'Incomplete'}</td><td>{comparable(scenario) ? signed(simulated(scenario)!.wins - actual(scenario.teamId)!.wins) : '—'}</td><td>{report.baseline.verified && scenario.status === 'complete' && scenario.champion ? name(scenario.champion) : 'Unverified'}</td></tr>)}</tbody></table></div>
      <p className={styles.note}>Read each row as a separate season. The eight AI franchises in this table never compete against each other in the same experiment.</p>
      {selected && <>
        <div className={styles.teamHeading}><div><p className={styles.eyebrow}>INSIDE THIS REPLAY</p><h4>{name(selected.teamId)}</h4><p>{selectedVerified ? `Simulated champion: ${selected.champion ? name(selected.champion) : 'not verified'}` : 'This replay has not completed verification.'}</p></div><label>Automated franchise<select aria-label="Automated franchise in one-team replay" value={selected.teamId} onChange={event => onTeamChange(event.target.value)}>{report.teams.map(team => <option key={team.id} value={team.id}>{name(team.id)}</option>)}</select></label></div>
        <div className={styles.summary}><div><span>REGULAR-SEASON CATEGORY WINS</span><strong>{comparable(selected) ? signed(simulated(selected)!.wins - actual(selected.teamId)!.wins) : '—'}</strong><p>{record(actual(selected.teamId))} actual → {record(simulated(selected))} replay</p></div><div><span>PLAYOFF OUTCOME</span><strong>{!selectedVerified ? 'Unverified' : selected.champion === selected.teamId ? 'Champion' : playoffTeams(selected).has(selected.teamId) ? 'Qualified' : 'Missed playoffs'}</strong><p>{selectedVerified ? `${selected.standings.findIndex(row => row.teamId === selected.teamId) + 1} of ${report.teams.length} in replay seeding` : 'Awaiting a verified actual-season baseline.'}</p></div><div><span>AI PICKUPS / FORCED RETURNS</span><strong>{selected.acquisitions} / {selected.forcedReturns}</strong><p>Fixed owner claims take priority. Replacements use the AI pickup budget.</p></div></div>
        <details className={styles.fixed}><summary>The seven owners held fixed</summary><p>{report.teams.filter(team => team.id !== selected.teamId).map(team => name(team.id)).join(' · ')}</p><p>Their archived daily roster membership and starter selections stay fixed. When an owner claims a player held by AI, that player returns to the owner and the conflict is recorded below. Intraday transaction timing is unavailable.</p></details>
        {mode === 'redraft' && <div className={styles.draft}><div className={styles.subheading}><h5>This team’s AI draft results</h5><span>{drafts.length} original draft slots</span></div><ol>{drafts.map(decision => {
          const owner = ownerPicks.get(decision.overallPick ?? 0);
          return <li key={decision.id}><span>#{decision.overallPick ?? '—'}<small>Round {decision.round ?? '—'}</small></span><div><strong>{decision.playerIds.map(playerName).join(', ')}</strong>{owner && <small>{decision.playerIds.includes(owner.playerId) ? 'Same as the owner' : `Owner: ${owner.name}`}{owner.keeper ? ' · keeper' : ''}</small>}</div></li>;
        })}</ol><p className={styles.note}>Other franchises retain their actual draft allocations. Traded picks can give the selected team more or fewer than 13 selections.</p></div>}
        <div className={styles.rosters}><details><summary>{mode === 'post_draft' ? 'Actual opening roster' : 'Roster after the AI draft'} · {selected.initialRoster.length} players</summary><ul>{selected.initialRoster.map(id => <li key={id}>{playerName(id)}</li>)}</ul></details><details><summary>AI final roster · {selected.finalRoster.length} players</summary><ul>{selected.finalRoster.map(id => <li key={id}>{playerName(id)}</li>)}</ul></details></div>
        {selected.initialCuts.length > 0 && <p className={styles.constraint}>Opening roster adjustment: AI dropped {selected.initialCuts.map(playerName).join(', ')} to fit its 13-player roster limit. This policy uses ten starters, three bench slots, and no IR slot.</p>}
        <div className={styles.changes}><div className={styles.subheading}><h5>What AI changed</h5><span>{changed.length} roster decisions</span></div><ol>{changed.slice((page - 1) * 8, page * 8).map(decision => <li key={decision.id}><div><span>{decision.kind === 'forced_return' ? 'Fixed owner claim' : decision.kind === 'initial_drop' ? 'Opening roster cut' : 'AI pickup'}</span><time dateTime={decision.date}>{dayLabel(decision.date)}</time></div><strong>{decision.playerIds.map(playerName).join(', ')}</strong>{decision.droppedId !== undefined && <p>Dropped {playerName(decision.droppedId)}</p>}{decision.claimedByTeamId && <p>Returned to {name(decision.claimedByTeamId)}</p>}<p>{decision.reason}</p></li>)}</ol>{changed.length === 0 && <p className={styles.note}>No roster changes are recorded in this replay.</p>}{pages > 1 && <div className={styles.pagination}><span>Page {page} of {pages}</span><div><button type="button" disabled={page === 1} onClick={() => setDecisionPage(page - 1)}>Previous</button><button type="button" disabled={page === pages} onClick={() => setDecisionPage(page + 1)}>Next</button></div></div>}</div>
        <details className={styles.fixed}><summary>Replay standings & playoffs</summary><div className={styles.tableScroll}><table className={styles.results}><thead><tr><th scope="col">Franchise</th><th scope="col">W</th><th scope="col">L</th><th scope="col">T</th></tr></thead><tbody>{selected.standings.map(row => <tr key={row.teamId}><th scope="row">{name(row.teamId)}{row.teamId === selected.teamId ? ' · AI' : ''}</th><td>{row.wins}</td><td>{row.losses}</td><td>{row.ties}</td></tr>)}</tbody></table></div><ul className={styles.playoffs}>{selected.results.filter(result => result.playoff).map(result => <li key={result.matchupId}><span>Period {result.period}</span><strong>{name(result.home)} {result.homeWins}–{result.awayWins} {name(result.away)}</strong></li>)}</ul></details>
      </>}
      <details className={styles.method}><summary>How these controlled replays work</summary><ul>{report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>{report.baseline.issues.length > 0 && <ul>{report.baseline.issues.map((item, index) => <li key={index}>{item}</li>)}</ul>}</details>
      <p className={styles.saved}>Saved {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/New_York' }).format(new Date(report.createdAt))} · {report.coverage.firstDate} through {report.coverage.lastDate}</p>
    </>}
  </section>;
}
