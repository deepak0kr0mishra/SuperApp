import React, { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { encryptText, encryptFile } from '../../crypto/e2e.js';

function Avatar({ name = '?', color = '#6366f1', size = 40 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.25,
      background: color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, color: 'white', fontSize: size * 0.38, flexShrink: 0,
    }}>
      {name[0].toUpperCase()}
    </div>
  );
}

// Mini file sender to a specific DM room
function useFileSender() {
  const { user, keyPair } = useAuthStore();
  const { getEncryptionKey } = useChatStore();

  const sendFile = async (file, dmRoomId, forceMime) => {
    if (!file || !dmRoomId || !keyPair || !user?.id) return;
    const arrayBuffer = await file.arrayBuffer();
    const key = await getEncryptionKey(dmRoomId, keyPair, user.id);
    const { encryptFile: ef } = await import('../../crypto/e2e.js');
    const encryptedBuffer = await ef(arrayBuffer, key);
    const encryptedBlob = new Blob([encryptedBuffer]);
    const encryptedFile = new File([encryptedBlob], file.name, { type: file.type || forceMime });

    const result = await api.uploadFile(encryptedFile, dmRoomId, () => {});

    let type = 'file';
    const mime = forceMime || file.type || '';
    if (mime.startsWith('image/')) type = 'image';
    else if (mime.startsWith('audio/')) type = 'audio';

    const encryptedName = await encryptText(file.name, key);
    const socket = getSocket();
    socket?.emit('message:send', {
      roomId: dmRoomId,
      encryptedContent: encryptedName,
      type,
      fileId: result.fileId,
      fileName: file.name,
      fileSize: file.size,
      fileMime: mime,
    });
  };

  return { sendFile };
}

