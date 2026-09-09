import React, { useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';

export default function ProfileModal({ onClose }) {
  const { user, updateProfile } = useAuthStore();
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  if (!user) return null;

  const copyCode = async () => {
    const text = `${user.username}#${user.user_code || ''}`;
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal profile-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">👤 My Cosmic Profile</div>
          <button id="close-profile-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="profile-hero">
          <div className="avatar avatar-xl" style={{ background: user.avatar_color }}>
            {(user.display_name || user.username)[0].toUpperCase()}
          </div>
          <div>
            <div className="profile-name">{user.display_name || user.username}</div>
            <div className="profile-handle">@{user.username}</div>
            {user.role === 'admin' && <span className="admin-chip">🛡️ ADMIN</span>}
          </div>
        </div>

        <div className="profile-code-box">
          <div>
            <div className="profile-code-label">Your unique search code</div>
            <div className="profile-code-value">#{user.user_code || '------'}</div>
            <div className="profile-code-hint">Share <b>{user.username}#{user.user_code}</b> so anyone can find you instantly</div>
          </div>
          <button id="copy-code-btn" className="btn-copy" onClick={copyCode}>
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
              placeholder="Tell the cosmos about you…"
            />
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
