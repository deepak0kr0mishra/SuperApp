import React, { useState, useRef, useCallback, useEffect } from 'react';
import EmojiPicker from 'emoji-picker-react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { encryptText, encryptFile, getKeyForRoom } from '../../crypto/e2e.js';

const ACCEPTED_TYPES = '*/*';

function useTypingIndicator(roomId) {
  const socket = getSocket();
  const typingRef = useRef(false);
  const timerRef = useRef(null);

  const startTyping = useCallback(() => {
    if (!typingRef.current && socket && roomId) {
      typingRef.current = true;
      socket.emit('typing:start', { roomId });
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      typingRef.current = false;
      socket?.emit('typing:stop', { roomId });
    }, 3000);
  }, [socket, roomId]);

  const stopTyping = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (typingRef.current && socket && roomId) {
      typingRef.current = false;
      socket.emit('typing:stop', { roomId });
    }
  }, [socket, roomId]);

  return { startTyping, stopTyping };
}

export default function MessageInput({ roomId, replyTo, onClearReply }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const emojiRef = useRef(null);

  const { user, keyPair } = useAuthStore();
  const { rooms, members, encryptMessage } = useChatStore();
  const { startTyping, stopTyping } = useTypingIndicator(roomId);

  // Close emoji on outside click
  useEffect(() => {
    const handler = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) {
        setShowEmoji(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const getEncryptionKey = async () => {
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    return getKeyForRoom(
      roomId,
      room?.type || 'channel',
      keyPair.privateKey,
      roomMembers,
      user.id
    );
  };

  const sendTextMessage = async () => {
    const content = text.trim();
    if (!content || !keyPair || !roomId) return;

    setText('');
    stopTyping();
    onClearReply?.();

    const socket = getSocket();
    if (!socket) return;

    try {
      const key = await getEncryptionKey();
      const encrypted = await encryptText(content, key);
      socket.emit('message:send', {
        roomId,
        encryptedContent: encrypted,
        type: 'text',
        replyTo: replyTo?.id || null,
      });
    } catch (err) {
      console.error('Send error:', err);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage();
    }
  };

  const handleChange = (e) => {
    setText(e.target.value);
    startTyping();
    // Auto-resize textarea
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !roomId || !keyPair) return;
    e.target.value = '';

    setUploading(true);
    setUploadProgress(0);

    try {
      // Read, encrypt, re-wrap as Blob, upload
      const arrayBuffer = await file.arrayBuffer();
      const key = await getEncryptionKey();

      const encryptedBuffer = await encryptFile(arrayBuffer, key);
      const encryptedBlob = new Blob([encryptedBuffer]);
      const encryptedFile = new File([encryptedBlob], file.name, { type: file.type });

      const result = await api.uploadFile(encryptedFile, roomId, (pct) => setUploadProgress(pct));

      // Determine message type
      let type = 'file';
      if (file.type.startsWith('image/')) type = 'image';
      else if (file.type.startsWith('audio/')) type = 'audio';

      // Encrypt filename as message content
      const encryptedName = await encryptText(file.name, key);

      const socket = getSocket();
      socket?.emit('message:send', {
        roomId,
        encryptedContent: encryptedName,
        type,
        fileId: result.fileId,
        fileName: file.name,
        fileSize: file.size,
        fileMime: file.type,
      });
    } catch (err) {
      console.error('File upload error:', err);
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const onEmojiClick = (emojiData) => {
    const emoji = emojiData.emoji;
    const start = textareaRef.current?.selectionStart || text.length;
    const end = textareaRef.current?.selectionEnd || text.length;
    setText(prev => prev.slice(0, start) + emoji + prev.slice(end));
    setShowEmoji(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  return (
    <div className="message-input-area">
      {replyTo && (
        <div className="reply-preview" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            Replying to <strong>{replyTo.display_name || replyTo.username}</strong>
          </span>
          <button
            className="icon-btn"
            style={{ width: 20, height: 20, fontSize: 12 }}
            onClick={onClearReply}
          >✕</button>
        </div>
      )}

      {uploading && uploadProgress !== null && (
        <div className="upload-progress">
          <span>🔒 Encrypting & uploading…</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
          <span style={{ font: '11px monospace', color: 'var(--text-muted)' }}>{uploadProgress}%</span>
        </div>
      )}

      <div className="input-box">
        {/* File attach */}
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          accept={ACCEPTED_TYPES}
          onChange={handleFileSelect}
          id="file-attach-input"
        />
        <button
          id="attach-file-btn"
          className="input-action-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach file"
          disabled={uploading}
        >
          📎
        </button>

        {/* Text input */}
        <textarea
          ref={textareaRef}
          id="message-textarea"
          placeholder={`Message #${rooms.find(r => r.id === roomId)?.name || 'channel'}`}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={uploading}
        />

        {/* Right actions */}
        <div className="input-actions">
          {/* Emoji */}
          <div style={{ position: 'relative' }} ref={emojiRef}>
            <button
              id="emoji-picker-btn"
              className="input-action-btn"
              onClick={() => setShowEmoji(v => !v)}
              title="Emoji"
            >
              😊
            </button>
            {showEmoji && (
              <div className="emoji-picker-wrapper">
                <EmojiPicker
                  onEmojiClick={onEmojiClick}
                  theme="dark"
                  skinTonesDisabled
                  searchDisabled={false}
                  lazyLoadEmojis
                />
              </div>
            )}
          </div>

          {/* Send */}
          <button
            id="send-message-btn"
            className="send-btn"
            onClick={sendTextMessage}
            disabled={!text.trim() || uploading}
            title="Send message"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}
