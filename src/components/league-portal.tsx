'use client';

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import Image from 'next/image';
import { leagueData as previewData } from '@/lib/league-data';
import { validatePlanner } from '@/lib/planner';
import { acceptKeeperDraftSave, editKeeperDraft, initializeKeeperDraft, loadKeeperDraft, type KeeperDraft } from '@/lib/keeper-draft';
import type { LeaguePlayer, Team } from '@/lib/types';
import { AccountButton, LeagueConnectionNotice, OfficialKeeperControls, OfficialReviewPanel, useLeagueAccount } from './league-account';
import { KeeperProfileReview } from './keeper-profile-review';
import { LeagueAnalytics } from './league-analytics';
import { TradeWorkspace } from './trade-workspace';
import { DraftPickGrids, TeamPickInventory } from './draft-pick-grids';
import { TeamAccessPanel, CommissionerTeamAccess } from './team-access';
import { LeagueHighlights } from './league-highlights';
import { summarizeLeagueHistory } from '@/lib/league-highlights';
import { useEspnHistory, EspnHistoryNotice, EspnHistorySyncPanel } from './espn-history';
import { SeasonReadinessPanel, SeasonScheduleNotice } from './season-readiness';
import { LiveDraftBoard } from './live-draft-board';
import { DraftLottery } from './draft-lottery';
import heroStyles from './overview-hero.module.css';
import rosterStyles from './roster-density.module.css';
import commissionerNavStyles from './commissioner-nav.module.css';
import keeperPoolStyles from './keeper-pool-density.module.css';
import { usePortalLocation, useViewFocus } from './use-portal-location';
import type { PortalView as View, RosterSort } from '@/lib/portal-location';
import { managerLabel, seasonLabel } from '@/lib/display-labels';
import './portal-navigation.css';

const LeagueContext = createContext(previewData);

type Assignment = { playerId: number; pickId: string };
const navigation: { id: View; label: string; icon: string }[] = [
  { id: 'overview', label: 'League overview', icon: 'home' },
  { id: 'my-team', label: 'My Team', icon: 'teams' },
  { id: 'teams', label: 'Teams & players', icon: 'teams' },
  { id: 'keepers', label: 'Keeper planner', icon: 'keeper' },
  { id: 'draft', label: 'Draft board', icon: 'draft' },
  { id: 'trades', label: 'Trade log', icon: 'trade' },
  { id: 'lab', label: 'League Lab', icon: 'chart' },
  { id: 'charter', label: 'League charter', icon: 'book' },
  { id: 'commissioner', label: 'Commissioner tools', icon: 'shield' },
  { id: 'audit', label: 'Keeper cost audit', icon: 'check' },
];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
    teams: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
    keeper: <><path d="M6 3h12v18l-6-4-6 4Z"/><path d="m9 10 2 2 4-4"/></>,
    draft: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></>,
    trade: <><path d="M4 7h15l-4-4M20 17H5l4 4M19 7l-4 4M5 17l4-4"/></>,
    chart: <><path d="M3 3v18h18M7 17v-5M12 17V7M17 17V3"/><circle cx="20" cy="7" r="1"/></>,
    book: <><path d="M12 5v15M12 5C8 2 5 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-6-2-10 1Z"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    ball: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M6 5c8 4 8 10 0 14M18 5c-8 4-8 10 0 14"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.ball}</svg>;
}

function CrocMark({ large = false }: { large?: boolean }) {
  return <Image className={large ? 'croc-mark croc-mark-large' : 'croc-mark'} src="/images/croc-bois-mascot.png" alt="" width={512} height={512} sizes={large ? '(max-width: 980px) 170px, 220px' : '64px'}/>;
}

function TeamAvatar({ team, small = false }: { team: Team; small?: boolean }) {
  return <span aria-hidden="true" className={'team-avatar' + (small ? ' small' : '')} style={{ '--team-color': team.color } as CSSProperties}>{team.shortName}</span>;
}

function Status({ status }: { status: string }) {
  const label: Record<string, string> = { eligible: 'Eligible', ineligible: 'Ineligible', review: 'Needs review', recorded: 'Recorded', voided: 'Voided', provisional: 'Provisional', 'needs-review': 'Needs review' };
  return <span className={'status status-' + status}><span/>{label[status] || status}</span>;
}

type PlayerSortColumn = 'player' | 'team' | 'cost' | 'tenure';

