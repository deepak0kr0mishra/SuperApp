import React, { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from 'emoji-picker-react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';


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
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [sendError, setSendError] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  const textareaRef = useRef(null);
  const emojiRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

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



  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], `Voice_Message_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, { type: 'audio/webm' });
        sendFile(file, 'audio/webm');
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Microphone access denied or error:', err);
      setSendError('Microphone access denied');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(recordingTimerRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.onstop = null; // Prevent upload
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      clearInterval(recordingTimerRef.current);
    }
  };

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

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
          disabled={uploading || isRecording}
        >📎</button>
        {isRecording ? (
          <div className="recording-ui" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 8px', color: 'var(--danger)', fontWeight: 'bold' }}>
            <span className="recording-dot" style={{ animation: 'live-pulse 1s infinite' }}>🔴</span>
            <span>{Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}</span>
            <button className="icon-btn" onClick={cancelRecording} title="Cancel" style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>✕</button>
            <button className="icon-btn" onClick={stopRecording} title="Send" style={{ color: 'var(--brand)' }}>➤</button>
          </div>
        ) : (
          <button
            className="input-action-btn"
            onClick={startRecording}
            title="Record Voice Message"
            disabled={uploading}
          >🎤</button>
        )}

        <textarea
          ref={textareaRef}
          id="message-textarea"
          placeholder={`Message ${activeRoom?.type === 'dm' ? '' : '#'}${activeRoom?.name || 'channel'}`}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={uploading || isRecording}
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
            disabled={!text.trim() || uploading || isRecording}
            title="Send message (Enter)"
          >➤</button>
        </div>
      </div>
    </div>
  );
}
