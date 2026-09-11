import React, { useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import MessageList from './MessageList.jsx';
import MessageInput from './MessageInput.jsx';

export default function ChatPanel({ onOpenSearch, onOpenProfile, onToggleSidebar }) {
  const { activeRoomId, rooms, members, typingUsers } = useChatStore();
  const { user } = useAuthStore();
  const { currentChannelId, isMuted, toggleMute, leaveVoiceChannel, speakingUsers } = useVoiceStore();
  const [replyTo, setReplyTo] = useState(null);

  const activeRoom = rooms.find(r => r.id === activeRoomId);
  const roomTyping = typingUsers[activeRoomId] || {};
  const typingList = Object.entries(roomTyping)
    .filter(([uid]) => uid !== user?.id)
    .map(([, name]) => name);

  if (!activeRoomId || !activeRoom) {
    return (
      <div className="chat-area">
        <div className="topbar">
          <button className="icon-btn hamburger" onClick={onToggleSidebar} title="Chats">☰</button>
          <span className="topbar-name">Welcome</span>
        </div>
        <div className="empty-chat">
          <div className="empty-chat-icon">🍵</div>
          <div className="empty-chat-title">Welcome to TeaChat</div>
          <div className="empty-chat-sub">
            Pick a <b>chat</b> or a <b>space</b> from the left — or tap 🔍 to find someone and start a DM.
          </div>
          <button className="btn-primary empty-chat-btn" onClick={onOpenSearch}>🔍 Find someone to chat</button>
        </div>
      </div>
    );
  }

  const isDM = activeRoom.type === 'dm';
  const roomMembers = members[activeRoomId] || [];
  const peer = isDM ? roomMembers.find(m => m.id !== user?.id) : null;
  const peerStatus = peer ? (useChatStore.getState().userStatuses[peer.id] || peer.status || 'offline') : null;

  const roomIcons = { general: '🍵', media: '🎨', audio: '🎧', random: '⚡' };
  const roomIcon = isDM ? null : (roomIcons[(activeRoom.name || '').toLowerCase()] || '✦');
  const roomMemberCount = roomMembers.length;
  const voiceCount = (useVoiceStore.getState().voiceChannelMembers[currentChannelId] || []).length;

  return (
    <div className="chat-area">
      {/* Topbar */}
      <div className="topbar">
        <button className="icon-btn hamburger" onClick={onToggleSidebar} title="Back to chats">☰</button>
        {isDM && peer ? (
          <button className="dm-header" onClick={() => onOpenProfile?.(peer.id)} title="View profile">
            <span className="avatar avatar-sm" style={{ background: peer.avatar_color || '#6366f1' }}>
              {(peer.display_name || peer.username || '?')[0].toUpperCase()}
              <span className={`status-dot ${peerStatus}`} />
            </span>
            <span className="topbar-name-col">
              <span className="topbar-name">{peer.display_name || peer.username}</span>
              <span className={`topbar-sub ${peerStatus}`}>{peerStatus === 'online' ? 'Online' : 'Offline'}</span>
            </span>
          </button>
        ) : (
          <>
            <span style={{ fontSize: 18 }}>{roomIcon}</span>
            <div className="topbar-name">
              {activeRoom.name}
              {activeRoom.description && <span className="topbar-desc">{activeRoom.description}</span>}
            </div>
          </>
        )}

        {currentChannelId && (
          <div className="voice-live-pill">
            <span className="voice-member-dot" />
            <span>🔊 Voice live{voiceCount ? ` • ${voiceCount}` : ''}</span>
            <button id="topbar-mute-btn" className="pill-btn" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted ? '🔇' : '🎙️'}
            </button>
            <button id="topbar-leave-voice-btn" className="pill-btn danger" onClick={leaveVoiceChannel} title="Leave voice">✕</button>
          </div>
        )}

        <div className="topbar-actions">
          {!isDM && roomMemberCount > 0 && (
            <span className="member-count">✦ {roomMemberCount} members</span>
          )}
          {isDM && peer && (
            <button className="icon-btn" onClick={() => onOpenProfile?.(peer.id)} title="View profile">👤</button>
          )}
        </div>
      </div>

      {/* Messages */}
      <MessageList roomId={activeRoomId} onReply={setReplyTo} onOpenProfile={onOpenProfile} />

      {/* Typing */}
      <div className="typing-indicator">
        {typingList.length > 0 && (
          <>
            <strong>{typingList.join(', ')}</strong>
            {typingList.length === 1 ? ' is' : ' are'} typing
            <span className="typing-dots"><span /><span /><span /></span>
          </>
        )}
      </div>

      {/* Input */}
      <MessageInput roomId={activeRoomId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </div>
  );
}
