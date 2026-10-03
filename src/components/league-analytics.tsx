'use client';

import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import analyticsFile from '../../data/analytics.json';
import categoryPreferencesFile from '../../data/category-preferences.json';
import rosterPositionHistoryFile from '../../data/roster-position-history.json';
import { aggregateCategoryPreferences, type CategoryPreferences } from '@/lib/category-preferences';
import { aggregateRosterPositions, type RosterPositionHistory } from '@/lib/roster-position-history';
import { calculateLuckbox, type PlayoffHistory } from '@/lib/playoff-history';
import { managerLabel } from '@/lib/display-labels';
import type { LeagueData } from '@/lib/types';
import { updateQuery, useQueryFilter } from './use-portal-location';
import styles from './league-preferences.module.css';

type PositionRow = { franchiseId: string; position: number; count: number; seasons: number[] };
type PositionSeason = { season: number; franchiseId: string; position: number; historicalOwner: string };
type Appearance = { season: number; kept: boolean | null; round: number; overallPick: number; historicalOwner: string };
type Preference = { franchiseId: string; player: string; picks: number; keeperSelections?: number; freshSelections?: number; unknownSelections?: number; seasons: number[]; selections?: Appearance[] };
type Observation = { franchiseId: string; historicalOwner: string; season: number | null; wins: number; trades: number; sourceCells: string[] };
type Analytics = {
  version: number | string;
  coverage: { draftYears: number[]; selectionCount: number; limitations: string[] };
  franchises: { id: string; name: string; aliases: string[] }[];
  draftPositions: { metric: string; rows: PositionRow[]; seasonOrders: PositionSeason[]; inferredRows?: PositionRow[]; inferredSeasonOrders?: PositionSeason[]; limitations?: string[] };
  playerPreferences: { rows: Preference[]; keeperClassificationCoverage: unknown; limitations?: string[] };
  winsTrades: { observations: Observation[]; pearson: number | null; sampleSize: number; cohort: unknown; units: unknown; limitations: string[] };
};
const analytics = analyticsFile as unknown as Analytics;
const categoryHistory = categoryPreferencesFile as unknown as CategoryPreferences;
const positionHistory = rosterPositionHistoryFile as unknown as RosterPositionHistory;
const categoryYears = [...new Set([...categoryHistory.coverage.draftYears, ...positionHistory.coverage.draftYears])].sort((a, b) => b - a);
const palette = ['#386d54', '#d58045', '#6f7b53', '#668da1', '#b37263', '#9b8552', '#707ca7', '#a07996'];
const formatYears = (years: number[]) => { const sorted = [...new Set(years)].sort((a, b) => a - b); return sorted.length === 0 ? 'No dated records' : sorted.length === 1 ? String(sorted[0]) : sorted[0] + '–' + sorted[sorted.length - 1]; };
const joinedNames = (names: string[]) => names.length <= 3 ? names.join(' + ') : names.slice(0, 2).join(' + ') + ' + ' + (names.length - 2) + ' more';

function LabIcon({ kind }: { kind: 'fish' | 'dice' | 'phone' | 'heart' | 'chart' }) {
  return <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'fish' ? <><path d="M6 17c5-9 16-9 22 0-6 9-17 9-22 0Zm0 0L2 11v12Zm8-7 4-5 3 5M14 24l5 4 2-5"/><circle cx="23" cy="16" r="1"/><path d="M18 11c-3 4-3 8 0 12"/></> : kind === 'dice' ? <><rect x="5" y="5" width="22" height="22" rx="5"/><circle cx="11" cy="11" r="1"/><circle cx="21" cy="11" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="11" cy="21" r="1"/><circle cx="21" cy="21" r="1"/></> : kind === 'phone' ? <><path d="m8 4 6 6-4 4c3 5 4 6 9 8l4-4 5 6c-2 5-6 6-11 3C8 23 1 13 4 7Z"/><path d="M20 5c4 1 6 3 7 7M19 10c2 0 3 2 3 4"/></> : kind === 'heart' ? <><path d="M16 27S3 20 3 11c0-8 10-10 13-3 3-7 13-5 13 3 0 9-13 16-13 16Z"/><path d="m9 16 4 3 9-8"/></> : <><path d="M5 5v23h23M10 23V15M17 23V9M24 23V3"/></>}</svg>;
}

