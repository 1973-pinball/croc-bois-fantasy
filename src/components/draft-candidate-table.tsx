'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DraftAdvisorReport } from '@/lib/draft-advisor';
import type { DraftBoard } from '@/lib/draft-board';
import type { DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import { buildDraftCandidateRanks, defaultDraftCandidateDirection, filterDraftCandidatesByEspnRank, paginateDraftCandidates, sortDraftCandidates, type DraftCandidateDirection, type DraftCandidateOrder, type DraftCandidateRankLibrary, type DraftCandidateRankSnapshots } from '@/lib/draft-candidate-ranks';
import styles from './commissioner-strategy.module.css';

const labels: Record<DraftCandidateOrder, string> = {
  espn: 'ESPN rank',
  'espn-after-keepers': 'ESPN after keepers',
  bbm: 'BBM rank',
  yahoo: 'Yahoo rank',
  'bbm-value': 'ESPN − BBM',
  fit: 'Schedule + roster fit',
};
const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const gain = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;
const rankLabel = (value: number | null | undefined) => value == null ? '—' : `#${value}`;
const valueLabel = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value}`;

export function DraftCandidateTable({ catalog, library, report, board, seasonLoaded, rankSnapshots, rankStatus }: {
  catalog: DraftPlayerCatalog; library: DraftCandidateRankLibrary; report: DraftAdvisorReport | null; board?: DraftBoard | null; seasonLoaded: boolean; rankSnapshots?: DraftCandidateRankSnapshots; rankStatus?: string;
}) {
  const [sort, setSort] = useState<{ order: DraftCandidateOrder; direction: DraftCandidateDirection }>({ order: 'bbm-value', direction: 'descending' });
  const [rankLimitInput, setRankLimitInput] = useState({ value: '150', badInput: false });
  const [page, setPage] = useState(1);
  const { order, direction } = sort;
  const maxEspnRank = rankLimitInput.badInput ? NaN : rankLimitInput.value.trim() === '' ? null : Number(rankLimitInput.value);
  const invalidRankLimit = maxEspnRank !== null && (!Number.isSafeInteger(maxEspnRank) || maxEspnRank < 1);
  const ranks = useMemo(() => buildDraftCandidateRanks(catalog, library, rankSnapshots, board), [catalog, library, rankSnapshots, board]);
  const filteredCandidates = useMemo(() => filterDraftCandidatesByEspnRank(report?.candidates ?? [], ranks, maxEspnRank), [report, ranks, maxEspnRank]);
  const sortedCandidates = useMemo(() => sortDraftCandidates(order === 'fit' && !seasonLoaded ? [] : filteredCandidates, ranks, order, filteredCandidates.length, direction), [filteredCandidates, ranks, order, direction, seasonLoaded]);
  const pagination = paginateDraftCandidates(sortedCandidates, page);
  const candidates = pagination.candidates;
  useEffect(() => { if (page !== pagination.page) setPage(pagination.page); }, [page, pagination.page]);
  const missingSource = (order === 'bbm' || order === 'bbm-value') && !ranks.coverage.bbm ? 'Basketball Monster' : order === 'yahoo' && !ranks.coverage.yahoo ? 'Yahoo' : null;
  const directionLabel = order === 'bbm-value'
    ? direction === 'descending' ? 'biggest BBM values first' : 'smallest rank gaps first'
    : direction === 'ascending' ? 'low to high' : 'high to low';
  function changeSort(next: typeof sort) { setSort(next); setPage(1); }
  function chooseOrder(next: DraftCandidateOrder) { changeSort({ order: next, direction: defaultDraftCandidateDirection(next) }); }
  function rankHeader(column: Exclude<DraftCandidateOrder, 'fit'>, detail?: string) {
    const active = order === column;
    const nextDirection = active ? direction === 'ascending' ? 'descending' : 'ascending' : defaultDraftCandidateDirection(column);
    return <th scope="col" aria-sort={active ? direction : undefined} className={styles.rankHeader}>
      <button type="button" className={styles.rankSortButton} onClick={() => changeSort({ order: column, direction: nextDirection })} aria-label={`Sort by ${labels[column]}, ${nextDirection}`}>
        <span>{labels[column]}{detail && <small>{detail}</small>}</span><span className={styles.rankSortIndicator} aria-hidden="true">{active ? direction === 'ascending' ? '↑' : '↓' : '↕'}</span>
      </button>
    </th>;
  }
  return <section className={styles.panel} aria-labelledby="draft-candidates-title">
    <h3 id="draft-candidates-title">Available players · {labels[order]}</h3>
    <div className={`${styles.toolbar} ${styles.rankingToolbar}`}><div className={styles.rankingFields}><label>Player ranking<select aria-label="Player ranking" value={order} onChange={event => chooseOrder(event.target.value as DraftCandidateOrder)}>
      <option value="espn">ESPN rank</option>
      <option value="espn-after-keepers">ESPN after keepers</option>
      <option value="bbm">BBM rank</option>
      <option value="yahoo">Yahoo rank · preseason</option>
      <option value="bbm-value">ESPN − BBM · rank gap</option>
      <option value="fit">Schedule + roster fit</option>
    </select></label><label className={styles.rankLimit}>ESPN rank at most<input aria-label="ESPN rank at most" type="number" inputMode="numeric" min={1} step={1} placeholder="No limit" value={rankLimitInput.value} onChange={event => { setRankLimitInput({ value: event.currentTarget.value, badInput: event.currentTarget.validity.badInput }); setPage(1); }} aria-invalid={invalidRankLimit || undefined} aria-describedby={`draft-rank-limit-help${invalidRankLimit ? ' draft-rank-limit-error' : ''}`}/></label><small id="draft-rank-limit-help" className={styles.rankLimitHelp}>Includes the entered rank. Leave blank for all players; unranked players are hidden while a limit is set.</small></div><label>Sort direction<select aria-label="Sort direction" value={direction} onChange={event => changeSort({ order, direction: event.target.value as DraftCandidateDirection })}>
      <option value="ascending">{order === 'bbm-value' ? 'Smallest gap first' : 'Low to high'}</option>
      <option value="descending">{order === 'bbm-value' ? 'Biggest BBM values first' : 'High to low'}</option>
    </select></label></div>
    {invalidRankLimit && <p id="draft-rank-limit-error" className={styles.error} role="alert">Enter a whole number of 1 or higher, or leave the ESPN rank limit blank.</p>}
    <p className={styles.subtle} role="status">Showing {pagination.start}–{pagination.end} of {pagination.total} matching available players · Page {pagination.page} of {pagination.pageCount}{maxEspnRank !== null && !invalidRankLimit ? ` · ESPN rank ≤ ${maxEspnRank}` : ''} · {missingSource ? 'ESPN order until source ranks are available' : directionLabel}. Click a rank column to sort; click it again to reverse.</p>
    <p className={styles.subtle}>ESPN − BBM measures the rank gap: ESPN #80 and BBM #45 is <strong>+35</strong>. Bigger positive numbers highlight players BBM ranks earlier than ESPN. Sorting searches all players matching your ESPN rank limit, shown 15 per page; missing comparison ranks appear last in either direction.</p>
    <p className={styles.subtle}>Player ranks are available before the draft and do not need team rosters. ESPN uses its imported ROTO draft rank, with the captured catalog as a fallback. BBM uses its supplied Rank column or your privately saved ranked list. Yahoo uses its published preseason rank. Ranks include drafted players and do not change when a player is picked. ESPN: {ranks.coverage.espn || 'no'} · BBM: {ranks.coverage.bbm || 'no'} · Yahoo: {ranks.coverage.yahoo || 'no'} ranked players.</p>
    <p className={styles.subtle}>ESPN after keepers numbers the full ESPN-ranked pool after removing revealed keepers. It stays fixed when players are drafted and when you filter or change pages. Unranked players show —.{!board?.keepersRevealedAt && ' This column becomes available when keepers are revealed.'}</p>
    {rankStatus && <p className={styles.subtle} role="status">{rankStatus}</p>}
    {rankSnapshots?.['basketball-monster'] && <p className={styles.subtle}>Saved BBM ranked list: {new Date(rankSnapshots['basketball-monster'].importedAt).toLocaleDateString()}.</p>}
    {library['basketball-monster'] && !ranks.coverage.bbm && <p className={styles.notice} role="status">Upload a Basketball Monster projection file with its Rank column to enable BBM rank and value comparisons. Your saved projections still work for win-rate estimates.</p>}
    {library.yahoo && !ranks.coverage.yahoo && <p className={styles.notice} role="status">Refresh Yahoo projections above to load its published preseason ranks.</p>}
    {missingSource && <p className={styles.notice} role="status">Import {missingSource} projections above to use this ranking. Until then, players remain in ESPN order and missing ranks show —.</p>}
    <p className={styles.subtle}>Win rates and fit scores use your selected projection source and the full season. Usable / scheduled games shows how many of the player’s season games fit the active lineup versus how many are published. Recommendations consider all {report?.evaluatedCandidates ?? 0} evaluated players and may fall outside this list. Gains are percentage points (pp); lower turnovers are better.</p>
    {!seasonLoaded && <p className={styles.subtle}>Season win rates and usable games will appear when the full-season schedule is loaded.</p>}
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Available player ranks and value, scroll horizontally for all columns">
      <table className={`${styles.table} ${styles.candidateTable}`}>
        <caption className="visually-hidden">Available players compared by ESPN rank, ESPN rank after keepers, Basketball Monster supplied rank, Yahoo preseason rank, and ESPN minus BBM rank value</caption>
        <thead><tr><th scope="col">Player</th><th scope="col">Position</th>{rankHeader('espn')}{rankHeader('espn-after-keepers')}{rankHeader('bbm', 'Supplied rank')}{rankHeader('yahoo', 'Preseason')}{rankHeader('bbm-value', 'Bigger is better')}<th scope="col">Season category win rate</th><th scope="col">Gain</th><th scope="col">Usable / scheduled games<small>Full season</small></th><th scope="col">Fit score</th></tr></thead>
        <tbody>{candidates.map(candidate => {
          const values = ranks.byPlayerId.get(candidate.player.id);
          return <tr key={candidate.player.id}>
            <td><strong>{candidate.player.name}</strong><small>{candidate.player.nbaTeam}{candidate.hasProjection ? '' : ' · missing projection'}{candidate.blocked ? ' · not recommended' : ''}</small></td>
            <td>{candidate.player.eligiblePositions.join(' / ')}</td>
            <td>{rankLabel(values?.espnRank)}</td><td>{rankLabel(ranks.espnAfterKeepersByPlayerId.get(candidate.player.id))}</td><td>{rankLabel(values?.bbmRank)}</td><td>{rankLabel(values?.yahooRank)}</td>
            <td className={values?.bbmValue == null || values.bbmValue === 0 ? undefined : values.bbmValue > 0 ? styles.gain : styles.negative}>{valueLabel(values?.bbmValue)}</td>
            <td>{pct(seasonLoaded ? candidate.scheduleWinRate : null)}</td><td className={(candidate.scheduleGain ?? 0) < 0 ? styles.negative : styles.gain}>{gain(seasonLoaded ? candidate.scheduleGain : null)}</td>
            <td>{seasonLoaded ? candidate.usableGames ?? '—' : '—'} / {seasonLoaded ? candidate.scheduledGames ?? '—' : '—'}</td>
            <td>{pct(seasonLoaded ? candidate.fitScore : null)}<small>{seasonLoaded ? candidate.reasons.join(' ') : 'Full-season schedule required.'}</small></td>
          </tr>;
        })}{!candidates.length && <tr><td colSpan={11}>{invalidRankLimit ? 'Enter a valid ESPN rank limit to view players.' : report && maxEspnRank !== null && !filteredCandidates.length ? 'No available players match this ESPN rank limit. Increase it or leave it blank to show all players.' : order === 'fit' && report?.candidates.length ? 'No available players currently have an eligible roster-fit score.' : 'Available candidates appear after the draft board loads.'}</td></tr>}</tbody>
      </table>
    </div>
    <nav className={styles.actions} aria-label="Available player pages">
      <button type="button" className="button button-subtle" disabled={pagination.page === 1} onClick={() => setPage(pagination.page - 1)} aria-label="Previous player page">Previous</button>
      <span className={styles.subtle}>Page {pagination.page} of {pagination.pageCount}</span>
      <button type="button" className="button button-subtle" disabled={pagination.page === pagination.pageCount} onClick={() => setPage(pagination.page + 1)} aria-label="Next player page">Next</button>
    </nav>
  </section>;
}
