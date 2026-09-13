import React, { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { useVoiceStore } from '../../stores/voiceStore.js';
import { Avatar } from '../shared/Avatar.jsx';
import { api } from '../../services/api.js';

const MUTE_DURATIONS = [
  { id: 'hour', label: '1 hour' },
  { id: 'day', label: '1 day' },
  { id: 'week', label: '1 week' },
];

export default function MembersPanel() {
  const { activeRoomId, rooms, members, setMembers, userStatuses, allUsers } = useChatStore();
  const { user } = useAuthStore();
  const { currentChannelId, isMuted, voiceMuted, toggleMute, leaveVoiceChannel, voiceChannelMembers, speakingUsers, joinVoiceChannel } = useVoiceStore();
  const [mutes, setMutes] = useState([]);
  const [muteBusy, setMuteBusy] = useState('');
  const [notice, setNotice] = useState('');

  const isAdmin = user?.role === 'admin';
  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  const isDM = activeRoom?.type === 'dm';

  useEffect(() => {
    if (!activeRoomId) return;
    api.getMembers(activeRoomId)
      .then(({ members }) => setMembers(activeRoomId, members))
      .catch(console.error);
  }, [activeRoomId]);

  useEffect(() => {
    if (!isAdmin) return;
    api.adminGetMutes().then(({ mutes: m }) => setMutes(m || [])).catch(() => {});
  }, [isAdmin, activeRoomId]);

  const roomMembers = members[activeRoomId] || [];
  const online = roomMembers.filter(m => userStatuses[m.id] === 'online' || m.id === user?.id);
  const offline = roomMembers.filter(m => userStatuses[m.id] !== 'online' && m.id !== user?.id);

  const resolveVoiceUser = (uid) => {
    const fromRoom = roomMembers.find(m => m.id === uid);
    if (fromRoom) return { name: fromRoom.display_name || fromRoom.username, color: fromRoom.avatar_color, code: fromRoom.user_code };
    const fromAll = allUsers.find(u => u.id === uid);
    if (fromAll) return { name: fromAll.display_name || fromAll.username, color: fromAll.avatar_color, code: fromAll.user_code };
    return { name: uid.slice(0, 8) + '…', color: '#6366f1', code: null };
  };

  const flash = (m) => {
    setNotice(m);
    setTimeout(() => setNotice(''), 3000);
  };

  const handleRemove = async (member) => {
    if (!confirm(`Remove ${member.display_name || member.username} from #${activeRoom?.name}?`)) return;
    try {
      await api.adminRemoveMember(activeRoomId, member.id);
      setMembers(activeRoomId, roomMembers.filter((m) => m.id !== member.id));
      flash(`Removed @${member.username}`);
    } catch (err) {
      flash(err.message || 'Remove failed');
    }
  };

  const handleMute = async (member, kind, duration) => {
    setMuteBusy(`${member.id}:${kind}`);
    try {
      await api.adminMuteUser(member.id, kind, duration, '');
      const { mutes: m } = await api.adminGetMutes().catch(() => ({ mutes: [] }));
      setMutes(m || []);
      flash(`${kind === 'voice' ? '🔇 Voice-muted' : '🔇 Chat-muted'} @${member.username} for ${duration}`);
    } catch (err) {
      flash(err.message || 'Mute failed');
    } finally {
      setMuteBusy('');
    }
  };

  const handleUnmute = async (member, kind) => {
    setMuteBusy(`${member.id}:${kind}`);
    try {
      await api.adminUnmuteUser(member.id, kind);
      setMutes((prev) => prev.filter((x) => !(x.user_id === member.id && x.kind === kind)));
      flash(`Unmuted @${member.username} (${kind})`);
    } catch (err) {
      flash(err.message || 'Unmute failed');
    } finally {
      setMuteBusy('');
    }
  };

  const muteOf = (userId, kind) => mutes.find((m) => m.user_id === userId && m.kind === kind);
  const muteLabel = (m) => {
    if (!m) return '';
    try {
      return `until ${new Date(m.expires_at * 1000).toLocaleString()}`;
    } catch { return 'muted'; }
  };

  // Voice panel shows THIS room's call (voice id == room id).
  const vcMembers = (voiceChannelMembers[activeRoomId] || []);
  const inThis = currentChannelId === activeRoomId;

  return (
    <aside className="members-panel">
      <div className="members-header">
        ✦ Members — {roomMembers.length}
        {activeRoom?.max_members ? <span className="code-chip small">voice max {activeRoom.max_members}</span> : null}
      </div>
      {notice && <div className="admin-flash" style={{ margin: '8px 12px 0' }}>{notice}</div>}

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
                {muteOf(member.id, 'voice') && <span className="admin-chip" title={muteLabel(muteOf(member.id, 'voice'))}>🔇 VOICE</span>}
                {muteOf(member.id, 'chat') && <span className="admin-chip" title={muteLabel(muteOf(member.id, 'chat'))}>🔇 CHAT</span>}
                {isAdmin && !isDM && member.id !== user?.id && member.role !== 'admin' && (
                  <span className="member-admin-actions">
                    <button className="btn-mini" title="Remove from room" onClick={() => handleRemove(member)}>⛔</button>
                    {muteOf(member.id, 'voice')
                      ? <button className="btn-mini" title={`Unmute voice (${muteLabel(muteOf(member.id, 'voice'))})`} disabled={muteBusy === `${member.id}:voice`} onClick={() => handleUnmute(member, 'voice')}>🎙️</button>
                      : <button className="btn-mini" title="Voice-mute (listen only)" disabled={muteBusy === `${member.id}:voice`} onClick={() => handleMute(member, 'voice', prompt('Voice-mute duration? hour/day/week', 'day') || 'day')}>🔇</button>}
                    {muteOf(member.id, 'chat')
                      ? <button className="btn-mini" title={`Unmute chat (${muteLabel(muteOf(member.id, 'chat'))})`} disabled={muteBusy === `${member.id}:chat`} onClick={() => handleUnmute(member, 'chat')}>💬</button>
                      : <button className="btn-mini" title="Chat-mute (DMs only)" disabled={muteBusy === `${member.id}:chat`} onClick={() => handleMute(member, 'chat', prompt('Chat-mute duration? hour/day/week', 'day') || 'day')}>🚫</button>}
                  </span>
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
                {muteOf(member.id, 'voice') && <span className="admin-chip">🔇 VOICE</span>}
                {muteOf(member.id, 'chat') && <span className="admin-chip">🔇 CHAT</span>}
                {isAdmin && !isDM && member.id !== user?.id && member.role !== 'admin' && (
                  <span className="member-admin-actions">
                    <button className="btn-mini" title="Remove from room" onClick={() => handleRemove(member)}>⛔</button>
                    {muteOf(member.id, 'voice')
                      ? <button className="btn-mini" onClick={() => handleUnmute(member, 'voice')}>🎙️</button>
                      : <button className="btn-mini" onClick={() => handleMute(member, 'voice', 'day')}>🔇</button>}
                    {muteOf(member.id, 'chat')
                      ? <button className="btn-mini" onClick={() => handleUnmute(member, 'chat')}>💬</button>
                      : <button className="btn-mini" onClick={() => handleMute(member, 'chat', 'day')}>🚫</button>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {roomMembers.length === 0 && (
          <div className="sidebar-empty">No members yet</div>
        )}
        {isAdmin && !isDM && (
          <div className="admin-hint" style={{ margin: '8px 12px', fontSize: 11 }}>
            Voice 🔇 = listen-only · Chat 🚫 = DMs only. Durations: {MUTE_DURATIONS.map((d) => d.label).join(' / ')}. Text chat is unlimited; voice caps apply to calls only (you bypass them).
          </div>
        )}
      </div>

      {/* Voice panel: this room's call */}
      <div className="voice-panel">
        <div className="voice-panel-title">🔊 Voice — this room</div>

        <div style={{ marginBottom: 8 }}>
          <div
            className={`voice-panel-row ${inThis ? 'active' : ''}`}
            id={`voice-panel-${activeRoomId}`}
            onClick={() => inThis ? leaveVoiceChannel() : joinVoiceChannel(activeRoomId)}
          >
            <span style={{ fontSize: 14 }}>🔊</span>
            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: inThis ? 'var(--success)' : 'var(--text-secondary)' }}>
              {activeRoom?.name || 'Voice'}
            </span>
            {vcMembers.length > 0 && (
              <span className="voice-count">{activeRoom?.max_members ? `${vcMembers.length}/${activeRoom.max_members}` : vcMembers.length}</span>
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
            <div className="voice-panel-empty">Empty — hit 🔊 Join call up top ✦</div>
          )}
        </div>

        {currentChannelId && (
          <div className="voice-controls" style={{ marginTop: 8 }}>
            <button
              id="members-mute-btn"
              className={`voice-btn ${isMuted ? 'muted' : ''}`}
              onClick={toggleMute}
              title={voiceMuted ? 'Voice-muted by admin (listen only)' : undefined}
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
        {voiceMuted && inThis && (
          <div className="mute-notice" style={{ marginTop: 8 }}>🔇 Voice-muted (listen only)</div>
        )}
      </div>
    </aside>
  );
}
