import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { api } from '../../services/api.js';

function timeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Props:
// - userId?: view someone else (peer profile). Omit/null = my profile (edit mode).
// - onStartDM?: (room) => void — called after creating/opening a DM with peer.
// - onClose: close modal.
export default function ProfileModal({ userId, onClose, onStartDM }) {
  const { user: me, updateProfile } = useAuthStore();
  const { userStatuses } = useChatStore();
  const isSelf = !userId || userId === me?.id;

  const [peer, setPeer] = useState(null);
  const [loadingPeer, setLoadingPeer] = useState(!isSelf);
  const [peerError, setPeerError] = useState('');
  const [startingDM, setStartingDM] = useState(false);

  const [displayName, setDisplayName] = useState(me?.display_name || '');
  const [bio, setBio] = useState(me?.bio || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isSelf) return;
    let cancelled = false;
    setLoadingPeer(true);
    setPeerError('');
    // Fast path: already in allUsers cache
    const cached = useChatStore.getState().allUsers.find(u => u.id === userId);
    if (cached) {
      setPeer(cached);
      setLoadingPeer(false);
    }
    api.getUser(userId)
      .then(({ user }) => { if (!cancelled) { setPeer(user); setLoadingPeer(false); } })
      .catch(() => { if (!cancelled) { if (!cached) setPeerError('Could not load profile'); setLoadingPeer(false); } });
    return () => { cancelled = true; };
  }, [userId, isSelf]);

  if (!me) return null;

  const copyCode = async (u) => {
    const text = `${u.username}#${u.user_code || ''}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      await updateProfile(displayName.trim(), bio.trim());
      setMsg('Profile updated ✦');
    } catch (err) {
      setMsg(err.message || 'Failed to update');
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(''), 3000);
    }
  };

  const handleStartDM = async () => {
    if (!peer) return;
    setStartingDM(true);
    try {
      const { room } = await api.createDM(peer.id);
      useChatStore.getState().addRoom(room);
      try {
        const { members } = await api.getMembers(room.id);
        useChatStore.getState().setMembers(room.id, members);
      } catch {}
      useChatStore.getState().setActiveRoom(room.id);
      onStartDM?.(room);
      onClose?.();
    } catch (err) {
      setPeerError(err.message || 'Could not start chat');
    } finally {
      setStartingDM(false);
    }
  };

  // ---------- Peer profile (view-only + Start chat) ----------
  if (!isSelf) {
    const u = peer;
    const status = u ? (userStatuses[u.id] || u.status || 'offline') : 'offline';
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal profile-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <div className="modal-title">👤 Profile</div>
            <button id="close-profile-modal" className="icon-btn" onClick={onClose}>✕</button>
          </div>
          {loadingPeer && !u && <div className="profile-loading"><span className="spinner" /> Loading profile…</div>}
          {peerError && !u && <div className="form-error">{peerError}</div>}
          {u && (
            <>
              <div className="profile-hero">
                <div className="avatar avatar-xl" style={{ background: u.avatar_color }}>
                  {(u.display_name || u.username)[0].toUpperCase()}
                  <span className={`status-dot ${status}`} style={{ width: 14, height: 14 }} />
                </div>
                <div className="profile-hero-text">
                  <div className="profile-name">{u.display_name || u.username}</div>
                  <div className="profile-handle">@{u.username} {u.user_code ? <span className="code-chip">#{u.user_code}</span> : null}</div>
                  <div className={`profile-status ${status}`}>{status === 'online' ? '🟢 Online now' : '⚫ Offline'}</div>
                  {u.role === 'admin' && <span className="admin-chip">🛡️ ADMIN</span>}
                </div>
              </div>
              {u.bio ? (
                <div className="profile-bio-box">{u.bio}</div>
              ) : (
                <div className="profile-bio-empty">No bio yet</div>
              )}
              <div className="profile-meta">
                <span>✦ Member since {timeAgo(u.created_at)}</span>
              </div>
              <div className="profile-actions">
                <button className="btn-primary" onClick={handleStartDM} disabled={startingDM}>
                  {startingDM ? 'Opening chat…' : `💬 Chat with ${u.display_name || u.username}`}
                </button>
                <button className="btn-ghost" onClick={() => copyCode(u)}>{copied ? '✓ Copied!' : `⧉ Copy ${u.username}#${u.user_code || ''}`}</button>
              </div>
              {peerError && <div className="form-error" style={{ marginTop: 10 }}>{peerError}</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  // ---------- My profile (edit mode, improved) ----------
  const myStatus = 'online';
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">👤 My profile</div>
          <button id="close-profile-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="profile-hero">
          <div className="avatar avatar-xl" style={{ background: me.avatar_color }}>
            {(me.display_name || me.username)[0].toUpperCase()}
            <span className={`status-dot ${myStatus}`} style={{ width: 14, height: 14 }} />
          </div>
          <div className="profile-hero-text">
            <div className="profile-name">{me.display_name || me.username}</div>
            <div className="profile-handle">@{me.username}</div>
            <div className="profile-status online">🟢 Online</div>
            {me.role === 'admin' && <span className="admin-chip">🛡️ ADMIN</span>}
          </div>
        </div>

        <div className="profile-code-box">
          <div>
            <div className="profile-code-label">Your unique code</div>
            <div className="profile-code-value">#{me.user_code || '------'}</div>
            <div className="profile-code-hint">Share <b>{me.username}#{me.user_code}</b> so anyone can find you</div>
          </div>
          <button id="copy-code-btn" className="btn-copy" onClick={() => copyCode(me)}>
            {copied ? '✓ Copied!' : '⧉ Copy'}
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="form-group">
            <label className="form-label" htmlFor="profile-display-name">Display name</label>
            <input
              id="profile-display-name"
              className="form-input"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              maxLength={40}
              placeholder="How should people see you?"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="profile-bio">Bio (max 200)</label>
            <textarea
              id="profile-bio"
              className="form-input profile-bio"
              value={bio}
              onChange={e => setBio(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="Tell people about you…"
            />
            <div className="char-count">{bio.length}/200</div>
          </div>
          {msg && <div className="profile-msg">{msg}</div>}
          <button id="save-profile-btn" className="btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile ✦'}
          </button>
        </form>
      </div>
    </div>
  );
}
