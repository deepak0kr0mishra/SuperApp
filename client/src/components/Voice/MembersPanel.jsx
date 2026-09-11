import React, { useEffect } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';
import { api } from '../../services/api.js';
import { VOICE_CHANNELS } from '../Sidebar/Sidebar.jsx';

export default function MembersPanel() {
  const { activeRoomId, members, setMembers, userStatuses, allUsers } = useChatStore();
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

  // FIX: resolve voice userIds to real names via allUsers (not just current room members)
  const resolveVoiceUser = (uid) => {
    const fromRoom = roomMembers.find(m => m.id === uid);
    if (fromRoom) return { name: fromRoom.display_name || fromRoom.username, color: fromRoom.avatar_color, code: fromRoom.user_code };
    const fromAll = allUsers.find(u => u.id === uid);
    if (fromAll) return { name: fromAll.display_name || fromAll.username, color: fromAll.avatar_color, code: fromAll.user_code };
    return { name: uid.slice(0, 8) + '…', color: '#6366f1', code: null };
  };

  return (
    <aside className="members-panel">
      <div className="members-header">✦ Members — {roomMembers.length}</div>

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
                {member.user_code && <span className="code-chip small">#{member.user_code}</span>}
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
        {roomMembers.length === 0 && (
          <div className="sidebar-empty">No members yet</div>
        )}
      </div>

      {/* Voice panel at bottom — FIXED to show who joined */}
      <div className="voice-panel">
        <div className="voice-panel-title">🔊 Voice — live</div>

        {VOICE_CHANNELS.map(vc => {
          const vcMembers = voiceChannelMembers[vc.id] || [];
          const inThis = currentChannelId === vc.id;
          return (
            <div key={vc.id} style={{ marginBottom: 8 }}>
              <div
                className={`voice-panel-row ${inThis ? 'active' : ''}`}
                id={`voice-panel-${vc.id}`}
                onClick={() => inThis ? leaveVoiceChannel() : joinVoiceChannel(vc.id)}
              >
                <span style={{ fontSize: 14 }}>{vc.emoji}</span>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: inThis ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {vc.name}
                </span>
                {vcMembers.length > 0 && (
                  <span className="voice-count">{vcMembers.length}</span>
                )}
              </div>

              {vcMembers.length > 0 ? (
                <div className="voice-panel-members">
                  {vcMembers.map(uid => {
                    const vu = resolveVoiceUser(uid);
                    const isSpeaking = speakingUsers.has(uid);
                    return (
                      <div key={uid} className={`voice-panel-member ${isSpeaking ? 'speaking' : ''}`}>
                        <Avatar name={vu.name} color={vu.color} size="xs" status={isSpeaking ? 'online' : undefined} />
                        <span className="voice-member-name">{vu.name}</span>
                        {vu.code && <span className="code-chip tiny">#{vu.code}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 10 }}>{isSpeaking ? '🟢 talking' : '🎙️'}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="voice-panel-empty">Empty room — hop in ✦</div>
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
