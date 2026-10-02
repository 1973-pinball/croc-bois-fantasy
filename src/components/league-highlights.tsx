import type { CSSProperties } from 'react';
import analytics from '../../data/analytics.json';
import type { Team } from '@/lib/types';
import styles from './league-highlights.module.css';

export interface HighlightStanding {
  franchiseId: string | number;
  count: number;
  /** Use the historical manager label when the measurement predates today's owner. */
  managerLabel?: string;
}

export interface LeagueHighlightsProps {
  teams: readonly Team[];
  championships?: readonly HighlightStanding[];
  /** Only complete championship coverage may produce a championship ranking. */
  championshipsComplete?: boolean;
  championshipCoverage?: string;
  wins?: readonly HighlightStanding[];
  winsCoverage?: string;
  className?: string;
}

export interface HighlightRank {
  rank: number;
  count: number;
  entries: HighlightStanding[];
}

/** Competition ranks preserve ties, including every franchise tied at third. */
export function rankHighlightStandings(standings: readonly HighlightStanding[]): HighlightRank[] | null {
  const ids = new Set<string>();
  for (const entry of standings) {
    const id = String(entry.franchiseId);
    if (!id || ids.has(id) || !Number.isSafeInteger(entry.count) || entry.count < 0) return null;
    ids.add(id);
  }
  const ordered = standings.filter(entry => entry.count > 0).sort((a, b) => b.count - a.count || String(a.franchiseId).localeCompare(String(b.franchiseId)));
  const groups: HighlightRank[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index];
    const previous = groups.at(-1);
    if (previous?.count === entry.count) previous.entries.push(entry);
    else {
      const rank = index + 1;
      if (rank > 3) break;
      groups.push({ rank, count: entry.count, entries: [entry] });
    }
  }
  return groups;
}

const recordedWins: HighlightStanding[] = analytics.winsTrades.observations.map(item => ({
  franchiseId: item.franchiseId,
  count: item.wins,
  managerLabel: item.historicalOwner,
}));
const ordinal = (rank: number) => rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd';

