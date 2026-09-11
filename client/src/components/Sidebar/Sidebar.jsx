import React, { useMemo, useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore, messageText } from '../../stores/chatStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';

export const VOICE_CHANNELS = [
  { id: 'voice-general', name: 'General', emoji: '🔊' },
  { id: 'voice-gaming', name: 'Gaming', emoji: '🔊' },
  { id: 'voice-study', name: 'Study Room', emoji: '🔊' },
];

const CHANNEL_ICONS = {
  general: '🍵',
  media: '🎨',
  audio: '🎧',
  random: '⚡',
};

function channelIcon(name) {
  return CHANNEL_ICONS[(name || '').toLowerCase()] || '✦';
}

function previewOf(msg) {
  if (!msg) return 'No messages yet';
  if (msg.type === 'image') return `🖼️ ${msg.file_name || 'Photo'}`;
  if (msg.type === 'video') return `🎬 ${msg.file_name || 'Video'}`;
  if (msg.type === 'audio') return `🎵 ${msg.file_name || 'Voice note'}`;
  if (msg.type === 'file') return `📎 ${msg.file_name || 'File'}`;
  const t = messageText(msg);
  return t.length > 42 ? t.slice(0, 42) + '…' : (t || 'No messages yet');
}

export default function Sidebar({ activeTab, onTabChange, onCreateRoom, onOpenDM, onOpenSearch, onOpenProfile, onOpenAdmin, onRoomSelect }) {
  const { user, logout } = useAuthStore();
  const { rooms, activeRoomId, unread, allUsers, userStatuses, members, messages, voiceChannels } = useChatStore();
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('teachat_theme') || 'light'; } catch { return 'light'; }
  });

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try {
      localStorage.setItem('teachat_theme', next);
      document.documentElement.dataset.theme = next;
    } catch {}
  };
  const { currentChannelId, voiceChannelMembers, speakingUsers, joinVoiceChannel, leaveVoiceChannel, isMuted, toggleMute } = useVoiceStore();
  const [filter, setFilter] = useState('');

  const channels = useMemo(() => rooms.filter(r => r.type === 'channel'), [rooms]);
  const dms = useMemo(() => {
    const list = rooms.filter(r => r.type === 'dm');
    // Sort by last activity (newest first) like a normal chat app
    return [...list].sort((a, b) => {
      const ma = messages[a.id]?.[messages[a.id].length - 1]?.created_at || 0;
      const mb = messages[b.id]?.[messages[b.id].length - 1]?.created_at || 0;
      return mb - ma;
    });
  }, [rooms, messages]);

  const q = filter.trim().toLowerCase();

  const resolvePeer = (room) => {
    const roomMembers = members[room.id] || [];
    let peer = roomMembers.find(m => m.id !== user?.id) || null;
    if (!peer) {
      // Fallback for rooms whose members haven't loaded yet
      const me = allUsers.find(u => u.id === user?.id);
      const parts = String(room.name || '').split('-');
      const otherName = parts.find(p => p && p !== me?.username);
      peer = allUsers.find(u => u.username === otherName) || null;
    }
    return peer;
  };

  const peerStatus = (peer) => {
    if (!peer) return 'offline';
    return userStatuses[peer.id] || peer.status || 'offline';
  };

  const filteredDMs = q
    ? dms.filter(room => {
        const peer = resolvePeer(room);
        const name = (peer?.display_name || peer?.username || room.name || '').toLowerCase();
        const uname = (peer?.username || '').toLowerCase();
        const code = (peer?.user_code || '').toLowerCase();
        const uid = (peer?.uid || '').toLowerCase();
        const email = (peer?.email || '').toLowerCase();
        return name.includes(q) || uname.includes(q) || code.includes(q) || uid.includes(q) || email.includes(q);
      })
    : dms;

  const filteredChannels = q
    ? channels.filter(r => (r.name || '').toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    : channels;

  const totalUnreadDMs = dms.reduce((n, r) => n + (unread[r.id] || 0), 0);

  const handleVoiceJoin = async (channelId) => {
    if (currentChannelId === channelId) leaveVoiceChannel();
    else {
      try { await joinVoiceChannel(channelId); }
      catch (err) { console.error('Voice join error:', err); }
    }
  };

  const isAdmin = user?.role === 'admin';

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🍵</div>
          <div>
            <div className="sidebar-logo-text">TeaChat</div>
            <div className="sidebar-logo-sub">warm chats</div>
          </div>
        </div>
        <button id="sidebar-search-btn" className="icon-btn" onClick={onOpenSearch} title="Find people">🔍</button>
      </div>

      {/* Chats / Spaces tabs like a normal chat app */}
      <div className="sidebar-tabs">
        <button className={`sidebar-tab ${activeTab === 'chats' ? 'active' : ''}`} onClick={() => onTabChange?.('chats')}>
          💬 Chats {totalUnreadDMs > 0 && <span className="tab-badge">{totalUnreadDMs}</span>}
        </button>
        <button className={`sidebar-tab ${activeTab === 'spaces' ? 'active' : ''}`} onClick={() => onTabChange?.('spaces')}>
          ✨ Spaces
        </button>
      </div>

      <div className="sidebar-filter">
        <input
          className="sidebar-filter-input"
          placeholder={activeTab === 'chats' ? 'Search chats…' : 'Search spaces…'}
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      <div className="sidebar-content">
        {activeTab === 'chats' ? (
          <>
            <div className="sidebar-section-title">
              <span>💬 Direct messages</span>
              <button id="new-dm-btn" className="sidebar-section-btn" onClick={onOpenDM} title="New chat">+</button>
            </div>
            {filteredDMs.length === 0 && (
              <div className="sidebar-empty">
                {q ? 'No chats match your search' : <>No chats yet — tap <b>+</b> or 🔍 to start one</>}
              </div>
            )}
            {filteredDMs.map(room => {
              const peer = resolvePeer(room);
              const status = peerStatus(peer);
              const last = messages[room.id]?.[messages[room.id].length - 1];
              const label = peer ? (peer.display_name || peer.username) : room.name;
              return (
                <div
                  key={room.id}
                  id={`dm-${room.id}`}
                  className={`dm-item ${activeRoomId === room.id ? 'active' : ''}`}
                  onClick={() => onRoomSelect(room.id)}
                >
                  <Avatar name={label || '?'} color={peer?.avatar_color || '#6366f1'} size="md" status={status} />
                  <div className="dm-meta">
                    <div className="dm-top">
                      <span className="dm-name">{label}</span>
                      {last && <span className="dm-time">{new Date(last.created_at * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
                    </div>
                    <div className="dm-bottom">
                      <span className="dm-preview">
                        {last?.sender_id === user?.id ? 'You: ' : ''}{previewOf(last)}
                      </span>
                      {unread[room.id] > 0 && <span className="channel-badge">{unread[room.id]}</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Voice stays reachable but collapsed under chats */}
            <div className="sidebar-section-title" style={{ marginTop: 12 }}><span>🔊 Voice</span></div>
            {(voiceChannels?.length ? voiceChannels : VOICE_CHANNELS).map(vc => {
              const vmembers = voiceChannelMembers[vc.id] || [];
              const inChannel = currentChannelId === vc.id;
              return (
                <div key={vc.id} id={`voice-channel-${vc.id}`} className={`voice-channel-item ${inChannel ? 'in-channel' : ''}`} onClick={() => handleVoiceJoin(vc.id)}>
                  <div className={`voice-channel-header ${inChannel ? 'in-channel' : ''}`}>
                    <span>{vc.emoji}</span>
                    <span style={{ flex: 1 }}>{vc.name}</span>
                    {vmembers.length > 0 && <span className="voice-count">{vmembers.length}</span>}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="sidebar-section-title">
              <span>✨ Spaces</span>
              <button id="create-channel-btn" className="sidebar-section-btn" onClick={onCreateRoom} title="Create space">+</button>
            </div>
            {filteredChannels.length === 0 && <div className="sidebar-empty">No spaces yet — create one ✦</div>}
            {filteredChannels.map(room => (
              <div
                key={room.id}
                id={`channel-${room.id}`}
                className={`channel-item ${activeRoomId === room.id ? 'active' : ''}`}
                onClick={() => onRoomSelect(room.id)}
                title={room.description || room.name}
              >
                <span className="channel-icon">{channelIcon(room.name)}</span>
                <span className="channel-name">{room.name}</span>
                {unread[room.id] > 0 && <span className="channel-badge">{unread[room.id]}</span>}
              </div>
            ))}
            {filteredChannels.map(() => null)}
          </>
        )}
      </div>

      <div className="sidebar-user">
        <div style={{ cursor: 'pointer', display: 'flex' }} onClick={onOpenProfile} title="My profile">
          <Avatar name={user?.display_name || user?.username || '?'} color={user?.avatar_color || '#6366f1'} size="md" status="online" />
        </div>
        <div className="sidebar-user-info" onClick={onOpenProfile} style={{ cursor: 'pointer' }} title="Open profile">
          <div className="sidebar-user-name">{user?.display_name || user?.username}</div>
          <div className="sidebar-user-status">
            Online {user?.uid ? <span className="code-chip small">UID {user.uid}</span> : user?.user_code ? <span className="code-chip small">#{user.user_code}</span> : null} {isAdmin ? <span className="admin-chip">ADMIN</span> : null}
          </div>
        </div>
        {isAdmin && (
          <button id="sidebar-admin-btn" className="icon-btn" onClick={onOpenAdmin} title="Admin dashboard">🛡️</button>
        )}
        <button id="sidebar-theme-btn" className="icon-btn" onClick={toggleTheme} title={theme === 'light' ? 'Dark mode' : 'Light mode'}>
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        {currentChannelId && (
          <button id="sidebar-mute-btn" className={`icon-btn ${isMuted ? 'danger' : ''}`} onClick={(e) => { e.stopPropagation(); toggleMute(); }} title={isMuted ? 'Unmute' : 'Mute'}>
            {isMuted ? '🔇' : '🎙️'}
          </button>
        )}
        <button id="sidebar-logout-btn" className="icon-btn danger" onClick={logout} title="Log out">⏻</button>
      </div>
    </aside>
  );
}
