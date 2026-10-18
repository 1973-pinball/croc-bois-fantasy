import { draftBoardSchema, type DraftBoard } from './draft-board';
import { compareDraftCatalogPlayers, type DraftCatalogPlayer } from './draft-player-catalog';

export type PracticeDraftAccess = { userId?: string; commissioner: boolean; seasonId: string; connection: string };
export type PracticeDraft = {
  userId: string;
  baseline: DraftBoard;
  board: DraftBoard;
  practicePickIds: string[];
  message: string;
};
export type PracticeDraftAction =
  | { type: 'start' | 'pause' | 'resume' | 'tick' | 'undo' | 'reset' }
  | { type: 'configure'; seconds: number }
  | { type: 'pick'; playerId: number; pickId: string };

export function canUsePracticeDraft(access: PracticeDraftAccess) {
  return Boolean(access.userId && access.commissioner && access.seasonId && access.connection === 'live');
}

function firstAvailable(board: DraftBoard) {
  return [...board.picks].filter(pick => pick.status === 'available')
    .sort((a, b) => (a.overallPick ?? Infinity) - (b.overallPick ?? Infinity))[0]?.id ?? null;
}

function waitingCopy(baseline: DraftBoard, now: number): DraftBoard {
  const board = draftBoardSchema.parse(baseline);
  board.nextPickId = firstAvailable(board);
  board.clock = { ...board.clock, status: 'waiting', startedAt: null, deadlineAt: null,
    remainingSeconds: board.clock.durationSeconds, serverNow: new Date(now).toISOString() };
  return board;
}

/** This state has no transport, storage, live clock, or private queue dependency. */
export function createPracticeDraft(snapshot: DraftBoard, access: PracticeDraftAccess, now = Date.now()): PracticeDraft {
  if (!canUsePracticeDraft(access)) throw new Error('Commissioner access is required to open practice.');
  const baseline = draftBoardSchema.parse(snapshot);
  if (baseline.seasonId !== access.seasonId) throw new Error('The practice snapshot belongs to another season.');
  if (baseline.phase !== 'draft_ready' || !baseline.orderComplete || !baseline.keepersRevealedAt) {
    throw new Error('Practice needs a published draft order and revealed keepers.');
  }
  if (!firstAvailable(baseline)) throw new Error('This board has no available picks to practice.');
  return { userId: access.userId!, baseline, board: waitingCopy(baseline, now), practicePickIds: [],
    message: 'Practice is ready. Start the local clock to make pretend picks.' };
}

function selected(state: PracticeDraft, player: DraftCatalogPlayer, now: number, automatic: boolean): PracticeDraft {
  const board = draftBoardSchema.parse(state.board);
  const pick = board.picks.find(item => item.id === board.nextPickId && item.status === 'available');
  if (!pick) throw new Error('There is no available practice pick.');
  pick.status = 'selected'; pick.playerId = player.id; pick.playerName = player.name;
  // Synthetic selection identity only exists in this in-memory board.
  pick.selectionId = `00000000-0000-4000-8000-${String(board.revision + 1).padStart(12, '0')}`;
  pick.rosterOwnerId = pick.currentOwnerId;
  board.revision += 1; board.orderLocked = true; board.nextPickId = firstAvailable(board);
  board.clock = { ...board.clock, status: board.nextPickId ? 'running' : 'completed',
    deadlineAt: board.nextPickId ? new Date(now + board.clock.durationSeconds * 1000).toISOString() : null,
    remainingSeconds: board.nextPickId ? board.clock.durationSeconds : null, serverNow: new Date(now).toISOString() };
  return { ...state, board, practicePickIds: [...state.practicePickIds, pick.id],
    message: `${automatic ? 'Practice timer selected' : 'Pretend pick recorded:'} ${player.name}.` };
}

