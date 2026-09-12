import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';

function toEmbedUrl(watch) {
  if (!watch?.video_id) return '';
  const params = new URLSearchParams({
    autoplay: watch.is_playing ? '1' : '0',
    rel: '0',
  });
  if (watch.position > 0) params.set('start', String(Math.floor(watch.position)));
  return `https://www.youtube-nocookie.com/embed/${watch.video_id}?${params.toString()}`;
}

// One shared YouTube player per room. Anyone can queue a link; play/pause
// state syncs to everyone in the room via socket + REST persistence.
export default function WatchTogether({ roomId }) {
  const watch = useChatStore((s) => s.watch[roomId]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lastVid = useRef('');

  useEffect(() => {
    // Load persisted state when opening a room.
    api.getWatch(roomId)
      .then(({ watch: w }) => {
        if (w?.video_id) useChatStore.getState().setWatch(roomId, w);
      })
      .catch(() => {});
  }, [roomId]);

  useEffect(() => {
    if (watch?.video_id) lastVid.current = watch.video_id;
  }, [watch?.video_id]);

  if (!roomId) return null;

  const submit = async (e) => {
    e?.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { watch: w } = await api.setWatch(roomId, { url: url.trim(), is_playing: true, position: 0 });
      useChatStore.getState().setWatch(roomId, w);
      getSocket()?.emit('watch:set', { roomId, url: url.trim() });
      setUrl('');
    } catch (err) {
      setError(err.message || 'Could not load that video');
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = () => {
    if (!watch?.video_id) return;
    const next = !watch.is_playing;
    const optimistic = { ...watch, is_playing: next ? 1 : 0 };
    useChatStore.getState().setWatch(roomId, optimistic);
    getSocket()?.emit('watch:state', { roomId, is_playing: next, position: watch.position || 0 });
    api.setWatch(roomId, { videoId: watch.video_id, is_playing: next, position: watch.position || 0 }).catch(() => {});
  };

  const clear = () => {
    useChatStore.getState().setWatch(roomId, { room_id: roomId, video_id: '', url: '', is_playing: 0, position: 0 });
    getSocket()?.emit('watch:set', { roomId, url: '' });
    api.setWatch(roomId, { url: '' }).catch(() => {});
  };

  return (
    <div className="watch-card">
      <div className="watch-header">
        <span>📺 Watch together</span>
        {watch?.video_id && (
          <span className="watch-actions">
            <button className="btn-mini" onClick={togglePlay} title={watch.is_playing ? 'Pause for everyone' : 'Play for everyone'}>
              {watch.is_playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <button className="btn-mini" onClick={clear} title="Remove video">✕</button>
          </span>
        )}
      </div>
      {watch?.video_id ? (
        <div className="watch-player">
          <iframe
            key={`${watch.video_id}-${watch.is_playing ? 'play' : 'pause'}`}
            src={toEmbedUrl(watch)}
            title="Watch together"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="watch-empty">No video yet — paste a YouTube link below and everyone watches in sync ✦</div>
      )}
      <form className="watch-form" onSubmit={submit}>
        <input
          className="form-input"
          placeholder="Paste a YouTube link…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={500}
        />
        <button className="btn-mini primary" type="submit" disabled={busy || !url.trim()}>
          {busy ? 'Loading…' : 'Queue'}
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