function PlayerTable({ players, showTeam = false, compact = false, sort, setSort }: { players: LeaguePlayer[]; showTeam?: boolean; compact?: boolean; sort: RosterSort; setSort: (sort: RosterSort) => void }) {
  const leagueData = useContext(LeagueContext);
  const sortId = useId();
  const sortedPlayers = useMemo(() => {
    const teamNames = new Map(leagueData.teams.map(team => [team.id, team.shortName]));
    const compareText = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true });
    const value = (player: LeaguePlayer): string | number | null => sort.column === 'player' ? player.name : sort.column === 'team' ? teamNames.get(player.teamId) ?? null : sort.column === 'cost' ? player.baseCost : player.tenure;
    return [...players].sort((a, b) => {
      const left = value(a), right = value(b);
      // Missing values remain last in either direction; ties stay alphabetical.
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      const comparison = left === null || right === null ? 0 : typeof left === 'number' && typeof right === 'number' ? left - right : compareText(String(left), String(right));
      return comparison * (sort.direction === 'ascending' ? 1 : -1) || compareText(a.name, b.name) || a.id - b.id;
    });
  }, [players, leagueData.teams, sort]);
  function sortableHeader(column: PlayerSortColumn, label: string) {
    const active = sort.column === column;
    const nextDirection = active && sort.direction === 'ascending' ? 'descending' : 'ascending';
    return <th scope="col" aria-sort={active ? sort.direction : 'none'}><button type="button" className="table-sort-button" onClick={() => setSort({ column, direction: nextDirection })} aria-label={`Sort by ${label.toLowerCase()}, ${nextDirection}`}><span>{label}</span><span className="table-sort-indicator" aria-hidden="true">{active ? sort.direction === 'ascending' ? '↑' : '↓' : '↕'}</span></button></th>;
  }
  return <div className={'table-wrap' + (compact ? ` ${rosterStyles.table}` : '')}>
    {compact && <div className={rosterStyles.mobileSort}><label htmlFor={sortId}>Sort roster</label><select id={sortId} value={`${sort.column}:${sort.direction}`} onChange={event => { const [column, direction] = event.target.value.split(':') as [PlayerSortColumn, 'ascending' | 'descending']; setSort({ column, direction }); }}>{(['player', ...(showTeam ? ['team'] : []), 'cost', 'tenure'] as PlayerSortColumn[]).flatMap(column => (['ascending', 'descending'] as const).map(direction => <option key={`${column}:${direction}`} value={`${column}:${direction}`}>{({ player: 'Player', team: 'Team', cost: 'Keeper cost', tenure: 'Tenure' })[column]} · {direction === 'ascending' ? 'ascending' : 'descending'}</option>))}</select></div>}
    <table className="data-table"><caption className="visually-hidden">Roster players, keeper costs, tenure, and eligibility. Player details explain each eligibility decision.</caption><thead><tr>{sortableHeader('player', 'Player')}{showTeam && sortableHeader('team', 'Team')}{sortableHeader('cost', 'Keeper cost')}{sortableHeader('tenure', 'Tenure')}<th scope="col">Eligibility</th></tr></thead><tbody>
    {sortedPlayers.map(player => <tr key={player.id}>
      <td className={rosterStyles.playerName}><strong>{player.name}</strong><span className="cell-note">{player.wasKept ? 'Previously kept' : 'Roster player'}{player.rosterSlot ? ' · ' + player.rosterSlot : ''}</span>{compact && <span className={rosterStyles.mobileFacts}>{showTeam && <span>{leagueData.teams.find(team => team.id === player.teamId)?.shortName || 'Unassigned'}</span>}<span>{player.baseCost ? 'Round ' + player.baseCost : 'Cost —'}</span><span>Tenure {player.tenure === null ? '—' : player.tenure + '/5'}</span></span>}</td>
      {showTeam && <td className={rosterStyles.metadataColumn}>{leagueData.teams.find(team => team.id === player.teamId)?.shortName || 'Unassigned'}</td>}
      <td className={rosterStyles.metadataColumn}><span className="round-label">{player.baseCost ? 'Round ' + player.baseCost : '—'}</span></td><td className={rosterStyles.metadataColumn}>{player.tenure === null ? '—' : player.tenure + ' / 5'}</td>
      <td>{compact ? <div className={rosterStyles.eligibility}><Status status={player.status}/><details className={rosterStyles.reason}><summary aria-label={`Eligibility details for ${player.name}`}>Details</summary><p>{player.reason}</p></details></div> : <><Status status={player.status}/><span className="cell-note reason-note">{player.reason}</span></>}</td>
    </tr>)}
    {players.length === 0 && <tr><td colSpan={showTeam ? 5 : 4}><div className="empty-state">No players match this search.</div></td></tr>}
  </tbody></table></div>;
}

