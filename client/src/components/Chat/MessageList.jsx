import React, { useEffect, useRef, useState, useCallback } from 'react';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { useChatStore } from '../../stores/chatStore.js';
import { useAuthStore } from '../../stores/authStore.js';
import { getSocket } from '../../services/socket.js';
import { Avatar, formatBytes, getFileIcon } from '../shared/Avatar.jsx';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

function DateDivider({ date }) {
  const d = new Date(date * 1000);
  let label;
  if (isToday(d)) label = 'Today';
  else if (isYesterday(d)) label = 'Yesterday';
  else label = format(d, 'MMMM d, yyyy');
  return <div className="date-divider">{label}</div>;
}

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
      <button
        className="input-action-btn"
        onClick={() => onReply(message)}
        title="Reply"
        style={{ fontSize: 14 }}
      >
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

function MessageContent({ message, roomId, keyPair, userId, members, rooms }) {
  const [decrypted, setDecrypted] = useState(null);
  const { decryptMessage, decryptFileData } = useChatStore();
  const [imageUrl, setImageUrl] = useState(null);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (message.encrypted_content) {
        const text = await decryptMessage(message.encrypted_content, roomId, keyPair, userId);
        if (!cancelled) setDecrypted(text);
      }
    })();
    return () => { cancelled = true; };
  }, [message.encrypted_content, roomId]);

  useEffect(() => {
    if ((message.type === 'image' || message.type === 'audio') && message.file_id) {
      // Fetch and decrypt the file
      (async () => {
        try {
          const token = localStorage.getItem('sc_token');
          const res = await fetch(`/api/files/${message.file_id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const blob = await res.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const decryptedBuffer = await decryptFileData(arrayBuffer, roomId, keyPair, userId);
          const url = URL.createObjectURL(new Blob([decryptedBuffer], { type: message.file_mime }));
          setImageUrl(url);
        } catch (err) {
          console.error('File decrypt error:', err);
        }
      })();
    }
  }, [message.file_id]);

  if (message.type === 'image') {
    return (
      <div>
        {message.file_name && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{message.file_name}</div>}
        {imageUrl ? (
          <>
            <img
              className="message-image"
              src={imageUrl}
              alt={message.file_name}
              onClick={() => setLightbox(true)}
            />
            {lightbox && (
              <div className="lightbox" onClick={() => setLightbox(false)}>
                <img src={imageUrl} alt={message.file_name} />
              </div>
            )}
          </>
        ) : (
          <div style={{ padding: '20px', background: 'var(--bg-elevated)', borderRadius: 10, color: 'var(--text-muted)', fontSize: 13 }}>
            <span className="spinner" style={{ display: 'inline-block', width: 16, height: 16, marginRight: 8 }} />
            Decrypting image…
          </div>
        )}
      </div>
    );
  }

  if (message.type === 'audio') {
    return (
      <div className="message-audio">
        <span style={{ fontSize: 20 }}>🎵</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>{message.file_name}</div>
          {imageUrl ? (
            <audio className="audio-player" controls src={imageUrl} preload="none" />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <span className="spinner" style={{ display: 'inline-block', width: 12, height: 12, marginRight: 6 }} />
              Decrypting…
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.type === 'file') {
    const handleDownload = async () => {
      try {
        const token = localStorage.getItem('sc_token');
        const res = await fetch(`/api/files/${message.file_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const decryptedBuffer = await decryptFileData(arrayBuffer, roomId, keyPair, userId);
        const url = URL.createObjectURL(new Blob([decryptedBuffer], { type: message.file_mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = message.file_name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Download failed:', err);
      }
    };

    return (
      <div className="message-file" onClick={handleDownload}>
        <span className="file-icon">{getFileIcon(message.file_mime)}</span>
        <div className="file-info">
          <div className="file-name">{message.file_name}</div>
          <div className="file-size">{formatBytes(message.file_size)} • Click to download</div>
        </div>
        <span style={{ color: 'var(--brand-primary)', fontSize: 18 }}>⬇</span>
      </div>
    );
  }

  return (
    <div className="message-text">
      {decrypted ?? (
        <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Decrypting…</span>
      )}
    </div>
  );
}

export default function MessageList({ roomId, onReply }) {
  const { messages, members } = useChatStore();
  const { user, keyPair } = useAuthStore();
  const rooms = useChatStore(s => s.rooms);
  const listRef = useRef(null);
  const roomMessages = messages[roomId] || [];

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [roomMessages.length]);

  if (roomMessages.length === 0) {
    return (
      <div className="message-list message-list-empty" ref={listRef}>
        <div className="message-list-empty-icon">💬</div>
        <div className="message-list-empty-text">Start the conversation</div>
        <div className="message-list-empty-sub">Messages are end-to-end encrypted 🔒</div>
      </div>
    );
  }

  let lastDate = null;
  let lastSenderId = null;

  return (
    <div className="message-list" ref={listRef}>
      {roomMessages.map((msg, i) => {
        const msgDate = new Date(msg.created_at * 1000);
        const showDate = !lastDate || !isSameDay(msgDate, new Date(lastDate * 1000));
        if (showDate) lastDate = msg.created_at;

        const isGrouped = !showDate && lastSenderId === msg.sender_id;
        lastSenderId = msg.sender_id;

        const isOwn = msg.sender_id === user?.id;

        return (
          <React.Fragment key={msg.id}>
            {showDate && <DateDivider date={msg.created_at} />}
            <div className={`message-row ${isGrouped ? 'grouped' : ''}`} id={`msg-${msg.id}`}>
              <div
                className="message-avatar"
                style={{ background: msg.avatar_color || '#6366f1' }}
              >
                {(msg.display_name || msg.username || '?')[0].toUpperCase()}
              </div>
              <div className="message-content">
                {!isGrouped && (
                  <div className="message-header">
                    <span className="message-sender" style={{ color: msg.avatar_color }}>
                      {msg.display_name || msg.username}
                    </span>
                    <span className="message-time">
                      {format(msgDate, 'h:mm a')}
                    </span>
                  </div>
                )}
                <MessageContent
                  message={msg}
                  roomId={roomId}
                  keyPair={keyPair}
                  userId={user?.id}
                  members={members[roomId] || []}
                  rooms={rooms}
                />
                {msg.reactions && msg.reactions.length > 0 && (
                  <div className="message-reactions">
                    {msg.reactions.map(r => (
                      <button
                        key={r.emoji}
                        className={`reaction-btn ${r.users?.includes(user?.id) ? 'reacted' : ''}`}
                        onClick={() => {
                          const socket = getSocket();
                          if (r.users?.includes(user?.id)) {
                            socket?.emit('message:unreact', { messageId: msg.id, emoji: r.emoji, roomId });
                          } else {
                            socket?.emit('message:react', { messageId: msg.id, emoji: r.emoji, roomId });
                          }
                        }}
                      >
                        {r.emoji}
                        <span className="reaction-count">{r.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <MessageActions message={msg} roomId={roomId} onReply={onReply} />
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
