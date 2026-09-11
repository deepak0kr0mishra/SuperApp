import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';

function RowAvatar({ name = '?', color = '#6366f1', size = 40, status }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.25,
      background: color, position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, color: 'white', fontSize: size * 0.38, flexShrink: 0,
    }}>
      {name[0].toUpperCase()}
      {status && (
        <span style={{
          position: 'absolute', bottom: -2, right: -2, width: 10, height: 10,
          borderRadius: '50%', border: '2px solid var(--bg-elevated)',
          background: status === 'online' ? 'var(--success)' : 'var(--text-muted)',
        }} />
      )}
    </div>
  );
}

// Find people -> tap to open a normal 1:1 chat (like WhatsApp).
export default function UserSearch({ onClose, onOpenDM }) {
  const [search, setSearch] = useState('');
  const [serverResults, setServerResults] = useState(null);
  const [openingId, setOpeningId] = useState(null);
  const [error, setError] = useState('');

  const { user } = useAuthStore();
  const { allUsers, addRoom, setActiveRoom, setMembers } = useChatStore();
  const socket = getSocket();

  useEffect(() => {
    const q = search.trim();
    if (!q) { setServerResults(null); return; }
    const t = setTimeout(async () => {
      try {
        const { users } = await api.searchUsers(q);
        setServerResults(users);
      } catch { /* fall back to local */ }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const source = serverResults || allUsers;
  const qLower = search.trim().toLowerCase();
  const filtered = source.filter(u => {
    if (u.id === user?.id) return false;
    if (!qLower) return true;
    const hashIdx = qLower.indexOf('#');
    if (hashIdx >= 0) {
      const namePart = qLower.slice(0, hashIdx);
      const codePart = qLower.slice(hashIdx + 1).toUpperCase();
      const nameOk = !namePart || u.username.toLowerCase().includes(namePart) || (u.display_name || '').toLowerCase().includes(namePart);
      const codeOk = !codePart || (u.user_code || '').toUpperCase().includes(codePart) || (u.uid || '').toUpperCase().includes(codePart);
      return nameOk && codeOk;
    }
    return (
      u.username.toLowerCase().includes(qLower) ||
      (u.display_name || '').toLowerCase().includes(qLower) ||
      (u.user_code || '').toLowerCase().includes(qLower.replace('#', '')) ||
      (u.uid || '').toLowerCase().includes(qLower) ||
      (u.email || '').toLowerCase().includes(qLower)
    );
  });

  const openChat = async (targetUser) => {
    setOpeningId(targetUser.id);
    setError('');
    try {
      const { room } = await api.createDM(targetUser.id);
      addRoom(room);
      socket?.emit('room:join', { roomId: room.id });
      try {
        const { members } = await api.getMembers(room.id);
        setMembers(room.id, members);
      } catch {}
      setActiveRoom(room.id);
      onOpenDM?.(room);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not open chat');
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal search-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">💬 New chat</div>
          <button id="close-user-search" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <input
          id="user-search-input"
          className="form-input"
          placeholder="Search name, @username, UID, or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
        <div className="search-tip">Tap anyone to open a 1:1 chat. Share your UID <b>{user?.uid || user?.user_code}</b> to be found.</div>
        {error && <div className="form-error" style={{ marginTop: 10 }}>{error}</div>}
        <div className="search-list">
          {filtered.length === 0 ? (
            <div className="search-empty">{search ? 'No people found' : 'Start typing to search everyone…'}</div>
          ) : (
            filtered.map(u => (
              <button
                key={u.id}
                id={`search-user-${u.id}`}
                className="search-row"
                onClick={() => openChat(u)}
                disabled={openingId === u.id}
              >
                <RowAvatar name={u.display_name || u.username} color={u.avatar_color || '#6366f1'} status={u.status} />
                <span className="search-row-text">
                  <span className="search-row-name">
                    {u.display_name || u.username}
                    {(u.uid || u.user_code) && <span className="code-chip">{u.uid || `#${u.user_code}`}</span>}
                  </span>
                  <span className="search-row-sub">@{u.username}{u.bio ? ` • ${u.bio.slice(0, 40)}` : ''}</span>
                </span>
                <span className="search-row-cta">{openingId === u.id ? '…' : '💬'}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