export function LeaguePortal({ report, initialSearch = '' }: { report?: ReactNode; initialSearch?: string }) {
  const account = useLeagueAccount();
  const location = usePortalLocation(report ? 'audit' : 'overview', initialSearch);
  const { search, tradeSearch, allTeams, draftView } = location;
  const view = report ? 'audit' : location.view;
  useViewFocus(view);
  const commissionerTipId = useId();
  const leagueData = account.data;
  const espnHistory = useEspnHistory();
  const completedThrough = Math.max(leagueData.season, espnHistory.completedThrough, ...espnHistory.history.seasons.filter(season => season.championFranchiseId).map(season => season.espnSeasonId));
  const completedYears = Array.from({ length: Math.max(0, completedThrough - 2017) }, (_, index) => 2018 + index);
  const historyHighlights = summarizeLeagueHistory(espnHistory.history.seasons, completedYears, espnHistory.history.statsOnlySeasons);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const activeTeam = leagueData.teams.some(team => team.id === location.teamId) ? location.teamId! : leagueData.teams[0]?.id ?? 0;
  const [draftsByTeam, setDraftsByTeam] = useState<Record<number, KeeperDraft>>({});
  const [plannerNotice, setPlannerNotice] = useState('');
  const draftYear = leagueData.drafts.some(item => String(item.year) === location.draftYear) ? location.draftYear! : String(Math.max(...leagueData.drafts.map(item => item.year)));
  const setSearch = (value: string) => location.update({ roster: value });
  const setTradeSearch = (value: string) => location.update({ trade: value });
  const setAllTeams = (value: boolean) => location.update({ all: value });
  const setDraftYear = (value: string) => location.update({ year: value });
  const openedAccount = useRef<string | null>(null);
  const plannerAccount = useRef<string | null>(null);
  const ownTeamKey = account.ownTeamIds.join(',');
  const overviewAction: { view: View; label: string } = account.live?.draftOrder?.length ? { view: 'draft', label: 'Open draft room' } : account.ownTeamIds.length ? { view: 'keepers', label: 'Plan my keepers' } : { view: 'my-team', label: 'Find my team' };
  const myTeamView = view === 'my-team' && account.ownTeamIds.includes(activeTeam);
  const team = leagueData.teams.find(item => item.id === activeTeam) || leagueData.teams[0];
  const draft = draftsByTeam[activeTeam];
  const assignments = draft?.assignments || [];
  const teamPlayers = leagueData.players.filter(player => player.teamId === activeTeam);
  const ownedPicks = leagueData.picks.filter(pick => pick.ownerTeamId === activeTeam && pick.season === leagueData.season).sort((a, b) => a.round - b.round);
  const eligiblePlayers = leagueData.players.filter(player => player.status === 'eligible');
  const plannerErrors = useMemo(() => validatePlanner(activeTeam, assignments, leagueData), [activeTeam, assignments, leagueData]);
  const heading = navigation.find(item => item.id === view)?.label || 'Commissioner Tools';
  const rosterPlayers = leagueData.players.filter(player => (allTeams || player.teamId === activeTeam) && player.name.toLowerCase().includes(search.trim().toLowerCase()));
  const matchingTrades = [...leagueData.trades].reverse().filter(trade => (trade.id + ' ' + trade.parties.join(' ') + ' ' + trade.summary + ' ' + trade.notes).toLowerCase().includes(tradeSearch.trim().toLowerCase()));

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const sync = () => { setMobile(query.matches); if (!query.matches) setMobileOpen(false); };
    sync(); query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    document.title = `${heading} | Croc Bois`;
  }, [heading]);

  useEffect(() => {
    if (!mobileOpen || !mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLElement>('a, button:not(:disabled)')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),[tabindex="0"]') || [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', trap); };
  }, [mobileOpen, mobile]);

  useEffect(() => {
    if (!account.sessionLoading && account.connection !== 'loading' && view === 'commissioner' && !account.commissioner) {
      location.update({ view: 'overview' }); setMobileOpen(false);
    }
  }, [view, account.commissioner, account.sessionLoading, account.connection]);

  useEffect(() => {
    if (account.sessionLoading || account.connection === 'loading' || !account.session?.user) return;
    const key = account.session.user.id + ':' + ownTeamKey;
    if (openedAccount.current === key) return;
    openedAccount.current = key;
    const own = ownTeamKey.split(',').filter(Boolean).map(Number);
    const params = new URLSearchParams(window.location.search);
    // Explicit deep links always win over the signed-in landing-page default.
    if (!params.has('view') && !report) location.update({ view: 'my-team', team: own[0] || null, all: false });
    else if (params.get('view') === 'my-team' && own.length && !own.includes(Number(params.get('team')))) location.update({ team: own[0], all: false });
  }, [account.sessionLoading, account.session?.user?.id, account.connection, ownTeamKey]);

  useEffect(() => {
    if (account.sessionLoading) return;
    const key = JSON.stringify([account.seasonId, account.session?.user?.id, account.session?.memberships, account.session?.assignments]);
    if (plannerAccount.current !== null && plannerAccount.current !== key) {
      setDraftsByTeam({}); setPlannerNotice('Season or account access changed. Load your current team’s saved keeper draft before continuing.');
    }
    plannerAccount.current = key;
  }, [account.sessionLoading, account.session, account.seasonId]);

  useEffect(() => {
    if (!account.submissionsLoaded) return;
    setDraftsByTeam(previous => {
      const next = { ...previous };
      let changed = false;
      for (const item of leagueData.teams) {
        if (!account.canManageTeam(item.id)) continue;
        const submission = account.submissionFor(item.id);
        const initialized = initializeKeeperDraft(next[item.id], account.toPlannerAssignments(submission), submission?.revision ?? 0);
        if (initialized !== next[item.id]) { next[item.id] = initialized; changed = true; }
      }
      return changed ? next : previous;
    });
  }, [account.submissionsLoaded, account.submissions, account.session, leagueData]);

  function closeMenu() { setMobileOpen(false); requestAnimationFrame(() => menuRef.current?.focus()); }
  function navigate(next: View, teamId?: number) {
    if (next === 'commissioner' && !account.commissioner) return;
    if (next === view && teamId === undefined) { if (mobileOpen) closeMenu(); return; }
    const selected = teamId ?? (next === 'my-team' && account.ownTeamIds.length && !account.ownTeamIds.includes(activeTeam) ? account.ownTeamIds[0] : activeTeam);
    if (report || next === 'audit') { window.location.assign(location.href({ view: next, team: selected })); return; }
    location.update({ view: next, team: selected, ...(next === 'my-team' ? { all: false } : {}), order: null }, false);
    setMobileOpen(false); setPlannerNotice('');
  }
  function navigationClick(event: MouseEvent<HTMLAnchorElement>, next: View) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || report || next === 'audit') return;
    event.preventDefault(); navigate(next);
  }
  function openMyTeam(id: number) { if (account.ownTeamIds.includes(id)) navigate('my-team', id); }
  function changeTeam(id: number) { location.update({ team: id, all: false }, false); setPlannerNotice(''); }
  function updateAssignments(next: Assignment[]) { setDraftsByTeam(previous => ({ ...previous, [activeTeam]: editKeeperDraft(previous[activeTeam], next) })); setPlannerNotice(''); }
  function loadAssignments(next: Assignment[], revision: number) { setDraftsByTeam(previous => ({ ...previous, [activeTeam]: loadKeeperDraft(next, revision) })); setPlannerNotice('Saved keeper draft loaded.'); }
  function acceptSavedRevision(expectedRevision: number, revision: number) {
    setDraftsByTeam(previous => {
      const accepted = acceptKeeperDraftSave(previous[activeTeam], expectedRevision, revision);
      return accepted && accepted !== previous[activeTeam] ? { ...previous, [activeTeam]: accepted } : previous;
    });
  }
  function togglePlayer(player: LeaguePlayer) {
    if (assignments.some(item => item.playerId === player.id)) { updateAssignments(assignments.filter(item => item.playerId !== player.id)); return; }
    const available = ownedPicks.filter(pick => !assignments.some(item => item.pickId === pick.id) && player.baseCost !== null && pick.round <= player.baseCost);
    const pick = [...available].sort((a, b) => b.round - a.round)[0];
    updateAssignments([...assignments, { playerId: player.id, pickId: pick?.id || '' }]);
  }

  return <LeagueContext.Provider value={leagueData}><div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside ref={sidebarRef} id="league-navigation" className={'sidebar' + (mobileOpen ? ' sidebar-open' : '')} inert={mobile && !mobileOpen} role={mobile && mobileOpen ? 'dialog' : undefined} aria-modal={mobile && mobileOpen ? true : undefined} aria-label="Main navigation">
      <a className="brand" href="/?view=overview" onClick={event => navigationClick(event, 'overview')} aria-label="Croc Bois league overview"><span className="brand-mark"><CrocMark/></span><span className="brand-name">CROC BOIS<span>FANTASY BASKETBALL</span></span></a>
      <button type="button" className="drawer-close" onClick={closeMenu} aria-label="Close navigation">Close ×</button>
      <div className="sidebar-season"><span className="live-dot"/> THE LEAGUE OFFICE <span className="season-year">{leagueData.season}</span></div>
      <nav>{navigation.map(item => item.id === 'commissioner' && !account.commissioner
        ? <span key={item.id} className={commissionerNavStyles.locked} tabIndex={0} role="group" aria-label="Commissioner Tools requires commissioner access" aria-describedby={commissionerTipId}><button className="nav-item" disabled aria-describedby={commissionerTipId}><Icon name={item.icon}/><span>{item.label}</span></button><span id={commissionerTipId} role="tooltip" className={commissionerNavStyles.tooltip}>Commissioner access is required to manage league settings and reviews.</span></span>
        : <a key={item.id} href={location.href({ view: item.id })} className={'nav-item' + (view === item.id ? ' active' : '')} onClick={event => navigationClick(event, item.id)} aria-current={view === item.id ? 'page' : undefined}><Icon name={item.icon}/><span>{item.label}</span>{view === item.id && <span className="nav-active-dot"/>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-footer">EST. 2017 <span>KEEP IT CROC.</span></div></div>
    </aside>
    {mobileOpen && <button className="nav-backdrop" onClick={closeMenu} tabIndex={-1} aria-label="Close navigation"/>}
    <div className="main-shell" inert={mobile && mobileOpen}>
      <header className="topbar"><div className="topbar-left"><button ref={menuRef} aria-controls="league-navigation" className="icon-button mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation" aria-expanded={mobileOpen}><Icon name="menu"/></button><span className="topbar-league">CROC BOIS</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-current">{heading}</span></div><div className="topbar-right"><span className={"public-label" + (account.session?.user?.email ? " account-email" : "")} title={account.session?.user?.email || undefined}><span/>{account.session?.user?.email || "Public league hub"}</span><AccountButton account={account}/></div></header>
      <main id="main-content" tabIndex={-1} className={'main-content' + (view === 'draft' ? ' draft-page' : '') + (view === 'teams' || myTeamView ? ` ${rosterStyles.rosterPage}` : '')}><div className="league-context"><LeagueConnectionNotice account={account}/>{!report && <SeasonScheduleNotice account={account}/>}</div>
        {report}
        {account.sessionError && <div className="workflow-message workflow-error" role="alert">{account.sessionError} <button className="text-button" onClick={() => void account.reloadSession()}>Refresh account</button></div>}
        {view === 'my-team' && <>
          <div className={myTeamView ? rosterStyles.myTeamHeading : undefined}><PageTitle eyebrow="YOUR LEAGUE HOME" title="My Team" description={myTeamView ? 'Your roster, your picks, and your next move.' : 'Connect your account to the franchise you manage.'}/>
            {myTeamView && <div className="filter-controls"><button className="button button-green" onClick={() => navigate('keepers')}>My keeper submissions <Icon name="keeper" size={17}/></button><button className="button button-subtle" onClick={() => navigate('trades')}>Trade tools <Icon name="trade" size={17}/></button></div>}
          </div>
          {!account.session?.user ? <section className="panel"><h2>Sign in to find your team</h2><p>Use your Google account, request your team, and the commissioner will approve your access.</p><AccountButton account={account} className="button button-green" label="Sign in with Google"/></section> : myTeamView ? <details className={rosterStyles.accessDetails}><summary>Team access & account <span>Manage linked teams and requests</span></summary><TeamAccessPanel account={account} onOpenTeam={openMyTeam}/></details> : <TeamAccessPanel account={account} onOpenTeam={openMyTeam}/>}
        </>}
        {view === 'overview' && <>
          <div className="page-heading"><div><p className="eyebrow">THE OFFICIAL LEAGUE HUB</p><h1>Welcome, croc bois</h1><p className="page-intro">The players, the picks, and the deals that make this league ours.</p></div><span className="season-pill"><Icon name="ball" size={16}/> {seasonLabel(leagueData.season)} SEASON</span></div>
          <section className={heroStyles.hero} aria-labelledby="hero-title"><div className={heroStyles.mark} aria-hidden="true"><CrocMark large/></div><div className={heroStyles.copy}><h2 id="hero-title">Dynasties aren’t built in a single season.</h2><p>Know what you own. Plan who you keep. Make your next move count.</p></div><button className="button button-orange" onClick={() => navigate(overviewAction.view)}>{overviewAction.label} <Icon name="arrow" size={18}/></button></section>
          <section className="stats-grid league-history-stats" aria-label="League at a glance"><Stat label="FRANCHISES" value={leagueData.teams.length} detail="One very competitive league" icon="teams"/><Stat label="YEARS ACTIVE" value={completedYears.length} detail="Keeping it croc since 2017" icon="clock"/><Stat label="TRADES IN THE ARCHIVE" value={leagueData.trades.length} detail="History, including voided records" icon="trade"/></section>
          <EspnHistoryNotice history={espnHistory}/>
          <LeagueHighlights loading={espnHistory.source === 'loading'} teams={leagueData.teams} championships={historyHighlights.championships} championshipsComplete={historyHighlights.championshipsComplete} championshipCoverage={`${historyHighlights.championshipYears} of ${completedYears.length} seasons verified · 2017–${completedThrough}`} wins={historyHighlights.wins} winsCoverage={historyHighlights.winsComplete ? `2017–${completedThrough} regular-season category wins · all completed seasons` : `2018–2024 recorded category wins · ESPN backfill: ${historyHighlights.winsYears}/${completedYears.length} seasons stored`}/>
          <div className="overview-columns"><section className="panel league-teams"><div className="panel-header"><div><p className="eyebrow">THE FRANCHISES</p><h2>Meet the league</h2></div><button className="text-button" onClick={() => navigate('teams')}>View all <Icon name="arrow" size={16}/></button></div><div className="team-list">{leagueData.teams.map(item => <button key={item.id} className="team-list-row" onClick={() => navigate('teams', item.id)}><TeamAvatar team={item}/><span className="team-row-name"><strong>{item.name}</strong><small>{managerLabel(item)}</small></span><span className="team-player-count">{leagueData.players.filter(player => player.teamId === item.id).length}<small>players</small></span><Icon name="arrow" size={17}/></button>)}</div></section>
            <div className="overview-side"><section className="panel next-move"><div className="panel-header"><div><p className="eyebrow">THE SEASON AHEAD</p><h2>From keepers to tip-off.</h2></div><span className="small-icon"><Icon name="keeper"/></span></div><p>Follow each step as the league gets ready for the next season.</p><div className="steps"><div><span>01</span><p>Check your eligible players<small>Cost, tenure, and keeper history</small></p></div><div><span>02</span><p>Match players to your picks<small>You decide which pick goes where</small></p></div><div><span>03</span><p>Submit for review<small>Save privately, then send to the commissioner</small></p></div></div><p className="overview-process-note">After every submission is locked, keepers are revealed and the draft room opens for selections.</p></section><section className="snapshot-note"><span className="note-icon"><Icon name="clock"/></span><div><strong>A new home for the league’s history.</strong><p>Imported records are available to explore. Items needing a commissioner’s ruling stay clearly marked.</p><button className="text-button" disabled={!account.commissioner} onClick={() => navigate('commissioner')}>{leagueData.reviewItems.length} items to reconcile <Icon name="arrow" size={15}/></button></div></section></div></div>
          <section className="panel"><div className="panel-header"><div><p className="eyebrow">FROM THE TRADE LOG</p><h2>The deals live on.</h2></div><button className="text-button" onClick={() => navigate('trades')}>Open trade log <Icon name="arrow" size={16}/></button></div><div className="recent-trades">{leagueData.trades.slice(-3).reverse().map(trade => <div className="recent-trade" key={trade.id}><span className="trade-number">#{trade.id}</span><div><strong>{trade.parties.join(' ↔ ') || 'Historical trade'}</strong><p>{trade.summary}</p></div><Status status={trade.status}/></div>)}</div></section>
        </>}

        {(view === 'teams' || myTeamView) && <>
          {view === 'teams' && <PageTitle eyebrow="THE FRANCHISES" title="Teams & players" description="A place for every roster, every keeper cost, and every future pick."/>}
          {(view === 'teams' || account.ownTeamIds.length > 1) && <div className="team-tabs" aria-label="Select a team">{leagueData.teams.filter(item => view === 'teams' || account.ownTeamIds.includes(item.id)).map(item => <button key={item.id} className={'team-tab' + (item.id === activeTeam && !allTeams ? ' selected' : '')} aria-pressed={item.id === activeTeam && !allTeams} onClick={() => changeTeam(item.id)}><TeamAvatar team={item} small/><span>{item.name}</span></button>)}</div>}
          {team && !allTeams && <section className="team-feature"><TeamAvatar team={team}/><div><p className="eyebrow">FRANCHISE PROFILE</p><h2>{team.name}</h2><p>{managerLabel(team)}</p></div><div className="team-feature-stat"><strong>{teamPlayers.length}</strong><span>roster players</span></div><div className="team-feature-stat"><strong>{ownedPicks.length}</strong><span>{leagueData.season} picks</span></div><button className="button button-green" onClick={() => navigate('keepers')}>Plan keepers <Icon name="arrow" size={17}/></button></section>}
          <section className={`panel ${rosterStyles.rosterPanel}`}><div className="panel-header flexible-header"><div><p className="eyebrow">ROSTER SNAPSHOT</p><h2>{allTeams ? 'The entire player pool' : 'The roster'}</h2></div><div className="filter-controls">{view === 'teams' && <label className="check-label"><input type="checkbox" checked={allTeams} onChange={event => setAllTeams(event.target.checked)}/> All teams</label>}<SearchInput value={search} onChange={setSearch} placeholder="Find a player…" label="Search roster players"/></div></div><div className="filter-summary" aria-live="polite"><span>{rosterPlayers.length} {rosterPlayers.length === 1 ? 'player' : 'players'}{search ? ` matching “${search}”` : ''}</span>{(search || allTeams || location.sort.column !== 'player' || location.sort.direction !== 'ascending') && <button className="text-button" onClick={() => location.update({ roster: null, all: null, sort: null })}>Reset filters</button>}</div><PlayerTable players={rosterPlayers} showTeam={allTeams} compact sort={location.sort} setSort={sort => location.update({ sort: `${sort.column}:${sort.direction}` })}/></section>
          {!allTeams && <TeamPickInventory account={account} teamId={activeTeam}/>}
        </>}

        {view === 'keepers' && <>
          <PageTitle eyebrow="BUILD FOR NEXT SEASON" title="Your keeper gameplan." description="Choose your players. Assign your picks. See how it all fits."/>
          <div className="info-banner"><Icon name="lock"/><p>{account.connection === 'live' && account.canManageTeam(activeTeam) ? <><strong>Private keeper workspace.</strong> Save your draft, then submit it for commissioner review. Your selections stay hidden from other teams until every submission is locked.</> : <><strong>Private planning preview.</strong> Selections stay in this page session and are not submitted or published. Official controls appear when you sign in and select a team you currently manage.</>}</p></div>
          <div className="planner-controls"><label className="field-label">Preview a roster<select value={activeTeam} onChange={event => changeTeam(Number(event.target.value))}>{leagueData.teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>Nominal keeper costs progress independently of the pick you spend.</p></div>
          <div className="planner-layout"><section className={`panel ${keeperPoolStyles.pool}`}><div className="panel-header"><div><p className="eyebrow">STEP 01 · SELECT & ASSIGN</p><h2>{team?.shortName} keeper pool</h2></div><span className="small muted">{teamPlayers.filter(player => player.status === 'eligible').length} eligible</span></div><div className="keeper-list">{teamPlayers.map(player => { const assignment = assignments.find(item => item.playerId === player.id); const permitted = ownedPicks.filter(pick => player.baseCost !== null && pick.round <= player.baseCost); return <div className={'keeper-row' + (assignment ? ' keeper-selected' : '') + (player.status !== 'eligible' ? ' keeper-unavailable' : '')} key={player.id}><div className="keeper-selection"><label className="keeper-checkbox"><input type="checkbox" checked={Boolean(assignment)} disabled={player.status !== 'eligible'} onChange={() => togglePlayer(player)} aria-label={'Select ' + player.name + ' as a keeper'}/><span><strong>{player.name}</strong><small>{player.baseCost ? 'Round ' + player.baseCost + ' base cost' : player.status === 'ineligible' ? 'No eligible keeper cost' : 'Cost needs review'}<span className="divider-dot">·</span>{player.tenure === null ? 'Tenure needs review' : 'Tenure ' + player.tenure + ' of 5'}</small></span></label><Status status={player.status}/></div>{assignment && <div className="pick-assignment"><label htmlFor={'pick-' + player.id}>Spend this pick</label><select id={'pick-' + player.id} value={assignment.pickId} onChange={event => updateAssignments(assignments.map(item => item.playerId === player.id ? { ...item, pickId: event.target.value } : item))}><option value="">Choose a pick</option>{permitted.map(pick => <option value={pick.id} key={pick.id}>Round {pick.round} · originally {leagueData.teams.find(item => item.id === pick.originalTeamId)?.shortName}{assignments.some(item => item.playerId !== player.id && item.pickId === pick.id) ? ' · already assigned' : ''}</option>)}</select><small>Next season’s base cost: {player.tenure !== null && player.tenure >= 4 ? 'not eligible (five-year limit)' : player.baseCost && player.baseCost > 1 ? 'round ' + (player.baseCost - 1) : 'not eligible'}.</small></div>}{player.status !== 'eligible' && <details className={keeperPoolStyles.reason}><summary aria-label={'Keeper eligibility details for ' + player.name}>Details</summary><p>{player.reason}</p></details>}</div>; })}</div></section>
            <aside className="planner-summary"><div className="summary-top"><span className="hero-kicker">YOUR LOCAL DRAFT</span><h2>The keeper list.</h2><p>Make every round count.</p></div><div className="summary-metrics"><div><strong>{assignments.length}</strong><span>keepers selected</span></div><div><strong>{ownedPicks.length - new Set(assignments.filter(item => item.pickId).map(item => item.pickId)).size}</strong><span>picks remaining</span></div></div><div className="summary-players">{assignments.length === 0 ? <p className="summary-empty">Your list starts here.<br/>Select a player to plan your first keeper.</p> : assignments.map(item => <div key={item.playerId}><span>{leagueData.players.find(player => player.id === item.playerId)?.name}</span><strong>{ownedPicks.find(pick => pick.id === item.pickId) ? 'R' + ownedPicks.find(pick => pick.id === item.pickId)?.round : '—'}</strong></div>)}</div>{assignments.length > 0 && <div className={'validation-box' + (plannerErrors.length ? ' validation-errors' : '')} role="status">{plannerErrors.length ? <><strong>Adjust before submitting</strong><ul>{plannerErrors.map((error, index) => <li key={index}>{error}</li>)}</ul></> : <><Icon name="check" size={17}/><span>These selections pass the current keeper rules.</span></>}</div>}<div className="summary-actions"><button className="button button-orange full-width" onClick={() => setPlannerNotice(assignments.length === 0 ? 'No keepers selected. An empty keeper list can be saved and submitted through the official controls.' : plannerErrors.length ? 'This plan needs the adjustments listed above.' : 'Your plan passes the current checks. It remains a local preview; nothing has been submitted.')}><Icon name="check" size={17}/> Check my plan</button><button className="text-button" disabled={!assignments.length} onClick={() => updateAssignments([])}>Clear selections</button><p className="small" aria-live="polite">{plannerNotice || 'Your changes stay in this page until you save an official private draft.'}</p></div><OfficialKeeperControls account={account} teamId={activeTeam} draft={draft} onLoad={loadAssignments} onSaved={acceptSavedRevision} errors={plannerErrors}/></aside></div>
          <div className="rule-cards"><div><span>01</span><h3>Your cost follows the player.</h3><p>Spending an earlier pick does not accelerate next year’s base cost.</p></div><div><span>02</span><h3>The required round comes first.</h3><p>Use an earlier round only when no pick in the required round is available.</p></div><div><span>03</span><h3>Five years is the limit.</h3><p>The original drafted season counts toward the player’s keeper tenure.</p></div></div>
        </>}

        {view === 'draft' && <>
          <PageTitle eyebrow="ON THE CLOCK" title="The draft room." description="Follow the live draft, trace your picks, or revisit past seasons."/>
          <nav className="draft-view-tabs" aria-label="Draft views">{([['live', 'Live draft'], ['ownership', 'Pick ownership'], ['archive', 'Archive']] as const).map(([mode, label]) => <a key={mode} href={location.href({ draftView: mode })} aria-current={draftView === mode ? 'page' : undefined} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); location.update({ draftView: mode, order: null }, false); }}>{label}</a>)}</nav>
          {draftView === 'live' && <LiveDraftBoard account={account} openOrderEditor={location.openOrderEditor}/>}
          {draftView === 'ownership' && <DraftPickGrids account={account} mode="current"/>}
          {draftView === 'archive' && <><section className="panel draft-archive"><div className="draft-toolbar"><label className="field-label">Historical draft<select value={draftYear} onChange={event => setDraftYear(event.target.value)}>{[...leagueData.drafts].sort((a, b) => b.year - a.year).map(draft => <option value={String(draft.year)} key={draft.year}>{draft.year} draft</option>)}</select></label><div className="draft-legend"><span><i className="legend-kept"/> Keeper</span><span><Icon name="draft" size={16}/> Snake order · scroll across for all teams</span></div></div><HistoricalBoard year={Number(draftYear)}/></section><DraftPickGrids account={account} mode="archive"/></>}
        </>}

        {view === 'trades' && <>
          <PageTitle eyebrow="THE RECEIPTS" title="Every saint has a past. Every sinner has a future." description="Players, picks, the occasional mule rights, and the coveted 3-team-trade."/>
          <TradeWorkspace key={`${account.session?.user?.id || 'guest'}:${account.commissioner}:${ownTeamKey}`} account={account}/>
          <div className="ledger-topline"><div className="ledger-stat"><strong>{leagueData.trades.length}</strong><span>historical trade records</span></div><SearchInput value={tradeSearch} onChange={setTradeSearch} placeholder="Search teams, players, or trade #…" label="Search trade log"/></div>
          <div className="info-banner"><Icon name="book"/><p><strong>The league’s original trade log, preserved.</strong> Written terms remain attached to every record. Complex obligations and ownership changes require reconciliation before they can drive live transactions.</p></div>
          <p className="filter-summary" aria-live="polite">{matchingTrades.length} of {leagueData.trades.length} historical records{tradeSearch ? ` matching “${tradeSearch}”` : ''}</p><section className="trade-ledger">{matchingTrades.map(trade => <details className={'trade-card' + (trade.status === 'voided' ? ' trade-voided' : '')} key={trade.id}><summary><span className="trade-number">#{trade.id}</span><span className="trade-card-body"><strong>{trade.parties.join(' ↔ ') || 'Historical trade'}</strong><span>{trade.summary || 'View original trade terms'}</span></span><Status status={trade.status}/><span className="details-plus" aria-hidden="true">+</span></summary><div className="trade-details"><p className="eyebrow">ORIGINAL TERMS & CONTEXT</p><p>{trade.notes || trade.summary}</p>{trade.status === 'voided' && <div className="void-note">This trade is marked voided in the source record. It is retained for historical visibility.</div>}</div></details>)}{matchingTrades.length === 0 && <div className="panel empty-state">No trades match this search.</div>}</section>
        </>}

        {view === 'lab' && <><EspnHistoryNotice history={espnHistory}/><LeagueAnalytics league={leagueData} playoffHistory={espnHistory.history}/></>}

        {view === 'charter' && <>
          <PageTitle eyebrow="THE WAY WE PLAY" title="The league charter." description="The rules behind the rivalries. Preserved for everyone in the league."/>
          <div className="charter-layout"><aside className="charter-index"><p className="eyebrow">IN THIS CHARTER</p>{leagueData.charter.map((section, index) => <a href={'#charter-' + index} key={index}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</a>)}</aside><div className="charter-content"><div className="charter-cover"><span className="hero-kicker">CROC BOIS FANTASY BASKETBALL</span><h2>A league of our own.</h2><p>Shared rules. Long memories. A lot of basketball.</p><Icon name="ball" size={68}/></div><div className="info-banner"><Icon name="book"/><p>Current rules summary with commissioner clarifications; the original historical charter is preserved in migration records. Unresolved questions appear in the review queue.</p></div>{leagueData.charter.map((section, index) => <section className="charter-section" id={'charter-' + index} key={index}><span className="section-number">{String(index + 1).padStart(2, '0')}</span><h2>{section.title}</h2>{section.paragraphs.map((paragraph, pIndex) => <p key={pIndex}>{paragraph}</p>)}</section>)}</div></div>
        </>}

        {view === 'commissioner' && account.commissioner && <>
          <PageTitle eyebrow="THE COMMISSIONER’S DESK" title="Commissioner Tools" description="League setup, the draft lottery, keeper reviews, and team access."/>
          <SeasonReadinessPanel account={account}/><CommissionerTeamAccess account={account}/><EspnHistorySyncPanel account={account} history={espnHistory}/><DraftLottery account={account}/><OfficialReviewPanel account={account}/><KeeperProfileReview account={account}/>
          <div className="info-banner"><Icon name="shield"/><p><strong>Read-only migration review.</strong> These are imported data questions, not private keeper submissions. Sign in and commissioner access are required before any official approval or correction can be recorded.</p></div>
          <div className="review-stats"><div><strong>{leagueData.reviewItems.length}</strong><span>items to reconcile</span></div><div><strong>{eligiblePlayers.length}</strong><span>players marked eligible</span></div><div><strong>{leagueData.players.filter(player => player.status === 'review').length}</strong><span>player records need review</span></div></div>
          <section className="panel review-list"><div className="panel-header"><div><p className="eyebrow">BEFORE THE OPENING TIP</p><h2>Reconciliation queue</h2></div><span className="muted small">Original records remain intact</span></div>{leagueData.reviewItems.map(item => <article className="review-item" key={item.id}><span className="review-item-icon"><Icon name="book"/></span><div><h3>{item.player}</h3><p>{item.detail}</p></div><Status status={item.status}/></article>)}{leagueData.reviewItems.length === 0 && <div className="empty-state">No reconciliation items in this snapshot.</div>}</section>
          <section className="setup-callout"><Icon name="lock" size={28}/><div><h2>{account.connection === 'live' ? 'League accounts are connected.' : 'The official league workflow comes next.'}</h2><p>{account.connection === 'live' ? 'Sign in with your assigned league account to save private keeper drafts. Commissioners can review, approve, return, and lock submitted selections above.' : 'Authenticated team access, hidden keeper submissions, commissioner locking, and trade review will connect here once the league services are configured.'}</p></div><AccountButton account={account} className="button button-green" label="Account setup"/></section>
        </>}
        <footer className="page-footer"><span><Icon name="ball" size={15}/> CROC BOIS FANTASY BASKETBALL</span><span>Roster snapshot: {leagueData.snapshotDate}{account.lastLeagueCheckedAt ? ` · League checked ${new Date(account.lastLeagueCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span></footer>
      </main>
    </div>
  </div></LeagueContext.Provider>;
}

function Stat({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: string }) {
  return <div className="stat-card"><div><span className="eyebrow">{label}</span><span className="stat-icon"><Icon name={icon}/></span></div><strong>{value.toLocaleString()}</strong><p>{detail}</p></div>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-intro">{description}</p></div></div>;
}

function SearchInput({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return <div className="search-input"><Icon name="search" size={18}/><input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label}/>{value && <button type="button" onClick={() => onChange('')} aria-label={`Clear ${label.toLowerCase()}`}>Clear</button>}</div>;
}

function HistoricalBoard({ year }: { year: number }) {
  const leagueData = useContext(LeagueContext);
  const draft = leagueData.drafts.find(item => item.year === year);
  if (!draft) return <div className="panel empty-state">This draft is not in the current archive.</div>;
  const firstRound = draft.selections.filter(item => item.round === 1).sort((a, b) => a.pick - b.pick);
  const count = firstRound.length || leagueData.teams.length;
  const rounds = [...new Set(draft.selections.map(item => item.round))].sort((a, b) => a - b);
  return <><div className="archive-note"><Icon name="clock" size={17}/> {year} historical draft · imported results · even rounds run right to left</div><div className="draft-scroll"><div className="draft-grid" style={{ '--draft-teams': count } as CSSProperties}><div className="draft-header round-heading">RD</div>{Array.from({ length: count }, (_, index) => <div className="draft-header historical-header" key={index}><span>SLOT {String(index + 1).padStart(2, '0')}</span><strong>{firstRound[index]?.originalOwner || firstRound[index]?.owner || '—'}</strong></div>)}{rounds.map(round => {
    const roundPicks = draft.selections.filter(item => item.round === round).sort((a, b) => a.pick - b.pick);
    const cells = Array.from({ length: count }, (_, index) => roundPicks[index]);
    if (round % 2 === 0) cells.reverse();
    return <div className="draft-grid-fragment" key={round}><div className="draft-round">{String(round).padStart(2, '0')}<small>{round % 2 === 0 ? '←' : '→'}</small></div>{cells.map((pick, index) => <div className={'draft-cell historical-cell' + (pick?.kept ? ' draft-cell-kept' : '')} key={index}>{pick ? <><span className="draft-pick-label">PICK {pick.pick}{pick.kept ? ' · KEEPER' : ''}</span><strong>{pick.player || 'Unrecorded'}</strong><small>{pick.owner || pick.originalOwner}</small>{pick.originalOwner !== pick.owner && pick.owner && <span className="draft-transfer-icon"><Icon name="trade" size={13}/></span>}</> : <span className="muted">—</span>}</div>)}</div>;
  })}</div></div></>;
}
