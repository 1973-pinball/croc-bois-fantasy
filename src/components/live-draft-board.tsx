'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import catalogFile from '../../data/draft-player-catalog.json';
import { draftBoardSchema, draftOverallPick, type DraftAction, type DraftBoard } from '@/lib/draft-board';
import { draftLotterySchema } from '@/lib/draft-lottery';
import type { DraftPlayerCatalog } from '@/lib/draft-player-catalog';
import { franchiseColorStyle } from '@/lib/franchise-colors';
import { assignDraftSlot, readDraftShortlist } from '@/lib/draft-workspace';
import type { LeagueAccount } from './league-account';
import { DraftRosters } from './draft-rosters';
import styles from './live-draft-board.module.css';

const catalog = catalogFile as DraftPlayerCatalog;
const rankedPlayers = [...catalog.players].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));
const catalogIds = new Set(catalog.players.map(player => player.id));
const catalogById = new Map(catalog.players.map(player => [player.id, player]));
type Selection = { playerId: number; pickId: string; revision: number };
type OrderDraft = { revision: number; ids: string[]; note: string; source: { id: string; drawnAt: string; ids: string[] } | null };

function DraftOrderEditor({ board, account, busy, publish, open = false }: { board: DraftBoard; account: LeagueAccount; busy: boolean; publish: (draft: OrderDraft) => Promise<boolean>; open?: boolean }) {
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const draftRef = useRef<OrderDraft | null>(null);
  const loadingRef = useRef(false);
  const boardRef = useRef(board);
  boardRef.current = board;
  const requestRef = useRef<AbortController | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const commissioner = Boolean(account.session?.user && account.commissioner && account.connection === 'live');
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!open || !detailsRef.current) return;
    detailsRef.current.open = true;
    detailsRef.current.querySelector('summary')?.focus();
    detailsRef.current.scrollIntoView({ block: 'center' });
  }, [open]);

  function accept(next: OrderDraft | null) { draftRef.current = next; setDraft(next); }
  function fromBoard(current: DraftBoard): OrderDraft {
    return { revision: current.revision, ids: [...current.teams].sort((a, b) => (a.draftPosition ?? Infinity) - (b.draftPosition ?? Infinity)).map(team => current.orderComplete ? team.franchiseId : ''), note: '', source: null };
  }
  async function initialize() {
    if (!commissioner || loadingRef.current || draftRef.current) return;
    setLoadError('');
    if (boardRef.current.orderComplete) { accept(fromBoard(boardRef.current)); return; }
    const controller = new AbortController(); requestRef.current = controller;
    loadingRef.current = true; setLoading(true);
    let nextSource: { id: string; drawnAt: string; ids: string[] } | null = null;
    try {
      const response = await fetch('/api/draft-lottery?seasonId=' + encodeURIComponent(board.seasonId), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) void account.reloadSession();
        throw new Error(body?.message || 'The saved lottery could not be loaded. Enter the order manually.');
      }
      const parsed = draftLotterySchema.safeParse(body?.lottery);
      if (!parsed.success || parsed.data.seasonId !== board.seasonId) throw new Error('The lottery response could not be verified. Enter the order manually.');
      if (parsed.data.result) {
        const result = parsed.data.result;
        const participants = new Set(boardRef.current.teams.map(team => team.franchiseId));
        if (result.priorityOrder.length !== 8 || participants.size !== 8 || new Set(result.priorityOrder).size !== 8 || result.priorityOrder.some(id => !participants.has(id))) throw new Error('The saved lottery does not match all eight participating teams. Enter the order manually.');
        nextSource = { id: result.id, drawnAt: result.drawnAt, ids: [...result.priorityOrder] };
      } else if (parsed.data.hasRun) throw new Error('The saved lottery result is unavailable for this account. Enter the order manually.');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setLoadError(failure instanceof Error ? failure.message : 'The saved lottery could not be loaded. Enter the order manually.');
    } finally {
      if (!controller.signal.aborted) {
        const current = boardRef.current;
        // No fields are editable before this first read resolves. Polls and later opens
        // never replace an accepted draft; published slots always win on initialization.
        if (!draftRef.current) accept({ ...fromBoard(current), source: current.orderComplete ? null : nextSource });
        loadingRef.current = false; setLoading(false);
      }
    }
  }
  const stale = Boolean(draft && draft.revision !== board.revision);
  const valid = Boolean(draft && draft.note.trim().length >= 5 && draft.ids.length === board.teams.length && new Set(draft.ids).size === board.teams.length && draft.ids.every(id => board.teams.some(team => team.franchiseId === id)));
  const locked = busy || board.orderLocked || !['setup', 'keeper_selection', 'draft_ready'].includes(board.phase);
  async function submit() {
    if (!commissioner || !draft || stale || locked || !valid) return;
    if (await publish(draft)) { accept(null); setLoadError(''); if (detailsRef.current) detailsRef.current.open = false; }
  }
  const slots = [...board.teams].sort((a, b) => (a.draftPosition ?? Infinity) - (b.draftPosition ?? Infinity));
  return <details ref={detailsRef} className={styles.orderEditor} onToggle={event => { if (event.currentTarget.open) void initialize(); }}>
    <summary>Manage draft order</summary>
    <p>{commissioner ? 'Review and edit the slot order, then publish it to the board. Unpublished edits stay private to this editor.' : account.commissioner && account.connection !== 'live' ? 'Showing the last loaded draft slots. Restore the live connection before editing the order.' : 'Everyone can view the draft slots. Only the commissioner can set or change the order.'} Pick ownership follows the existing trade records.</p>
    {!commissioner && <ol className={styles.readOnlyOrder}>{slots.map((team, index) => <li key={index} className={styles.ownerColor} style={franchiseColorStyle(board.orderComplete ? team.franchiseId : null)}><span>Slot {index + 1}</span><strong>{board.orderComplete ? team.displayName : 'Not assigned'}</strong></li>)}</ol>}
    {commissioner && loading && <p role="status">Loading the saved choice-priority lottery for reference…</p>}
    {commissioner && loadError && <p className={styles.error} role="alert">{loadError}</p>}
    {commissioner && draft && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className={styles.orderReview}><strong>Unpublished draft · review before publishing</strong>{draft.source ? <><p>The lottery drawn {new Date(draft.source.drawnAt).toLocaleString()} sets who chooses first. Record each franchise’s chosen slot below; the lottery does not assign slots.</p><ol aria-label="Saved choice priority">{draft.source.ids.map(id => <li key={id}>{board.teams.find(team => team.franchiseId === id)?.displayName}</li>)}</ol></> : <p>{board.orderComplete ? 'Started from the current published order.' : 'No saved choice-priority lottery was loaded. Choose the franchises below.'}</p>}<p>The public board changes only when you choose Publish draft order. Choosing a franchise already in another slot swaps the two positions.</p></div>
      <fieldset disabled={locked}>
        <div className={styles.orderFields}>{draft.ids.map((id, index) => <label key={index} className={styles.ownerColor} style={franchiseColorStyle(id)}>Slot {index + 1}<select aria-label={`Franchise for draft slot ${index + 1}`} value={id} onChange={event => accept({ ...draft, ids: assignDraftSlot(draft.ids, index, event.target.value) })}><option value="">Choose franchise</option>{board.teams.map(team => <option key={team.franchiseId} value={team.franchiseId}>{team.displayName}</option>)}</select></label>)}</div>
        <label className={styles.noteLabel}>Order note <span>Required · at least 5 characters</span><textarea rows={2} value={draft.note} onChange={event => accept({ ...draft, note: event.target.value })} maxLength={2000} required minLength={5} aria-describedby="draft-order-note-help" aria-invalid={draft.note.length > 0 && draft.note.trim().length < 5} placeholder="Record how the league decided this order."/></label>
        <p id="draft-order-note-help">{draft.note.trim().length < 5 ? 'Add a note of at least 5 non-space characters to publish.' : 'Order note is ready.'}{draft.ids.some(id => !id) && ' Assign every slot before publishing.'}</p>
        {stale && <p role="alert" className={styles.error}>The board changed. Reload the order before publishing.<button type="button" className="text-button" onClick={() => { accept(null); void initialize(); }}>Load current order</button></p>}
        <button className="button button-green" disabled={stale || !valid}>Publish draft order</button>
        {board.orderLocked && <p>Draft order is fixed once live draft selections begin.</p>}
      </fieldset>
    </form>}
  </details>;
}

