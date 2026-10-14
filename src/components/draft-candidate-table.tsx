'use client';

import { useMemo, useState } from 'react';
import type { DraftAdvisorReport } from '@/lib/draft-advisor';
import type { DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import { buildDraftCandidateRanks, sortDraftCandidates, type DraftCandidateOrder, type DraftCandidateRankLibrary } from '@/lib/draft-candidate-ranks';
import styles from './commissioner-strategy.module.css';

const titles: Record<DraftCandidateOrder, string> = {
  espn: 'Next 15 available · ESPN order',
  bbm: 'Top 15 available · BBM rank',
  yahoo: 'Top 15 available · Yahoo rank',
  'bbm-value': 'Top 15 available · biggest BBM value',
  fit: 'Top 15 · schedule and roster fit',
};
const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const gain = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pp`;
const rankLabel = (value: number | null | undefined) => value == null ? '—' : `#${value}`;
const valueLabel = (value: number | null | undefined) => value == null ? '—' : `${value > 0 ? '+' : ''}${value}`;

export function DraftCandidateTable({ catalog, library, report, seasonLoaded }: {
  catalog: DraftPlayerCatalog; library: DraftCandidateRankLibrary; report: DraftAdvisorReport | null; seasonLoaded: boolean;
}) {
  const [order, setOrder] = useState<DraftCandidateOrder>('espn');
  const ranks = useMemo(() => buildDraftCandidateRanks(catalog, library), [catalog, library]);
  const candidates = useMemo(() => sortDraftCandidates(order === 'fit' && !seasonLoaded ? [] : report?.candidates ?? [], ranks, order), [report, ranks, order, seasonLoaded]);
  const missingSource = (order === 'bbm' || order === 'bbm-value') && !ranks.coverage.bbm ? 'Basketball Monster' : order === 'yahoo' && !ranks.coverage.yahoo ? 'Yahoo' : null;
  return <section className={styles.panel} aria-labelledby="draft-candidates-title">
    <h3 id="draft-candidates-title">{titles[order]}</h3>
    <div className={styles.toolbar}><label>Player ranking<select value={order} onChange={event => setOrder(event.target.value as DraftCandidateOrder)}>
      <option value="espn">ESPN rank</option>
      <option value="bbm">BBM rank</option>
      <option value="yahoo">Yahoo rank · preseason</option>
      <option value="bbm-value">Biggest BBM value (ESPN rank − BBM rank)</option>
      <option value="fit">Schedule + roster fit</option>
    </select></label></div>
    <p className={styles.subtle}>ESPN − BBM measures the rank gap: ESPN #80 and BBM #45 is <strong>+35</strong>. Bigger positive numbers mean better BBM value relative to ESPN. Sorting searches all available players before showing 15; missing ranks appear last.</p>
    <p className={styles.subtle}>ESPN uses its supplied draft rank. BBM uses the supplied Rank column from its ranked table. Yahoo uses its published preseason rank. Ranks include drafted players and stay fixed as picks are made. BBM: {ranks.coverage.bbm || 'no'} ranked players · Yahoo: {ranks.coverage.yahoo || 'no'} ranked players.</p>
    {library['basketball-monster'] && !ranks.coverage.bbm && <p className={styles.notice} role="status">Upload a Basketball Monster projection file with its Rank column to enable BBM rank and value comparisons. Your saved projections still work for win-rate estimates.</p>}
    {library.yahoo && !ranks.coverage.yahoo && <p className={styles.notice} role="status">Refresh Yahoo projections above to load its published preseason ranks.</p>}
    {missingSource && <p className={styles.notice} role="status">Import {missingSource} projections above to use this ranking. Until then, players remain in ESPN order and missing ranks show —.</p>}
    <p className={styles.subtle}>Win rates and fit scores use your selected projection source and the full season. Usable / scheduled games shows how many of the player’s season games fit the active lineup versus how many are published. Recommendations consider all {report?.evaluatedCandidates ?? 0} evaluated players and may fall outside this list. Gains are percentage points (pp); lower turnovers are better.</p>
    {!seasonLoaded && <p className={styles.subtle}>Season win rates and usable games will appear when the full-season schedule is loaded.</p>}
    <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Available player ranks and value, scroll horizontally for all columns">
      <table className={`${styles.table} ${styles.candidateTable}`}>
        <caption className="visually-hidden">Available players compared by ESPN rank, Basketball Monster supplied rank, Yahoo preseason rank, and ESPN minus BBM rank value</caption>
        <thead><tr><th scope="col">Player</th><th scope="col">Position</th><th scope="col">ESPN rank</th><th scope="col">BBM rank<small>Supplied rank</small></th><th scope="col">Yahoo rank<small>Preseason</small></th><th scope="col">ESPN − BBM<small>Bigger is better</small></th><th scope="col">Season category win rate</th><th scope="col">Gain</th><th scope="col">Usable / scheduled games<small>Full season</small></th><th scope="col">Fit score</th></tr></thead>
        <tbody>{candidates.map(candidate => {
          const values = ranks.byPlayerId.get(candidate.player.id);
          return <tr key={candidate.player.id}>
            <td><strong>{candidate.player.name}</strong><small>{candidate.player.nbaTeam}{candidate.hasProjection ? '' : ' · missing projection'}{candidate.blocked ? ' · not recommended' : ''}</small></td>
            <td>{candidate.player.eligiblePositions.join(' / ')}</td>
            <td>{rankLabel(values?.espnRank)}</td><td>{rankLabel(values?.bbmRank)}</td><td>{rankLabel(values?.yahooRank)}</td>
            <td className={values?.bbmValue == null || values.bbmValue === 0 ? undefined : values.bbmValue > 0 ? styles.gain : styles.negative}>{valueLabel(values?.bbmValue)}</td>
            <td>{pct(seasonLoaded ? candidate.scheduleWinRate : null)}</td><td className={(candidate.scheduleGain ?? 0) < 0 ? styles.negative : styles.gain}>{gain(seasonLoaded ? candidate.scheduleGain : null)}</td>
            <td>{seasonLoaded ? candidate.usableGames ?? '—' : '—'} / {seasonLoaded ? candidate.scheduledGames ?? '—' : '—'}</td>
            <td>{pct(seasonLoaded ? candidate.fitScore : null)}<small>{seasonLoaded ? candidate.reasons.join(' ') : 'Full-season schedule required.'}</small></td>
          </tr>;
        })}{!candidates.length && <tr><td colSpan={10}>{order === 'fit' && report?.candidates.length ? 'No available players currently have an eligible roster-fit score.' : 'Available candidates appear after the draft board loads.'}</td></tr>}</tbody>
      </table>
    </div>
  </section>;
}
