import React, { useMemo, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function winLine(board) {
  const b = String(board || '---------').padEnd(9, '-').slice(0, 9);
  for (const line of LINES) {
    const [a, c, d] = line;
    if (b[a] !== '-' && b[a] === b[c] && b[c] === b[d]) return line;
  }
  return null;
}

function nameOf(members, allUsers, id) {
  if (!id) return '?';
  const m = (members || []).find((x) => x.id === id)
    || (allUsers || []).find((x) => x.id === id);
  return m?.display_name || m?.username || 'Player';
}

// Shared board per room: first mover is X, second distinct mover is O.
// Synced live via `game:update` (REST persists, socket broadcasts).
export default function TicTacToe({ roomId }) {
  const game = useChatStore((s) => s.games?.[roomId]);
  const members = useChatStore((s) => s.members?.[roomId] || []);
  const allUsers = useChatStore((s) => s.allUsers || []);
  const { user } = useAuthStore();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const board = game?.board || '---------';
  const cells = board.split('');
  const line = useMemo(() => winLine(board), [board]);
  const status = game?.status || 'playing';
  const turn = game?.turn || 'X';
  const myMark = user?.id === game?.player_x ? 'X' : user?.id === game?.player_o ? 'O' : null;
  const canPlay = status === 'playing'
    && (!game?.player_x || !game?.player_o || !!myMark);

  const move = async (i) => {
    if (!canPlay || cells[i] !== '-' || busy) return;
    setBusy(true);
    setErr('');
    try {
      // Socket first for instant sync; REST persists + broadcasts too.
      getSocket()?.emit('game:move', { roomId, index: i });
      const { game: g } = await api.gameMove(roomId, i);
      if (g) useChatStore.getState().setGame(roomId, g);
    } catch (e) {
      setErr(e.message || 'Could not move');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setErr('');
    try {
      getSocket()?.emit('game:reset', { roomId });
      const { game: g } = await api.resetGame(roomId);
      if (g) useChatStore.getState().setGame(roomId, g);
    } catch (e) {
      setErr(e.message || 'Could not reset');
    } finally {
      setBusy(false);
    }
  };

  const statusText = status === 'won'
    ? `🏆 ${(game.winner === 'X' ? nameOf(members, allUsers, game.player_x) : nameOf(members, allUsers, game.player_o))} (${game.winner}) wins!`
    : status === 'draw'
      ? `🤝 Draw — reset to play again`
      : !game?.player_x
        ? `❌⭕ Be the first to move (you'll be X)`
        : turn === myMark
          ? `Your turn (${myMark})`
          : myMark
            ? `${nameOf(members, allUsers, turn === 'X' ? game.player_x : game.player_o)} (${turn}) to move`
            : turn === 'X'
              ? `X (${nameOf(members, allUsers, game.player_x)}) to move`
              : game?.player_o
                ? `O (${nameOf(members, allUsers, game.player_o)}) to move`
                : `O to move — jump in to claim O!`;

  return (
    <div className="ttt-card">
      <button className="ttt-header" onClick={() => setOpen((v) => !v)} title={open ? 'Hide game' : 'Show game'}>
        <span>❌⭕ Tic-tac-toe</span>
        <span className="ttt-status-mini">
          {status === 'won' ? `🏆 ${game.winner}` : status === 'draw' ? '🤝' : `${turn} to move`}
        </span>
        <span className="ttt-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="ttt-body">
          <div className="ttt-board">
            {cells.map((v, i) => (
              <button
                key={i}
                className={`ttt-cell ${v !== '-' ? 'taken' : ''} ${line?.includes(i) ? 'win' : ''}`}
                onClick={() => move(i)}
                disabled={v !== '-' || status !== 'playing' || busy}
                title={v === '-' ? `Play square ${i + 1}` : v}
              >
                {v === '-' ? '' : v}
              </button>
            ))}
          </div>
          <div className="ttt-status">{statusText}</div>
          <div className="ttt-players">
            <span>X: {game?.player_x ? nameOf(members, allUsers, game.player_x) : '—'}</span>
            <span>O: {game?.player_o ? nameOf(members, allUsers, game.player_o) : '—'}</span>
            {myMark && <span className="code-chip small">you are {myMark}</span>}
          </div>
          {err && <div className="form-error" style={{ margin: '6px 0 0' }}>{err}</div>}
          <button className="btn-mini" onClick={reset} disabled={busy} title="Clear the board">
            ↺ New game
          </button>
        </div>
      )}
    </div>
  );
}
