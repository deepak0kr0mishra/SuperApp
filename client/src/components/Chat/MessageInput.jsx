import React, { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from 'emoji-picker-react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { findYouTubeId } from '../../utils/youtube.js';

// --- Typing indicator hook ---
function useTypingIndicator(roomId) {
  const typingRef = useRef(false);
  const timerRef = useRef(null);

  const startTyping = useCallback(() => {
    const socket = getSocket();
    if (!socket || !roomId) return;
    if (!typingRef.current) {
      typingRef.current = true;
      socket.emit('typing:start', { roomId });
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      typingRef.current = false;
      socket?.emit('typing:stop', { roomId });
    }, 3000);
  }, [roomId]);

  const stopTyping = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const socket = getSocket();
    if (typingRef.current && socket && roomId) {
      typingRef.current = false;
      socket.emit('typing:stop', { roomId });
    }
  }, [roomId]);

  return { startTyping, stopTyping };
}

export function classifyFile(file, forceMime) {
  const mime = forceMime || file.type || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

// --- Main MessageInput (plain text, no encryption) ---
export default function MessageInput({ roomId, replyTo, onClearReply }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState('');
  const [showYT, setShowYT] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState('');

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const emojiRef = useRef(null);

  const { rooms, myMutes } = useChatStore();
  const { startTyping, stopTyping } = useTypingIndicator(roomId);

  useEffect(() => {
    const handler = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) {
        setShowEmoji(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // --- Send text message (plain) ---
  const sendTextMessage = async () => {
    const content = text.trim();
    if (!content || !roomId) return;
    setText('');
    setSendError('');
    stopTyping();
    onClearReply?.();
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const socket = getSocket();
    if (!socket) {
      setSendError('Not connected. Reconnecting…');
      setText(content);
      return;
    }
    try {
      socket.emit('message:send', {
        roomId,
        content,
        type: 'text',
        replyTo: replyTo?.id || null,
      });
      // YouTube link in a space chat → same as Watch-together queue.
      try {
        const room = rooms.find((r) => r.id === roomId);
        if (room && room.type !== 'dm') {
          const vid = findYouTubeId(content);
          if (vid) {
            api.setWatch(roomId, { videoId: vid, is_playing: true, position: 0 }).then(({ watch }) => {
              if (watch?.video_id) useChatStore.getState().setWatch(roomId, watch);
            }).catch(() => {});
            socket.emit('watch:set', { roomId, videoId: vid });
          }
        }
      } catch {}
    } catch (err) {
      console.error('Send error:', err);
      setSendError('Failed to send. Try again.');
      setText(content);
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
    if (e.target.value.trim()) startTyping();
    else stopTyping();
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  // --- Send file (plain upload, no encryption) ---
  const sendFile = async (file, forceMime) => {
    if (!file || !roomId) return;
    setUploading(true);
    setUploadProgress(0);
    setSendError('');
    try {
      const result = await api.uploadFile(file, roomId, (pct) => setUploadProgress(pct));
      const mime = forceMime || file.type || '';
      const type = classifyFile(file, forceMime);
      const socket = getSocket();
      socket?.emit('message:send', {
        roomId,
        content: file.name,
        type,
        fileId: result.fileId,
        fileName: file.name,
        fileSize: file.size,
        fileMime: mime,
      });
    } catch (err) {
      console.error('File send error:', err);
      setSendError('Upload failed. Try a smaller file.');
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) sendFile(file);
    e.target.value = '';
  };

  const onEmojiClick = (emojiData) => {
    const emoji = emojiData.emoji;
    const start = textareaRef.current?.selectionStart ?? text.length;
    const end = textareaRef.current?.selectionEnd ?? text.length;
    setText(prev => prev.slice(0, start) + emoji + prev.slice(end));
    setShowEmoji(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Queue a YouTube video into the room's Watch-together player.
  const queueYouTube = async (e) => {
    e?.preventDefault();
    const raw = ytUrl.trim();
    if (!raw || !roomId || ytBusy) return;
    setYtBusy(true);
    setYtError('');
    try {
      const { watch } = await api.setWatch(roomId, { url: raw, is_playing: true, position: 0 });
      if (watch?.video_id) {
        useChatStore.getState().setWatch(roomId, watch);
        getSocket()?.emit('watch:set', { roomId, url: raw });
        setYtUrl('');
        setShowYT(false);
      } else {
        setYtError('Could not queue that link');
      }
    } catch (err) {
      setYtError(err.message || 'Send a valid YouTube link');
    } finally {
      setYtBusy(false);
    }
  };

  const activeRoom = rooms.find(r => r.id === roomId);
  const chatMute = (myMutes || []).find(m => m.kind === 'chat');
  const chatMuted = !!chatMute && activeRoom?.type !== 'dm';
  const muteUntil = chatMute ? new Date(chatMute.expires_at * 1000).toLocaleString() : '';

  if (chatMuted) {
    return (
      <div className="message-input-area">
        <div className="mute-notice">🔇 You are muted from chatting until {muteUntil} — DMs still work.</div>
      </div>
    );
  }

  return (
    <div className="message-input-area">
      {replyTo && (
        <div className="reply-preview">
          <span>Replying to <strong>{replyTo.display_name || replyTo.username}</strong>: {(replyTo.content || replyTo.encrypted_content || '').slice(0, 80)}</span>
          <button className="icon-btn" style={{ width: 20, height: 20, fontSize: 12 }} onClick={onClearReply}>✕</button>
        </div>
      )}

      {sendError && <div className="send-error">{sendError}</div>}

      {uploading && uploadProgress !== null && (
        <div className="upload-progress">
          <span>Uploading…</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
          <span className="progress-pct">{uploadProgress}%</span>
        </div>
      )}

      <div className="input-box">
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip"
          onChange={handleFileSelect}
          id="file-attach-input"
        />
        <button
          id="attach-file-btn"
          className="input-action-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach photo, video, or file"
          disabled={uploading}
        >📎</button>
        {activeRoom?.type !== 'dm' && (
          <div style={{ position: 'relative' }}>
            <button
              id="yt-queue-btn"
              className="input-action-btn"
              onClick={() => { setShowYT(v => !v); setYtError(''); }}
              title="Watch together — queue a YouTube video"
              disabled={uploading}
            >📺</button>
            {showYT && (
              <form className="yt-popup" onSubmit={queueYouTube}>
                <div className="yt-popup-title">📺 Watch together</div>
                <input
                  className="form-input"
                  placeholder="Paste a YouTube link…"
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                  maxLength={500}
                  autoFocus
                />
                {ytError && <div className="form-error" style={{ margin: '8px 0 0' }}>{ytError}</div>}
                <div className="yt-popup-actions">
                  <button type="button" className="btn-mini" onClick={() => setShowYT(false)}>Cancel</button>
                  <button type="submit" className="btn-mini primary" disabled={ytBusy || !ytUrl.trim()}>
                    {ytBusy ? 'Loading…' : '▶ Queue & play'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          id="message-textarea"
          placeholder={`Message ${activeRoom?.type === 'dm' ? '' : '#'}${activeRoom?.name || 'channel'}`}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={uploading}
          maxLength={2000}
        />
        <div className="input-actions">
          <div style={{ position: 'relative' }} ref={emojiRef}>
            <button
              id="emoji-picker-btn"
              className="input-action-btn"
              onClick={() => setShowEmoji(v => !v)}
              title="Emoji"
            >😊</button>
            {showEmoji && (
              <div className="emoji-picker-wrapper">
                <EmojiPicker onEmojiClick={onEmojiClick} theme="dark" skinTonesDisabled lazyLoadEmojis />
              </div>
            )}
          </div>
          <button
            id="send-message-btn"
            className="send-btn"
            onClick={sendTextMessage}
            disabled={!text.trim() || uploading}
            title="Send message (Enter)"
          >➤</button>
        </div>
      </div>
    </div>
  );
}
