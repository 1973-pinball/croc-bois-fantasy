'use client';

import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { leagueData as previewData } from '@/lib/league-data';
import { validatePlanner } from '@/lib/planner';
import type { LeaguePlayer, Team } from '@/lib/types';
import { AccountButton, LeagueConnectionNotice, OfficialKeeperControls, OfficialReviewPanel, useLeagueAccount, type LeagueAccount } from './league-account';

const LeagueContext = createContext(previewData);

type View = 'overview' | 'teams' | 'keepers' | 'draft' | 'trades' | 'charter' | 'commissioner';
type Assignment = { playerId: number; pickId: string };
const navigation: { id: View; label: string; icon: string }[] = [
  { id: 'overview', label: 'League overview', icon: 'home' },
  { id: 'teams', label: 'Teams & players', icon: 'teams' },
  { id: 'keepers', label: 'Keeper planner', icon: 'keeper' },
  { id: 'draft', label: 'Draft board', icon: 'draft' },
  { id: 'trades', label: 'Trade ledger', icon: 'trade' },
  { id: 'charter', label: 'League charter', icon: 'book' },
];

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></>,
    teams: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
    keeper: <><path d="M6 3h12v18l-6-4-6 4Z"/><path d="m9 10 2 2 4-4"/></>,
    draft: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/></>,
    trade: <><path d="M4 7h15l-4-4M20 17H5l4 4M19 7l-4 4M5 17l4-4"/></>,
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
  return <svg className={large ? 'croc-mark croc-mark-large' : 'croc-mark'} viewBox="0 0 128 128" fill="none" aria-hidden="true">
    <circle cx="91" cy="82" r="22" fill="var(--orange)"/>
    <path d="M70 82h42M91 60v44M76 66c20 8 20 24 0 32M106 66c-20 8-20 24 0 32" stroke="var(--green)" strokeWidth="2.5"/>
    <path d="M18 68 24 49 37 43 39 32 50 39 64 31 69 41 82 40 100 55 100 65 63 68 69 76 48 85 29 78Z" fill="currentColor"/>
    <path d="m70 58 5 7 5-7 5 7 5-7" stroke="var(--green)" strokeWidth="3"/>
    <circle cx="57" cy="47" r="4" fill="var(--green)"/><path d="M29 63h23" stroke="var(--green)" strokeWidth="3" strokeLinecap="round"/>
  </svg>;
}

function TeamAvatar({ team, small = false }: { team: Team; small?: boolean }) {
  return <span className={'team-avatar' + (small ? ' small' : '')} style={{ '--team-color': team.color } as CSSProperties}>{team.shortName.slice(0, 3)}</span>;
}

function Status({ status }: { status: string }) {
  const label: Record<string, string> = { eligible: 'Eligible', ineligible: 'Ineligible', review: 'Needs review', recorded: 'Recorded', voided: 'Voided', provisional: 'Provisional', 'needs-review': 'Needs review' };
  return <span className={'status status-' + status}><span/>{label[status] || status}</span>;
}

function PlayerTable({ players, showTeam = false }: { players: LeaguePlayer[]; showTeam?: boolean }) {
  const leagueData = useContext(LeagueContext);
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>Player</th>{showTeam && <th>Team</th>}<th>Keeper cost</th><th>Tenure</th><th>Eligibility</th></tr></thead><tbody>
    {players.map(player => <tr key={player.id}><td><strong>{player.name}</strong><span className="cell-note">{player.wasKept ? 'Previously kept' : 'Roster player'}{player.rosterSlot ? ' · ' + player.rosterSlot : ''}</span></td>{showTeam && <td>{leagueData.teams.find(team => team.id === player.teamId)?.shortName || 'Unassigned'}</td>}<td><span className="round-label">{player.baseCost ? 'Round ' + player.baseCost : '—'}</span></td><td>{player.tenure === null ? '—' : player.tenure + ' / 5'}</td><td><Status status={player.status}/><span className="cell-note reason-note">{player.reason}</span></td></tr>)}
    {players.length === 0 && <tr><td colSpan={showTeam ? 5 : 4}><div className="empty-state">No players match this search.</div></td></tr>}
  </tbody></table></div>;
}

