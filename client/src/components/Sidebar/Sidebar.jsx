import React from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';

export const VOICE_CHANNELS = [
  { id: 'vc-general', name: 'Nebula Lounge', emoji: '🌌' },
  { id: 'vc-gaming', name: 'Gaming Orbit', emoji: '🎮' },
  { id: 'vc-music', name: 'Music Comet', emoji: '🎧' },
];

const CHANNEL_ICONS = {
  general: '🌌',
  media: '🎨',
  audio: '🎧',
  random: '⚡',
};

function channelIcon(name) {
  return CHANNEL_ICONS[(name || '').toLowerCase()] || '✦';
}

export default function Sidebar({ onCreateRoom, onOpenDM, onOpenSearch, onOpenProfile, onOpenAdmin, onRoomSelect }) {
  const { user, logout } = useAuthStore();
  const { rooms, activeRoomId, unread, allUsers, userStatuses } = useChatStore();
  const { currentChannelId, voiceChannelMembers, speakingUsers, joinVoiceChannel, leaveVoiceChannel, isMuted, toggleMute } = useVoiceStore();

  const channels = rooms.filter(r => r.type === 'channel');
  const dms = rooms.filter(r => r.type === 'dm');

  const handleRoomClick = (roomId) => {
    // FIX: delegate to parent so history + members are fetched (general/media/random fix)
    if (onRoomSelect) {
      onRoomSelect(roomId);
    }
  };

  const handleVoiceJoin = async (channelId) => {
    if (currentChannelId === channelId) {
      leaveVoiceChannel();
    } else {
      try {
        await joinVoiceChannel(channelId);
      } catch (err) {
        console.error('Voice join error:', err);
      }
    }
  };

  const resolveVoiceUser = (uid) => {
    const found = allUsers.find(u => u.id === uid);
    if (found) return { name: found.display_name || found.username, color: found.avatar_color, status: found.status, code: found.user_code };
    return { name: uid.slice(0, 8), color: '#6366f1', status: 'online', code: null };
  };

  const getDMLabel = (room) => {
    if (!user) return room.name;
    const parts = room.name.split('-');
    return parts.find(p => p !== user.username) || room.name;
  };

  const isAdmin = user?.role === 'admin';

  return (
    <aside className="sidebar">
      {/* Header — creative Nebula branding */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🌌</div>
          <div>
            <div className="sidebar-logo-text">Nebula</div>
            <div className="sidebar-logo-sub">cosmic chat</div>
          </div>
        </div>
        <button id="sidebar-search-btn" className="icon-btn" onClick={onOpenSearch} title="Find people by name or #code">🔍</button>
      </div>

      <div className="sidebar-content">
        {/* Channels → Spaces */}
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            <span>✨ Spaces</span>
            <button
              id="create-channel-btn"
              className="sidebar-section-btn"
              onClick={onCreateRoom}
              title="Create space"
            >+</button>
          </div>
        </div>

        {channels.map(room => (
          <div
            key={room.id}
            id={`channel-${room.id}`}
            className={`channel-item ${activeRoomId === room.id ? 'active' : ''}`}
            onClick={() => handleRoomClick(room.id)}
            title={room.description || room.name}
          >
            <span className="channel-icon">{channelIcon(room.name)}</span>
            <span className="channel-name">{room.name}</span>
            {unread[room.id] > 0 && (
              <span className="channel-badge">{unread[room.id]}</span>
            )}
          </div>
        ))}
        {channels.length === 0 && (
          <div className="sidebar-empty">No spaces yet — create one ✦</div>
        )}

        {/* Voice Channels */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>
          <div className="sidebar-section-title"><span>🔊 Voice Orbit</span></div>
        </div>

        {VOICE_CHANNELS.map(vc => {
          const members = voiceChannelMembers[vc.id] || [];
          const inChannel = currentChannelId === vc.id;
          return (
            <div
              key={vc.id}
              id={`voice-channel-${vc.id}`}
              className={`voice-channel-item ${inChannel ? 'in-channel' : ''}`}
              onClick={() => handleVoiceJoin(vc.id)}
            >
              <div className={`voice-channel-header ${inChannel ? 'in-channel' : ''}`}>
                <span>{vc.emoji}</span>
                <span style={{ flex: 1 }}>{vc.name}</span>
                {members.length > 0 && (
                  <span className="voice-count">{members.length} online</span>
                )}
              </div>
              {/* FIX: show who is joined by name, not raw userId */}
              {members.length > 0 && (
                <div className="voice-channel-members-list">
                  {members.map(uid => {
                    const vu = resolveVoiceUser(uid);
                    const speaking = speakingUsers.has(uid);
                    const status = userStatuses[uid] || vu.status || 'online';
                    return (
                      <div key={uid} className={`voice-member-item ${speaking ? 'speaking' : ''}`}>
                        <span className="voice-member-dot" style={{ background: speaking ? 'var(--success)' : status === 'online' ? 'var(--success)' : 'var(--text-muted)' }} />
                        <Avatar name={vu.name} color={vu.color} size="xs" />
                        <span className="voice-member-name">{vu.name}</span>
                        {speaking && <span className="speaking-ring">🔊</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Direct Messages */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>
          <div className="sidebar-section-title">
            <span>💫 Direct</span>
            <button
              id="new-dm-btn"
              className="sidebar-section-btn"
              onClick={onOpenDM}
              title="New DM"
            >+</button>
          </div>
        </div>

        {dms.map(room => (
          <div
            key={room.id}
            id={`dm-${room.id}`}
            className={`dm-item ${activeRoomId === room.id ? 'active' : ''}`}
            onClick={() => handleRoomClick(room.id)}
          >
            <div
              className="avatar avatar-sm"
              style={{ background: 'linear-gradient(135deg, #22d3ee, #a855f7)' }}
            >
              {getDMLabel(room)[0]?.toUpperCase()}
            </div>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {getDMLabel(room)}
            </span>
            {unread[room.id] > 0 && (
              <span className="channel-badge">{unread[room.id]}</span>
            )}
          </div>
        ))}
        {dms.length === 0 && (
          <div className="sidebar-empty">No transmissions yet</div>
        )}
      </div>

      {/* User footer with profile + admin */}
      <div className="sidebar-user">
        <div style={{ cursor: 'pointer', display: 'flex' }} onClick={onOpenProfile} title="My profile & code">
          <Avatar
            name={user?.display_name || user?.username || '?'}
            color={user?.avatar_color || '#6366f1'}
            size="md"
            status="online"
          />
        </div>
        <div className="sidebar-user-info" onClick={onOpenProfile} style={{ cursor: 'pointer' }} title="Open profile">
          <div className="sidebar-user-name">{user?.display_name || user?.username}</div>
          <div className="sidebar-user-status">
            Online {user?.user_code ? <span className="code-chip small">#{user.user_code}</span> : null} {isAdmin ? <span className="admin-chip">ADMIN</span> : null}
          </div>
        </div>
        {isAdmin && (
          <button
            id="sidebar-admin-btn"
            className="icon-btn"
            onClick={onOpenAdmin}
            title="Admin dashboard"
          >
            🛡️
          </button>
        )}
        {currentChannelId && (
          <button
            id="sidebar-mute-btn"
            className={`icon-btn ${isMuted ? 'danger' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleMute(); }}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🎙️'}
          </button>
        )}
        <button
          id="sidebar-profile-btn"
          className="icon-btn"
          onClick={onOpenProfile}
          title="Profile"
        >
          👤
        </button>
        <button
          id="sidebar-logout-btn"
          className="icon-btn danger"
          onClick={logout}
          title="Log out"
        >
          ⏻
        </button>
      </div>
    </aside>
  );
}