// Mini audio recorder inside the search panel
function MiniRecorder({ onComplete, onCancel }) {
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    start();
    return () => cleanup();
  }, []);

  const cleanup = () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  };

  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      onComplete(blob, mimeType);
      cleanup();
    };
    recorder.start(100);
    timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
  };

  const stop = () => mediaRecorderRef.current?.stop();
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(244,63,94,0.1)', borderRadius: 8, padding: '6px 10px' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', animation: 'recording-pulse 1s infinite' }} />
      <span style={{ fontSize: 12, color: 'var(--danger)', fontFamily: 'monospace' }}>{fmt(elapsed)}</span>
      <button onClick={() => { cleanup(); onCancel(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
      <button onClick={stop} style={{ background: 'var(--danger)', border: 'none', borderRadius: 6, padding: '3px 10px', color: 'white', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Send</button>
    </div>
  );
}

export default function UserSearch({ onClose, onOpenDM }) {
  const [search, setSearch] = useState('');
  const [serverResults, setServerResults] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [dmRoom, setDmRoom] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [actionStatus, setActionStatus] = useState('');
  const fileInputRef = useRef(null);

  const { user, keyPair } = useAuthStore();
  const { allUsers, addRoom, setActiveRoom, setMembers, getEncryptionKey } = useChatStore();
  const { sendFile } = useFileSender();
  const socket = getSocket();

  // Server-side search (handles user_code + name#CODE) with debounce
  useEffect(() => {
    const q = search.trim();
    if (!q) { setServerResults(null); return; }
    const t = setTimeout(async () => {
      try {
        const { users } = await api.searchUsers(q);
        setServerResults(users);
      } catch { /* ignore, fall back to local */ }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const source = serverResults || allUsers;
  const qLower = search.trim().toLowerCase();
  const filtered = source.filter(u => {
    if (u.id === user?.id) return false;
    if (!qLower) return true;
    // support "name#CODE" format
    const hashIdx = qLower.indexOf('#');
    if (hashIdx >= 0) {
      const namePart = qLower.slice(0, hashIdx);
      const codePart = qLower.slice(hashIdx + 1);
      const nameOk = !namePart || u.username.toLowerCase().includes(namePart) || (u.display_name || '').toLowerCase().includes(namePart);
      const codeOk = !codePart || (u.user_code || '').toLowerCase().includes(codePart);
      return nameOk && codeOk;
    }
    return (
      u.username.toLowerCase().includes(qLower) ||
      (u.display_name || '').toLowerCase().includes(qLower) ||
      (u.user_code || '').toLowerCase().includes(qLower.replace('#', ''))
    );
  });

  const getOrCreateDM = async (targetUser) => {
    setLoading(true);
    try {
      const { room } = await api.createDM(targetUser.id);
      addRoom(room);
      // Join the room socket
      socket?.emit('room:join', { roomId: room.id });
      // Fetch members for key derivation
      const { members } = await api.getMembers(room.id);
      setMembers(room.id, members);
      setDmRoom(room);
      return room;
    } catch (err) {
      console.error('DM error:', err);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleSelectUser = async (targetUser) => {
    setSelectedUser(targetUser);
    setDmRoom(null);
    await getOrCreateDM(targetUser);
  };

  const handleOpenChat = async () => {
    if (!dmRoom) return;
    setActiveRoom(dmRoom.id);
    onOpenDM?.(dmRoom);
    onClose();
  };

  const handleSendMessage = async () => {
    if (!dmRoom || !keyPair || !user?.id) return;
    const text = prompt('Type a quick message:');
    if (!text?.trim()) return;
    const key = await getEncryptionKey(dmRoom.id, keyPair, user.id);
    const encrypted = await encryptText(text.trim(), key);
    socket?.emit('message:send', { roomId: dmRoom.id, encryptedContent: encrypted, type: 'text' });
    setActionStatus('Message sent!');
    setTimeout(() => setActionStatus(''), 2000);
  };

  const handleSendFile = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !dmRoom) return;
    setActionStatus('Encrypting & sending file…');
    try {
      await sendFile(file, dmRoom.id);
      setActionStatus('File sent!');
    } catch {
      setActionStatus('Failed to send file');
    }
    setTimeout(() => setActionStatus(''), 3000);
  };

  const handleRecordingComplete = async (blob, mimeType) => {
    setRecording(false);
    if (!dmRoom) return;
    setActionStatus('Sending voice message…');
    const ext = mimeType.includes('ogg') ? '.ogg' : '.webm';
    const file = new File([blob], `voice-${Date.now()}${ext}`, { type: mimeType });
    try {
      await sendFile(file, dmRoom.id, mimeType);
      setActionStatus('Voice message sent!');
    } catch {
      setActionStatus('Failed to send voice message');
    }
    setTimeout(() => setActionStatus(''), 3000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-header" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>🔍</span>
            <div className="modal-title">Find People</div>
          </div>
          <button id="close-user-search" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {/* Search input */}
        <input
          id="user-search-input"
          className="form-input"
          placeholder="Search by name, @username, #code, or name#code…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
          style={{ marginBottom: 8 }}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
          Tip: every explorer has a unique code like <b>#A1B2C3</b> — share <b>username#code</b> for instant finds ✦
        </div>

        {/* User list / Selected user panel */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {!selectedUser ? (
            // User list
            filtered.length === 0 ? (
              <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                {search ? 'No users found' : 'Type to search…'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {filtered.map(u => (
                  <div
                    key={u.id}
                    id={`search-user-${u.id}`}
                    onClick={() => handleSelectUser(u)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-overlay)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <Avatar name={u.display_name || u.username} color={u.avatar_color || '#6366f1'} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {u.display_name || u.username}
                        {u.user_code && <span className="code-chip">#{u.user_code}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>@{u.username}{u.bio ? ` • ${u.bio.slice(0, 40)}` : ''}</div>
                    </div>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: u.status === 'online' ? 'var(--success)' : 'var(--text-muted)',
                    }} />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>→</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            // Selected user panel
            <div>
              {/* Back button */}
              <button
                onClick={() => { setSelectedUser(null); setDmRoom(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand-primary)', fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                ← Back to search
              </button>

              {/* User card */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 16,
                background: 'var(--bg-overlay)', borderRadius: 14, padding: '16px 20px', marginBottom: 12,
                border: '1px solid var(--border-default)',
              }}>
                <Avatar name={selectedUser.display_name || selectedUser.username} color={selectedUser.avatar_color || '#6366f1'} size={56} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {selectedUser.display_name || selectedUser.username}
                    {selectedUser.user_code && <span className="code-chip">#{selectedUser.user_code}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>@{selectedUser.username}</div>
                  {selectedUser.bio && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{selectedUser.bio}</div>}
                  <div style={{ fontSize: 12, color: selectedUser.status === 'online' ? 'var(--success)' : 'var(--text-muted)', marginTop: 2 }}>
                    {selectedUser.status === 'online' ? '🟢 Online' : '⚫ Offline'}
                  </div>
                </div>
              </div>

              {loading && (
                <div style={{ textAlign: 'center', padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>
                  <span className="spinner" style={{ display: 'inline-block', width: 16, height: 16, marginRight: 8 }} />
                  Setting up secure channel…
                </div>
              )}

              {dmRoom && !loading && (
                <>
                  <div style={{
                    background: 'rgba(34,211,162,0.07)', border: '1px solid rgba(34,211,162,0.2)',
                    borderRadius: 10, padding: '8px 12px', marginBottom: 12,
                    fontSize: 12, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    🔒 Encrypted DM channel ready
                  </div>

                  {/* Action status */}
                  {actionStatus && (
                    <div style={{
                      background: 'rgba(124,106,255,0.1)', border: '1px solid rgba(124,106,255,0.2)',
                      borderRadius: 8, padding: '6px 12px', marginBottom: 10,
                      fontSize: 12, color: 'var(--brand-primary)', textAlign: 'center',
                    }}>
                      {actionStatus}
                    </div>
                  )}

                  {/* Recording UI */}
                  {recording && (
                    <div style={{ marginBottom: 12 }}>
                      <MiniRecorder
                        onComplete={handleRecordingComplete}
                        onCancel={() => setRecording(false)}
                      />
                    </div>
                  )}

                  {/* Action buttons */}
                  {!recording && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                      <button
                        id="search-open-chat-btn"
                        onClick={handleOpenChat}
                        style={{
                          background: 'var(--brand-gradient)', border: 'none', borderRadius: 10,
                          padding: '12px 0', color: 'white', fontSize: 13, fontWeight: 600,
                          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        💬 Open Chat
                      </button>
                      <button
                        id="search-send-message-btn"
                        onClick={handleSendMessage}
                        style={{
                          background: 'var(--bg-overlay)', border: '1px solid var(--border-default)',
                          borderRadius: 10, padding: '12px 0', color: 'var(--text-primary)',
                          fontSize: 13, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        ✉️ Quick Message
                      </button>
                      <button
                        id="search-send-file-btn"
                        onClick={handleSendFile}
                        style={{
                          background: 'var(--bg-overlay)', border: '1px solid var(--border-default)',
                          borderRadius: 10, padding: '12px 0', color: 'var(--text-primary)',
                          fontSize: 13, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        📁 Send File
                      </button>
                      <button
                        id="search-record-audio-btn"
                        onClick={() => setRecording(true)}
                        style={{
                          background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.25)',
                          borderRadius: 10, padding: '12px 0', color: 'var(--danger)',
                          fontSize: 13, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        }}
                      >
                        🎙️ Voice Note
                      </button>
                    </div>
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    style={{ display: 'none' }}
                    onChange={handleFileSelected}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
