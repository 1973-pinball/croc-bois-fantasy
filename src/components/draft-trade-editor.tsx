'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { draftBoardSchema, type DraftBoard } from '@/lib/draft-board';
import { buildTradePickInventory, type TradePickInventory } from '@/lib/trade-pick-inventory';
import type { LeagueAccount } from './league-account';
import styles from './commissioner-strategy.module.css';

type Asset = { key: string; label: string; ownerId: string; kind: 'player' | 'pick'; playerId?: number; pickId?: string; year?: number };
type Preview = { revision: number; teamA: string; teamB: string; assets: Asset[]; note: string };

export function DraftTradeEditor({ account, board, stale, accept, refresh }: {
  account: LeagueAccount; board: DraftBoard; stale: boolean; accept: (board: DraftBoard) => void; refresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inventory, setInventory] = useState<TradePickInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState('');
  const [teamA, setTeamA] = useState(board.teams[0]?.franchiseId ?? '');
  const [teamB, setTeamB] = useState(board.teams[1]?.franchiseId ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef(false), active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const franchiseIds = account.live?.franchiseIds;
  const loadInventory = useCallback(async () => {
    if (!franchiseIds) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setInventoryError('');
    try {
      const response = await fetch('/api/draft-picks', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Pick ownership could not be loaded.');
      const next = buildTradePickInventory(body, board.draftYear, franchiseIds);
      if (!controller.signal.aborted && active.current) setInventory(next);
    } catch (failure) {
      if (!controller.signal.aborted && active.current) setInventoryError(failure instanceof Error ? failure.message : 'Pick ownership could not be loaded.');
    } finally {
      if (request.current === controller) { request.current = null; if (active.current) setLoading(false); }
    }
  }, [board.draftYear, franchiseIds]);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { if (expanded) void loadInventory(); }, [expanded, board.revision, loadInventory]);
  const teamName = (id: string) => board.teams.find(team => team.franchiseId === id)?.displayName ?? 'Unknown team';
  const assets = useMemo<Asset[]>(() => {
    const used = new Set(inventory?.usedPickIds);
    const players = board.picks.filter(pick => pick.status !== 'available' && pick.playerId !== null).map(pick => ({
      key: `player:${pick.playerId}`, label: `${pick.playerName ?? `Player ${pick.playerId}`} · ${pick.status === 'keeper' ? 'keeper' : 'drafted'}`,
      ownerId: pick.rosterOwnerId ?? pick.currentOwnerId ?? '', kind: 'player' as const, playerId: pick.playerId!,
    }));
    const picks = (inventory?.picks ?? []).filter(pick => {
      if (used.has(pick.id) || pick.season > board.draftYear + 1) return false;
      const ownerId = franchiseIds?.[pick.ownerTeamId];
      const recipientId = ownerId === teamA ? teamB : ownerId === teamB ? teamA : null;
      return recipientId !== null && (inventory?.participantIdsByYear[pick.season] ?? []).some(id => franchiseIds?.[id] === recipientId);
    }).map(pick => {
      const publicPick = board.picks.find(row => row.id === pick.id);
      return { key: `pick:${pick.id}`, label: `${pick.season} · round ${pick.round}${publicPick?.overallPick ? ` · #${publicPick.overallPick}` : ''} · originally ${account.data.teams.find(team => team.id === pick.originalTeamId)?.shortName ?? pick.originalTeamId}`,
        ownerId: franchiseIds?.[pick.ownerTeamId] ?? '', kind: 'pick' as const, pickId: pick.id, year: pick.season };
    });
    return [...players, ...picks];
  }, [board, inventory, franchiseIds, account.data.teams, teamA, teamB]);
  const available = account.commissioner && account.connection === 'live' && board.phase === 'draft_ready' && Boolean(board.keepersRevealedAt) && !stale;
  const selection = assets.filter(asset => selected.includes(asset.key));
  const validSelection = selected.length > 0 && selected.length === selection.length && teamA !== teamB && selection.every(asset => asset.ownerId === teamA || asset.ownerId === teamB);
  const unchanged = preview && preview.revision === board.revision && preview.teamA === teamA && preview.teamB === teamB && preview.note === note.trim()
    && preview.assets.length === selection.length && preview.assets.every(asset => selection.some(current => current.key === asset.key && current.ownerId === asset.ownerId));
  async function record() {
    if (!preview || !unchanged || !available || pending.current || loading || inventoryError) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const transfer = (asset: Asset) => ({ fromFranchiseId: asset.ownerId, toFranchiseId: asset.ownerId === preview.teamA ? preview.teamB : preview.teamA });
      const response = await fetch('/api/draft-trades', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId: board.seasonId, expectedRevision: preview.revision, note: preview.note,
          players: preview.assets.filter(asset => asset.kind === 'player').map(asset => ({ playerId: asset.playerId, ...transfer(asset) })),
          picks: preview.assets.filter(asset => asset.kind === 'pick').map(asset => ({ pickId: asset.pickId, ...transfer(asset) })),
        }) });
      const body = await response.json();
      if (!response.ok) { if ([401, 403].includes(response.status)) void account.reloadSession(); throw new Error(body.message || 'The trade could not be recorded. Refresh ownership and review the trade again.'); }
      const next = draftBoardSchema.parse(body.board);
      if (next.seasonId !== board.seasonId) throw new Error('The trade response belongs to another season. Refresh the board.');
      if (active.current) {
        accept(next); setSelected([]); setPreview(null); setNote('');
        setMessage(`Trade recorded. Rosters, pick ownership, and projections are updated.${next.clock.status === 'paused' ? ' The draft clock is paused; resume it in the draft room when ready.' : ''}`);
        await Promise.all([account.reloadLeague(), loadInventory()]);
      }
    } catch (failure) {
      if (active.current) { setMessage(failure instanceof Error ? failure.message : 'The trade could not be recorded.'); setPreview(null); await Promise.all([refresh(), loadInventory()]); }
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <details className={styles.panel} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Record draft trade · players and picks</summary>
    <p className={styles.subtle}>Swap players, keepers, or unspent picks, including {board.draftYear} for {board.draftYear + 1}. Pick years and original slots stay fixed; ownership changes. A traded keeper’s paid cost stays with the original payer. This records the trade immediately on the league’s public records and pauses a running draft clock.</p>
    {!available && <p className={styles.notice}>Draft trades open after keeper finalization and reveal. Restore the live connection before recording changes.</p>}
    <div className={styles.actions}><button type="button" className="text-button" disabled={busy || loading} onClick={() => void loadInventory()}>{loading ? 'Refreshing pick ownership…' : 'Refresh pick ownership'}</button></div>
    {inventoryError && <p role="alert" className={styles.error}>{inventoryError}</p>}
    <div className={styles.tradeSides}>{[teamA, teamB].map((teamId, index) => <div className={styles.tradeSide} key={index}>
      <label className={styles.field}>{index === 0 ? 'First team' : 'Second team'}<select value={teamId} disabled={busy} onChange={event => { (index === 0 ? setTeamA : setTeamB)(event.target.value); setSelected([]); setPreview(null); }}>{board.teams.map(team => <option key={team.franchiseId} value={team.franchiseId}>{team.displayName}</option>)}</select></label>
      <p className={styles.subtle}>Sending to {teamName(index === 0 ? teamB : teamA)}</p>
      <div className={styles.assetList}>{assets.filter(asset => asset.ownerId === teamId).map(asset => <label key={asset.key}><input type="checkbox" checked={selected.includes(asset.key)} disabled={busy || !available || loading || Boolean(inventoryError) || teamA === teamB} onChange={event => { setSelected(previous => event.target.checked ? [...previous, asset.key] : previous.filter(key => key !== asset.key)); setPreview(null); }}/><span>{asset.label}</span></label>)}</div>
      {!loading && !assets.some(asset => asset.ownerId === teamId) && <p className={styles.subtle}>No eligible assets loaded.</p>}
    </div>)}</div>
    <label className={styles.field}>Trade note<textarea rows={2} minLength={5} maxLength={2000} value={note} disabled={busy} onChange={event => { setNote(event.target.value); setPreview(null); }} placeholder="Agreed pick swap / player trade details"/></label>
    <div className={styles.actions}><button type="button" className="button button-subtle" disabled={!available || busy || loading || Boolean(inventoryError) || !inventory || !validSelection || note.trim().length < 5} onClick={() => setPreview({ revision: board.revision, teamA, teamB, assets: selection, note: note.trim() })}>Review trade</button></div>
    {preview && <div className={styles.importer}><h4>Confirm the exchange</h4>{[teamA, teamB].map(id => <div key={id}><p className={styles.subtle}><strong>{teamName(id)}</strong> sends to {teamName(id === teamA ? teamB : teamA)}:</p><ul>{preview.assets.filter(asset => asset.ownerId === id).map(asset => <li key={asset.key}>{asset.label}</li>)}{!preview.assets.some(asset => asset.ownerId === id) && <li>No assets</li>}</ul></div>)}
      {!unchanged && <p role="status" className={styles.notice}>The draft or ownership changed. Review the trade again using the current records.</p>}
      <button type="button" className="button button-orange" disabled={!unchanged || !available || busy || loading || Boolean(inventoryError)} onClick={() => void record()}>{busy ? 'Recording trade…' : 'Record trade now'}</button>
    </div>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
  </details>;
}