export function LeaguePortal() {
  const account = useLeagueAccount();
  const leagueData = account.data;
  const [view, setView] = useState<View>('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeTeam, setActiveTeam] = useState(leagueData.teams[0]?.id ?? 0);
  const [search, setSearch] = useState('');
  const [allTeams, setAllTeams] = useState(false);
  const [assignmentsByTeam, setAssignmentsByTeam] = useState<Record<number, Assignment[]>>({});
  const [plannerNotice, setPlannerNotice] = useState('');
  const [draftYear, setDraftYear] = useState('upcoming');
  const [tradeSearch, setTradeSearch] = useState('');
  const team = leagueData.teams.find(item => item.id === activeTeam) || leagueData.teams[0];
  const assignments = assignmentsByTeam[activeTeam] || [];
  const teamPlayers = leagueData.players.filter(player => player.teamId === activeTeam);
  const ownedPicks = leagueData.picks.filter(pick => pick.ownerTeamId === activeTeam && pick.season === leagueData.season).sort((a, b) => a.round - b.round);
  const eligiblePlayers = leagueData.players.filter(player => player.status === 'eligible');
  const plannerErrors = useMemo(() => validatePlanner(activeTeam, assignments, leagueData), [activeTeam, assignments, leagueData]);
  const heading = navigation.find(item => item.id === view)?.label || 'Commissioner review';

  useEffect(() => {
    if (!account.submissionsLoaded) return;
    setAssignmentsByTeam(previous => {
      const next = { ...previous };
      let changed = false;
      for (const item of leagueData.teams) {
        if (next[item.id] !== undefined || !account.canManageTeam(item.id)) continue;
        const submission = account.submissionFor(item.id);
        if (submission) { next[item.id] = account.toPlannerAssignments(submission); changed = true; }
      }
      return changed ? next : previous;
    });
  }, [account.submissionsLoaded, account.submissions, account.session, leagueData]);

  function navigate(next: View) { setView(next); setMobileOpen(false); setSearch(''); setPlannerNotice(''); }
  function changeTeam(id: number) { setActiveTeam(id); setPlannerNotice(''); }
  function updateAssignments(next: Assignment[]) { setAssignmentsByTeam(previous => ({ ...previous, [activeTeam]: next })); setPlannerNotice(''); }
  function togglePlayer(player: LeaguePlayer) {
    if (assignments.some(item => item.playerId === player.id)) { updateAssignments(assignments.filter(item => item.playerId !== player.id)); return; }
    const available = ownedPicks.filter(pick => !assignments.some(item => item.pickId === pick.id) && player.baseCost !== null && pick.round <= player.baseCost);
    const pick = [...available].sort((a, b) => b.round - a.round)[0];
    updateAssignments([...assignments, { playerId: player.id, pickId: pick?.id || '' }]);
  }

  return <LeagueContext.Provider value={leagueData}><div className="app-shell">
    <a href="#main-content" className="skip-link">Skip to content</a>
    <aside className={'sidebar' + (mobileOpen ? ' sidebar-open' : '')} aria-label="Main navigation">
      <button className="brand" onClick={() => navigate('overview')} aria-label="Croc Bois league overview"><span className="brand-mark"><CrocMark/></span><span className="brand-name">CROC BOIS<span>FANTASY BASKETBALL</span></span></button>
      <div className="sidebar-season"><span className="live-dot"/> THE LEAGUE OFFICE <span className="season-year">{leagueData.season}</span></div>
      <nav>{navigation.map(item => <button key={item.id} className={'nav-item' + (view === item.id ? ' active' : '')} onClick={() => navigate(item.id)} aria-current={view === item.id ? 'page' : undefined}><Icon name={item.icon}/><span>{item.label}</span>{view === item.id && <span className="nav-active-dot"/>}</button>)}<a className="nav-item" href="/audit"><Icon name="check"/><span>Keeper cost audit</span></a></nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><Icon name="ball" size={25}/><p>Built for the league.<br/><strong>Made for the long game.</strong></p></div><button className={'nav-item commissioner-link' + (view === 'commissioner' ? ' active' : '')} onClick={() => navigate('commissioner')} aria-current={view === 'commissioner' ? 'page' : undefined}><Icon name="shield"/><span>Commissioner review</span></button><div className="sidebar-footer">EST. 2017 <span>KEEP IT CROC.</span></div></div>
    </aside>
    {mobileOpen && <button className="nav-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation"/>}
    <div className="main-shell">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle navigation" aria-expanded={mobileOpen}><Icon name="menu"/></button><span className="topbar-league">CROC BOIS</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-current">{heading}</span></div><div className="topbar-right"><span className="public-label"><span/> Public league hub</span><AccountButton account={account}/></div></header>
      <main id="main-content" className="main-content"><LeagueConnectionNotice account={account}/>
        {view === 'overview' && <>
          <div className="page-heading"><div><p className="eyebrow">THE OFFICIAL LEAGUE HUB</p><h1>Welcome to the swamp.</h1><p className="page-intro">The players, the picks, and the deals that make this league ours.</p></div><span className="season-pill"><Icon name="ball" size={16}/> {leagueData.season} SEASON</span></div>
          <section className="hero-card" aria-labelledby="hero-title"><div className="hero-copy"><span className="hero-kicker"><span/> THE NEXT CHAPTER</span><h2 id="hero-title">Dynasties aren’t built<br/>in a single season.</h2><p>Know what you own. Plan who you keep.<br/>Make your next move count.</p><button className="button button-orange" onClick={() => navigate('keepers')}>Open keeper planner <Icon name="arrow" size={18}/></button></div><div className="hero-art" aria-hidden="true"><div className="court-arc arc-one"/><div className="court-arc arc-two"/><div className="court-line"/><div className="hero-emblem"><CrocMark large/><span>CROC BOIS</span><small>FANTASY BASKETBALL CLUB</small></div><span className="hero-art-year">EST. 2017</span></div></section>
          <section className="stats-grid" aria-label="League at a glance"><Stat label="FRANCHISES" value={leagueData.teams.length} detail="One very competitive league" icon="teams"/><Stat label="ROSTERED PLAYERS" value={leagueData.players.length} detail="From the imported league snapshot" icon="ball"/><Stat label="DRAFT PICKS" value={leagueData.picks.filter(pick => pick.season === leagueData.season).length} detail="13 rounds. Every pick has a story." icon="draft"/><Stat label="TRADES IN THE ARCHIVE" value={leagueData.trades.length} detail="History, including voided records" icon="trade"/></section>
          <div className="overview-columns"><section className="panel league-teams"><div className="panel-header"><div><p className="eyebrow">THE FRANCHISES</p><h2>Meet the league</h2></div><button className="text-button" onClick={() => navigate('teams')}>View all <Icon name="arrow" size={16}/></button></div><div className="team-list">{leagueData.teams.map(item => <button key={item.id} className="team-list-row" onClick={() => { changeTeam(item.id); navigate('teams'); }}><TeamAvatar team={item}/><span className="team-row-name"><strong>{item.name}</strong><small>{item.managers.join(' · ') || item.owner}</small></span><span className="team-player-count">{leagueData.players.filter(player => player.teamId === item.id).length}<small>players</small></span><Icon name="arrow" size={17}/></button>)}</div></section>
            <div className="overview-side"><section className="panel next-move"><div className="panel-header"><div><p className="eyebrow">YOUR NEXT MOVE</p><h2>A little offseason homework.</h2></div><span className="small-icon"><Icon name="keeper"/></span></div><p>Explore your roster’s keeper costs and see how your picks fit together.</p><div className="steps"><div><span>01</span><p>Check your eligible players<small>Cost, tenure, and keeper history</small></p></div><div><span>02</span><p>Match players to your picks<small>You decide which pick goes where</small></p></div><div><span>03</span><p>Review before the deadline<small>Official submission opens after setup</small></p></div></div><button className="button button-green full-width" onClick={() => navigate('keepers')}>Plan my keepers <Icon name="arrow" size={17}/></button></section><section className="snapshot-note"><span className="note-icon"><Icon name="clock"/></span><div><strong>A new home for the league’s history.</strong><p>Imported records are available to explore. Items needing a commissioner’s ruling stay clearly marked.</p><button className="text-button" onClick={() => navigate('commissioner')}>{leagueData.reviewItems.length} items to reconcile <Icon name="arrow" size={15}/></button></div></section></div></div>
          <section className="panel"><div className="panel-header"><div><p className="eyebrow">FROM THE LEDGER</p><h2>The deals live on.</h2></div><button className="text-button" onClick={() => navigate('trades')}>Open trade archive <Icon name="arrow" size={16}/></button></div><div className="recent-trades">{leagueData.trades.slice(-3).reverse().map(trade => <div className="recent-trade" key={trade.id}><span className="trade-number">#{trade.id}</span><div><strong>{trade.parties.join(' ↔ ') || 'Historical trade'}</strong><p>{trade.summary}</p></div><Status status={trade.status}/></div>)}</div></section>
        </>}

        {view === 'teams' && <>
          <PageTitle eyebrow="THE FRANCHISES" title="Teams & players" description="A place for every roster, every keeper cost, and every future pick."/>
          <div className="team-tabs" aria-label="Select a team">{leagueData.teams.map(item => <button key={item.id} className={'team-tab' + (item.id === activeTeam && !allTeams ? ' selected' : '')} onClick={() => { changeTeam(item.id); setAllTeams(false); }}><TeamAvatar team={item} small/><span>{item.shortName}</span></button>)}</div>
          {team && !allTeams && <section className="team-feature"><TeamAvatar team={team}/><div><p className="eyebrow">FRANCHISE PROFILE</p><h2>{team.name}</h2><p>{team.managers.join(' · ') || team.owner}</p></div><div className="team-feature-stat"><strong>{teamPlayers.length}</strong><span>roster players</span></div><div className="team-feature-stat"><strong>{ownedPicks.length}</strong><span>{leagueData.season} picks</span></div><button className="button button-green" onClick={() => navigate('keepers')}>Plan keepers <Icon name="arrow" size={17}/></button></section>}
          <section className="panel"><div className="panel-header flexible-header"><div><p className="eyebrow">ROSTER SNAPSHOT</p><h2>{allTeams ? 'The entire player pool' : 'The roster'}</h2></div><div className="filter-controls"><label className="check-label"><input type="checkbox" checked={allTeams} onChange={event => setAllTeams(event.target.checked)}/> All teams</label><SearchInput value={search} onChange={setSearch} placeholder="Find a player…" label="Search roster players"/></div></div><PlayerTable players={leagueData.players.filter(player => (allTeams || player.teamId === activeTeam) && player.name.toLowerCase().includes(search.toLowerCase()))} showTeam={allTeams}/></section>
          {!allTeams && <section className="panel"><div className="panel-header"><div><p className="eyebrow">PICK INVENTORY</p><h2>{leagueData.season} draft capital</h2></div><span className="muted small">Original franchise stays with each pick</span></div><div className="pick-inventory">{ownedPicks.map(pick => <div className="inventory-pick" key={pick.id}><span>ROUND</span><strong>{String(pick.round).padStart(2, '0')}</strong><small>via {leagueData.teams.find(item => item.id === pick.originalTeamId)?.shortName || 'Unknown'}</small></div>)}{ownedPicks.length === 0 && <p className="empty-state">No picks in this season’s imported inventory.</p>}</div></section>}
        </>}

        {view === 'keepers' && <>
          <PageTitle eyebrow="BUILD FOR NEXT SEASON" title="Your keeper game plan." description="Choose your players. Assign your picks. See how it all fits."/>
          <div className="info-banner"><Icon name="lock"/><p>{account.connection === 'live' && account.canManageTeam(activeTeam) ? <><strong>Private keeper workspace.</strong> Save your draft, then submit it for commissioner review. Your selections stay hidden from other teams until every submission is locked.</> : <><strong>Private planning preview.</strong> Selections stay in this page session and are not submitted or published. Official controls appear when you sign in and select a team you currently manage.</>}</p></div>
          <div className="planner-controls"><label className="field-label">Preview a roster<select value={activeTeam} onChange={event => changeTeam(Number(event.target.value))}>{leagueData.teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><p>Nominal keeper costs progress independently of the pick you spend.</p></div>
          <div className="planner-layout"><section className="panel"><div className="panel-header"><div><p className="eyebrow">STEP 01 · SELECT & ASSIGN</p><h2>{team?.shortName} keeper pool</h2></div><span className="small muted">{teamPlayers.filter(player => player.status === 'eligible').length} eligible</span></div><div className="keeper-list">{teamPlayers.map(player => { const assignment = assignments.find(item => item.playerId === player.id); const permitted = ownedPicks.filter(pick => player.baseCost !== null && pick.round <= player.baseCost); return <div className={'keeper-row' + (assignment ? ' keeper-selected' : '') + (player.status !== 'eligible' ? ' keeper-unavailable' : '')} key={player.id}><div className="keeper-selection"><label className="keeper-checkbox"><input type="checkbox" checked={Boolean(assignment)} disabled={player.status !== 'eligible'} onChange={() => togglePlayer(player)} aria-label={'Select ' + player.name + ' as a keeper'}/><span><strong>{player.name}</strong><small>{player.baseCost ? 'Round ' + player.baseCost + ' base cost' : player.status === 'ineligible' ? 'No eligible keeper cost' : 'Cost needs review'}<span className="divider-dot">·</span>{player.tenure === null ? 'Tenure needs review' : 'Tenure ' + player.tenure + ' of 5'}</small></span></label><Status status={player.status}/></div>{assignment && <div className="pick-assignment"><label htmlFor={'pick-' + player.id}>Spend this pick</label><select id={'pick-' + player.id} value={assignment.pickId} onChange={event => updateAssignments(assignments.map(item => item.playerId === player.id ? { ...item, pickId: event.target.value } : item))}><option value="">Choose a pick</option>{permitted.map(pick => <option value={pick.id} key={pick.id}>Round {pick.round} · originally {leagueData.teams.find(item => item.id === pick.originalTeamId)?.shortName}{assignments.some(item => item.playerId !== player.id && item.pickId === pick.id) ? ' · already assigned' : ''}</option>)}</select><small>Next season’s base cost: {player.tenure !== null && player.tenure >= 4 ? 'not eligible (five-year limit)' : player.baseCost && player.baseCost > 1 ? 'round ' + (player.baseCost - 1) : 'not eligible'}.</small></div>}{player.status !== 'eligible' && <p className="keeper-reason">{player.reason}</p>}</div>; })}</div></section>
            <aside className="planner-summary"><div className="summary-top"><span className="hero-kicker">YOUR LOCAL DRAFT</span><h2>The keeper list.</h2><p>Make every round count.</p></div><div className="summary-metrics"><div><strong>{assignments.length}</strong><span>keepers selected</span></div><div><strong>{ownedPicks.length - new Set(assignments.filter(item => item.pickId).map(item => item.pickId)).size}</strong><span>picks remaining</span></div></div><div className="summary-players">{assignments.length === 0 ? <p className="summary-empty">Your list starts here.<br/>Select a player to plan your first keeper.</p> : assignments.map(item => <div key={item.playerId}><span>{leagueData.players.find(player => player.id === item.playerId)?.name}</span><strong>{ownedPicks.find(pick => pick.id === item.pickId) ? 'R' + ownedPicks.find(pick => pick.id === item.pickId)?.round : '—'}</strong></div>)}</div>{assignments.length > 0 && <div className={'validation-box' + (plannerErrors.length ? ' validation-errors' : '')} role="status">{plannerErrors.length ? <><strong>Adjust before submitting</strong><ul>{plannerErrors.map((error, index) => <li key={index}>{error}</li>)}</ul></> : <><Icon name="check" size={17}/><span>These selections pass the current keeper rules.</span></>}</div>}<div className="summary-actions"><button className="button button-orange full-width" onClick={() => setPlannerNotice(assignments.length === 0 ? 'No keepers selected. An empty keeper list can be saved and submitted through the official controls.' : plannerErrors.length ? 'This plan needs the adjustments listed above.' : 'Your plan passes the current checks. It remains a local preview; nothing has been submitted.')}><Icon name="check" size={17}/> Check my plan</button><button className="text-button" disabled={!assignments.length} onClick={() => updateAssignments([])}>Clear selections</button><p className="small" aria-live="polite">{plannerNotice || 'Your changes stay in this page until you save an official private draft.'}</p></div><OfficialKeeperControls account={account} teamId={activeTeam} assignments={assignments} onLoad={updateAssignments} errors={plannerErrors}/></aside></div>
          <div className="rule-cards"><div><span>01</span><h3>Your cost follows the player.</h3><p>Spending an earlier pick does not accelerate next year’s base cost.</p></div><div><span>02</span><h3>The required round comes first.</h3><p>Use an earlier round only when no pick in the required round is available.</p></div><div><span>03</span><h3>Five years is the limit.</h3><p>The original drafted season counts toward the player’s keeper tenure.</p></div></div>
        </>}

        {view === 'draft' && <>
          <PageTitle eyebrow="ON THE CLOCK" title="The draft room." description="Follow the picks from their original franchise to their next chapter."/>
          <div className="draft-toolbar"><div className="field-label">Season<select aria-label="Select draft season" value={draftYear} onChange={event => setDraftYear(event.target.value)}><option value="upcoming">{leagueData.season} · pick ownership</option>{[...leagueData.drafts].sort((a, b) => b.year - a.year).map(draft => <option value={String(draft.year)} key={draft.year}>{draft.year} · historical draft</option>)}</select></div><div className="draft-legend"><span><i className="legend-kept"/> Keeper</span><span><i className="legend-traded"/> Changed owner</span><span><Icon name="draft" size={16}/> 13 rounds · snake draft</span></div></div>
          {draftYear === 'upcoming' ? <UpcomingDraftBoard account={account}/> : <HistoricalBoard year={Number(draftYear)}/>}
        </>}

        {view === 'trades' && <>
          <PageTitle eyebrow="THE RECEIPTS" title="Every deal has a story." description="Players, picks, promises, and the occasional very complicated arrangement."/>
          <div className="ledger-topline"><div className="ledger-stat"><strong>{leagueData.trades.length}</strong><span>historical trade records</span></div><SearchInput value={tradeSearch} onChange={setTradeSearch} placeholder="Search teams, players, or trade #…" label="Search trade ledger"/></div>
          <div className="info-banner"><Icon name="book"/><p><strong>The league’s original ledger, preserved.</strong> Written terms remain attached to every record. Complex obligations and ownership changes require reconciliation before they can drive live transactions.</p></div>
          <section className="trade-ledger">{[...leagueData.trades].reverse().filter(trade => (trade.id + ' ' + trade.parties.join(' ') + ' ' + trade.summary + ' ' + trade.notes).toLowerCase().includes(tradeSearch.toLowerCase())).map(trade => <details className={'trade-card' + (trade.status === 'voided' ? ' trade-voided' : '')} key={trade.id}><summary><span className="trade-number">#{trade.id}</span><span className="trade-card-body"><strong>{trade.parties.join(' ↔ ') || 'Historical trade'}</strong><span>{trade.summary || 'View original trade terms'}</span></span><Status status={trade.status}/><span className="details-plus" aria-hidden="true">+</span></summary><div className="trade-details"><p className="eyebrow">ORIGINAL TERMS & CONTEXT</p><p>{trade.notes || trade.summary}</p>{trade.status === 'voided' && <div className="void-note">This trade is marked voided in the source record. It is retained for historical visibility.</div>}</div></details>)}{!leagueData.trades.some(trade => (trade.id + ' ' + trade.parties.join(' ') + ' ' + trade.summary + ' ' + trade.notes).toLowerCase().includes(tradeSearch.toLowerCase())) && <div className="panel empty-state">No trades match this search.</div>}</section>
        </>}

        {view === 'charter' && <>
          <PageTitle eyebrow="THE WAY WE PLAY" title="The league charter." description="The rules behind the rivalries. Preserved for everyone in the league."/>
          <div className="charter-layout"><aside className="charter-index"><p className="eyebrow">IN THIS CHARTER</p>{leagueData.charter.map((section, index) => <a href={'#charter-' + index} key={index}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</a>)}</aside><div className="charter-content"><div className="charter-cover"><span className="hero-kicker">CROC BOIS FANTASY BASKETBALL</span><h2>A league of our own.</h2><p>Shared rules. Long memories. A lot of basketball.</p><Icon name="ball" size={68}/></div><div className="info-banner"><Icon name="book"/><p>Current rules summary with commissioner clarifications; the original historical charter is preserved in migration records. Unresolved questions appear in the review queue.</p></div>{leagueData.charter.map((section, index) => <section className="charter-section" id={'charter-' + index} key={index}><span className="section-number">{String(index + 1).padStart(2, '0')}</span><h2>{section.title}</h2>{section.paragraphs.map((paragraph, pIndex) => <p key={pIndex}>{paragraph}</p>)}</section>)}</div></div>
        </>}

        {view === 'commissioner' && <>
          <PageTitle eyebrow="THE COMMISSIONER’S DESK" title="Get the details right." description="A transparent review queue for the records that need a closer look."/><OfficialReviewPanel account={account}/>
          <div className="info-banner"><Icon name="shield"/><p><strong>Read-only migration review.</strong> These are imported data questions, not private keeper submissions. Sign in and commissioner access are required before any official approval or correction can be recorded.</p></div>
          <div className="review-stats"><div><strong>{leagueData.reviewItems.length}</strong><span>items to reconcile</span></div><div><strong>{eligiblePlayers.length}</strong><span>players marked eligible</span></div><div><strong>{leagueData.players.filter(player => player.status === 'review').length}</strong><span>player records need review</span></div></div>
          <section className="panel review-list"><div className="panel-header"><div><p className="eyebrow">BEFORE THE OPENING TIP</p><h2>Reconciliation queue</h2></div><span className="muted small">Original records remain intact</span></div>{leagueData.reviewItems.map(item => <article className="review-item" key={item.id}><span className="review-item-icon"><Icon name="book"/></span><div><h3>{item.player}</h3><p>{item.detail}</p></div><Status status={item.status}/></article>)}{leagueData.reviewItems.length === 0 && <div className="empty-state">No reconciliation items in this snapshot.</div>}</section>
          <section className="setup-callout"><Icon name="lock" size={28}/><div><h2>{account.connection === 'live' ? 'League accounts are connected.' : 'The official league workflow comes next.'}</h2><p>{account.connection === 'live' ? 'Sign in with your assigned league account to save private keeper drafts. Commissioners can review, approve, return, and lock submitted selections above.' : 'Authenticated team access, hidden keeper submissions, commissioner locking, and trade review will connect here once the league services are configured.'}</p></div><AccountButton account={account} className="button button-green" label="Account setup"/></section>
        </>}
        <footer className="page-footer"><span><Icon name="ball" size={15}/> CROC BOIS FANTASY BASKETBALL</span><span>{account.connection === 'live' ? 'Live league records' : 'Historical snapshot'} · {leagueData.snapshotDate}</span></footer>
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
  return <label className="search-input"><Icon name="search" size={18}/><input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={label}/></label>;
}

function UpcomingDraftBoard({ account }: { account: LeagueAccount }) {
  const leagueData = account.data;
  const order = account.live?.draftOrder || [];
  const orderedTeams = order.map(id => leagueData.teams.find(team => team.id === id)).filter((team): team is Team => Boolean(team));
  const hasOrder = orderedTeams.length === leagueData.teams.length && new Set(order).size === leagueData.teams.length;
  const teams = hasOrder ? orderedTeams : leagueData.teams;
  return <><div className="info-banner"><Icon name={hasOrder ? 'draft' : 'clock'}/><p>{hasOrder ? <><strong>Published snake order.</strong> Odd rounds run left to right; even rounds run right to left. Keeper selections appear only after the league reveal.</> : <><strong>Pick ownership, before the lottery.</strong> Columns show original franchises, not draft positions. The final snake order follows the lottery and each owner’s position choice.</>}</p></div><div className="draft-scroll"><div className="draft-grid" style={{ '--draft-teams': teams.length } as CSSProperties}><div className="draft-header round-heading">RD</div>{teams.map((team, index) => <div className="draft-header" key={team.id}><TeamAvatar team={team} small/><strong>{hasOrder ? String(index + 1) + ' · ' : ''}{team.shortName}</strong></div>)}{Array.from({ length: 13 }, (_, index) => index + 1).map(round => <div className="draft-grid-fragment" key={round}><div className="draft-round">{String(round).padStart(2, '0')}{hasOrder && <small>{round % 2 === 0 ? '←' : '→'}</small>}</div>{teams.map((originalTeam, index) => {
    const pick = leagueData.picks.find(item => item.season === leagueData.season && item.round === round && item.originalTeamId === originalTeam.id);
    const owner = leagueData.teams.find(item => item.id === pick?.ownerTeamId);
    const keeper = account.live?.keepersRevealedAt ? account.live.revealedKeepers.find(item => item.pickId === pick?.id) : undefined;
    const player = keeper && leagueData.players.find(item => item.id === keeper.playerId);
    const traded = owner && owner.id !== originalTeam.id;
    const number = (round - 1) * teams.length + (round % 2 === 0 ? teams.length - index : index + 1);
    return <div className={'draft-cell' + (traded ? ' draft-cell-traded' : '') + (keeper ? ' draft-cell-kept' : '')} key={originalTeam.id}><span className="draft-pick-label">{hasOrder ? 'PICK ' + number : 'ROUND ' + round}{keeper ? ' · KEEPER' : ''}</span><strong>{keeper ? player?.name || 'Confirmed keeper' : owner?.shortName || 'Unconfirmed'}</strong><small>{keeper ? owner?.shortName : traded ? 'via ' + originalTeam.shortName : pick && account.live?.usedPickIds?.includes(pick.id) ? 'Pick used' : 'Own pick'}</small>{traded && <span className="draft-transfer-icon"><Icon name="trade" size={13}/></span>}</div>;
  })}</div>)}</div></div></>;
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