export function LeagueAnalytics({ league, playoffHistory }: { league: LeagueData; playoffHistory: PlayoffHistory }) {
  const [spotlightParam, setSpotlight] = useQueryFilter('labTeam', 'all');
  const spotlight = analytics.franchises.some(franchise => franchise.id === spotlightParam) ? spotlightParam : 'all';
  const [slotSeasonParam, setSlotSeason] = useQueryFilter('labDraftYear', 'all');
  const [inferredParam, setInferredParam] = useQueryFilter('labInferred', '1');
  const includeInferred = inferredParam !== '0';
  const setIncludeInferred = (value: boolean) => setInferredParam(value ? '1' : '0');
  const [positionParam, setPositionParam] = useQueryFilter('labPosition', '1');
  const selectedPosition = /^\d+$/.test(positionParam) && Number(positionParam) >= 1 && Number(positionParam) <= analytics.franchises.length ? Number(positionParam) : 1;
  const setSelectedPosition = (value: number) => setPositionParam(String(value));
  const [selectedCell, setSelectedCell] = useState<{ franchiseId: string; position: number } | null>(null);
  const [activePoint, setActivePoint] = useState(0);
  const [showTrend, setShowTrend] = useState(true);
  const [preferenceTabParam, setPreferenceTab] = useQueryFilter('labTab', 'players');
  const preferenceTab = preferenceTabParam === 'categories' ? 'categories' : 'players';
  const [playerSearchParam, setPlayerSearch] = useQueryFilter('labPlayer', '');
  const playerSearch = playerSearchParam.slice(0, 200);
  const [preferenceSeasonParam, setPreferenceSeason] = useQueryFilter('labPlayerYear', 'all');
  const preferenceSeason = analytics.coverage.draftYears.some(year => String(year) === preferenceSeasonParam) ? preferenceSeasonParam : 'all';
  const [categorySeasonParam, setCategorySeason] = useQueryFilter('labCategoryYear', 'all');
  const categorySeason = categoryYears.some(year => String(year) === categorySeasonParam) ? categorySeasonParam : 'all';
  const [selectedPreference, setSelectedPreference] = useState<{ key: string; scope: string } | null>(null);
  const [preferencePageSize, setPreferencePageSize] = useState(10);
  const [preferencePagination, setPreferencePagination] = useState({ scope: '', page: 1 });
  const clipId = useId().replace(/:/g, '');
  const franchises = analytics.franchises;
  const label = (id: string) => league.teams.find(team => String(team.id) === id)?.shortName || franchises.find(franchise => franchise.id === id)?.name || id;
  const name = (id: string) => league.teams.find(team => String(team.id) === id)?.name || franchises.find(franchise => franchise.id === id)?.name || id;
  const currentManager = (id: string) => { const team = league.teams.find(team => String(team.id) === id); return team ? managerLabel(team) : ''; };
  const color = (id: string) => league.teams.find(team => String(team.id) === id)?.color || palette[Math.max(0, franchises.findIndex(franchise => franchise.id === id)) % palette.length];
  const positionSeasons = useMemo(() => [...analytics.draftPositions.seasonOrders, ...(includeInferred ? analytics.draftPositions.inferredSeasonOrders || [] : [])], [includeInferred]);
  const availableSlotYears = [...new Set(positionSeasons.map(item => item.season))].sort((a, b) => b - a);
  const slotSeason = availableSlotYears.some(year => String(year) === slotSeasonParam) ? slotSeasonParam : 'all';
  const filteredOrders = positionSeasons.filter(item => slotSeason === 'all' || String(item.season) === slotSeason);
  const countFor = (franchiseId: string, position: number) => filteredOrders.filter(item => item.franchiseId === franchiseId && item.position === position);
  const maxFrequency = Math.max(1, ...franchises.flatMap(franchise => Array.from({ length: franchises.length }, (_, index) => countFor(franchise.id, index + 1).length)));
  const selectedSlotRanking = franchises.map(franchise => ({ ...franchise, count: countFor(franchise.id, selectedPosition).length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const selectedSlotMax = Math.max(1, ...selectedSlotRanking.map(item => item.count));
  const authoritativeYears = [...new Set(analytics.draftPositions.seasonOrders.map(item => item.season))];
  const firstSlotCounts = franchises.map(franchise => ({ id: franchise.id, count: countFor(franchise.id, 1).length }));
  const firstSlotMax = Math.max(0, ...firstSlotCounts.map(item => item.count));
  const firstSlotWinners = firstSlotCounts.filter(item => item.count === firstSlotMax && firstSlotMax > 0);
  const luckbox = calculateLuckbox(filteredOrders, playoffHistory.seasons);
  const observations = analytics.winsTrades.observations.filter(item => Number.isFinite(item.wins) && Number.isFinite(item.trades));
  useEffect(() => {
    const index = analytics.winsTrades.observations.filter(item => Number.isFinite(item.wins) && Number.isFinite(item.trades)).findIndex(item => item.franchiseId === spotlight);
    if (index >= 0) setActivePoint(index);
  }, [spotlight]);
  useEffect(() => { setSelectedCell(null); }, [slotSeason, includeInferred]);
  const mostTrades = Math.max(0, ...observations.map(item => item.trades));
  const busiest = observations.filter(item => item.trades === mostTrades);
  const maxAppearances = Math.max(0, ...analytics.playerPreferences.rows.map(item => item.picks));
  const biggestFavorites = analytics.playerPreferences.rows.filter(item => item.picks === maxAppearances);
  const point = observations[activePoint] || observations[0];
  const averageTrades = observations.reduce((sum, item) => sum + item.trades, 0) / Math.max(1, observations.length);
  const averageWins = observations.reduce((sum, item) => sum + item.wins, 0) / Math.max(1, observations.length);
  const covariance = observations.reduce((sum, item) => sum + (item.trades - averageTrades) * (item.wins - averageWins), 0);
  const tradeVariance = observations.reduce((sum, item) => sum + (item.trades - averageTrades) ** 2, 0);
  const slope = tradeVariance > 0 ? covariance / tradeVariance : null;
  const xMax = Math.max(10, Math.ceil(mostTrades / 10) * 10);
  const lowestWin = Math.min(...observations.map(item => item.wins));
  const highestWin = Math.max(...observations.map(item => item.wins));
  const yMin = observations.length ? Math.max(0, Math.floor((lowestWin - 10) / 50) * 50) : 0;
  const yMax = observations.length ? Math.max(yMin + 50, Math.ceil((highestWin + 10) / 50) * 50) : 100;
  const plot = { left: 56, top: 25, width: 526, height: 272 };
  const x = (value: number) => plot.left + value / xMax * plot.width;
  const y = (value: number) => plot.top + plot.height - (value - yMin) / (yMax - yMin) * plot.height;
  const selectedCellOrders = selectedCell ? countFor(selectedCell.franchiseId, selectedCell.position) : [];
  const preferenceRows = analytics.playerPreferences.rows.map(item => {
    const selections = (item.selections || []).filter(selection => preferenceSeason === 'all' || String(selection.season) === preferenceSeason);
    const dated = Boolean(item.selections);
    const total = dated ? selections.length : preferenceSeason === 'all' ? item.picks : item.seasons.filter(year => String(year) === preferenceSeason).length;
    return { ...item, selectedAppearances: selections, value: total };
  }).filter(item => (spotlight === 'all' || item.franchiseId === spotlight) && item.player.toLowerCase().includes(playerSearch.trim().toLowerCase()) && item.value > 0).sort((a, b) => b.value - a.value || a.player.localeCompare(b.player) || a.franchiseId.localeCompare(b.franchiseId));
  const preferenceScope = JSON.stringify([spotlight, preferenceSeason, playerSearch, preferencePageSize]);
  useEffect(() => {
    setPreferencePagination({ scope: preferenceScope, page: 1 });
    setSelectedPreference(null);
  }, [preferenceScope]);
  const preferencePageCount = Math.max(1, Math.ceil(preferenceRows.length / preferencePageSize));
  const preferencePage = preferencePagination.scope === preferenceScope ? Math.min(preferencePagination.page, preferencePageCount) : 1;
  const preferenceStart = (preferencePage - 1) * preferencePageSize;
  const rankedPreferences = preferenceRows.slice(preferenceStart, preferenceStart + preferencePageSize);
  const preferenceMax = Math.max(1, ...preferenceRows.map(item => item.value));
  const preferencePageScope = `${preferenceScope}:${preferencePage}`;
  const selectedPreferenceKey = selectedPreference?.scope === preferencePageScope ? selectedPreference.key : null;
  const preferenceDetail = rankedPreferences.find(item => item.franchiseId + ':' + item.player === selectedPreferenceKey);
  const changePreferencePage = (page: number) => {
    setPreferencePagination({ scope: preferenceScope, page: Math.max(1, Math.min(page, preferencePageCount)) });
    setSelectedPreference(null);
  };
  const categoryDraftYears = categorySeason === 'all' ? categoryYears : [Number(categorySeason)];
  const rosterPositions = aggregateRosterPositions(positionHistory, categoryDraftYears);
  const categoryPreferences = aggregateCategoryPreferences(categoryHistory, categoryDraftYears);
  const seasonLabel = (draftYear: number) => `${draftYear}–${String(draftYear + 1).slice(-2)}`;
  const seasonList = (years: number[]) => [...years].sort((a, b) => a - b).map(seasonLabel).join(', ');
  const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const resetPlayerFilters = () => { updateQuery({ labTeam: null, labPlayer: null, labPlayerYear: null }); setSelectedPreference(null); };

  return <div className="league-lab">
    <div className="page-heading lab-heading"><div><p className="eyebrow">THE CROC BOIS CURIOSITY DEPARTMENT</p><h1>League Lab.</h1><p className="page-intro">A little evidence for the group chat. Explore the patterns behind the picks, deals, and familiar faces.</p></div><span className="lab-stamp"><LabIcon kind="chart"/><span>HISTORICAL<br/>DEEP CUTS</span></span></div>
    <div className="lab-controls"><label>Spotlight a franchise<select value={spotlight} onChange={event => { setSpotlight(event.target.value); const found = observations.findIndex(item => item.franchiseId === event.target.value); if (found >= 0) setActivePoint(found); }}><option value="all">The whole league</option>{franchises.map(franchise => <option value={franchise.id} key={franchise.id}>{name(franchise.id)} · {currentManager(franchise.id)}</option>)}</select></label><p>Highlights the charts and filters both preference views.<br/><span>Current names follow franchise history across manager changes. Historical manager labels stay with their recorded seasons.</span></p>{spotlight !== 'all' && <button className="text-button" onClick={() => setSpotlight('all')}>Clear spotlight</button>}</div>

    <div className="lab-section-caption"><span>THE UNOFFICIAL HARDWARE</span><span>Every award comes with receipts.</span></div>
    <section className="lab-awards" aria-label="Evidence-backed league awards">
      <article className="lab-award award-green"><div className="lab-award-top"><LabIcon kind="fish"/><span>NO. 1 DRAFT SLOTS</span></div><h2>Fish on heater</h2><div className="award-result"><strong>{firstSlotMax}<small>×</small></strong><span>{joinedNames(firstSlotWinners.map(item => label(item.id))) || 'Awaiting records'}{firstSlotWinners.length > 1 && <small>Tied for the lead</small>}</span></div><p>Most original first-overall slots in the selected draft years.</p><div className="award-source">{formatYears(filteredOrders.map(item => item.season))} · same selection as the draft chart{includeInferred && filteredOrders.some(item => item.season < 2022) ? ' · includes reconstructed slots' : ''}</div></article>
      <article className="lab-award award-orange"><div className="lab-award-top"><LabIcon kind="dice"/><span>PLAYOFF TEAM · TOP 4 SLOT</span></div><h2>Luckbox</h2>{luckbox.status === 'available' ? <><div className="award-result"><strong>{luckbox.winners[0]?.value || 0}<small>×</small></strong><span>{joinedNames(luckbox.winners.map(item => label(item.franchiseId))) || 'No qualifying top-four slots'}{luckbox.winners.length > 1 && <small>Tied for the lead</small>}</span></div><p>Most top-four original draft slots after making the playoffs.</p></> : <><div className="award-result award-pending"><strong>?</strong><span>Historical brackets<br/>needed.</span></div><p>{luckbox.coveredDraftYears.length} of {luckbox.requestedDraftYears.length} selected draft years matched to playoff results.</p></>}<div className="award-source">{luckbox.status === 'available' ? `${formatYears(luckbox.coveredDraftYears)} · same selection as the draft chart` : `Missing results for ${formatYears(luckbox.missingDraftYears)} · ESPN history export needed`}</div></article>
      <article className="lab-award"><div className="lab-award-top"><LabIcon kind="phone"/><span>TRADE COUNT</span></div><h2>Always on the phone</h2><div className="award-result"><strong>{mostTrades}</strong><span>{joinedNames(busiest.map(item => label(item.franchiseId)))}{busiest.length > 1 && <small>Tied for the lead</small>}</span></div><p>Most trades in league history</p><div className="award-source">Cumulative counts · formula caveats below</div></article>
      <article className="lab-award"><div className="lab-award-top"><LabIcon kind="heart"/><span>PLAYER × FRANCHISE REUNIONS</span></div><h2>Ride or die</h2><div className="award-result"><strong>{maxAppearances}<small>×</small></strong><span>{biggestFavorites.length ? joinedNames(biggestFavorites.map(item => item.player)) : 'No recorded player'}{biggestFavorites.length > 1 && <small>{joinedNames(biggestFavorites.map(item => label(item.franchiseId)))} · tied</small>}</span></div><p>{biggestFavorites.length === 1 ? label(biggestFavorites[0].franchiseId) + ' keeps finding a way back.' : 'The most repeated player/franchise draft-board pairings.'}</p><div className="award-source">Includes retained keepers · {formatYears(analytics.coverage.draftYears)}</div></article>
    </section>

    <section className="panel lab-draft-panel" aria-labelledby="draft-pattern-title"><div className="panel-header"><div><p className="eyebrow">01 / DRAFT GRAVITY</p><h2 id="draft-pattern-title">Who keeps landing which spot?</h2></div><label className="lab-inline-filter">Draft year<select aria-label="Filter draft-position year" value={slotSeason} onChange={event => { setSlotSeason(event.target.value); setSelectedCell(null); }}><option value="all">{formatYears(availableSlotYears)} · all available</option>{availableSlotYears.map(year => <option key={year} value={String(year)}>{year}</option>)}</select></label></div>
      <div className="lab-panel-description"><p>Each square counts a franchise’s <strong>original draft position</strong>. Pick a column to see its regular visitors, or a square for the exact years.</p><label className="lab-inference-toggle"><input type="checkbox" checked={includeInferred} onChange={event => { setIncludeInferred(event.target.checked); setSlotSeason('all'); setSelectedCell(null); }}/><span>Include reconstructed 2018–2021 slots</span><span className="lab-inferred-tag">INFERRED</span></label></div>
      {includeInferred && <div className="lab-source-warning">Older slots are reconstructed from draft-board ownership clues. They are shown separately in the source notes and are not equivalent to explicit original-owner records.</div>}
      <div className="lab-draft-layout"><div className="lab-heatmap-area"><div className="lab-heatmap-scroll"><table className="lab-heatmap"><caption className="visually-hidden">Original draft-position frequencies by franchise. Click a position heading for a ranking or a cell for source years.</caption><thead><tr><th scope="col">FRANCHISE</th>{Array.from({ length: franchises.length }, (_, index) => index + 1).map(position => <th scope="col" key={position}><button className={position === selectedPosition ? 'selected' : ''} aria-pressed={position === selectedPosition} onClick={() => setSelectedPosition(position)} aria-label={'Rank franchises by draft position ' + position}>#{position}</button></th>)}</tr></thead><tbody>{franchises.map(franchise => <tr key={franchise.id} className={spotlight !== 'all' && spotlight !== franchise.id ? 'lab-dimmed' : ''}><th scope="row"><button onClick={() => setSpotlight(spotlight === franchise.id ? 'all' : franchise.id)} title={franchise.name}><span className="lab-team-badge" style={{ '--lab-color': color(franchise.id) } as CSSProperties}>{label(franchise.id)}</span><span>{franchise.name}</span></button></th>{Array.from({ length: franchises.length }, (_, index) => index + 1).map(position => { const records = countFor(franchise.id, position); const count = records.length; const active = selectedCell?.franchiseId === franchise.id && selectedCell.position === position; const tooltip = name(franchise.id) + ' · position ' + position + ' · ' + count + ' time' + (count === 1 ? '' : 's') + (count ? ' · ' + records.map(item => item.season).sort().join(', ') : ' in these records'); return <td key={position}><button className={'lab-heat-cell' + (active ? ' active' : '') + (count > 0 ? ' has-data' : '')} style={{ '--heat': count / maxFrequency, color: count / maxFrequency >= .5 ? 'var(--cream)' : 'var(--green)' } as CSSProperties} aria-label={tooltip} title={tooltip} aria-pressed={active} onClick={() => { setSelectedPosition(position); setSelectedCell({ franchiseId: franchise.id, position }); }}>{count || '–'}</button></td>; })}</tr>)}</tbody></table></div><div className="lab-heat-legend"><span>Fewer appearances</span>{[0, .25, .5, .75, 1].map(value => <i key={value} style={{ '--heat': value } as CSSProperties}/>)}<span>More appearances</span></div><div className="lab-cell-detail" aria-live="polite">{selectedCell ? <><strong>{label(selectedCell.franchiseId)} · position #{selectedCell.position}</strong><span>{selectedCellOrders.length ? selectedCellOrders.map(item => item.season + ' (' + item.historicalOwner + ')').join(' · ') : 'No appearances at this position in the selected records.'}</span></> : <><strong>{filteredOrders.length} recorded starting slots</strong><span>{formatYears(filteredOrders.map(item => item.season))} · before traded picks change hands</span></>}</div></div>
        <aside className="lab-position-ranking"><p className="eyebrow">THE #{selectedPosition} CLUB</p><h3>Frequent visitors.</h3><p>Original position #{selectedPosition}, in the selected years.</p><div className="lab-slot-bars">{selectedSlotRanking.map(franchise => <button key={franchise.id} onClick={() => { setSpotlight(franchise.id); setSelectedCell({ franchiseId: franchise.id, position: selectedPosition }); }} className={spotlight !== 'all' && spotlight !== franchise.id ? 'lab-dimmed' : ''}><span>{label(franchise.id)}</span><i><b style={{ width: franchise.count / selectedSlotMax * 100 + '%', background: color(franchise.id) }}/></i><strong>{franchise.count}</strong></button>)}</div><p className="lab-chart-footnote">These are draft slots, not lottery-choice priority. A slot does not prove who won the lottery.</p></aside></div>
    </section>

    <section className="panel lab-scatter-panel" aria-labelledby="wins-trades-title"><div className="panel-header"><div><p className="eyebrow">02 / THE DEALMAKER QUESTION</p><h2 id="wins-trades-title">Does dealing pay off?</h2></div><span className="lab-source-chip">LEAGUE HISTORY</span></div><div className="lab-panel-description"><p>This eight-franchise snapshot pairs <strong>cumulative trade counts</strong> with <strong>recorded regular-season wins from 2018–2024</strong>.</p></div><div className="lab-scatter-layout"><div className="lab-scatter-area"><div className="lab-chart-toolbar"><span>Hover, focus, or tap a franchise.</span><label><input type="checkbox" checked={showTrend} onChange={event => setShowTrend(event.target.checked)}/> Show trend</label></div><svg className="lab-scatter" viewBox="0 0 622 349" role="img" aria-labelledby={'scatter-title-' + clipId} aria-describedby={'scatter-description-' + clipId}><title id={'scatter-title-' + clipId}>Reported cumulative trades versus regular-season wins</title><desc id={'scatter-description-' + clipId}>Each point represents one franchise. Wins and trade counts cover different periods. Select a point to read its trade and win totals.</desc><defs><clipPath id={'plot-' + clipId}><rect x={plot.left} y={plot.top} width={plot.width} height={plot.height}/></clipPath></defs>{Array.from({ length: 5 }, (_, index) => yMin + index * (yMax - yMin) / 4).map(value => <g key={value}><line x1={plot.left} x2={plot.left + plot.width} y1={y(value)} y2={y(value)} className="lab-gridline"/><text x={plot.left - 12} y={y(value) + 3} textAnchor="end" className="lab-axis-text">{Math.round(value)}</text></g>)}{Array.from({ length: 5 }, (_, index) => index * xMax / 4).map(value => <g key={value}><line x1={x(value)} x2={x(value)} y1={plot.top} y2={plot.top + plot.height} className="lab-gridline vertical"/><text x={x(value)} y={plot.top + plot.height + 19} textAnchor="middle" className="lab-axis-text">{Math.round(value)}</text></g>)}<text x={plot.left} y={12} className="lab-axis-title">RECORDED WINS</text><text x={plot.left + plot.width / 2} y={343} textAnchor="middle" className="lab-axis-title">REPORTED CUMULATIVE TRADES</text>{showTrend && slope !== null && <line x1={x(0)} y1={y(averageWins - slope * averageTrades)} x2={x(xMax)} y2={y(averageWins + slope * (xMax - averageTrades))} className="lab-trendline" clipPath={'url(#plot-' + clipId + ')'}/>}<line x1={x(averageTrades)} x2={x(averageTrades)} y1={plot.top} y2={plot.top + plot.height} className="lab-meanline"/>{observations.map((item, index) => { const isActive = activePoint === index; const dim = spotlight !== 'all' && item.franchiseId !== spotlight; const atRight = x(item.trades) > plot.left + plot.width - 60; return <g key={item.franchiseId + ':' + index} className={'lab-scatter-point' + (dim ? ' lab-dimmed' : '')} role="button" tabIndex={0} aria-label={item.historicalOwner + ': ' + item.trades + ' reported trades and ' + item.wins + ' recorded wins'} onMouseEnter={() => setActivePoint(index)} onFocus={() => setActivePoint(index)} onClick={() => { setActivePoint(index); setSpotlight(spotlight === item.franchiseId ? 'all' : item.franchiseId); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActivePoint(index); setSpotlight(spotlight === item.franchiseId ? 'all' : item.franchiseId); } }}><title>{item.historicalOwner + ' · ' + item.trades + ' trades · ' + item.wins + ' wins'}</title><circle cx={x(item.trades)} cy={y(item.wins)} r="17" fill="transparent"/>{isActive && <circle cx={x(item.trades)} cy={y(item.wins)} r="12" fill={color(item.franchiseId)} opacity=".15"/>}<circle cx={x(item.trades)} cy={y(item.wins)} r={isActive ? 6.8 : 5.5} fill={color(item.franchiseId)} stroke="var(--surface)" strokeWidth="2"/><text x={x(item.trades) + (atRight ? -11 : 11)} y={y(item.wins) - 9} textAnchor={atRight ? 'end' : 'start'} className="lab-point-label">{label(item.franchiseId)}</text></g>; })}</svg><div className="lab-franchise-legend">{franchises.map(franchise => <button className={spotlight === franchise.id ? 'active' : ''} onClick={() => { setSpotlight(spotlight === franchise.id ? 'all' : franchise.id); const index = observations.findIndex(item => item.franchiseId === franchise.id); if (index >= 0) setActivePoint(index); }} key={franchise.id} aria-pressed={spotlight === franchise.id}><i style={{ background: color(franchise.id) }}/>{label(franchise.id)}</button>)}</div></div><aside className="lab-scatter-insight"><p className="eyebrow">THE ASSOCIATION</p><div className="lab-correlation"><span>r =</span><strong>{analytics.winsTrades.pearson === null ? '—' : analytics.winsTrades.pearson.toFixed(2)}</strong></div><p className="lab-correlation-caption">{analytics.winsTrades.pearson !== null && analytics.winsTrades.pearson > 0 ? 'A positive association in this snapshot.' : 'A descriptive comparison of the recorded values.'}</p><span className="lab-sample-size">{observations.length} franchise observations · Pearson correlation</span>{point && <div className="lab-point-detail" aria-live="polite"><span className="lab-team-badge" style={{ '--lab-color': color(point.franchiseId) } as CSSProperties}>{label(point.franchiseId)}</span><strong>{point.historicalOwner}</strong><div><p><b>{point.trades}</b><span>reported trades</span></p><p><b>{point.wins}</b><span>recorded wins</span></p></div></div>}<p className="lab-chart-footnote">Counts span different periods and include workbook formula adjustments. More trades are not proven to cause more wins.</p></aside></div><div className="lab-source-warning"><strong>Read this as a historical snapshot.</strong> Trade totals are not matched to the same years as the win totals. Different tenures, roster strength, and disputed tally formulas can affect the relationship.</div></section>

    <section className="panel lab-preference-panel" aria-labelledby="player-preferences-title">
      <div className="panel-header">
        <div><p className="eyebrow">03 / PATTERNS OF PLAY</p><h2 id="player-preferences-title">Everybody has a type.</h2></div>
        <label className="lab-inline-filter">{preferenceTab === 'players' ? 'Draft year' : 'Season'}
          <select aria-label={preferenceTab === 'players' ? 'Filter player preference year' : 'Filter category preference season'} value={preferenceTab === 'players' ? preferenceSeason : categorySeason} onChange={event => { if (preferenceTab === 'players') { setPreferenceSeason(event.target.value); setSelectedPreference(null); } else setCategorySeason(event.target.value); }}>
            <option value="all">{preferenceTab === 'players' ? `${formatYears(analytics.coverage.draftYears)} · full archive` : 'All recorded seasons'}</option>
            {(preferenceTab === 'players' ? [...analytics.coverage.draftYears].sort((a, b) => b - a) : categoryYears).map(year => <option key={year} value={String(year)}>{preferenceTab === 'players' ? year : seasonLabel(year)}</option>)}
          </select>
        </label>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Explore franchise preferences">
        {([{ id: 'players', label: 'Players' }, { id: 'categories', label: 'Category Preferences' }] as const).map((tab, index) => <button
          key={tab.id} id={`preference-tab-${tab.id}`} type="button" role="tab"
          aria-selected={preferenceTab === tab.id} aria-controls={`preference-panel-${tab.id}`} tabIndex={preferenceTab === tab.id ? 0 : -1}
          onClick={() => setPreferenceTab(tab.id)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'players' : event.key === 'End' ? 'categories' : index === 0 ? 'categories' : 'players';
            setPreferenceTab(next);
            document.getElementById(`preference-tab-${next}`)?.focus();
          }}
        >{tab.label}</button>)}
      </div>
      <div id="preference-panel-players" role="tabpanel" aria-labelledby="preference-tab-players" hidden={preferenceTab !== 'players'}>
        <div className="lab-panel-description"><p>Every recorded appearance on a franchise’s draft board counts, including retained players. Find the familiar faces and the years they came back.</p></div>
        <div className="lab-preference-controls">
          <span className={styles.metricLabel}>TOTAL DRAFT-BOARD APPEARANCES</span>
          <label className="search-input"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input aria-label="Search player preferences" type="search" maxLength={200} placeholder="Find a familiar face…" value={playerSearch} onChange={event => { setPlayerSearch(event.target.value); setSelectedPreference(null); }}/></label>
          {playerSearch && <button type="button" className="text-button" onClick={() => setPlayerSearch('')}>Clear search</button>}
          {(spotlight !== 'all' || preferenceSeason !== 'all' || playerSearch) && <button type="button" className="text-button" onClick={resetPlayerFilters}>Reset player filters</button>}
        </div>
        <div className="lab-preference-heading"><span>{spotlight === 'all' ? 'LEAGUE-WIDE PAIRINGS' : label(spotlight) + ' · ' + name(spotlight)}</span><span role="status">Showing {preferenceRows.length ? preferenceStart + 1 : 0}–{preferenceStart + rankedPreferences.length} of {preferenceRows.length} matching pairs</span></div>
        <div className="lab-preference-bars">
          {rankedPreferences.map((item, index) => <button key={item.franchiseId + ':' + item.player} className={selectedPreferenceKey === item.franchiseId + ':' + item.player ? 'selected' : ''} onClick={() => setSelectedPreference({ key: item.franchiseId + ':' + item.player, scope: preferencePageScope })} aria-label={item.player + ' with ' + name(item.franchiseId) + ': ' + item.value + ' draft-board appearances'} aria-pressed={selectedPreferenceKey === item.franchiseId + ':' + item.player}>
            <span className="lab-preference-rank">{String(preferenceStart + index + 1).padStart(2, '0')}</span>
            <span className="lab-preference-player"><strong>{item.player}</strong><small><i style={{ background: color(item.franchiseId) }}/>{label(item.franchiseId)} · {item.selectedAppearances.length ? formatYears(item.selectedAppearances.map(selection => selection.season)) : formatYears(item.seasons)}</small></span>
            <span className="lab-stacked-track" aria-hidden="true"><i style={{ width: item.value / preferenceMax * 100 + '%', background: color(item.franchiseId) }}/></span>
            <strong className="lab-preference-value">{item.value}</strong><span className="lab-preference-arrow" aria-hidden="true">↗</span>
          </button>)}
        </div>
        {rankedPreferences.length === 0 && <div className="empty-state">No recorded appearances match these filters. Try another franchise, year, or player.</div>}
        <div className={styles.pagination}>
          <label>Rows per page<select aria-label="Player appearances per page" value={preferencePageSize} onChange={event => { setPreferencePageSize(Number(event.target.value)); setSelectedPreference(null); }}><option value="10">10</option><option value="25">25</option></select></label>
          <nav className={styles.paginationNav} aria-label="Player appearance pages">
            <button type="button" onClick={() => changePreferencePage(1)} disabled={preferencePage === 1} aria-label="First player page">First</button>
            <button type="button" onClick={() => changePreferencePage(preferencePage - 1)} disabled={preferencePage === 1} aria-label="Previous player page">Previous</button>
            <span className={styles.pageNumber}>Page {preferencePage} of {preferencePageCount}</span>
            <button type="button" onClick={() => changePreferencePage(preferencePage + 1)} disabled={preferencePage === preferencePageCount} aria-label="Next player page">Next</button>
            <button type="button" onClick={() => changePreferencePage(preferencePageCount)} disabled={preferencePage === preferencePageCount} aria-label="Last player page">Last</button>
          </nav>
        </div>
        {preferenceDetail && <div className={`lab-appearance-detail ${styles.playerDetail}`} aria-live="polite">
          <div><p className="eyebrow">THE RECEIPTS</p><h3>{preferenceDetail.player} × {label(preferenceDetail.franchiseId)}</h3><span>{preferenceDetail.value} recorded appearance{preferenceDetail.value === 1 ? '' : 's'}</span></div>
          <div className="lab-appearance-timeline">{preferenceDetail.selectedAppearances.map((selection, index) => <div key={selection.season + ':' + index}><strong>{selection.season}</strong><span>Round {selection.round} · #{selection.overallPick}</span><small>Manager then: {selection.historicalOwner}</small></div>)}</div>
        </div>}
        <p className="lab-preference-note">These are franchise draft-board appearances, including retention and selections made by earlier owners. The archive describes recorded player relationships; it does not establish a manager’s intent.</p>
      </div>
      <div id="preference-panel-categories" role="tabpanel" aria-labelledby="preference-tab-categories" hidden={preferenceTab !== 'categories'}>
        <div className="lab-panel-description"><p>Explore each franchise’s recorded roster mix and strongest regular-season categories. Position averages use saved roster snapshots; category records use completed matchups.</p></div>
        <div className={styles.categoryScope}><span>{spotlight === 'all' ? 'ALL FRANCHISES' : label(spotlight) + ' · FRANCHISE HISTORY'}</span><p>Season labels follow the basketball season: 2025–26 begins with the 2025 draft. Results stay with the franchise across owner changes.</p></div>
        <div className={styles.franchises}>
          {franchises.filter(franchise => spotlight === 'all' || franchise.id === spotlight).map(franchise => {
            const roster = rosterPositions.find(row => row.franchiseId === franchise.id);
            const categories = categoryPreferences.find(row => row.franchiseId === franchise.id);
            const strongest = [...(categories?.categories || [])].filter(category => category.winRate !== null && category.decisions > 0).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0) || b.wins - a.wins || a.label.localeCompare(b.label)).slice(0, 3);
            const maxPosition = Math.max(1, ...(roster?.positions.map(position => position.averageCount ?? 0) || []));
            return <article className={styles.franchise} key={franchise.id} style={{ '--franchise-color': color(franchise.id) } as CSSProperties} aria-label={`${name(franchise.id)} category preferences`}>
              <header className={styles.franchiseHeader}><span className="lab-team-badge" style={{ '--lab-color': color(franchise.id) } as CSSProperties}>{label(franchise.id)}</span><div><h3>{name(franchise.id)}</h3><p>{currentManager(franchise.id)} · franchise history</p></div></header>
              <section className={styles.positionSection} aria-label={`${label(franchise.id)} roster positions`}>
                <h4>Average recorded roster mix</h4>
                {roster && roster.snapshotCount > 0 ? <>
                  <p className={styles.coverage}>{roster.snapshotCount} snapshot{roster.snapshotCount === 1 ? '' : 's'} · {seasonList(roster.recordedSeasons)} · {roster.averageRosterSize?.toFixed(1)} players per roster</p>
                  <dl className={styles.positions}>{roster.positions.map(position => <div key={position.position}><dt>{position.position}</dt><dd><strong>{position.averageCount?.toFixed(1) ?? '—'}</strong><span>{percent(position.averageShare)}</span><i aria-hidden="true"><b style={{ width: `${(position.averageCount ?? 0) / maxPosition * 100}%` }}/></i></dd></div>)}</dl>
                  {roster.unknownPlayers > 0 && <p className={styles.coverage}>{roster.unknownPlayers} player observation{roster.unknownPlayers === 1 ? '' : 's'} have no recorded primary position and remain in the roster denominator.</p>}
                </> : <p className={styles.unavailable}>No roster snapshots in the selected seasons.</p>}
                {roster && roster.missingSeasons.length > 0 && <p className={styles.missing}>No roster snapshot: {seasonList(roster.missingSeasons)}.</p>}
              </section>
              <section className={styles.resultsSection} aria-label={`${label(franchise.id)} category results`}>
                <h4>Strongest recorded categories</h4>
                {categories && categories.matchups > 0 && strongest.length > 0 ? <>
                  <p className={styles.coverage}>{categories.matchups} completed regular-season matchups · {seasonList(categories.recordedSeasons)}</p>
                  <div className={styles.strongest}>{strongest.map(category => <div key={category.id}><span>{category.label}</span><strong>{percent(category.winRate)}</strong><small>{category.wins} W · {category.losses} L · {category.ties} T</small></div>)}</div>
                  <details className={styles.categoryDetails}><summary>All {categories.categories.length} category records <span aria-hidden="true">+</span></summary><div className={styles.categoryTable}><table><caption className="visually-hidden">{name(franchise.id)} regular-season category records. Win rate gives a tie half credit.</caption><thead><tr><th scope="col">Category</th><th scope="col">W</th><th scope="col">L</th><th scope="col">T</th><th scope="col">Win rate</th></tr></thead><tbody>{categories.categories.map(category => <tr key={category.id}><th scope="row">{category.label}</th><td>{category.wins}</td><td>{category.losses}</td><td>{category.ties}</td><td>{percent(category.winRate)}{category.coverageMatchups < categories.matchups && <small>{category.coverageMatchups}/{categories.matchups} matchups</small>}</td></tr>)}</tbody></table></div></details>
                </> : <p className={styles.unavailable}>No completed category results in the selected seasons.</p>}
                {categories && categories.missingSeasons.length > 0 && <p className={styles.missing}>No category results: {seasonList(categories.missingSeasons)}.</p>}
              </section>
            </article>;
          })}
        </div>
        <p className="lab-preference-note">Positions count each player once at ESPN’s recorded primary position, including the bench and injured list. Averages weight recorded season snapshots equally and do not measure lineup usage throughout a season. Category win rate is (wins + ½ ties) ÷ decisions; a turnover win means fewer turnovers. Strong categories show results, without assuming a manager’s strategy.</p>
      </div>
    </section>
    <details className="panel lab-methodology"><summary><div><p className="eyebrow">BEHIND THE NUMBERS</p><h2>Sources, scope & a few healthy caveats.</h2></div><span aria-hidden="true">+</span></summary><div className="lab-methodology-content"><section><h3>Draft position is a specific thing.</h3><p>Verified original positions use the explicit original-owner columns from {formatYears(authoritativeYears)}. Reconstructed older slots are included by default and can be excluded with the chart toggle. A traded first-round pick can go to a different franchise, and neither record is the lottery’s choice priority.</p><p>Historical owners remain associated with their own draft years. A new owner inherits the franchise, but earlier draft choices are not attributed to them.</p></section><section><h3>Historical totals, with context.</h3><p>Trades cover the full historical ledger, while wins cover 2018–2024. Annual trade counts are unavailable, so the periods cannot be aligned.</p><p>These totals retain historical formula adjustments and owner-name inconsistencies. Some earlier owners were excluded from franchise tallies; those decisions limit comparisons.</p><p>The trend line is a least-squares fit through the reported pairs. Correlation is descriptive; unequal time windows and historical tally decisions limit what can be concluded.</p></section><section><h3>Favorite players, with context.</h3><p>Counts come from {analytics.coverage.selectionCount} draft-board entries across {formatYears(analytics.coverage.draftYears)}. Franchise identities are grouped across owner changes. A repeated player may reflect keeper retention, draft choices, or ownership transfers.</p><p>Known spelling variants and nicknames are normalized explicitly. Players without a recorded draft-board appearance are not added to these counts, even when a separate keeper list names them.</p></section><section><h3>How Luckbox is calculated.</h3><p>The four franchises in each season’s championship bracket form the playoff group for the following draft. For example, the 2025–26 bracket feeds the 2026 draft. Luckbox counts top-four original draft slots earned by those franchises and follows the draft chart’s year selection.</p><p>A winner appears only when every selected year has both a verified bracket and a complete original draft order. Missing results never count as a non-playoff season or a loss.</p></section>{analytics.coverage.limitations?.length > 0 && <section><h3>Archive coverage</h3><p>Older draft positions were reconstructed from ownership annotations. Later records distinguish original pick owners from the teams that received traded picks.</p></section>}</div></details>
  </div>;
}
