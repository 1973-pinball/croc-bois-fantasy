'use client';

import { useEffect, useMemo, useState } from 'react';
import { buildReferencePickGrids, partitionPickGridSeasons, pickGridCounts, pickOwnershipEvidence, type DraftPickGridSeason } from '@/lib/draft-pick-grids';
import type { LeagueAccount } from './league-account';
import styles from './draft-pick-grids.module.css';
import { managerLabel } from '@/lib/display-labels';
import { useQueryFilter } from './use-portal-location';

type CellSelection = { teamId: number; round: number | null };
const sourceLabels = { live: 'Live ownership', archive: 'Historical record', reference: 'Reference snapshot' };

function PickCountGrid({ season }: { season: DraftPickGridSeason }) {
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const rounds = Array.from({ length: season.roundCount }, (_, index) => index + 1);
  const counts = useMemo(() => pickGridCounts(season), [season]);
  const selectedTeam = season.teams.find(team => team.id === selection?.teamId);
  const selectedPicks = selection ? season.picks.filter(pick => pick.ownerTeamId === selection.teamId && (selection.round === null || pick.round === selection.round)).sort((a, b) => a.round - b.round || a.originalTeamId - b.originalTeamId) : [];
  const countClass = (count: number, baseline = 1) => count < baseline ? styles.shortfall : count > baseline ? styles.surplus : styles.standard;
  const teamKey = (team: DraftPickGridSeason['teams'][number]) => team.franchiseId || team.id;
  function countButton(team: DraftPickGridSeason['teams'][number], round: number | null) {
    const teamCounts = counts.get(team.id);
    const count = (round === null ? teamCounts?.total : teamCounts?.rounds[round - 1]) || 0;
    const selected = selection?.teamId === team.id && selection.round === round;
    return <button type="button" className={`${styles.count} ${countClass(count, round === null ? season.roundCount : 1)}${selected ? ` ${styles.selected}` : ''}`} onClick={() => setSelection({ teamId: team.id, round })} aria-pressed={selected} aria-label={`${team.owner} (${team.shortName}), ${round === null ? 'all rounds' : `round ${round}`}: ${count} ${count === 1 ? 'pick' : 'picks'}. Show original owners.`}>{count}</button>;
  }

  return <section className={`panel ${styles.gridPanel}`} aria-label={`${season.year} draft pick grid`}>
    <div className={styles.gridHeading}><div><p className="eyebrow">{season.year} DRAFT PICKS</p><h3>{season.year}<span>Who owns what</span></h3></div><div className={styles.metadata}><span className={styles.source}>{sourceLabels[season.source]}</span><span>{season.picks.length} picks · {season.teams.length} teams · {season.roundCount} rounds</span></div></div>
    {season.note && <p className={styles.sourceNote}>{season.note}</p>}
    <div className={styles.legend}><span><i className={styles.zeroKey}/> Missing pick</span><span><i className={styles.singleKey}/> One pick</span><span><i className={styles.extraKey}/> Extra picks</span><span className={styles.scrollHint}>Scroll across to see every team →</span></div>
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${season.year} ownership counts; scroll horizontally for all teams`}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>{season.year} draft picks grouped by current owner, with totals followed by counts for each round. Select a count to see the picks’ original owners.</caption>
        <thead><tr><th scope="col" className={styles.roundHeader}>Round</th>{season.teams.map(team => <th scope="col" key={teamKey(team)}><span className={styles.abbreviation} style={{ borderColor: team.color }}>{team.shortName}</span><span className={styles.owner}>{team.owner}</span></th>)}</tr></thead>
        <tbody><tr className={styles.totalRow}><th scope="row">Total picks</th>{season.teams.map(team => <td key={teamKey(team)}>{countButton(team, null)}</td>)}</tr>{rounds.map(round => <tr key={round}><th scope="row">Round {round}</th>{season.teams.map(team => <td key={teamKey(team)}>{countButton(team, round)}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <div className={styles.receipts} aria-live="polite" aria-atomic="true">
      {!selectedTeam || !selection ? <p><strong>Follow a pick:</strong> Select any count to see which teams originally owned those picks. Each column belongs to the team holding the picks now.</p> : <><div className={styles.receiptHeading}><div><p className="eyebrow">PICK ORIGINS</p><h4>{selectedTeam.shortName} · {selectedTeam.owner}<span>{selection.round === null ? 'All rounds' : `Round ${selection.round}`} · {selectedPicks.length} {selectedPicks.length === 1 ? 'pick' : 'picks'}</span></h4></div><button className="text-button" type="button" onClick={() => setSelection(null)} aria-label={`Close ${season.year} pick origins`}>Close</button></div>{selectedPicks.length === 0 ? <p>No picks in this round are currently owned by {selectedTeam.owner}.</p> : <ul className={styles.originList}>{selectedPicks.map(pick => { const original = season.teams.find(team => team.id === pick.originalTeamId); return <li key={pick.id}><span>Round {pick.round}</span><strong>{original ? `${original.shortName} · ${original.owner}` : 'Original franchise unavailable'}</strong><small>{pick.originalTeamId === pick.ownerTeamId ? 'Own original pick' : `Originally ${original?.owner || 'another franchise'} → now ${selectedTeam.owner}`}</small></li>; })}</ul>}</>}
    </div>
  </section>;
}

export function DraftPickGrids({ account, mode = 'current' }: { account: LeagueAccount; mode?: 'current' | 'archive' }) {
  const [remoteSeasons, setRemoteSeasons] = useState<DraftPickGridSeason[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [historicalYear, setHistoricalYear] = useQueryFilter('pickYear', '');
  const referenceSeasons = useMemo(() => buildReferencePickGrids(account.data), [account.data]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError('');
      try {
        const response = await fetch('/api/draft-picks', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.seasons)) throw new Error(body.message || 'Additional draft-pick seasons could not be loaded.');
        if (!controller.signal.aborted) setRemoteSeasons(body.seasons);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Additional draft-pick seasons could not be loaded.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [retry, account.data]);

  const seasons = useMemo(() => {
    const merged = new Map(referenceSeasons.map(season => [season.year, season]));
    for (const season of remoteSeasons) merged.set(season.year, season);
    const current = referenceSeasons.find(season => season.year === account.data.season);
    if (current) {
      const metadata = merged.get(current.year);
      merged.set(current.year, { ...current, roundCount: metadata?.roundCount || current.roundCount, source: account.connection === 'live' ? 'live' : 'reference', note: account.connection === 'error' ? 'Last loaded current-season ownership. The live league connection is unavailable.' : account.connection === 'live' ? 'Current ownership from the connected league. Totals include picks committed to keepers; they are not remaining draft selections.' : current.note });
    }
    return [...merged.values()].map(season => season.year < account.data.season ? season : { ...season, teams: season.teams.map(team => { const currentTeam = account.data.teams.find(item => item.id === team.id); return currentTeam ? { ...team, owner: managerLabel(currentTeam) } : team; }) }).sort((a, b) => a.year - b.year);
  }, [referenceSeasons, remoteSeasons, account.connection, account.data]);
  const { active, unchangedFuture: originalFuture, historical } = partitionPickGridSeasons(seasons, account.data.season);
  const current = active.find(season => season.year === account.data.season);
  const transferredFuture = active.filter(season => season.year > account.data.season);
  const historicalSeason = historical.find(season => String(season.year) === historicalYear);
  async function refresh() {
    setLoading(true);
    const refreshed = await account.reloadLeague();
    if (!refreshed) setRetry(value => value + 1);
  }

  return <div className={styles.workspace}>
    <div className={styles.intro}><div><p className="eyebrow">THE PICK INVENTORY</p><h2>{mode === 'archive' ? 'Historical pick ownership' : 'Pick ownership'}</h2><p>Columns show the <strong>current owner</strong> of each pick. Totals sit on top; each row counts the picks that team owns in a round. Select a cell to trace the original owner.</p></div><button type="button" className="button button-subtle" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh pick seasons'}</button></div>
    {error && <div className={styles.error} role="alert"><strong>Additional seasons could not be refreshed</strong><span>{error} The current-season grid continues to use the league records already loaded. Other grids retain their source labels.</span></div>}
    {mode === 'current' && <>{current ? <PickCountGrid key={`current-${current.year}`} season={current}/> : <div className="panel empty-state">Current-season pick ownership is not available yet.</div>}
    {transferredFuture.length > 0 && <div className={styles.sectionHeading}><p className="eyebrow">FUTURE PICKS ON THE MOVE</p><h3>Already spoken for</h3><p>These future seasons include picks held by a different team, even when every team’s total still matches.</p></div>}
    {transferredFuture.map(season => <PickCountGrid season={season} key={season.year}/>)}
    {originalFuture.length > 0 && <details className={`panel ${styles.futureSummary}`}><summary><span><strong>Future seasons with original ownership</strong><small>{originalFuture.map(season => season.year).join(' · ')} · no transferred picks in these records</small></span><span aria-hidden="true">+</span></summary><div className={styles.futureBody}>{originalFuture.map(season => <div key={season.year}><h4>{season.year}<span>{sourceLabels[season.source]}</span></h4><p>{season.picks.length} recorded picks · {season.roundCount} rounds. All recorded picks are still held by their original franchise.</p>{season.note && <p>{season.note}</p>}<ul>{season.teams.map(team => <li key={team.franchiseId || team.id}><strong>{team.shortName}</strong> {team.owner}<span>{season.picks.filter(pick => pick.ownerTeamId === team.id).length} picks</span></li>)}</ul></div>)}</div></details>}
    </>}
    {mode === 'archive' && historical.length > 0 && <section className={styles.history}><div className={styles.historyHeading}><div><p className="eyebrow">FROM THE ARCHIVE</p><h3>Historical pick ownership</h3><p>Choose a season to see the counts recorded in that year’s draft.</p></div><label className={styles.yearLabel} htmlFor="historical-pick-grid-season">Historical season<select id="historical-pick-grid-season" value={historicalYear} onChange={event => setHistoricalYear(event.target.value)}><option value="">Choose a past season</option>{historical.map(season => <option key={season.year} value={season.year}>{season.year}</option>)}</select></label></div>{historicalSeason && <PickCountGrid key={`history-${historicalSeason.year}`} season={historicalSeason}/>}</section>}
    {mode === 'current' && <details className={`panel ${styles.futureSummary}`}><summary><span><strong>Imported ownership receipts</strong><small>Verified workbook transfers · trades #87 and #92</small></span><span aria-hidden="true">+</span></summary><div className={styles.futureBody}><div><p>These receipts document the imported workbook through trade #92. Later finalized trades may change the live holdings shown above.</p><ul>{pickOwnershipEvidence.verifiedTransfers.map(receipt => { const from = account.data.teams.find(team => team.id === receipt.originalTeamId); const to = account.data.teams.find(team => team.id === receipt.ownerTeamId); return <li className={styles.evidenceReceipt} key={`${receipt.year}-${receipt.round}-${receipt.originalTeamId}`}><strong>Trade #{receipt.tradeId} · {receipt.year} round {receipt.round}</strong><span>{from?.shortName || 'Original franchise'} → {to?.shortName || 'Receiving franchise'}</span></li>; })}</ul>{pickOwnershipEvidence.notes.slice(0, 2).map(note => <p className={styles.evidenceNote} key={note}>{note}</p>)}</div></div></details>}
    <p className={styles.footnote}>These grids count ownership, including picks committed to keepers. The Live draft and Archive views follow original draft slots and show player selections.</p>
  </div>;
}

export function TeamPickInventory({ account, teamId }: { account: LeagueAccount; teamId: number }) {
  const team = account.data.teams.find(item => item.id === teamId);
  const seasonPicks = account.data.picks.filter(pick => pick.season === account.data.season);
  const ownedPicks = seasonPicks.filter(pick => pick.ownerTeamId === teamId);
  const roundCount = Math.max(0, ...seasonPicks.map(pick => pick.round));
  if (!team) return null;
  return <section className={`panel ${styles.teamInventory}`} aria-label={`${managerLabel(team)} pick inventory`}>
    <div className={styles.inventoryHeading}><div><p className="eyebrow">PICK INVENTORY</p><h2>{account.data.season} draft capital</h2><p>Current owner: <strong>{managerLabel(team)} · {team.shortName}</strong>. Original owners below.</p></div><div className={styles.inventoryTotal}><strong>{ownedPicks.length}</strong><span>picks owned</span></div></div>
    <div className={styles.roundTiles}>{Array.from({ length: roundCount }, (_, index) => index + 1).map(round => {
      const picks = ownedPicks.filter(pick => pick.round === round);
      return <div className={`${styles.roundTile} ${picks.length === 0 ? styles.missingTile : picks.length > 1 ? styles.extraTile : ''}`} key={round} data-round={round}><div className={styles.tileHeading}><span>Round {round}</span><strong>{picks.length} <small>{picks.length === 1 ? 'pick' : 'picks'}</small></strong></div>{picks.length === 0 ? <p className={styles.missingLabel}>No pick owned</p> : <ul>{picks.map(pick => { const original = account.data.teams.find(item => item.id === pick.originalTeamId); return <li key={pick.id}>{pick.originalTeamId === teamId ? <><strong>Own pick</strong>{' '}<span>{team.shortName} · {managerLabel(team)}</span></> : <><strong>From {original?.shortName || 'another franchise'}</strong>{' '}<span>{original ? managerLabel(original) : 'Original owner unavailable'}</span></>}</li>; })}</ul>}</div>;
    })}</div>
    {roundCount === 0 && <p className="empty-state">No pick inventory is available for this season.</p>}
  </section>;
}
