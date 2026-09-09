import React, { useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';
import { api } from '../../services/api.js';

const VOICE_CHANNELS = [
  { id: 'vc-general', name: 'General Voice' },
  { id: 'vc-gaming', name: 'Gaming Room' },
  { id: 'vc-music', name: 'Music Lounge' },
];

export default function MembersPanel() {
  const { activeRoomId, members, setMembers, userStatuses } = useChatStore();
  const { user } = useAuthStore();
  const { currentChannelId, isMuted, toggleMute, leaveVoiceChannel, voiceChannelMembers, speakingUsers, joinVoiceChannel } = useVoiceStore();

  useEffect(() => {
    if (!activeRoomId) return;
    api.getMembers(activeRoomId)
      .then(({ members }) => setMembers(activeRoomId, members))
      .catch(console.error);
  }, [activeRoomId]);

  const roomMembers = members[activeRoomId] || [];
  const online = roomMembers.filter(m => userStatuses[m.id] === 'online' || m.id === user?.id);
  const offline = roomMembers.filter(m => userStatuses[m.id] !== 'online' && m.id !== user?.id);

  return (
    <aside className="members-panel">
      <div className="members-header">Members</div>

      <div className="members-list">
        {online.length > 0 && (
          <div className="members-group">
            <div className="members-group-title">Online — {online.length}</div>
            {online.map(member => (
              <div key={member.id} className="member-row" id={`member-${member.id}`}>
                <Avatar
                  name={member.display_name || member.username}
                  color={member.avatar_color}
                  size="sm"
                  status="online"
                />
                <span className="member-name">{member.display_name || member.username}</span>
                {member.id === user?.id && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-overlay)', padding: '1px 6px', borderRadius: 999 }}>you</span>
                )}
              </div>
            ))}
          </div>
        )}

        {offline.length > 0 && (
          <div className="members-group">
            <div className="members-group-title">Offline — {offline.length}</div>
            {offline.map(member => (
              <div key={member.id} className="member-row" id={`member-offline-${member.id}`}
                style={{ opacity: 0.5 }}>
                <Avatar
                  name={member.display_name || member.username}
                  color={member.avatar_color}
                  size="sm"
                  status="offline"
                />
                <span className="member-name">{member.display_name || member.username}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Voice panel at bottom */}
      <div className="voice-panel">
        <div className="voice-panel-title">Voice Channels</div>

        {VOICE_CHANNELS.map(vc => {
          const vcMembers = voiceChannelMembers[vc.id] || [];
          const inThis = currentChannelId === vc.id;
          return (
            <div key={vc.id} style={{ marginBottom: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 8,
                  background: inThis ? 'rgba(34,211,162,0.08)' : 'var(--bg-overlay)',
                  border: `1px solid ${inThis ? 'rgba(34,211,162,0.2)' : 'var(--border-subtle)'}`,
                  cursor: 'pointer',
                  marginBottom: 4,
                }}
                id={`voice-panel-${vc.id}`}
                onClick={() => inThis ? leaveVoiceChannel() : joinVoiceChannel(vc.id)}
              >
                <span style={{ fontSize: 14 }}>{inThis ? '🔊' : '🔈'}</span>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: inThis ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {vc.name}
                </span>
                {vcMembers.length > 0 && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-hover)', borderRadius: 999, padding: '1px 6px' }}>
                    {vcMembers.length}
                  </span>
                )}
              </div>

              {vcMembers.length > 0 && (
                <div style={{ paddingLeft: 12 }}>
                  {vcMembers.map(uid => {
                    const member = roomMembers.find(m => m.id === uid) || { username: uid, display_name: uid };
                    const isSpeaking = speakingUsers.has(uid);
                    return (
                      <div key={uid} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 4px',
                        fontSize: 12,
                        color: isSpeaking ? 'var(--success)' : 'var(--text-muted)',
                      }}>
                        <span style={{ fontSize: 10 }}>{isSpeaking ? '🟢' : '🎙️'}</span>
                        {member.display_name || member.username}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {currentChannelId && (
          <div className="voice-controls" style={{ marginTop: 8 }}>
            <button
              id="members-mute-btn"
              className={`voice-btn ${isMuted ? 'muted' : ''}`}
              onClick={toggleMute}
            >
              {isMuted ? '🔇 Unmute' : '🎙️ Mute'}
            </button>
            <button
              id="members-leave-voice-btn"
              className="voice-btn leave"
              onClick={leaveVoiceChannel}
            >
              ✕ Leave
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
