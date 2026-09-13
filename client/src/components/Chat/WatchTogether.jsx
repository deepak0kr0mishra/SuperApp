import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { getSocket } from '../../services/socket.js';
import { api } from '../../services/api.js';
import { formatTime } from '../../utils/youtube.js';

// One shared YouTube player per room, driven by the real IFrame Player API.
// Anyone can queue / play / pause / seek — every action syncs to the room
// via socket + REST persistence. Volume stays personal (never synced).

let ytApiPromise = null;
function loadYouTubeAPI() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => reject(new Error('YouTube API failed to load'));
    document.head.appendChild(tag);
    const timeout = setTimeout(() => reject(new Error('YouTube API timeout')), 12000);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      try { prev?.(); } catch {}
      resolve(window.YT);
    };
  });
  return ytApiPromise;
}

// NOTE: parent renders <WatchTogether key={roomId} /> so all state is per-room
// and resets cleanly when switching rooms.
export default function WatchTogether({ roomId }) {
  const watch = useChatStore((s) => s.watch[roomId]);
  const [apiFailed, setApiFailed] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);

  const mountRef = useRef(null);
  const wrapRef = useRef(null);
  const playerRef = useRef(null);
  const volumeRef = useRef(80);
  const lastRemoteRef = useRef(0);
  volumeRef.current = volume;

  const vid = watch?.video_id || '';

  // Load persisted state on mount.
  useEffect(() => {
    api.getWatch(roomId)
      .then(({ watch: w }) => {
        if (w?.video_id) useChatStore.getState().setWatch(roomId, w);
      })
      .catch(() => {});
  }, [roomId]);

  // Broadcast + persist a playback change (local intent only).
  const emitState = useCallback((nextPlaying, pos) => {
    const position = Math.max(0, Math.floor(pos || 0));
    const prev = useChatStore.getState().watch[roomId] || {};
    useChatStore.getState().setWatch(roomId, {
      ...prev, room_id: roomId, is_playing: nextPlaying ? 1 : 0, position,
    });
    getSocket()?.emit('watch:state', { roomId, is_playing: nextPlaying, position });
    const videoId = useChatStore.getState().watch[roomId]?.video_id;
    if (videoId) {
      api.setWatch(roomId, { videoId, is_playing: nextPlaying, position }).catch(() => {});
    }
  }, [roomId]);

  // Native player buttons (inside the iframe) also sync to the room,
  // unless the change just came from a remote apply.
  const handlePlayerState = useCallback((e) => {
    if (Date.now() - lastRemoteRef.current < 1500) return;
    try {
      const st = e?.data;
      if (st === window.YT?.PlayerState?.PLAYING) {
        setPlaying(true);
        emitState(true, playerRef.current?.getCurrentTime?.() || 0);
      } else if (st === window.YT?.PlayerState?.PAUSED) {
        setPlaying(false);
        emitState(false, playerRef.current?.getCurrentTime?.() || 0);
      }
    } catch {}
  }, [emitState]);

  const handlePlayerError = useCallback(() => {
    setPlayerError('This video cannot be played here (private, deleted, or embedding disabled). Try another link.');
  }, []);

  // Create / destroy the player for the current video.
  useEffect(() => {
    if (!vid || apiFailed) return;
    let cancelled = false;
    let player = null;
    setReady(false);
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
    setPlayerError('');
    loadYouTubeAPI().then((YT) => {
      if (cancelled || !mountRef.current) return;
      player = new YT.Player(mountRef.current, {
        width: '100%',
        height: '100%',
        videoId: vid,
        playerVars: { rel: 0, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            playerRef.current = e.target;
            try {
              e.target.setVolume(volumeRef.current);
              const w = useChatStore.getState().watch[roomId];
              if (w?.position > 0) e.target.seekTo(w.position, true);
              if (w?.is_playing) e.target.playVideo();
            } catch {}
            setReady(true);
          },
          onStateChange: handlePlayerState,
          onError: handlePlayerError,
        },
      });
    }).catch(() => { if (!cancelled) setApiFailed(true); });
    return () => {
      cancelled = true;
      try { player?.destroy(); } catch {}
      if (playerRef.current === player) playerRef.current = null;
      setReady(false);
    };
  }, [roomId, vid, apiFailed, handlePlayerState, handlePlayerError]);

  // Apply remote state (echoes of our own actions are natural no-ops).
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !ready || !watch?.video_id) return;
    lastRemoteRef.current = Date.now();
    try {
      const st = p.getPlayerState?.();
      const isPlaying = st === 1;
      const wantPlaying = !!watch.is_playing;
      if (wantPlaying !== isPlaying) {
        if (wantPlaying) p.playVideo();
        else p.pauseVideo();
      }
      setPlaying(wantPlaying);
    } catch {}
    try {
      const t = p.getCurrentTime?.() || 0;
      if (Math.abs((watch.position || 0) - t) > 4) p.seekTo(watch.position || 0, true);
    } catch {}
  }, [watch, ready]);

  // Progress ticker.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      try {
        const p = playerRef.current;
        if (!p?.getCurrentTime) return;
        setCurrent(p.getCurrentTime() || 0);
        const d = p.getDuration?.() || 0;
        if (d) setDuration(d);
      } catch {}
    }, 500);
    return () => clearInterval(t);
  }, [ready]);

  // Heartbeat while playing so joiners land close to live.
  useEffect(() => {
    if (!ready || !playing) return;
    const t = setInterval(() => {
      try {
        const pos = Math.floor(playerRef.current?.getCurrentTime?.() || 0);
        getSocket()?.emit('watch:state', { roomId, is_playing: true, position: pos });
      } catch {}
    }, 10000);
    return () => clearInterval(t);
  }, [ready, playing, roomId]);

  if (!roomId) return null;

  const localPos = () => {
    try { return playerRef.current?.getCurrentTime?.() || current; } catch { return current; }
  };

  const doToggle = () => {
    const p = playerRef.current;
    if (!p || !ready) {
      // API not ready yet — flip server state, player follows on load.
      emitState(!playing, watch?.position || 0);
      setPlaying(!playing);
      return;
    }
    try {
      if (playing) { p.pauseVideo(); }
      else { p.playVideo(); }
    } catch {}
    const next = !playing;
    setPlaying(next);
    emitState(next, localPos());
  };

  const doSkip = (sec) => {
    const p = playerRef.current;
    const base = localPos();
    const target = Math.max(0, Math.min(base + sec, duration || base + sec));
    try { p?.seekTo?.(target, true); } catch {}
    setCurrent(target);
    emitState(playing, target);
  };

  const doSeek = (v) => {
    const target = Number(v) || 0;
    try { playerRef.current?.seekTo?.(target, true); } catch {}
    setCurrent(target);
    emitState(playing, target);
  };

  const doVolume = (v) => {
    const val = Math.max(0, Math.min(100, Number(v) || 0));
    setVolume(val);
    try {
      playerRef.current?.setVolume?.(val);
      if (val > 0 && muted) { playerRef.current?.unMute?.(); setMuted(false); }
    } catch {}
  };

  const doMute = () => {
    try {
      if (muted) { playerRef.current?.unMute?.(); }
      else { playerRef.current?.mute?.(); }
    } catch {}
    setMuted(!muted);
  };

  const doFullscreen = () => {
    try {
      const el = wrapRef.current;
      if (!el) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen?.();
    } catch {}
  };

  const clear = () => {
    try { playerRef.current?.stopVideo?.(); } catch {}
    useChatStore.getState().setWatch(roomId, { room_id: roomId, video_id: '', url: '', is_playing: 0, position: 0 });
    getSocket()?.emit('watch:set', { roomId, url: '' });
    api.setWatch(roomId, { url: '' }).catch(() => {});
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  };

  return (
    <div className="watch-card">
      <div className="watch-header">
        <span>📺 Watch together</span>
        {vid && (
          <span className="watch-actions">
            <span className={`watch-live ${playing ? 'on' : ''}`} title={playing ? 'Playing for everyone' : 'Paused for everyone'}>
              {playing ? '🔴 LIVE' : '⏸ PAUSED'}
            </span>
            <button className="btn-mini" onClick={clear} title="Remove video">✕ Clear</button>
          </span>
        )}
      </div>
      {vid ? (
        <div className="watch-player" ref={wrapRef}>
          {apiFailed ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${vid}?rel=0`}
              title="Watch together"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <div ref={mountRef} className="watch-yt-mount" />
          )}
          {playerError && <div className="form-error" style={{ marginTop: 8 }}>{playerError}</div>}
          {!ready && !apiFailed && <div className="watch-loading">⏳ Loading player… controls work anyway</div>}
          <div className="watch-controls">
            <button className="wc-btn" onClick={() => doSkip(-10)} title="Back 10 seconds for everyone">⏪<span>10</span></button>
            <button className="wc-btn wc-play" onClick={doToggle} title={playing ? 'Pause for everyone' : 'Play for everyone'}>
              {playing ? '⏸' : '▶'}
            </button>
            <button className="wc-btn" onClick={() => doSkip(10)} title="Forward 10 seconds for everyone">⏩<span>10</span></button>
            <span className="wc-time">{formatTime(current)} / {formatTime(duration)}</span>
            <input
              className="wc-seek"
              type="range"
              min={0}
              max={Math.max(1, Math.floor(duration) || 100)}
              value={Math.floor(Math.min(current, duration || current))}
              onChange={(e) => doSeek(e.target.value)}
              disabled={!ready || !duration}
              title="Seek"
            />
            <button className="wc-btn" onClick={doMute} title={muted ? 'Unmute (you only)' : 'Mute (you only)'}>
              {muted || volume === 0 ? '🔇' : volume < 50 ? '🔈' : '🔊'}
            </button>
            <input
              className="wc-vol"
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              onChange={(e) => doVolume(e.target.value)}
              title="Volume (you only)"
            />
            <button className="wc-btn" onClick={doFullscreen} title="Fullscreen">⛶</button>
          </div>
        </div>
      ) : (
        // Parent only mounts this card while a video is queued — nothing to show otherwise.
        null
      )}
    </div>
  );
}
