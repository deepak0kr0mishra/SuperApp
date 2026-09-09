import React, { useState, useRef, useEffect, useCallback } from 'react';
import EmojiPicker from 'emoji-picker-react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { encryptText, encryptFile } from '../../crypto/e2e.js';

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

// --- Audio Recorder component ---
function AudioRecorder({ onRecordingComplete, onCancel }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [amplitude, setAmplitude] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    startRecording();
    return () => cleanup();
  }, []);

  const cleanup = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Visualisation
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const detectAmplitude = () => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setAmplitude(avg);
        animFrameRef.current = requestAnimationFrame(detectAmplitude);
      };
      detectAmplitude();

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        onRecordingComplete(blob, mimeType);
        cleanup();
      };

      recorder.start(100); // collect every 100ms
      setRecording(true);

      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } catch (err) {
      console.error('Recording error:', err);
      onCancel();
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  const formatTime = (s) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  const bars = 20;
  const normalizedAmp = Math.min(amplitude / 60, 1);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      background: 'rgba(244,63,94,0.08)',
      border: '1px solid rgba(244,63,94,0.25)',
      borderRadius: 12,
      padding: '8px 14px',
      marginBottom: 8,
    }}>
      {/* Recording dot */}
      <div style={{
        width: 10, height: 10, borderRadius: '50%',
        background: 'var(--danger)',
        animation: 'recording-pulse 1s infinite',
        flexShrink: 0,
      }} />

      {/* Waveform visualiser */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 28, flex: 1 }}>
        {Array.from({ length: bars }).map((_, i) => {
          const phase = (i / bars) * Math.PI * 2;
          const h = 4 + normalizedAmp * 20 * Math.abs(Math.sin(phase + Date.now() / 200));
          return (
            <div
              key={i}
              style={{
                width: 3,
                height: Math.max(4, Math.min(24, h + Math.random() * normalizedAmp * 6)),
                background: 'var(--danger)',
                borderRadius: 2,
                opacity: 0.6 + normalizedAmp * 0.4,
                transition: 'height 0.1s ease',
              }}
            />
          );
        })}
      </div>

      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', flexShrink: 0, fontFamily: 'monospace' }}>
        {formatTime(elapsed)}
      </span>

      {/* Cancel */}
      <button
        onClick={() => { cleanup(); onCancel(); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)' }}
        title="Cancel recording"
      >🗑</button>

      {/* Stop & Send */}
      <button
        id="stop-recording-btn"
        onClick={stopRecording}
        style={{
          background: 'var(--danger)',
          border: 'none',
          borderRadius: 8,
          padding: '6px 14px',
          color: 'white',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        ⏹ Send
      </button>
    </div>
  );
}

// --- Main MessageInput ---
export default function MessageInput({ roomId, replyTo, onClearReply }) {
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const emojiRef = useRef(null);

  const { user, keyPair } = useAuthStore();
  const { rooms, members, getEncryptionKey } = useChatStore();
  const { startTyping, stopTyping } = useTypingIndicator(roomId);

  // Close emoji picker on outside click
  useEffect(() => {
    const handler = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) {
        setShowEmoji(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const getKey = useCallback(async () => {
    if (!keyPair || !user?.id || !roomId) throw new Error('Not ready');
    return getEncryptionKey(roomId, keyPair, user.id);
  }, [roomId, keyPair, user?.id, getEncryptionKey]);

  // --- Send text message ---
  const sendTextMessage = async () => {
    const content = text.trim();
    if (!content || !keyPair || !roomId) return;

    setText('');
    stopTyping();
    onClearReply?.();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const socket = getSocket();
    if (!socket) return;

    try {
      const key = await getKey();
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
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  // --- Send file (image / audio / generic) ---
  const sendFile = async (file, forceMime) => {
    if (!file || !roomId || !keyPair || !user?.id) return;
    setUploading(true);
    setUploadProgress(0);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const key = await getKey();
      const encryptedBuffer = await encryptFile(arrayBuffer, key);
      const encryptedBlob = new Blob([encryptedBuffer]);
      const encryptedFile = new File([encryptedBlob], file.name, { type: file.type || forceMime });

      const result = await api.uploadFile(encryptedFile, roomId, (pct) => setUploadProgress(pct));

      let type = 'file';
      const mime = forceMime || file.type || '';
      if (mime.startsWith('image/')) type = 'image';
      else if (mime.startsWith('audio/')) type = 'audio';

      const encryptedName = await encryptText(file.name, key);
      const socket = getSocket();
      socket?.emit('message:send', {
        roomId,
        encryptedContent: encryptedName,
        type,
        fileId: result.fileId,
        fileName: file.name,
        fileSize: file.size,
        fileMime: mime,
      });
    } catch (err) {
      console.error('File send error:', err);
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

  // --- Audio recording complete ---
  const handleRecordingComplete = async (blob, mimeType) => {
    setIsRecording(false);
    const ext = mimeType.includes('ogg') ? '.ogg' : '.webm';
    const file = new File([blob], `voice-message-${Date.now()}${ext}`, { type: mimeType });
    await sendFile(file, mimeType);
  };

  const onEmojiClick = (emojiData) => {
    const emoji = emojiData.emoji;
    const start = textareaRef.current?.selectionStart ?? text.length;
    const end = textareaRef.current?.selectionEnd ?? text.length;
    setText(prev => prev.slice(0, start) + emoji + prev.slice(end));
    setShowEmoji(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const activeRoom = rooms.find(r => r.id === roomId);

  return (
    <div className="message-input-area">
      {/* Reply preview */}
      {replyTo && (
        <div className="reply-preview" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Replying to <strong>{replyTo.display_name || replyTo.username}</strong></span>
          <button className="icon-btn" style={{ width: 20, height: 20, fontSize: 12 }} onClick={onClearReply}>✕</button>
        </div>
      )}

      {/* Upload progress */}
      {uploading && uploadProgress !== null && (
        <div className="upload-progress">
          <span>🔒 Encrypting & uploading…</span>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }} />
          </div>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{uploadProgress}%</span>
        </div>
      )}

      {/* Audio recorder UI */}
      {isRecording && (
        <AudioRecorder
          onRecordingComplete={handleRecordingComplete}
          onCancel={() => setIsRecording(false)}
        />
      )}

      {/* Main input box */}
      {!isRecording && (
        <div className="input-box">
          {/* Hidden file input */}
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept="*/*"
            onChange={handleFileSelect}
            id="file-attach-input"
          />

          {/* Attach file */}
          <button
            id="attach-file-btn"
            className="input-action-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file or photo"
            disabled={uploading}
          >📎</button>

          {/* Audio record button — press to record voice note, then Send */}
          <button
            id="record-audio-btn"
            className="input-action-btn"
            onClick={() => setIsRecording(true)}
            title="🎙️ Record voice note — press to start recording, then Send"
            disabled={uploading}
            style={{ color: 'var(--danger)', position: 'relative' }}
          >🎙️<span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)', animation: 'recording-pulse 1.6s infinite' }} /></button>

          {/* Text area */}
          <textarea
            ref={textareaRef}
            id="message-textarea"
            placeholder={`Message ${activeRoom?.type === 'dm' ? '' : '#'}${activeRoom?.name || 'channel'}`}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={uploading}
          />

          <div className="input-actions">
            {/* Emoji picker */}
            <div style={{ position: 'relative' }} ref={emojiRef}>
              <button
                id="emoji-picker-btn"
                className="input-action-btn"
                onClick={() => setShowEmoji(v => !v)}
                title="Emoji"
              >😊</button>
              {showEmoji && (
                <div className="emoji-picker-wrapper">
                  <EmojiPicker
                    onEmojiClick={onEmojiClick}
                    theme="dark"
                    skinTonesDisabled
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
              title="Send message (Enter)"
            >➤</button>
          </div>
        </div>
      )}
    </div>
  );
}
