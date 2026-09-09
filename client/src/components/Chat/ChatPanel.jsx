import React, { useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import MessageList from './MessageList.jsx';
import MessageInput from './MessageInput.jsx';

export default function ChatPanel() {
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
      <div className="chat-area" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', maxWidth: 360 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>🌌</div>
          <div style={{ fontSize: 22, fontWeight: 800, background: 'var(--cosmic-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', marginBottom: 8 }}>
            Welcome to Nebula
          </div>
          <div style={{ fontSize: 14 }}>
            Drift into a <b>✨ Space</b> like general, media or random — or ping anyone via name / <b>#code</b> for an encrypted DM. Hit <b>🎙️</b> to send voice notes.
          </div>
        </div>
      </div>
    );
  }

  const isDM = activeRoom.type === 'dm';
  const roomIcons = { general: '🌌', media: '🎨', audio: '🎧', random: '⚡' };
  const roomIcon = isDM ? '💫' : (roomIcons[(activeRoom.name || '').toLowerCase()] || '✦');
  const roomMemberCount = (members[activeRoomId] || []).length;
  const voiceCount = (useVoiceStore.getState().voiceChannelMembers[currentChannelId] || []).length;

  return (
    <div className="chat-area">
      {/* Topbar */}
      <div className="topbar">
        <span style={{ fontSize: 18 }}>{roomIcon}</span>
        <div className="topbar-name">
          {activeRoom.name}
          {activeRoom.description && (
            <span className="topbar-desc">{activeRoom.description}</span>
          )}
        </div>

        {/* Voice indicator in chat area — now shows live count */}
        {currentChannelId && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(34,211,162,0.08)',
            border: '1px solid rgba(34,211,162,0.2)',
            borderRadius: 999,
            padding: '4px 12px',
            fontSize: 12,
            color: 'var(--success)',
            fontWeight: 700,
          }}>
            <span className="voice-member-dot" style={{ background: 'var(--success)', width: 8, height: 8, borderRadius: '50%' }} />
            <span>🛰️ Orbit live{voiceCount ? ` • ${voiceCount}` : ''}</span>
            <button
              id="topbar-mute-btn"
              onClick={toggleMute}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: isMuted ? 'var(--danger)' : 'var(--success)' }}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? '🔇' : '🎙️'}
            </button>
            <button
              id="topbar-leave-voice-btn"
              onClick={leaveVoiceChannel}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--danger)' }}
              title="Leave voice"
            >
              ✕
            </button>
          </div>
        )}

        <div className="topbar-actions">
          <div className="e2e-badge">
            ✦ E2E Encrypted
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
            {roomMemberCount > 0 ? `✦ ${roomMemberCount} crew` : ''}
          </span>
        </div>
      </div>

      {/* Messages */}
      <MessageList
        roomId={activeRoomId}
        onReply={setReplyTo}
      />

      {/* Typing */}
      <div className="typing-indicator" style={{ padding: '0 16px' }}>
        {typingList.length > 0 && (
          <>
            <strong>{typingList.join(', ')}</strong>
            {typingList.length === 1 ? ' is' : ' are'} typing
            <span className="typing-dots">
              <span /><span /><span />
            </span>
          </>
        )}
      </div>

      {/* Input */}
      <MessageInput
        roomId={activeRoomId}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />
    </div>
  );
}
