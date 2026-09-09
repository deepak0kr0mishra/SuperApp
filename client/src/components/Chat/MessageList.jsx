import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { getSocket } from '../../services/socket.js';

// --- Utilities ---
export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

export function getFileIcon(mime = '') {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '🗜️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (mime.includes('text')) return '📃';
  return '📁';
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// --- Date Divider ---
function DateDivider({ date }) {
  const d = new Date(date * 1000);
  let label;
  if (isToday(d)) label = 'Today';
  else if (isYesterday(d)) label = 'Yesterday';
  else label = format(d, 'MMMM d, yyyy');
  return <div className="date-divider">{label}</div>;
}

// --- Message Actions (hover) ---
function MessageActions({ message, roomId, onReply }) {
  const { user } = useAuthStore();
  const socket = getSocket();

  return (
    <div className="message-actions">
      {QUICK_REACTIONS.map(emoji => (
        <button
          key={emoji}
          className="input-action-btn"
          style={{ fontSize: 16 }}
          onClick={() => socket?.emit('message:react', { messageId: message.id, emoji, roomId })}
          title={emoji}
        >
          {emoji}
        </button>
      ))}
      <button className="input-action-btn" onClick={() => onReply(message)} title="Reply" style={{ fontSize: 14 }}>
        ↩
      </button>
      {message.sender_id === user?.id && (
        <button
          className="input-action-btn"
          style={{ color: 'var(--danger)', fontSize: 14 }}
          onClick={() => socket?.emit('message:delete', { messageId: message.id, roomId })}
          title="Delete"
        >
          🗑
        </button>
      )}
    </div>
  );
}

// --- Individual Message Content with E2E Decryption ---
function MessageContent({ message, roomId }) {
  const { decryptMessage, decryptFileData } = useChatStore();
  const { user, keyPair } = useAuthStore();
  const [decrypted, setDecrypted] = useState(null);
  const [mediaUrl, setMediaUrl] = useState(null);
  const [lightbox, setLightbox] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);

  // FIX: Proper deps including keyPair and userId to avoid stale closures
  useEffect(() => {
    let cancelled = false;
    if (!keyPair || !user?.id) return;
    (async () => {
      if (message.encrypted_content) {
        const text = await decryptMessage(message.encrypted_content, roomId, keyPair, user.id);
        if (!cancelled) setDecrypted(text);
      } else {
        // FIX: Don't get stuck "Decrypting…" on empty content
        if (!cancelled) setDecrypted('');
      }
    })();
    return () => { cancelled = true; };
  }, [message.encrypted_content, roomId, keyPair, user?.id]); // FIX: full deps

  // FIX: Fetch & decrypt media with full deps
  useEffect(() => {
    if (!message.file_id || !keyPair || !user?.id) return;
    if (message.type !== 'image' && message.type !== 'audio') return;
    let cancelled = false;
    setMediaLoading(true);
    (async () => {
      try {
        const token = localStorage.getItem('sc_token');
        const res = await fetch(`/api/files/${message.file_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Failed to fetch file');
        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const decryptedBuffer = await decryptFileData(arrayBuffer, roomId, keyPair, user.id);
        const mime = message.file_mime || (message.type === 'audio' ? 'audio/webm' : 'application/octet-stream');
        const url = URL.createObjectURL(new Blob([decryptedBuffer], { type: mime }));
        if (!cancelled) {
          setMediaUrl(url);
          setMediaLoading(false);
        }
      } catch (err) {
        console.error('Media decrypt error:', err);
        if (!cancelled) setMediaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Don't revoke URL immediately — it's being displayed
    };
  }, [message.file_id, message.type, roomId, keyPair, user?.id]); // FIX: full deps

  // --- Image ---
  if (message.type === 'image') {
    return (
      <div>
        {mediaLoading && (
          <div style={{ padding: '16px', background: 'var(--bg-elevated)', borderRadius: 10, color: 'var(--text-muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            Decrypting image…
          </div>
        )}
        {mediaUrl && (
          <>
            <img
              className="message-image"
              src={mediaUrl}
              alt={message.file_name}
              onClick={() => setLightbox(true)}
            />
            {lightbox && (
              <div className="lightbox" onClick={() => setLightbox(false)}>
                <img src={mediaUrl} alt={message.file_name} />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // --- Audio ---
  if (message.type === 'audio') {
    return (
      <div className="message-audio">
        <span style={{ fontSize: 20 }}>🎵</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {message.file_name || 'Voice Message'}
          </div>
          {mediaLoading && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              Decrypting…
            </div>
          )}
          {mediaUrl && (
            <audio className="audio-player" controls src={mediaUrl} preload="metadata" style={{ width: '100%', height: 32 }} />
          )}
        </div>
      </div>
    );
  }

  // --- Generic File ---
  if (message.type === 'file') {
    const handleDownload = async () => {
      if (!keyPair || !user?.id) return;
      try {
        const token = localStorage.getItem('sc_token');
        const res = await fetch(`/api/files/${message.file_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const decryptedBuffer = await decryptFileData(arrayBuffer, roomId, keyPair, user.id);
        const url = URL.createObjectURL(new Blob([decryptedBuffer], { type: message.file_mime || 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = message.file_name || 'download';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        console.error('Download error:', err);
      }
    };

    return (
      <div className="message-file" onClick={handleDownload} title="Click to download">
        <span className="file-icon">{getFileIcon(message.file_mime)}</span>
        <div className="file-info">
          <div className="file-name">{message.file_name || 'File'}</div>
          <div className="file-size">{formatBytes(message.file_size)} • Click to download</div>
        </div>
        <span style={{ color: 'var(--brand-primary)', fontSize: 18 }}>⬇</span>
      </div>
    );
  }

  // --- Text ---
  return (
    <div className="message-text">
      {decrypted === null ? (
        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Decrypting…</span>
      ) : (
        decrypted || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>[empty]</span>
      )}
    </div>
  );
}

// --- Full Message List ---
export default function MessageList({ roomId, onReply }) {
  const { messages, members } = useChatStore();
  const { user } = useAuthStore();
  const listRef = useRef(null);
  const roomMessages = messages[roomId] || [];
  const socket = getSocket();

  // Auto-scroll to bottom
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [roomMessages.length]);

  // FIX: Pre-compute grouping outside render to avoid mutable vars in .map()
  const processedMessages = useMemo(() => {
    let lastDate = null;
    let lastSenderId = null;
    return roomMessages.map(msg => {
      const msgDate = new Date(msg.created_at * 1000);
      const showDate = !lastDate || !isSameDay(msgDate, new Date(lastDate * 1000));
      if (showDate) lastDate = msg.created_at;
      const isGrouped = !showDate && lastSenderId === msg.sender_id;
      lastSenderId = msg.sender_id;
      return { ...msg, showDate, isGrouped };
    });
  }, [roomMessages]);

  if (processedMessages.length === 0) {
    return (
      <div className="message-list message-list-empty" ref={listRef}>
        <div className="message-list-empty-icon">💬</div>
        <div className="message-list-empty-text">Start the conversation</div>
        <div className="message-list-empty-sub">Messages are end-to-end encrypted 🔒</div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={listRef}>
      {processedMessages.map((msg) => (
        <React.Fragment key={msg.id}>
          {msg.showDate && <DateDivider date={msg.created_at} />}
          <div
            className={`message-row ${msg.isGrouped ? 'grouped' : ''}`}
            id={`msg-${msg.id}`}
          >
            <div
              className="message-avatar"
              style={{ background: msg.avatar_color || '#6366f1', visibility: msg.isGrouped ? 'hidden' : 'visible' }}
            >
              {(msg.display_name || msg.username || '?')[0].toUpperCase()}
            </div>

            <div className="message-content">
              {!msg.isGrouped && (
                <div className="message-header">
                  <span className="message-sender" style={{ color: msg.avatar_color }}>
                    {msg.display_name || msg.username}
                  </span>
                  <span className="message-time">
                    {format(new Date(msg.created_at * 1000), 'h:mm a')}
                  </span>
                </div>
              )}

              <MessageContent message={msg} roomId={roomId} />

              {msg.reactions && msg.reactions.length > 0 && (
                <div className="message-reactions">
                  {msg.reactions.map(r => {
                    const userIds = r.users ? r.users.split(',') : [];
                    const reacted = userIds.includes(user?.id);
                    return (
                      <button
                        key={r.emoji}
                        className={`reaction-btn ${reacted ? 'reacted' : ''}`}
                        onClick={() => {
                          if (reacted) {
                            socket?.emit('message:unreact', { messageId: msg.id, emoji: r.emoji, roomId });
                          } else {
                            socket?.emit('message:react', { messageId: msg.id, emoji: r.emoji, roomId });
                          }
                        }}
                      >
                        {r.emoji}
                        <span className="reaction-count">{r.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <MessageActions message={msg} roomId={roomId} onReply={onReply} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
