import React, { useEffect, useState } from 'react';
import { api } from '../../services/api.js';
import { useAuthStore } from '../../stores/authStore.js';
import { getSocket } from '../../services/socket.js';

export default function AdminDashboard({ onClose }) {
  const { user } = useAuthStore();
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [{ stats }, { users }, { rooms }, { messages }] = await Promise.all([
          api.adminStats(),
          api.adminGetUsers(),
          api.adminGetRooms(),
          api.adminRecentMessages(),
        ]);
        setStats(stats);
        setUsers(users);
        setRooms(rooms);
        setMessages(messages);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const flash = (m) => {
    setActionMsg(m);
    setTimeout(() => setActionMsg(''), 3000);
  };

  const handleRole = async (u, role) => {
    try {
      await api.adminSetRole(u.id, role);
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, role } : x));
      flash(`${u.username} → ${role}`);
    } catch (err) { flash(err.message); }
  };

  const handleDeleteUser = async (u) => {
    if (!confirm(`Delete user @${u.username}? Their messages will be removed.`)) return;
    try {
      await api.adminDeleteUser(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      flash(`Deleted @${u.username}`);
    } catch (err) { flash(err.message); }
  };

  const handleDeleteRoom = async (r) => {
    if (!confirm(`Delete space #${r.name}?`)) return;
    try {
      await api.adminDeleteRoom(r.id);
      setRooms(prev => prev.filter(x => x.id !== r.id));
      flash(`Deleted #${r.name}`);
    } catch (err) { flash(err.message); }
  };

  const handleDeleteMessage = async (m) => {
    try {
      const res = await api.adminDeleteMessage(m.id);
      setMessages(prev => prev.filter(x => x.id !== m.id));
      // Live-remove for everyone currently in the room
      getSocket()?.emit('message:delete', { messageId: m.id, roomId: res.room_id || m.room_id });
      // Also emit locally via socket broadcast will come back; ensure immediate UI:
      flash(`Message removed`);
    } catch (err) { flash(err.message); }
  };

  if (user?.role !== 'admin') {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><div className="modal-title">🛡️ Admin</div><button className="icon-btn" onClick={onClose}>✕</button></div>
          <div style={{ color: 'var(--danger)' }}>Admin only. Ask an admin to promote you.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">🛡️ Command Deck <span className="admin-chip">ADMIN</span></div>
          <button id="close-admin-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="admin-tabs">
          {['overview', 'users', 'spaces', 'messages'].map(t => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'overview' ? '📊 Overview' : t === 'users' ? '👥 Users' : t === 'spaces' ? '✨ Spaces' : '💬 Messages'}
            </button>
          ))}
        </div>

        {actionMsg && <div className="admin-flash">{actionMsg}</div>}
        {error && <div className="form-error">⚠️ {error}</div>}

        {loading ? (
          <div className="admin-loading"><span className="spinner" /> Loading command deck…</div>
        ) : (
          <>
            {tab === 'overview' && stats && (
              <div className="admin-stats-grid">
                <div className="admin-stat"><div className="admin-stat-num">{stats.users}</div><div className="admin-stat-label">👥 Users</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.online}</div><div className="admin-stat-label">🟢 Online</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.rooms}</div><div className="admin-stat-label">✨ Spaces</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.messages}</div><div className="admin-stat-label">💬 Messages</div></div>
                <div className="admin-hint">Tip: first registered user is auto-admin. Promote others in Users tab.</div>
              </div>
            )}

            {tab === 'users' && (
              <div className="admin-list">
                {users.map(u => (
                  <div key={u.id} className="admin-row">
                    <div className="avatar avatar-sm" style={{ background: u.avatar_color }}>{(u.display_name || u.username)[0].toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">{u.display_name || u.username} {u.role === 'admin' && <span className="admin-chip">ADMIN</span>}</div>
                      <div className="admin-row-sub">@{u.username} • #{u.user_code} • {u.status}</div>
                    </div>
                    {u.id !== user.id ? (
                      <div className="admin-row-actions">
                        {u.role === 'admin'
                          ? <button className="btn-mini" onClick={() => handleRole(u, 'user')}>Demote</button>
                          : <button className="btn-mini primary" onClick={() => handleRole(u, 'admin')}>Make admin</button>}
                        <button className="btn-mini danger" onClick={() => handleDeleteUser(u)}>Delete</button>
                      </div>
                    ) : (
                      <span className="admin-row-sub">you</span>
                    )}
                  </div>
                ))}
                {users.length === 0 && <div className="sidebar-empty">No users</div>}
              </div>
            )}

            {tab === 'spaces' && (
              <div className="admin-list">
                {rooms.map(r => (
                  <div key={r.id} className="admin-row">
                    <div style={{ fontSize: 20 }}>{r.type === 'dm' ? '💫' : '✦'}</div>
                    <div style={{ flex: 1 }}>
                      <div className="admin-row-title">#{r.name} <span className="admin-row-sub">({r.type})</span></div>
                      <div className="admin-row-sub">{r.memberCount ?? '?'} members • {r.msgCount ?? '?'} msgs</div>
                    </div>
                    {['general', 'media', 'audio', 'random'].includes(r.id)
                      ? <span className="admin-row-sub">protected</span>
                      : r.type !== 'dm' && <button className="btn-mini danger" onClick={() => handleDeleteRoom(r)}>Delete</button>}
                  </div>
                ))}
              </div>
            )}

            {tab === 'messages' && (
              <div className="admin-list">
                {messages.map(m => (
                  <div key={m.id} className="admin-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">@{m.username} <span className="admin-row-sub">in #{m.room_name || m.room_id}</span></div>
                      <div className="admin-row-sub">{new Date(m.created_at * 1000).toLocaleString()} • {m.type}</div>
                    </div>
                    <button className="btn-mini danger" onClick={() => handleDeleteMessage(m)}>Remove</button>
                  </div>
                ))}
                {messages.length === 0 && <div className="sidebar-empty">No messages yet</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