function expirePractice(state: PracticeDraft, players: DraftCatalogPlayer[], now: number) {
  if (state.board.clock.status !== 'running' || !state.board.clock.deadlineAt || Date.parse(state.board.clock.deadlineAt) > now) return state;
  const occupied = new Set(state.board.picks.map(pick => pick.playerId));
  const player = [...players].filter(candidate => candidate.selectable && !occupied.has(candidate.id)).sort(compareDraftCatalogPlayers)[0];
  if (player) return selected(state, player, now, true);
  return { ...state, board: { ...state.board, clock: { ...state.board.clock, status: 'paused' as const, deadlineAt: null, remainingSeconds: 0 } },
    message: 'Practice paused because no available player remains in the captured catalog.' };
}

export function updatePracticeDraft(state: PracticeDraft, action: PracticeDraftAction, access: PracticeDraftAccess, players: DraftCatalogPlayer[], now = Date.now()): PracticeDraft {
  if (!canUsePracticeDraft(access) || access.userId !== state.userId || access.seasonId !== state.baseline.seasonId) {
    throw new Error('Open practice again with the commissioner account for this season.');
  }
  if (action.type === 'reset') return { ...state, board: waitingCopy(state.baseline, now), practicePickIds: [],
    message: 'Practice reset. The starting keepers, picks, owners, and rosters are restored.' };
  if (action.type === 'tick') return expirePractice(state, players, now);
  // Match the visible turn boundary: an expired practice turn wins over a late click.
  const advanced = action.type === 'pause' || action.type === 'pick' ? expirePractice(state, players, now) : state;
  if (action.type === 'pick' && advanced !== state) return advanced;
  const next = { ...advanced, board: draftBoardSchema.parse(advanced.board) };
  const board = next.board;
  const clock = board.clock;
  clock.serverNow = new Date(now).toISOString();
  if (action.type === 'configure') {
    if (clock.status !== 'waiting') throw new Error('Reset practice before changing its timer.');
    if (!Number.isInteger(action.seconds) || action.seconds < 10 || action.seconds > 600) throw new Error('Choose 10 to 600 seconds per practice pick.');
    clock.durationSeconds = action.seconds; clock.remainingSeconds = action.seconds;
    next.message = 'Practice timer updated.';
  } else if (action.type === 'start' || action.type === 'resume') {
    if (clock.status !== (action.type === 'start' ? 'waiting' : 'paused') || !board.nextPickId) throw new Error('The practice clock cannot start from its current state.');
    clock.status = 'running'; clock.startedAt ??= new Date(now).toISOString();
    clock.deadlineAt = new Date(now + (clock.remainingSeconds ?? clock.durationSeconds) * 1000).toISOString();
    board.orderLocked = true; next.message = 'Practice clock running. Choose a player for the team on the clock.';
  } else if (action.type === 'pause') {
    if (clock.status === 'completed') return advanced;
    if (clock.status !== 'running') throw new Error('Only a running practice draft can be paused.');
    clock.remainingSeconds = Math.max(0, (Date.parse(clock.deadlineAt!) - now) / 1000);
    clock.status = 'paused'; clock.deadlineAt = null; next.message = 'Practice paused.';
  } else if (action.type === 'pick') {
    if (clock.status !== 'running') throw new Error('Start or resume practice before making a pretend pick.');
    if (action.pickId !== board.nextPickId) throw new Error('The practice turn changed. Choose a player for the next pick.');
    const player = players.find(candidate => candidate.id === action.playerId && candidate.selectable);
    if (!player || board.picks.some(pick => pick.playerId === action.playerId)) throw new Error('Choose an available player from the captured ESPN catalog.');
    return selected(state, player, now, false);
  } else if (action.type === 'undo') {
    const id = next.practicePickIds.at(-1);
    const original = next.baseline.picks.find(pick => pick.id === id && pick.status === 'available');
    if (!original) throw new Error('There is no pretend pick to undo.');
    board.picks = board.picks.map(pick => pick.id === id ? { ...original } : pick);
    board.nextPickId = firstAvailable(board); next.practicePickIds = next.practicePickIds.slice(0, -1);
    clock.status = 'paused'; clock.deadlineAt = null; clock.remainingSeconds = clock.durationSeconds;
    next.message = 'Last pretend pick removed. Resume practice when ready.';
  }
  board.revision += 1;
  return next;
}
