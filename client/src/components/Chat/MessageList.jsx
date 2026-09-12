import React, { useEffect, useRef, useState, useMemo } from 'react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { useChatStore, messageText, isLegacyEncryptedBlob } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

export function getFileIcon(mime = '') {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '🗜️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (mime.includes('text')) return '📃';
  return '📁';
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

function DateDivider({ date }) {
  const d = new Date(date * 1000);
  let label;
  if (isToday(d)) label = 'Today';
  else if (isYesterday(d)) label = 'Yesterday';
  else label = format(d, 'MMMM d, yyyy');
  return <div className="date-divider">{label}</div>;
}

function MessageActions({ message, roomId, onReply, onEdit, onReport }) {
  const { user } = useAuthStore();
  const socket = getSocket();
  const deleted = !!message.is_deleted;
  return (
    <div className="message-actions">
      {!deleted && QUICK_REACTIONS.map(emoji => (
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
      {!deleted && (
        <button className="input-action-btn" onClick={() => onReply(message)} title="Reply" style={{ fontSize: 14 }}>↩</button>
      )}
      {!deleted && message.sender_id === user?.id && message.type === 'text' && (
        <button className="input-action-btn" onClick={() => onEdit(message)} title="Edit" style={{ fontSize: 14 }}>✎</button>
      )}
      {!deleted && message.sender_id !== user?.id && (
        <button className="input-action-btn" onClick={() => onReport(message)} title="Report" style={{ fontSize: 14 }}>⚑</button>
      )}
      {(message.sender_id === user?.id || user?.role === 'admin') && (
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

// Resolve a reply target from the loaded history
function ReplyQuote({ replyId, roomId }) {
  const msgs = useChatStore(s => s.messages[roomId] || []);
  const target = msgs.find(m => m.id === replyId);
  if (!target) return null;
  const text = messageText(target);
  return (
    <div className="reply-quote">
      <span className="reply-quote-name">{target.display_name || target.username}</span>
      <span className="reply-quote-text">
        {target.type !== 'text' ? `📎 ${target.file_name || target.type}` : text.slice(0, 120)}
      </span>
    </div>
  );
}

// --- Individual message body (plain text + direct media URLs) ---
function MessageContent({ message }) {
  const [lightbox, setLightbox] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const text = messageText(message);

  if (message.is_deleted) {
    return <div className="message-text deleted">This message was deleted.</div>;
  }

  // --- Image: direct <img> with auth token (no fetch/decrypt) ---
  if (message.type === 'image' && message.file_id) {
    const url = api.getFileUrl(message.file_id);
    return (
      <div className="msg-media">
        {!mediaError ? (
          <>
            <img
              className="message-image"
              src={url}
              alt={message.file_name || 'Image'}
              loading="lazy"
              onClick={() => setLightbox(true)}
              onError={() => setMediaError(true)}
            />
            {message.file_name && message.file_name !== text && (
              <div className="media-caption">{message.file_name}</div>
            )}
            {lightbox && (
              <div className="lightbox" onClick={() => setLightbox(false)}>
                <img src={url} alt={message.file_name || 'Image'} />
              </div>
            )}
          </>
        ) : (
          <a className="message-file" href={url} target="_blank" rel="noreferrer">
            <span className="file-icon">🖼️</span>
            <div className="file-info">
              <div className="file-name">{message.file_name || 'Image'}</div>
              <div className="file-size">{formatBytes(message.file_size)} • Tap to open</div>
            </div>
          </a>
        )}
      </div>
    );
  }

  // --- Video: native player with Range streaming ---
  if (message.type === 'video' && message.file_id) {
    const url = api.getFileUrl(message.file_id);
    if (!mediaError) {
      return (
        <div className="msg-media">
          <video
            className="message-video"
            src={url}
            controls
            preload="metadata"
            playsInline
            onError={() => setMediaError(true)}
          />
          {message.file_name && <div className="media-caption">{message.file_name} • {formatBytes(message.file_size)}</div>}
        </div>
      );
    }
  }

  // --- Audio (previously sent voice notes still play back) ---
  if (message.type === 'audio' && message.file_id) {
    const url = api.getFileUrl(message.file_id);
    return (
      <div className="message-audio">
        <span style={{ fontSize: 20 }}>🎵</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="audio-title">{message.file_name || 'Audio'}</div>
          <audio className="audio-player" controls src={url} preload="metadata" style={{ width: '100%', height: 32 }} />
        </div>
      </div>
    );
  }

  // --- Generic file ---
  if ((message.type === 'file' || (!message.file_id && false)) && message.file_id) {
    const url = api.getFileUrl(message.file_id);
    return (
      <a className="message-file" href={url} target="_blank" rel="noreferrer" title="Open / download">
        <span className="file-icon">{getFileIcon(message.file_mime)}</span>
        <div className="file-info">
          <div className="file-name">{message.file_name || 'File'}</div>
          <div className="file-size">{formatBytes(message.file_size)} • Tap to open</div>
        </div>
        <span className="file-open">⬇</span>
      </a>
    );
  }

  // Fallback: file_id present but type is generic/unknown
  if (message.file_id && (message.type === 'file' || message.type === 'video')) {
    const url = api.getFileUrl(message.file_id);
    return (
      <a className="message-file" href={url} target="_blank" rel="noreferrer">
        <span className="file-icon">{getFileIcon(message.file_mime)}</span>
        <div className="file-info">
          <div className="file-name">{message.file_name || 'Attachment'}</div>
          <div className="file-size">{formatBytes(message.file_size)} • Tap to open</div>
        </div>
        <span className="file-open">⬇</span>
      </a>
    );
  }

  // --- Text (plain) ---
  if (isLegacyEncryptedBlob(text)) {
    return (
      <div className="message-text legacy">
        <span className="legacy-note">[Old encrypted message — sent before encryption was removed]</span>
      </div>
    );
  }
  return <div className="message-text">{text || <span className="empty-note">[empty]</span>}</div>;
}

// --- Full Message List (paginated, infinite scroll up) ---
export default function MessageList({ roomId, onReply, onOpenProfile }) {
  const { messages, hasMore, loadingOlder } = useChatStore();
  const { user } = useAuthStore();
  const listRef = useRef(null);
  const stickRef = useRef(true);
  const roomMessages = messages[roomId] || [];
  const socket = getSocket();
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [reportMsg, setReportMsg] = useState(null);
  const [reportReason, setReportReason] = useState('');
  const [reportState, setReportState] = useState('');

  // Mark room as read whenever the visible history changes while focused.
  useEffect(() => {
    if (!roomId || roomMessages.length === 0) return;
    const t = setTimeout(() => {
      api.markRead(roomId).catch(() => {});
      getSocket()?.emit('message:read', { roomId });
      useChatStore.getState().clearUnread(roomId);
    }, 800);
    return () => clearTimeout(t);
  }, [roomId, roomMessages.length]);

  const loadOlder = async () => {
    const state = useChatStore.getState();
    if (state.loadingOlder[roomId] || !state.hasMore[roomId]) return;
    const msgs = state.messages[roomId] || [];
    if (msgs.length === 0) return;
    const oldest = msgs[0].created_at;
    state.setLoadingOlder(roomId, true);
    const el = listRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    try {
      const { messages: older, hasMore: more } = await api.getMessages(roomId, { before: oldest, limit: 50 });
      state.prependMessages(roomId, older || []);
      if (more === false) useChatStore.setState(s => ({ hasMore: { ...s.hasMore, [roomId]: false } }));
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (err) {
      console.error('Load older failed:', err);
      state.setLoadingOlder(roomId, false);
    }
  };

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 120) loadOlder();
  };

  useEffect(() => {
    if (listRef.current && stickRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [roomMessages.length, roomId]);

  useEffect(() => {
    stickRef.current = true;
    if (listRef.current) listRef.current.scrollTop = listRef.current?.scrollHeight || 0;
  }, [roomId]);

  const startEdit = (msg) => {
    setEditingId(msg.id);
    setEditText(messageText(msg));
  };

  const submitEdit = async () => {
    const text = editText.trim();
    if (!text) return;
    const id = editingId;
    setEditingId(null);
    try {
      getSocket()?.emit('message:edit', { messageId: id, content: text.slice(0, 2000) });
    } catch (err) {
      console.error('Edit failed:', err);
    }
  };

  const submitReport = async (e) => {
    e?.preventDefault();
    if (!reportMsg || !reportReason.trim()) return;
    setReportState('sending');
    try {
      await api.report({
        messageId: reportMsg.id,
        targetUserId: reportMsg.sender_id,
        reason: reportReason.trim().slice(0, 500),
      });
      setReportState('sent');
      setTimeout(() => { setReportMsg(null); setReportReason(''); setReportState(''); }, 1500);
    } catch (err) {
      setReportState(err.message || 'Failed');
    }
  };

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
        <div className="message-list-empty-sub">Send a message or photo below</div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={listRef} onScroll={handleScroll}>
      {loadingOlder[roomId] && <div className="date-divider">Loading older messages…</div>}
      {processedMessages.map((msg) => {
        const mine = msg.sender_id === user?.id;
        const edited = !!(msg.edited_at || msg.updated_at);
        return (
          <React.Fragment key={msg.id}>
            {msg.showDate && <DateDivider date={msg.created_at} />}
            <div className={`message-row ${msg.isGrouped ? 'grouped' : ''} ${mine ? 'mine' : ''}`} id={`msg-${msg.id}`}>
              <button
                className="message-avatar"
                style={{ background: msg.avatar_color || '#6366f1', visibility: msg.isGrouped ? 'hidden' : 'visible' }}
                onClick={() => onOpenProfile?.(msg.sender_id)}
                title={`View ${(msg.display_name || msg.username || '')}'s profile`}
              >
                {(msg.display_name || msg.username || '?')[0].toUpperCase()}
              </button>
              <div className="message-content">
                {!msg.isGrouped && (
                  <div className="message-header">
                    <button className="message-sender" style={{ color: msg.avatar_color }} onClick={() => onOpenProfile?.(msg.sender_id)}>
                      {msg.display_name || msg.username}
                    </button>
                    <span className="message-time">
                      {format(new Date(msg.created_at * 1000), 'h:mm a')}
                      {edited && !msg.is_deleted ? ' • edited' : ''}
                    </span>
                  </div>
                )}
                {msg.reply_to && <ReplyQuote replyId={msg.reply_to} roomId={roomId} />}
                {editingId === msg.id ? (
                  <div className="edit-box">
                    <textarea
                      className="form-input"
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      maxLength={2000}
                      rows={2}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button className="btn-mini primary" onClick={submitEdit}>Save</button>
                      <button className="btn-mini" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <MessageContent message={msg} />
                )}
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
                            socket?.emit(reacted ? 'message:unreact' : 'message:react', { messageId: msg.id, emoji: r.emoji, roomId });
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
              <MessageActions message={msg} roomId={roomId} onReply={onReply} onEdit={startEdit} onReport={setReportMsg} />
            </div>
          </React.Fragment>
        );
      })}

      {reportMsg && (
        <div className="modal-overlay" onClick={() => setReportMsg(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">⚑ Report message</div>
              <button className="icon-btn" onClick={() => setReportMsg(null)}>✕</button>
            </div>
            <form onSubmit={submitReport}>
              <div className="form-group">
                <label className="form-label" htmlFor="report-reason">Why are you reporting this?</label>
                <textarea
                  id="report-reason"
                  className="form-input"
                  value={reportReason}
                  onChange={e => setReportReason(e.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="e.g. spam, harassment…"
                  required
                />
              </div>
              {reportState === 'sent'
                ? <div className="profile-msg">Report sent — thanks ✦</div>
                : reportState && reportState !== 'sending'
                  ? <div className="form-error">{reportState}</div>
                  : null}
              <button className="btn-primary" type="submit" disabled={!reportReason.trim() || reportState === 'sending'}>
                {reportState === 'sending' ? 'Sending…' : 'Send report'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
