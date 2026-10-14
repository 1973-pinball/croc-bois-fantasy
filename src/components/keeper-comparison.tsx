'use client';

import { useEffect, useMemo, useState } from 'react';
import catalogFile from '../../data/draft-player-catalog.json';
import type { DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import { buildKeeperAdvisor, type KeeperAdvisorRow } from '@/lib/keeper-advisor';
import { PROJECTION_SOURCES } from '@/lib/draft-projections';
import { keeperPaymentPickPool } from '@/lib/keeper-payment-options';
import type { LeagueAccount } from './league-account';
import { paymentDeadlinePicks } from './keeper-payment-editor';
import type { ProjectionLibrary } from './commissioner-strategy-tools';
import styles from './commissioner-strategy.module.css';

const catalog = catalogFile as DraftPlayerCatalog;
function Verdict({ row, imported }: { row?: KeeperAdvisorRow; imported: boolean }) {
  if (!imported) return <span className={styles.subtle}>Import projections above</span>;
  if (!row) return <span className={styles.subtle}>No player record</span>;
  return <><span className={row.keep === true ? styles.keep : row.keep === false ? styles.pass : styles.subtle}>{row.keep === true ? 'Yes · Keep' : row.keep === false ? 'No · Don’t keep' : 'Needs data / review'}</span><small>{row.projectedRank === null ? 'Rank unavailable' : `#${row.projectedRank} · round ${row.projectedRound} value`}</small><small>{row.paymentRound === null ? 'No verified payment' : `Pay round ${row.paymentRound}`}{row.roundSavings !== null ? ` · ${row.roundSavings > 0 ? '+' : ''}${row.roundSavings} round${Math.abs(row.roundSavings) === 1 ? '' : 's'} of value` : ''}</small><details><summary>Why?</summary><small>{row.reasons.join(' ')}</small></details></>;
}

export function KeeperComparison({ account, library }: { account: LeagueAccount; library: ProjectionLibrary }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [checked, setChecked] = useState<string | null>(null);
  const selected = choice ?? String(account.ownTeamIds[0] ?? 'all');
  const teams = selected === 'all' ? account.data.teams : account.data.teams.filter(team => String(team.id) === selected);
  const teamKey = teams.map(team => team.id).join(',');
  const usedPicks = account.live?.usedPickIds ?? [];
  const usedKey = usedPicks.join(',');
  const revealedKeepers = account.live?.revealedKeepers ?? [];
  const reusableKey = revealedKeepers.map(keeper => `${keeper.teamId}:${keeper.playerId}:${keeper.pickId}`).join(',');
  const deadlinePicks = useMemo(() => paymentDeadlinePicks(account), [account.keeperDeadlinePassed, account.live?.keeperPaymentInventory, account.data.picks]);
  const paymentPicks = (teamId: number, includeUsed = false) => keeperPaymentPickPool({ season: account.data.season, teamId, picks: account.data.picks, deadlinePicks,
    usedPickIds: includeUsed ? [] : account.data.picks.filter(pick => usedPicks.includes(pick.id) || usedPicks.includes(account.officialPickId(pick.id))).map(pick => pick.id),
  });
  // Pick ownership and frozen roster changes refresh while this private view is open.
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (!active || pending || document.visibilityState !== 'visible') return;
      pending = true;
      try { const next = await account.reloadLeague(); if (active && next) setChecked(new Date().toISOString()); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [account.reloadLeague]);
  const reports = useMemo(() => teamKey.split(',').filter(Boolean).flatMap(id => PROJECTION_SOURCES.map(source => buildKeeperAdvisor({ teamId: Number(id), leagueData: account.data, catalog, projections: library[source.id] ?? null,
    deadlinePicks,
    // Live database IDs and migration-preview IDs can differ; mark both identities consumed.
    usedPickIds: account.data.picks.filter(pick => usedPicks.includes(pick.id) || usedPicks.includes(account.officialPickId(pick.id))).map(pick => pick.id),
    reusablePickIds: account.data.picks.filter(pick => revealedKeepers.some(keeper => keeper.teamId === Number(id) && account.data.players.some(player => player.id === keeper.playerId && player.teamId === keeper.teamId) && (keeper.pickId === pick.id || keeper.pickId === account.officialPickId(pick.id)))).map(pick => pick.id),
  }))), [account.data, teamKey, library, usedKey, reusableKey, deadlinePicks]);
  const playerIds = new Set(teams.map(team => team.id));
  const players = account.data.players.filter(player => playerIds.has(player.teamId) && player.name.toLowerCase().includes(query.trim().toLowerCase())).map(player => ({ player, sources: PROJECTION_SOURCES.map(source => ({ source, row: reports.find(report => report.teamId === player.teamId && report.source === source.id)?.rows.find(row => row.player.id === player.id) })) })).filter(item => {
    const values = item.sources.filter(value => library[value.source.id]).map(value => value.row?.keep ?? null);
    return filter === 'all' || (filter === 'keep' && values.some(value => value === true)) || (filter === 'pass' && values.length > 0 && values.every(value => value === false)) || (filter === 'disagree' && values.includes(true) && values.includes(false)) || (filter === 'review' && (!values.length || values.includes(null)));
  }).sort((a, b) => a.player.teamId - b.player.teamId || a.player.name.localeCompare(b.player.name));
  const warnings = [...new Set(reports.flatMap(report => report.source && library[report.source] ? report.warnings : []))];
  const methodology = reports[0]?.methodology ?? [];
  return <>
    <details className={`${styles.panel} ${styles.methodology}`}><summary>Keeper comparisons by projection</summary><h3>Keep or draft again?</h3><p className={styles.subtle}>Every source is shown side by side. A projected round 6 player kept with a round 13 pick has +7 rounds of value. Before the deadline, payment estimates use current ownership. After it, only picks owned at the deadline and still owned can pay. These are private suggestions, not spent picks.</p><div className={styles.toolbar}><label>Team<select value={selected} onChange={event => setChoice(event.target.value)}><option value="all">All teams</option>{account.data.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><label>Show suggestions<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Every player</option><option value="keep">Keep in at least one source</option><option value="pass">Don’t keep in every loaded source</option><option value="disagree">Sources disagree</option><option value="review">Needs data / review</option></select></label><label>Search player<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Player name"/></label></div>
      <p className={styles.subtle}>{players.length} players · roster snapshot {account.data.snapshotDate}{checked ? ` · ownership checked ${new Date(checked).toLocaleTimeString()}` : ''}. Ownership and pick availability refresh every 15 seconds.</p>
      <div className={styles.tableWrap}><table className={styles.table}><caption className="visually-hidden">Keeper decisions and projected round value for each projection source</caption><thead><tr><th>Player / owner</th><th>Keeper cost</th>{PROJECTION_SOURCES.map(source => <th key={source.id}>{source.label}</th>)}<th>Rank spread</th></tr></thead><tbody>{players.map(({ player, sources }) => {
        const ranks = sources.flatMap(({ row }) => row?.projectedRank === null || row?.projectedRank === undefined ? [] : [row.projectedRank]);
        return <tr key={player.id}><td><strong>{player.name}</strong><small>{account.data.teams.find(team => team.id === player.teamId)?.name}</small><small>ESPN draft rank #{catalog.players.find(item => item.id === player.id)?.rank ?? '—'}</small></td><td>{player.baseCost === null ? '—' : `Round ${player.baseCost}`}<small>{player.status === 'eligible' ? 'Eligible' : player.status === 'ineligible' ? 'Ineligible' : 'History needs review'}</small><small>{revealedKeepers.some(keeper => keeper.playerId === player.id) ? `Saved keeper · paying round ${revealedKeepers.find(keeper => keeper.playerId === player.id)!.paymentRound}` : null}</small><small>{player.tenure === null ? 'Tenure unverified' : `Tenure ${player.tenure}/5`}</small></td>{sources.map(({ source, row }) => <td key={source.id}><Verdict row={row} imported={Boolean(library[source.id])}/></td>)}<td>{ranks.length >= 2 ? `#${Math.min(...ranks)}–#${Math.max(...ranks)}` : '—'}<small>{ranks.length >= 2 ? `${Math.max(...ranks) - Math.min(...ranks)} places across loaded sources` : 'Load two or more sources'}</small></td></tr>;
      })}{!players.length && <tr><td colSpan={PROJECTION_SOURCES.length + 3}>No players match these filters.</td></tr>}</tbody></table></div>
    </details>
    <details className={`${styles.panel} ${styles.methodology}`}><summary>Suggested keeper sets and payment picks</summary><h3>Suggested keeper sets and payment picks</h3><p className={styles.subtle}>Each source proposes a hypothetical combined list. Picks are allocated once per list. Costs are applied only after the keeper deadline and every team has submitted; the final lock charges and reveals all teams together. Suggestions do not change saved keepers or reopen a frozen list.</p>{teams.map(team => <details key={team.id}><summary>{team.name} · {paymentPicks(team.id).length} eligible, unused payment picks</summary><p className={styles.subtle}>Payment-eligible rounds: {paymentPicks(team.id, true).sort((a, b) => a.round - b.round).map(pick => `${pick.round}${usedPicks.includes(pick.id) || usedPicks.includes(account.officialPickId(pick.id)) ? ' (used)' : ''}`).join(', ') || 'None'}</p><div className={styles.sourceCards}>{PROJECTION_SOURCES.map(source => {
        const report = reports.find(item => item.teamId === team.id && item.source === source.id);
        return <div key={source.id} className={styles.sourceCard}><strong>{source.label}</strong>{!library[source.id] ? <span>Import needed</span> : report?.assignments.length ? report.assignments.map(assignment => <span key={assignment.playerId}>{account.data.players.find(player => player.id === assignment.playerId)?.name} · pay round {account.data.picks.find(pick => pick.id === assignment.pickId)?.round}</span>) : <span>No verified value keepers recommended.</span>}</div>;
      })}</div></details>)}</details>
    {deadlinePicks === null && <p className={styles.notice} role="status">The keeper deadline has passed. Payment suggestions are waiting for the deadline ownership snapshot; projected player rankings remain available.</p>}
    {warnings.length > 0 && <details className={styles.notice}><summary>Keeper coverage notes ({warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <details className={`${styles.panel} ${styles.methodology}`}><summary>How keeper decisions and round values work</summary><ul>{methodology.map((item, index) => <li key={index}>{item}</li>)}</ul><p>These source-based rankings are calculated from imported category projections. ESPN’s supplied draft rank stays visible separately. Sources with different player coverage are not perfectly comparable; import full player pools for the most useful comparison.</p></details>
  </>;
}