function HighlightIcon({ trophy }: { trophy: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {trophy ? <><path d="M7 3h10v5a5 5 0 0 1-10 0V3ZM7 5H3v2a5 5 0 0 0 5 5M17 5h4v2a5 5 0 0 1-5 5M12 13v6M8 21h8M9 19h6"/></> : <><path d="M4 21V11h4v10M10 21V3h4v18M16 21V7h4v14M2 21h20"/><path d="m10 3 2-2 2 2"/></>}
  </svg>;
}

function PodiumMedal({ rank }: { rank: number }) {
  return <svg className={styles.medal} viewBox="0 0 120 130" fill="none" aria-hidden="true">
    <path d="M34 92C17 80 12 58 22 36M28 83l-12-4M23 73l-12-7M21 60l-9-9M23 47l-5-12M86 92c17-12 22-34 12-56M92 83l12-4M97 73l12-7M99 60l9-9M97 47l5-12" stroke="var(--medal-edge)" strokeWidth="3" strokeLinecap="round"/>
    <path d="M36 91c8 7 15 10 24 11 9-1 16-4 24-11" stroke="var(--medal-edge)" strokeWidth="2" strokeLinecap="round"/>
    <path d="m48 82 5 23h14l5-23" fill="var(--medal-shade)" stroke="var(--medal-edge)" strokeWidth="1.5"/>
    <path d="M42 107h36l6 11H36l6-11Z" fill="var(--medal-face)" stroke="var(--medal-edge)" strokeWidth="1.5"/>
    <path d="M34 118h52v7H34z" fill="var(--medal-shade)" stroke="var(--medal-edge)" strokeWidth="1.5"/>
    <circle cx="60" cy="50" r="34" fill="var(--medal-face)" stroke="var(--medal-edge)" strokeWidth="2"/>
    <circle cx="60" cy="50" r="28.5" stroke="var(--medal-edge)" strokeWidth="1" opacity=".4"/>
    <path d="M27 46c18 0 45 10 61 21M43 22c13 17 22 41 24 61M31 68c12-16 39-31 61-29M73 19c-10 22-18 36-37 52" stroke="var(--medal-edge)" strokeWidth="1.6"/>
    <path d="M39 31a27 27 0 0 1 29-7" stroke="white" strokeOpacity=".65" strokeWidth="3" strokeLinecap="round"/>
    <circle cx="60" cy="94" r="12" fill="var(--medal-face)" stroke="var(--medal-edge)" strokeWidth="1.5"/>
    <text x="60" y="99" textAnchor="middle" fill="var(--medal-edge)" fontSize="14" fontWeight="800" fontFamily="Arial, sans-serif">{rank}</text>
  </svg>;
}

function Podium({ title, standings, ready, coverage, teams }: {
  title: 'Championships' | 'Total wins';
  standings: readonly HighlightStanding[];
  ready: boolean;
  coverage: string;
  teams: readonly Team[];
}) {
  const ranks = ready ? rankHighlightStandings(standings) : [];
  const valid = ranks !== null && standings.every(entry => teams.some(team => String(team.id) === String(entry.franchiseId)));
  const available = ready && valid && Boolean(ranks?.length);
  const trophy = title === 'Championships';
  const unavailableMessage = !ready
    ? 'Awaiting complete championship history'
    : !valid ? 'These totals need a data review'
    : trophy ? 'No championships recorded in this period' : 'No wins recorded in this period';

  return <section className={`${styles.panel} ${trophy ? styles.championships : styles.wins}`} aria-label={title}>
    <div className={styles.heading}>
      <h2>{title}</h2>
      <span className={styles.icon}><HighlightIcon trophy={trophy}/></span>
    </div>
    <p className={styles.coverage}>{coverage}</p>
    {!available && <div className={styles.pending}><strong>{unavailableMessage}</strong><span>{!ready ? 'No leaders ranked until every season is confirmed.' : 'Only verified totals are ranked.'}</span></div>}
    {available && <div className={styles.podium} aria-label="Top three ranks, including ties">
      {[2, 1, 3].map(rank => {
        const group = available ? ranks?.find(item => item.rank === rank) : undefined;
        const tied = Boolean(group && group.entries.length > 1);
        return <div key={rank} className={`${styles.place} ${rank === 1 ? styles.first : rank === 2 ? styles.second : styles.third}`} data-rank={group?.rank}>
          <div className={styles.competitors}>
            {group && <PodiumMedal rank={rank}/>}
            {group ? group.entries.map(entry => {
              const team = teams.find(item => String(item.id) === String(entry.franchiseId))!;
              return <div className={styles.competitor} key={entry.franchiseId}>
                <span className={styles.teamMark} style={{ '--team-color': team.color } as CSSProperties} title={team.name}>{team.shortName}</span>
                <span className={styles.manager}>{entry.managerLabel || team.owner}</span>
              </div>;
            }) : <span className={styles.placeholder} aria-hidden="true">—</span>}
          </div>
          <div className={styles.step}>
            <span className={styles.rank}>{group ? `${tied ? 'T' : ''}${ordinal(rank)}` : '—'}</span>
            <strong className={styles.value}>{group ? group.count.toLocaleString('en-US') : '—'}</strong>
            <span className={styles.unit}>{group ? trophy ? group.count === 1 ? 'title' : 'titles' : 'wins' : ' '}</span>
          </div>
        </div>;
      })}
    </div>}
    {available && <p className={styles.footnote}>Franchise totals · ties share a rank</p>}
  </section>;
}

export function LeagueHighlights({ teams, championships = [], championshipsComplete = false, championshipCoverage = 'League championship history', wins, winsCoverage, className = '' }: LeagueHighlightsProps) {
  return <div className={`${styles.highlights} ${className}`}>
    <Podium title="Championships" standings={championships} ready={championshipsComplete} coverage={championshipCoverage} teams={teams}/>
    <Podium title="Total wins" standings={wins ?? recordedWins} ready coverage={winsCoverage || (wins ? 'Recorded regular-season category wins' : '2018–2024 recorded regular-season category wins')} teams={teams}/>
  </div>;
}