export function LiveDraftBoard({ account, openOrderEditor = false }: { account: LeagueAccount; openOrderEditor?: boolean }) {
  const seasonId = account.seasonId;
  const [board, setBoard] = useState<DraftBoard | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState('all');
  const [eligibility, setEligibility] = useState('all');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [shortlistOnly, setShortlistOnly] = useState(false);
  const [shortlist, setShortlist] = useState<{ key: string; ids: number[] }>({ key: '', ids: [] });
  const [workspaceView, setWorkspaceView] = useState<'players' | 'rosters'>('players');
  const [previewBoard, setPreviewBoard] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const presentationButtonRef = useRef<HTMLButtonElement>(null);
  const correctionRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editingPickId, setEditingPickId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [lastRead, setLastRead] = useState<string | null>(null);
  const identity = `${seasonId}:${account.session?.user?.id || 'anonymous'}:${account.commissioner}:${account.connection}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const shortlistKey = account.session?.user?.id && seasonId ? `croc-bois:draft-shortlist:${seasonId}:${account.session.user.id}` : '';
  const shortlistIds = shortlist.key === shortlistKey ? shortlist.ids : [];
  useEffect(() => {
    let ids: number[] = [];
    try { ids = shortlistKey ? readDraftShortlist(window.localStorage.getItem(shortlistKey), catalogIds) : []; } catch { /* Browser storage may be unavailable. */ }
    setShortlist({ key: shortlistKey, ids }); setShortlistOnly(false);
  }, [shortlistKey]);
  useEffect(() => {
    const onFullscreen = () => { const active = document.fullscreenElement === sectionRef.current; setPresenting(active); if (!active) presentationButtonRef.current?.focus(); };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);
  useEffect(() => {
    if (!editingPickId) return;
    correctionRef.current?.focus();
    correctionRef.current?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [editingPickId]);

  function toggleShortlist(playerId: number) {
    if (!shortlistKey) return;
    const ids = shortlistIds.includes(playerId) ? shortlistIds.filter(id => id !== playerId) : [...shortlistIds, playerId];
    setShortlist({ key: shortlistKey, ids });
    try { window.localStorage.setItem(shortlistKey, JSON.stringify(ids)); } catch { setNotice('Your shortlist is available for this visit, but this browser could not save it.'); }
  }
  async function togglePresentation() {
    try {
      if (presenting) await document.exitFullscreen();
      else if (sectionRef.current?.requestFullscreen) await sectionRef.current.requestFullscreen();
      else setNotice('Fullscreen presentation is not supported by this browser. The full board remains available below.');
    } catch { setNotice('The browser could not open fullscreen. The full board remains available below.'); }
  }

  const acceptBoard = useCallback((next: DraftBoard) => {
    setBoard(previous => !previous || previous.seasonId !== next.seasonId || next.revision >= previous.revision ? next : previous);
  }, []);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!seasonId) { setLoading(false); return null; }
    setRefreshing(true);
    try {
      const response = await fetch(`/api/draft-board?seasonId=${encodeURIComponent(seasonId)}`, { cache: 'no-store', credentials: 'same-origin', signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'The live draft board could not be loaded.');
      const next = draftBoardSchema.parse(body.board);
      if (next.seasonId !== seasonId) throw new Error('The draft response belongs to another season.');
      if (signal?.aborted) return null;
      acceptBoard(next); setLastRead(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setError(''); return next;
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'The live draft board could not be loaded.');
      return null;
    } finally { if (!signal?.aborted) { setLoading(false); setRefreshing(false); } }
  }, [seasonId, acceptBoard]);

  useEffect(() => {
    setBoard(null); setLoading(true); setSelected(null); setEditingPickId(null); setEditingRevision(null); setNotice('');
    const controller = new AbortController();
    let polling = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || polling || busyRef.current) return;
      polling = true;
      try { await reload(controller.signal); } finally { polling = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [reload]);

  useEffect(() => {
    setSelected(null); setEditingPickId(null); setEditingRevision(null); setChangeNote(''); setNotice('');
  }, [identity]);

  async function send(action: DraftAction, success: string) {
    if (!account.session?.user || !account.commissioner || account.connection !== 'live' || error || busyRef.current) return false;
    const actor = identityRef.current;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/draft-board', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
      const result = await response.json();
      if (actor !== identityRef.current) return false;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) void account.reloadSession();
        throw new Error(result.message || 'The draft change was not saved.');
      }
      const next = draftBoardSchema.parse(result.board);
      if (next.seasonId !== seasonId) throw new Error('The draft response belongs to another season.');
      acceptBoard(next);
      setSelected(null); setEditingPickId(null); setEditingRevision(null); setChangeNote(''); setNotice(success);
      void account.reloadLeague();
      return true;
    } catch (failure) {
      if (actor === identityRef.current) setError(failure instanceof Error ? failure.message : 'The draft change was not saved.');
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }

  const occupied = useMemo(() => new Map((board?.picks || []).filter(pick => pick.playerId !== null).map(pick => [pick.playerId!, pick])), [board]);
  const profiles = useMemo(() => new Map(account.data.players.map(player => [player.id, player])), [account.data.players]);
  const teams = board?.teams || [];
  const teamName = (id: string | null) => teams.find(team => team.franchiseId === id)?.displayName || '';
  const teamShortName = (id: string | null) => {
    const team = teams.find(item => item.franchiseId === id);
    return account.data.teams.find(item => item.id === team?.espnTeamId)?.shortName || team?.displayName || '';
  };
  const searchTerm = query.trim().toLocaleLowerCase();
  const matchingPlayers = rankedPlayers.filter(player =>
    player.name.toLocaleLowerCase().includes(searchTerm) &&
    (position === 'all' || player.eligiblePositions.some(value => value === position)) &&
    (eligibility === 'all' || (profiles.get(player.id)?.status ?? 'ineligible') === eligibility) &&
    (!shortlistOnly || shortlistIds.includes(player.id)) &&
    (!availableOnly || (!occupied.has(player.id) && player.selectable)),
  );
  const filteredPlayers = searchTerm ? matchingPlayers : matchingPlayers.slice(0, 200);
  const currentPick = board?.picks.find(pick => pick.id === board.nextPickId);
  const editingPick = board?.picks.find(pick => pick.id === editingPickId && pick.status === 'selected');
  const target = editingPick || currentPick;
  const candidate = catalog.players.find(player => player.id === selected?.playerId);
  const selectionStale = Boolean(selected && (selected.revision !== board?.revision || selected.pickId !== target?.id));
  const editStale = Boolean(editingPickId && editingRevision !== board?.revision);
  const canDraft = Boolean(account.session?.user && account.commissioner && account.connection === 'live' && board?.phase === 'draft_ready' && board.orderComplete && board.keepersRevealedAt && !busy && !error);
  const candidateAvailable = Boolean(candidate?.selectable && !occupied.has(candidate.id));
  const draftedCount = board?.picks.filter(pick => pick.status === 'selected').length || 0;
  const keeperCount = board?.picks.filter(pick => pick.status === 'keeper').length || 0;
  const allPicksFilled = Boolean(board?.picks.length && board.picks.every(pick => pick.status !== 'available'));
  const count = teams.length || account.data.teams.length;
  const rounds = board?.roundCount || 13;
  const slotTeams = [...teams].sort((a, b) => (a.draftPosition ?? Infinity) - (b.draftPosition ?? Infinity));
  const statusFor = (id: number) => occupied.get(id)?.status === 'keeper' ? 'Kept · off board' : occupied.has(id) ? 'Drafted · off board' : profiles.get(id)?.status === 'eligible' ? 'Eligible keeper' : profiles.get(id)?.status === 'review' ? 'Keeper review pending' : 'Ineligible keeper';

  function choosePlayer(playerId: number) {
    if (!board) return;
    setSelected({ playerId, pickId: target?.id || '', revision: editingPickId ? editingRevision ?? board.revision : board.revision }); setNotice('');
  }

  function resetSelection() { setSelected(null); setEditingPickId(null); setEditingRevision(null); setChangeNote(''); void reload(); }

  const preferredFranchiseId = account.ownTeamIds.map(teamId => board?.teams.find(team => team.espnTeamId === teamId)?.franchiseId).find(Boolean);

  return <section ref={sectionRef} className={`panel ${styles.panel} ${presenting ? styles.presenting : ''}`} aria-labelledby="live-draft-title">
    <div className="panel-header">
      <div><p className="eyebrow">THE NEXT CHAPTER · {board?.draftYear || account.data.season}</p><h2 id="live-draft-title">Live draft board</h2></div>
      <div className={styles.liveStatus}><span aria-hidden="true" className={error || account.connection !== 'live' ? styles.offlineDot : styles.liveDot}/>{loading ? 'Connecting…' : error ? 'Refresh needed' : account.connection !== 'live' ? 'Viewing board · official actions paused' : 'Updates every 5 seconds'}<button className="text-button" disabled={busy || loading || refreshing} onClick={() => void reload()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button ref={presentationButtonRef} className="text-button" onClick={() => void togglePresentation()}>{presenting ? 'Exit presentation' : 'Present board'}</button></div>
    </div>
    <div className={styles.summary}>
      <div><strong>{board?.orderComplete ? currentPick ? `Pick ${currentPick.overallPick} · ${teamShortName(currentPick.currentOwnerId)}` : allPicksFilled ? 'Every pick is filled' : !board.keepersRevealedAt ? 'Waiting for keeper reveal' : 'Draft entry paused' : 'Draft order to be decided'}</strong><p>{!board?.orderComplete ? 'Pick owners will appear once the order is set.' : !board.keepersRevealedAt ? 'Keeper placements appear after every team is locked and keepers are revealed.' : 'Revealed keepers occupy their payment picks. Draft selections fill the remaining spots.'}</p></div>
      <dl><div><dt>Keepers</dt><dd>{keeperCount}</dd></div><div><dt>Drafted</dt><dd>{draftedCount}</dd></div><div><dt>Available picks</dt><dd>{count * rounds - keeperCount - draftedCount}</dd></div></dl>
    </div>
    {error && <div className={styles.error} role="alert">{error} {board && 'The last loaded board remains visible.'}</div>}
    {account.commissioner && account.connection !== 'live' && <p className={styles.error} role="status">Official draft actions are paused until the live league connection is restored. <button className="text-button" onClick={() => void account.reloadLeague()}>Refresh league connection</button></p>}
    {notice && <p className={styles.success} role="status">{notice}</p>}
    <div className={styles.layout}>
      <div className={styles.boardArea}>
        {!board?.orderComplete && <div className={styles.unpublished}><h3>Draft order is unpublished</h3><p>The choice-priority lottery decides who chooses first. The board fills after the agreed slots are published.</p><button type="button" className="button button-subtle" aria-expanded={previewBoard} aria-controls="draft-board-preview" onClick={() => setPreviewBoard(value => !value)}>{previewBoard ? 'Hide empty board preview' : `Preview ${count * rounds} draft slots`}</button></div>}
        <div id="draft-board-preview" hidden={!board?.orderComplete && !previewBoard && !presenting}>
        <div className={styles.legend}><span><i className={styles.keeperSwatch}/>Kept</span><span><i className={styles.draftedSwatch}/>Drafted</span><span><i className={styles.nextSwatch}/>Next pick</span><small>{board?.draftFormat === 'linear' ? 'Linear' : 'Snake'} · {rounds} rounds</small></div>
        {board?.orderComplete && <div className={styles.ownershipKey}><p>Colors show the current pick owner. Slot headings show the original franchise.</p><ul aria-label="Pick owner colors">{slotTeams.map(team => <li key={team.franchiseId} className={styles.ownerColor} style={franchiseColorStyle(team.franchiseId)} title={team.displayName}><span className={styles.ownerSwatch} aria-hidden="true"/>{teamShortName(team.franchiseId)}</li>)}</ul></div>}
        <div className={styles.boardScroll} tabIndex={0} aria-label="Live draft grid; scroll to see all rounds and slots">
          <div className={styles.grid} style={{ '--teams': count } as CSSProperties} role="table" aria-label="Live draft board by original slot" aria-rowcount={rounds + 1} aria-colcount={count + 1}>
            <div className={styles.boardRow} role="row">
            <div className={styles.corner} role="columnheader">ROUND</div>
            {Array.from({ length: count }, (_, index) => <div key={index} className={`${styles.columnHeader} ${board?.orderComplete ? styles.ownerColor : ''}`} style={franchiseColorStyle(board?.orderComplete ? slotTeams[index]?.franchiseId : null)} role="columnheader" title={board?.orderComplete ? `Original slot: ${teamName(slotTeams[index]?.franchiseId || null)}` : undefined}><span>SLOT {index + 1}</span><strong>{board?.orderComplete ? teamShortName(slotTeams[index]?.franchiseId || null) : '\u00a0'}</strong></div>)}
            </div>
            {Array.from({ length: rounds }, (_, roundIndex) => {
              const round = roundIndex + 1;
              return <div className={styles.boardRow} key={round} role="row"><div className={styles.round} role="rowheader" aria-label={`Round ${round}`}>{String(round).padStart(2, '0')}<small aria-hidden="true">{board?.draftFormat === 'linear' || round % 2 ? '→' : '←'}</small></div>
                {Array.from({ length: count }, (_, index) => {
                  const overall = draftOverallPick(round, index + 1, count, board?.draftFormat || 'snake');
                  const pick = board?.orderComplete ? board.picks.find(item => item.overallPick === overall) : undefined;
                  const keeper = pick?.status === 'keeper', drafted = pick?.status === 'selected';
                  const next = pick?.id === board?.nextPickId && Boolean(board?.keepersRevealedAt);
                  const selectedCell = editingPickId === pick?.id && Boolean(pick);
                  const player = pick?.playerId ? catalogById.get(pick.playerId) : undefined;
                  const roundPick = overall - (round - 1) * count;
                  return <div role="cell" key={index} style={franchiseColorStyle(pick?.currentOwnerId)} className={`${styles.cell} ${pick?.currentOwnerId ? styles.ownerColor : ''} ${keeper ? styles.keeperCell : drafted ? styles.draftedCell : ''} ${next ? styles.nextCell : ''} ${selectedCell ? styles.selectedCell : ''} ${drafted && account.commissioner ? styles.editableCell : ''}`}>
                    <span className={styles.pickLabel} aria-label={`Round ${round}, pick ${roundPick}, overall ${overall}`}><b>{round}.{String(roundPick).padStart(2, '0')}</b><span>#{overall}</span></span>
                    <strong className={pick?.playerName ? '' : styles.emptyPick}>{pick?.playerName || (next ? 'On the clock' : board?.orderComplete ? 'Available' : 'Awaiting order')}</strong>
                    {player && <span className={styles.playerMeta}><b>{player.primaryPosition || '—'}</b>{player.nbaTeam || 'FA'}</span>}
                    <div className={styles.cellFooter}><span title={pick?.currentOwnerId ? `Current owner: ${teamName(pick.currentOwnerId)}` : undefined}>{board?.orderComplete ? teamShortName(pick?.currentOwnerId || null) : `Slot ${index + 1}`}</span>{keeper ? <b className={styles.keeperBadge}>Kept</b> : drafted ? <b className={styles.draftedBadge}>Drafted</b> : next ? <b className={styles.nextBadge}>Next</b> : null}{pick && pick.currentOwnerId !== pick.originalFranchiseId && <small className={styles.via}>via {teamShortName(pick.originalFranchiseId)}</small>}</div>
                    {drafted && account.commissioner && <button className={styles.editPick} disabled={!canDraft} aria-label={`Correct pick ${overall}: ${pick?.playerName}`} onClick={() => { setWorkspaceView('players'); setEditingPickId(pick!.id); setEditingRevision(board!.revision); setSelected(null); setChangeNote(''); setNotice(''); }}>Edit</button>}
                  </div>;
                })}
              </div>;
            })}
          </div>
        </div>
        </div>
        <p className={styles.footnote}>{lastRead ? `Last checked ${lastRead}. ` : ''}Keeper eligibility belongs to the player’s current franchise. Ineligible keepers can still be drafted.</p>
        {board && <DraftOrderEditor key={identity} board={board} account={account} busy={busy || Boolean(error)} open={openOrderEditor} publish={draft => send({ action: 'set_order', seasonId, expectedRevision: draft.revision, franchiseIds: draft.ids, note: draft.note }, 'Draft order published.')}/>}
      </div>
      <aside className={styles.sidePanel} aria-label="Draft tools">
        <div className={styles.workspaceSwitch} role="group" aria-label="Draft tools view">{(['players', 'rosters'] as const).map(view => <button key={view} type="button" aria-pressed={workspaceView === view} aria-controls={`draft-tools-${view}`} onClick={() => setWorkspaceView(view)}>{view === 'players' ? 'Players' : 'Rosters'}</button>)}</div>
        <div id="draft-tools-players" className={`${styles.sidePanelBody} ${workspaceView !== 'players' ? styles.workspaceHidden : ''}`}>
      <section className={styles.playerPanel} aria-labelledby="draft-player-pool-title">
        <p className="eyebrow">SCOUTING THE FIELD</p><h3 id="draft-player-pool-title">Player pool</h3>
        <p className={styles.rankingSource}>{catalog.rankingSource.label}<br/>{catalog.espnSeasonId - 1}–{String(catalog.espnSeasonId).slice(-2)} · updated {catalog.fetchedAt.slice(0, 10)}</p>
        <div className={styles.categories}>{catalog.categories.map(category => <span key={category.id}>{category.label}</span>)}</div>
        <label className={styles.field}>Find a player<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the player pool" aria-describedby="draft-player-search-help"/></label>
        <p id="draft-player-search-help" className={styles.footnote}>Browse the top 200 matches, or search by name to find any player.</p>
        <label className={styles.field}>Position<select value={position} onChange={event => setPosition(event.target.value)}><option value="all">All positions</option>{['PG', 'SG', 'SF', 'PF', 'C'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className={styles.field}>Keeper eligibility<select value={eligibility} onChange={event => setEligibility(event.target.value)}><option value="all">All players</option><option value="eligible">Eligible keepers</option><option value="ineligible">Ineligible keepers</option></select></label>
        <label className={styles.checkbox}><input type="checkbox" checked={availableOnly} onChange={event => setAvailableOnly(event.target.checked)}/>Available players only</label>
        {shortlistKey ? <><label className={styles.checkbox}><input type="checkbox" checked={shortlistOnly} onChange={event => setShortlistOnly(event.target.checked)}/>My shortlist only ({shortlistIds.length})</label><p className={styles.footnote}>Your shortlist is private to this account and season on this browser. It never records a draft pick.</p></> : <p className={styles.footnote}>Sign in to keep a private player shortlist on this browser.</p>}
        <div className={styles.filterSummary}><span>{matchingPlayers.length} matching players</span>{(query || position !== 'all' || eligibility !== 'all' || availableOnly || shortlistOnly) && <button type="button" className="text-button" onClick={() => { setQuery(''); setPosition('all'); setEligibility('all'); setAvailableOnly(false); setShortlistOnly(false); }}>Reset filters</button>}</div>
        <label className={styles.field}>Choose a player<select aria-label="Choose a player for the live draft" value={selected?.playerId || ''} onChange={event => event.target.value ? choosePlayer(Number(event.target.value)) : setSelected(null)} disabled={busy || !board}><option value="">Select from ESPN category rankings</option>{filteredPlayers.map(player => <option key={player.id} value={player.id} disabled={!player.selectable || occupied.has(player.id)}>{player.rank === null ? 'NR' : `#${player.rank}`} · {player.name} · {statusFor(player.id)}</option>)}</select></label>
        {candidate && <div className={styles.candidate}><strong>{candidate.name}</strong><span>{candidate.primaryPosition || 'Position unavailable'} · {candidate.nbaTeam || 'NBA free agent'}</span><span>{statusFor(candidate.id)}{profiles.get(candidate.id)?.status === 'eligible' ? ` · R${profiles.get(candidate.id)?.baseCost}` : ''}</span>{shortlistKey && <button className="text-button" type="button" aria-pressed={shortlistIds.includes(candidate.id)} onClick={() => toggleShortlist(candidate.id)}>{shortlistIds.includes(candidate.id) ? 'Remove from my shortlist' : 'Add to my shortlist'}</button>}</div>}
        {account.commissioner ? <div ref={correctionRef} tabIndex={-1} className={styles.pickActions} aria-label={editingPick ? `Correct pick ${editingPick.overallPick}` : 'Record next pick'}>
          <strong>{editingPick ? `Correct pick ${editingPick.overallPick}` : currentPick ? `Pick ${currentPick.overallPick ?? '—'}` : allPicksFilled ? 'Draft board complete' : board?.orderComplete ? 'Waiting for draft entry' : 'Order pending'}</strong>
          {target && <span>{teamName(target.currentOwnerId)}</span>}
          {!board?.orderComplete ? <p>Set the agreed draft order to place selections.</p> : !board.keepersRevealedAt ? <p>Live drafting opens after all keepers have been locked and revealed.</p> : board.phase !== 'draft_ready' && <p>Draft entry is closed for this season.</p>}
          {editingPick && <><p>Currently {editingPick.playerName}. Choose a replacement above or remove this selection.</p><label className={styles.field}>Correction reason <span>Required · at least 5 characters</span><textarea rows={2} value={changeNote} maxLength={2000} required minLength={5} aria-describedby="draft-correction-help" aria-invalid={changeNote.length > 0 && changeNote.trim().length < 5} onChange={event => setChangeNote(event.target.value)} placeholder="Explain the correction or removal."/></label><p id="draft-correction-help">{changeNote.trim().length < 5 ? 'Add at least 5 non-space characters to save or remove this pick.' : 'Correction reason is ready.'}</p></>}
          {(selectionStale || editStale) && <p className={styles.error} role="alert">The board changed after you started this selection. Load the latest pick before recording.<button type="button" className="text-button" onClick={resetSelection}>Load latest pick</button></p>}
          <button className="button button-green" disabled={!canDraft || !selected || !candidateAvailable || selectionStale || editStale || !target || Boolean(editingPick && changeNote.trim().length < 5)} onClick={() => { if (!selected || !seasonId) return; void send(editingPick ? { action: 'correct', seasonId, expectedRevision: selected.revision, pickId: selected.pickId, playerId: selected.playerId, note: changeNote } : { action: 'record', seasonId, expectedRevision: selected.revision, pickId: selected.pickId, playerId: selected.playerId }, editingPick ? 'Draft selection corrected.' : 'Draft selection recorded.'); }}>{busy ? 'Saving…' : editingPick ? 'Save corrected pick' : 'Record draft pick'}</button>
          {editingPick && <><button className="button button-subtle" disabled={!canDraft || editStale || changeNote.trim().length < 5} onClick={() => { if (seasonId && editingRevision !== null) void send({ action: 'undo', seasonId, expectedRevision: editingRevision, pickId: editingPick.id, note: changeNote }, 'Draft selection removed; the pick is available again.'); }}>Remove this selection</button><button className="text-button" disabled={busy} onClick={resetSelection}>Back to next pick</button></>}
        </div> : <p className={styles.viewerNote}>The commissioner records draft selections. This board updates automatically.</p>}
        <div className={styles.poolHeading}><span>{!searchTerm && matchingPlayers.length > 200 ? 'Top 200 matches' : `${filteredPlayers.length} players shown`}</span><span>ESPN rank</span></div>
        <div className={styles.playerList} aria-label="Ranked players and keeper eligibility">
          {filteredPlayers.map(player => {
            const occupiedPick = occupied.get(player.id);
            return <div key={player.id} className={styles.playerEntry}><button type="button" className={`${styles.playerRow} ${occupiedPick ? styles.offBoard : ''} ${selected?.playerId === player.id ? styles.chosenPlayer : ''}`} disabled={busy || !board || !player.selectable || Boolean(occupiedPick)} onClick={() => choosePlayer(player.id)} aria-pressed={selected?.playerId === player.id} aria-label={`${player.name}, ${player.rank === null ? 'unranked' : `rank ${player.rank}`}, ${statusFor(player.id)}`}>
              <span className={styles.rank}>{player.rank ?? '—'}</span><span className={styles.playerInfo}><strong>{player.name}</strong><small>{player.primaryPosition || '—'} · {player.nbaTeam || 'FA'}</small><span className={`${styles.playerBadge} ${occupiedPick?.status === 'keeper' ? styles.keptBadge : profiles.get(player.id)?.status === 'eligible' ? styles.eligibleBadge : ''}`}>{statusFor(player.id)}</span></span>{occupiedPick && <span className={styles.offBoardMark} aria-hidden="true">✓</span>}
            </button>{shortlistKey && <button type="button" className={styles.shortlistButton} aria-pressed={shortlistIds.includes(player.id)} aria-label={`${shortlistIds.includes(player.id) ? 'Remove' : 'Add'} ${player.name} ${shortlistIds.includes(player.id) ? 'from' : 'to'} my shortlist`} onClick={() => toggleShortlist(player.id)}><span aria-hidden="true">{shortlistIds.includes(player.id) ? '★' : '☆'}</span></button>}</div>;
          })}
          {!filteredPlayers.length && <p className={styles.footnote}>No players match these filters.</p>}
        </div>
        <p className={styles.footnote}>ESPN’s supplied ROTO category ranking. Players without a supplied rank follow alphabetically. Keeper labels use the league’s current confirmed profiles.</p>
      </section>
        </div>
        <div id="draft-tools-rosters" className={`${styles.sidePanelBody} ${workspaceView !== 'rosters' ? styles.workspaceHidden : ''}`}>
          {board ? <DraftRosters compact key={`${seasonId}:${account.session?.user?.id || 'public'}`} board={board} preferredFranchiseId={preferredFranchiseId}/> : <p className={styles.rosterLoading} role="status">{loading ? 'Loading draft rosters…' : 'Draft rosters will appear when the board is available.'}</p>}
        </div>
      </aside>
    </div>
  </section>;
}
