import React, { useMemo, useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore, messageText } from '../../stores/chatStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';

export const VOICE_CHANNELS = [
  { id: 'general', name: 'general', emoji: '🔊' },
  { id: 'developers', name: 'Developers', emoji: '🔊' },
  { id: 'creatives', name: 'Creatives', emoji: '🔊' },
  { id: 'chill-01', name: 'Chill_01', emoji: '🔊' },
  { id: 'chill-02', name: 'Chill_02', emoji: '🔊' },
];

const CHANNEL_ICONS = {
  general: '🍵',
  developers: '💻',
  creatives: '🎨',
  chill_01: '☕',
  'chill-01': '☕',
  chill_02: '☕',
  'chill-02': '☕',
};

function channelIcon(name) {
  const key = String(name || '').toLowerCase().replace('-', '_');
  if (CHANNEL_ICONS[key]) return CHANNEL_ICONS[key];
  return CHANNEL_ICONS[String(name || '').toLowerCase()] || '✦';
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
  const { rooms, activeRoomId, unread, allUsers, userStatuses, members, messages } = useChatStore();
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
  const { currentChannelId, voiceChannelMembers, isMuted, voiceMuted, toggleMute } = useVoiceStore();
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

  const isAdmin = user?.role === 'admin';

  // Text chat is unlimited — occupancy shows the member count only.
  // The voice call cap (room.max_members) is shown on the 🔊 live count.
  const occupancyOf = (room) => {
    const count = members[room.id]?.length ?? room.memberCount ?? 0;
    return `${count}`;
  };
  const voiceCountOf = (room, live) => {
    if (!live || live.length === 0) return null;
    return room.max_members ? `🔊${live.length}/${room.max_members}` : `🔊${live.length}`;
  };

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
          </>
        ) : (
          <>
            <div className="sidebar-section-title">
              <span>✨ Spaces</span>
              {isAdmin && (
                <button id="create-channel-btn" className="sidebar-section-btn" onClick={onCreateRoom} title="Create space">+</button>
              )}
            </div>
            {filteredChannels.length === 0 && <div className="sidebar-empty">No spaces yet</div>}
            {filteredChannels.map(room => {
              const vmembers = voiceChannelMembers[room.id] || [];
              return (
                <div
                  key={room.id}
                  id={`channel-${room.id}`}
                  className={`channel-item ${activeRoomId === room.id ? 'active' : ''}`}
                  onClick={() => onRoomSelect(room.id)}
                  title={room.description || room.name}
                >
                  <span className="channel-icon">{channelIcon(room.name)}</span>
                  <span className="channel-name">{room.name}</span>
                  <span className="channel-occupancy" title={room.max_members ? `Voice limit ${room.max_members}` : 'Unlimited'}>
                    {occupancyOf(room)}
                  </span>
                  {voiceCountOf(room, vmembers) && <span className="voice-count" title={`${vmembers.length} in call${room.max_members ? ` (limit ${room.max_members})` : ''}`}>{voiceCountOf(room, vmembers)}</span>}
                  {unread[room.id] > 0 && <span className="channel-badge">{unread[room.id]}</span>}
                </div>
              );
            })}
            {filteredChannels.map(() => null)}
          </>
        )}
      </div>

      <div className="sidebar-user-actions">
        {isAdmin && (
          <button id="sidebar-admin-btn" className="icon-btn" onClick={onOpenAdmin} title="Admin dashboard">🛡️</button>
        )}
        {currentChannelId && (
          <button id="sidebar-mute-btn" className={`icon-btn ${isMuted ? 'danger' : ''}`} onClick={(e) => { e.stopPropagation(); toggleMute(); }} title={voiceMuted ? 'Voice-muted by admin (listen only)' : isMuted ? 'Unmute' : 'Mute'}>
            {isMuted ? '🔇' : '🎙️'}
          </button>
        )}
        <button id="sidebar-theme-btn" className="icon-btn" onClick={toggleTheme} title={theme === 'light' ? 'Dark mode' : 'Light mode'}>
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        <button id="sidebar-logout-btn" className="icon-btn danger" onClick={logout} title="Log out" aria-label="Log out">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
      <div className="sidebar-user">
        <div style={{ cursor: 'pointer', display: 'flex' }} onClick={onOpenProfile} title="My profile">
          <Avatar name={user?.display_name || user?.username || '?'} color={user?.avatar_color || '#6366f1'} size="md" status="online" />
        </div>
        <div className="sidebar-user-info" onClick={onOpenProfile} style={{ cursor: 'pointer' }} title="Open profile">
          <div className="sidebar-user-name">{user?.display_name || user?.username}</div>
          <div className="sidebar-user-status" title={user?.uid ? `UID ${user.uid}` : undefined}>
            Online {isAdmin ? <span className="admin-chip">ADMIN</span> : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
