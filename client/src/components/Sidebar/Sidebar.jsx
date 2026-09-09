import React, { useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { Avatar } from '../shared/Avatar.jsx';

const VOICE_CHANNELS = [
  { id: 'vc-general', name: 'General Voice' },
  { id: 'vc-gaming', name: 'Gaming Room' },
  { id: 'vc-music', name: 'Music Lounge' },
];

export default function Sidebar({ onCreateRoom, onOpenDM }) {
  const { user, logout } = useAuthStore();
  const { rooms, activeRoomId, setActiveRoom, unread } = useChatStore();
  const { currentChannelId, voiceChannelMembers, joinVoiceChannel, leaveVoiceChannel, isMuted, toggleMute } = useVoiceStore();
  const [showSettings, setShowSettings] = useState(false);

  const channels = rooms.filter(r => r.type === 'channel');
  const dms = rooms.filter(r => r.type === 'dm');

  const handleRoomClick = (roomId) => {
    const socket = getSocket();
    if (socket) {
      if (activeRoomId) socket.emit('room:leave', { roomId: activeRoomId });
      socket.emit('room:join', { roomId });
    }
    setActiveRoom(roomId);
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

  const getDMLabel = (room) => {
    if (!user) return room.name;
    const parts = room.name.split('-');
    return parts.find(p => p !== user.username) || room.name;
  };

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🔐</div>
          <span className="sidebar-logo-text">SecureChat</span>
        </div>
      </div>

      <div className="sidebar-content">
        {/* Channels */}
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            Channels
            <button
              id="create-channel-btn"
              className="sidebar-section-btn"
              onClick={onCreateRoom}
              title="Create channel"
            >+</button>
          </div>
        </div>

        {channels.map(room => (
          <div
            key={room.id}
            id={`channel-${room.id}`}
            className={`channel-item ${activeRoomId === room.id ? 'active' : ''}`}
            onClick={() => handleRoomClick(room.id)}
          >
            <span className="channel-icon">#</span>
            <span className="channel-name">{room.name}</span>
            {unread[room.id] > 0 && (
              <span className="channel-badge">{unread[room.id]}</span>
            )}
          </div>
        ))}

        {/* Voice Channels */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>
          <div className="sidebar-section-title">Voice Channels</div>
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
                <span>{inChannel ? '🔊' : '🔈'}</span>
                <span style={{ flex: 1 }}>{vc.name}</span>
                {members.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{members.length}</span>
                )}
              </div>
              {members.length > 0 && (
                <div className="voice-channel-members-list">
                  {members.map(uid => (
                    <div key={uid} className="voice-member-item">
                      <span>🎙️</span>
                      <span>{uid}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Direct Messages */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>
          <div className="sidebar-section-title">
            Direct Messages
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
              style={{ background: 'var(--brand-primary)' }}
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
      </div>

      {/* User footer */}
      <div className="sidebar-user">
        <Avatar
          name={user?.display_name || user?.username || '?'}
          color={user?.avatar_color || '#6366f1'}
          size="md"
          status="online"
        />
        <div className="sidebar-user-info">
          <div className="sidebar-user-name">{user?.display_name || user?.username}</div>
          <div className="sidebar-user-status">Online</div>
        </div>
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
