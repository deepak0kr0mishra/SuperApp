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
  const [reports, setReports] = useState([]);
  const [voice, setVoice] = useState([]);
  const [mutes, setMutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [msgQuery, setMsgQuery] = useState('');

  const [newChannel, setNewChannel] = useState('');
  const [newVoice, setNewVoice] = useState('');
  const [renameId, setRenameId] = useState(null);
  const [renameVal, setRenameVal] = useState('');

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const [{ stats: s }, { users: u }, { rooms: r }, { messages: m }, { reports: rep }, vc, { mutes: mu }] = await Promise.all([
        api.adminStats(),
        api.adminGetUsers(),
        api.adminGetRooms(),
        api.adminRecentMessages(),
        api.adminGetReports().catch(() => ({ reports: [] })),
        api.adminGetVoice().catch(() => ({ channels: [] })),
        api.adminGetMutes().catch(() => ({ mutes: [] })),
      ]);
      setStats(s);
      setUsers(u);
      setRooms(r);
      setMessages(m);
      setReports(rep || []);
      setVoice(vc.channels || []);
      setMutes(mu || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const flash = (m) => {
    setActionMsg(m);
    setTimeout(() => setActionMsg(''), 3000);
  };

  const searchUsers = async (e) => {
    e?.preventDefault();
    try {
      const { users: u } = await api.adminGetUsers(userQuery.trim());
      setUsers(u);
    } catch (err) { flash(err.message); }
  };

  const searchMessages = async (e) => {
    e?.preventDefault();
    try {
      const { messages: m } = await api.adminRecentMessages(msgQuery.trim());
      setMessages(m);
    } catch (err) { flash(err.message); }
  };

  const handleRole = async (u, role) => {
    try {
      await api.adminSetRole(u.id, role);
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, role } : x));
      flash(`${u.username} → ${role}`);
    } catch (err) { flash(err.message); }
  };

  const handleDisable = async (u) => {
    try {
      if (u.is_disabled) {
        await api.adminEnableUser(u.id);
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, is_disabled: 0 } : x));
        flash(`Enabled @${u.username}`);
      } else {
        if (!confirm(`Disable @${u.username}? They will be logged out and blocked.`)) return;
        await api.adminDisableUser(u.id);
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, is_disabled: 1 } : x));
        flash(`Disabled @${u.username}`);
      }
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

  const handleResetPassword = async (u) => {
    const np = prompt(`New password for @${u.username} (min 6 characters):`);
    if (!np) return;
    try {
      await api.adminResetPassword(u.id, np);
      flash(`Password reset for @${u.username}`);
    } catch (err) { flash(err.message); }
  };

  const handleCreateChannel = async (e) => {
    e?.preventDefault();
    if (!newChannel.trim()) return;
    try {
      const { room } = await api.adminCreateRoom(newChannel.trim(), '');
      setRooms(prev => [...prev, { ...room, memberCount: 1, msgCount: 0 }]);
      getSocket()?.emit('room:created', room);
      setNewChannel('');
      flash(`Created #${room.name}`);
    } catch (err) { flash(err.message); }
  };

  const handleRenameRoom = async (id) => {
    if (!renameVal.trim()) { setRenameId(null); return; }
    try {
      const { room } = await api.adminRenameRoom(id, { name: renameVal.trim() });
      setRooms(prev => prev.map(x => x.id === id ? { ...x, name: room.name } : x));
      setRenameId(null);
      flash(`Renamed → #${room.name}`);
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

  const handleCreateVoice = async (e) => {
    e?.preventDefault();
    if (!newVoice.trim()) return;
    try {
      const { channel } = await api.adminCreateVoice(newVoice.trim(), '');
      setVoice(prev => [...prev, channel]);
      setNewVoice('');
      flash(`Voice channel created`);
    } catch (err) { flash(err.message); }
  };

  const handleDeleteVoice = async (id) => {
    try {
      await api.adminDeleteVoice(id);
      setVoice(prev => prev.filter(x => x.id !== id));
      flash('Voice channel deleted');
    } catch (err) { flash(err.message); }
  };

  const handleDeleteMessage = async (m) => {
    try {
      const res = await api.adminDeleteMessage(m.id);
      setMessages(prev => prev.filter(x => x.id !== m.id));
      // Live-remove for everyone currently in the room
      getSocket()?.emit('message:delete', { messageId: m.id, roomId: res.room_id || m.room_id });
      flash(`Message removed`);
    } catch (err) { flash(err.message); }
  };

  const handleMute = async (u, kind) => {
    const duration = prompt(`Mute @${u.username} (${kind}) — duration? hour/day/week`, 'day');
    if (!duration || !['hour', 'day', 'week'].includes(duration)) return;
    try {
      await api.adminMuteUser(u.id, kind, duration, '');
      const { mutes: mu } = await api.adminGetMutes().catch(() => ({ mutes: [] }));
      setMutes(mu || []);
      flash(`${kind === 'voice' ? '🔇 Voice-muted' : '🚫 Chat-muted'} @${u.username} for ${duration}`);
    } catch (err) { flash(err.message); }
  };

  const handleUnmute = async (userId, kind) => {
    try {
      await api.adminUnmuteUser(userId, kind);
      setMutes(prev => prev.filter(x => !(x.user_id === userId && x.kind === kind)));
      flash(`Unmuted (${kind})`);
    } catch (err) { flash(err.message); }
  };

  const handleRemoveMember = async (roomId, userId, username) => {
    if (!confirm(`Remove @${username} from this room?`)) return;
    try {
      await api.adminRemoveMember(roomId, userId);
      const { rooms: r } = await api.adminGetRooms().catch(() => ({ rooms: [] }));
      if (r?.length) setRooms(r);
      flash(`Removed @${username}`);
    } catch (err) { flash(err.message); }
  };



  const handleReport = async (r, action) => {    try {
      await api.adminResolveReport(r.id, action);
      setReports(prev => prev.map(x => x.id === r.id
        ? { ...x, status: action === 'dismiss' ? 'dismissed' : 'resolved' }
        : x));
      if (action === 'delete_message' && r.message_id) {
        setMessages(prev => prev.filter(x => x.id !== r.message_id));
        if (r.room_id) getSocket()?.emit('message:delete', { messageId: r.message_id, roomId: r.room_id });
      }
      flash(`Report ${action === 'dismiss' ? 'dismissed' : 'resolved'}`);
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

  const openReports = reports.filter(r => r.status === 'open');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">🛡️ Command Deck <span className="admin-chip">ADMIN</span></div>
          <button id="close-admin-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="admin-tabs">
          {['overview', 'users', 'spaces', 'mutes', 'voice', 'messages', 'reports'].map(t => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'overview' ? '📊 Overview'
                : t === 'users' ? '👥 Users'
                : t === 'spaces' ? '✨ Spaces'
                : t === 'mutes' ? `🔇 Mutes${mutes.length ? ` (${mutes.length})` : ''}`
                : t === 'voice' ? '🔊 Voice'
                : t === 'messages' ? '💬 Messages'
                : `⚑ Reports${openReports.length ? ` (${openReports.length})` : ''}`}
            </button>
          ))}
        </div>

        {actionMsg && <div className="admin-flash">{actionMsg}</div>}
        {error && <div className="form-error">⚠️ {error}</div>}

        <div className="admin-body">
        {loading ? (
          <div className="admin-loading"><span className="spinner" /> Loading command deck…</div>
        ) : (
          <>
            {tab === 'overview' && stats && (
              <div className="admin-stats-grid">
                <div className="admin-stat"><div className="admin-stat-num">{stats.users}</div><div className="admin-stat-label">👥 Total users</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.online}</div><div className="admin-stat-label">🟢 Online</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.messages}</div><div className="admin-stat-label">💬 Total messages</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.messagesToday ?? 0}</div><div className="admin-stat-label">📅 Today</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.rooms}</div><div className="admin-stat-label">✨ Spaces</div></div>
                <div className="admin-stat"><div className="admin-stat-num">{stats.activeConversations ?? 0}</div><div className="admin-stat-label">🔥 Active (7d)</div></div>
                <div className="admin-hint">10 slots: Admin_01…Admin_05 fixed + up to 5 promotable. Admin passwords can't be reset — each admin changes their own in Profile.</div>

              </div>
            )}

            {tab === 'users' && (
              <div className="admin-list">
                <form className="admin-search" onSubmit={searchUsers}>
                  <input
                    className="form-input"
                    placeholder="Search username, UID, email…"
                    value={userQuery}
                    onChange={e => setUserQuery(e.target.value)}
                  />
                  <button className="btn-mini primary" type="submit">Search</button>
                </form>
                {users.map(u => (
                  <div key={u.id} className="admin-row">
                    <div className="avatar avatar-sm" style={{ background: u.avatar_color }}>{(u.display_name || u.username)[0].toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">
                        {u.display_name || u.username} {u.role === 'admin' && <span className="admin-chip">ADMIN</span>}
                        {u.is_disabled ? <span className="admin-chip" style={{ background: 'var(--danger)' }}>DISABLED</span> : null}
                      </div>
                      <div className="admin-row-sub">@{u.username} • UID {u.uid || u.user_code} • {u.status}</div>
                    </div>
                    {u.id !== user.id ? (
                      <div className="admin-row-actions">
                        {u.role === 'admin'
                          ? <button className="btn-mini" onClick={() => handleRole(u, 'user')}>Demote</button>
                          : <button className="btn-mini primary" onClick={() => handleRole(u, 'admin')}>Make admin</button>}
                        {u.role !== 'admin' && (
                          <>
                            <button className="btn-mini" onClick={() => handleResetPassword(u)}>Reset PW</button>
                            <button className="btn-mini" title="Voice-mute (listen only)" onClick={() => handleMute(u, 'voice')}>🔇</button>
                            <button className="btn-mini" title="Chat-mute (DMs only)" onClick={() => handleMute(u, 'chat')}>🚫</button>
                          </>
                        )}
                        <button className="btn-mini" onClick={() => handleDisable(u)}>{u.is_disabled ? 'Enable' : 'Disable'}</button>
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
                <form className="admin-search" onSubmit={handleCreateChannel}>
                  <input
                    className="form-input"
                    placeholder="New space name…"
                    value={newChannel}
                    onChange={e => setNewChannel(e.target.value)}
                    maxLength={40}
                  />
                  <button className="btn-mini primary" type="submit">Create</button>
                </form>
                {rooms.map(r => (
                  <div key={r.id} className="admin-row">
                    <div style={{ fontSize: 20 }}>{r.type === 'dm' ? '💫' : '✦'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renameId === r.id ? (
                        <span style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="form-input"
                            value={renameVal}
                            onChange={e => setRenameVal(e.target.value)}
                            maxLength={40}
                            autoFocus
                          />
                          <button className="btn-mini primary" onClick={() => handleRenameRoom(r.id)}>Save</button>
                          <button className="btn-mini" onClick={() => setRenameId(null)}>✕</button>
                        </span>
                      ) : (
                        <>
                          <div className="admin-row-title">#{r.name} <span className="admin-row-sub">({r.type}{r.max_members ? ` · voice max ${r.max_members}` : ''})</span></div>
                          <div className="admin-row-sub">{r.memberCount ?? '?'} members • {r.msgCount ?? '?'} msgs</div>
                        </>
                      )}
                    </div>
                    {['general', 'developers', 'creatives', 'chill-01', 'chill-02'].includes(r.id)
                      ? <span className="admin-row-sub">protected</span>
                      : r.type !== 'dm' && renameId !== r.id && (
                        <span className="admin-row-actions">
                          <button className="btn-mini" onClick={() => { setRenameId(r.id); setRenameVal(r.name); }}>Rename</button>
                          <button className="btn-mini danger" onClick={() => handleDeleteRoom(r)}>Delete</button>
                        </span>
                      )}
                  </div>
                ))}
              </div>
            )}

            {tab === 'mutes' && (
              <div className="admin-list">
                <div className="admin-hint">🔇 voice = listen-only in calls · 🚫 chat = DMs only. Hour / day / week, revokable anytime. Admins can't be muted.</div>
                {mutes.map((m) => (
                  <div key={`${m.user_id}:${m.kind}`} className="admin-row">
                    <div style={{ fontSize: 20 }}>{m.kind === 'voice' ? '🔇' : '🚫'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">@{m.username || m.user_id} <span className="admin-chip">{m.kind}</span></div>
                      <div className="admin-row-sub">
                        until {m.expires_at ? new Date(m.expires_at * 1000).toLocaleString() : '?'}
                        {m.reason ? ` · ${m.reason}` : ''}
                      </div>
                    </div>
                    <button className="btn-mini primary" onClick={() => handleUnmute(m.user_id, m.kind)}>Unmute</button>
                  </div>
                ))}
                {mutes.length === 0 && <div className="sidebar-empty">Nobody muted 🎉</div>}
              </div>
            )}

            {tab === 'voice' && (
              <div className="admin-list">
                <form className="admin-search" onSubmit={handleCreateVoice}>
                  <input
                    className="form-input"
                    placeholder="New voice channel…"
                    value={newVoice}
                    onChange={e => setNewVoice(e.target.value)}
                    maxLength={40}
                  />
                  <button className="btn-mini primary" type="submit">Create</button>
                </form>
                {voice.map(v => (
                  <div key={v.id} className="admin-row">
                    <div style={{ fontSize: 20 }}>🔊</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">{v.name}</div>
                      <div className="admin-row-sub">{v.description || v.id}</div>
                    </div>
                    <button className="btn-mini danger" onClick={() => handleDeleteVoice(v.id)}>Delete</button>
                  </div>
                ))}
                {voice.length === 0 && <div className="sidebar-empty">No voice channels</div>}
              </div>
            )}

            {tab === 'messages' && (
              <div className="admin-list">
                <form className="admin-search" onSubmit={searchMessages}>
                  <input
                    className="form-input"
                    placeholder="Search messages…"
                    value={msgQuery}
                    onChange={e => setMsgQuery(e.target.value)}
                  />
                  <button className="btn-mini primary" type="submit">Search</button>
                </form>
                {messages.map(m => (
                  <div key={m.id} className="admin-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">@{m.username} <span className="admin-row-sub">in #{m.room_name || m.room_id}</span></div>
                      <div className="admin-row-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {(m.content || '').slice(0, 120)}
                      </div>
                      <div className="admin-row-sub">{m.created_at ? new Date(m.created_at * 1000).toLocaleString() : ''} • {m.type}</div>
                    </div>
                    <button className="btn-mini danger" onClick={() => handleDeleteMessage(m)}>Remove</button>
                  </div>
                ))}
                {messages.length === 0 && <div className="sidebar-empty">No messages yet</div>}
              </div>
            )}

            {tab === 'reports' && (
              <div className="admin-list">
                {reports.map(r => (
                  <div key={r.id} className="admin-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="admin-row-title">
                        ⚑ {r.reporter_name || 'Someone'} reported
                        <span className="admin-chip" style={{ marginLeft: 6 }}>{r.status}</span>
                      </div>
                      <div className="admin-row-sub" style={{ whiteSpace: 'normal' }}>{r.reason}</div>
                      <div className="admin-row-sub">{r.created_at ? new Date(r.created_at * 1000).toLocaleString() : ''}</div>
                    </div>
                    {r.status === 'open' && (
                      <div className="admin-row-actions">
                        {r.message_id && <button className="btn-mini danger" onClick={() => handleReport(r, 'delete_message')}>Delete msg</button>}
                        {r.target_user_id && <button className="btn-mini" onClick={() => handleReport(r, 'disable_user')}>Disable user</button>}
                        <button className="btn-mini" onClick={() => handleReport(r, 'dismiss')}>Dismiss</button>
                      </div>
                    )}
                  </div>
                ))}
                {reports.length === 0 && <div className="sidebar-empty">No reports 🎉</div>}
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
