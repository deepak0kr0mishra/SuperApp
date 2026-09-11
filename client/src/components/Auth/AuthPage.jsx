import React, { useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';

export default function AuthPage() {
  const [tab, setTab] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, register, error, clearError } = useAuthStore();

  const handleSubmit = async (e) => {
    e.preventDefault();
    clearError();
    setLoading(true);
    try {
      if (tab === 'login') {
        await login(username.trim(), password);
      } else {
        await register(username.trim(), displayName, password, email.trim());
      }
    } catch {
      // error handled in store
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (t) => {
    setTab(t);
    clearError();
  };

  return (
    <div className="auth-page">
      <div className="auth-bg-glow auth-bg-glow-1" />
      <div className="auth-bg-glow auth-bg-glow-2" />

      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-icon">🌌</div>
          <div className="auth-logo-text">Nebula</div>
        </div>
        <p className="auth-tagline">Ride the cosmic wave — instant chats, spaces, voice orbits & codes ✦</p>

        <div className="auth-tabs">
          <button
            id="auth-tab-login"
            className={`auth-tab ${tab === 'login' ? 'active' : ''}`}
            onClick={() => switchTab('login')}
          >
            Sign In
          </button>
          <button
            id="auth-tab-register"
            className={`auth-tab ${tab === 'register' ? 'active' : ''}`}
            onClick={() => switchTab('register')}
          >
            Create Account
          </button>
        </div>

        {error && (
          <div className="form-error">
            <span>⚠️</span>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="form-group">
            <label className="form-label" htmlFor="auth-username">
              {tab === 'login' ? 'Username or email' : 'Username'}
            </label>
            <input
              id="auth-username"
              type="text"
              className="form-input"
              placeholder={tab === 'login' ? 'e.g. john_doe or john@mail.com' : 'e.g. john_doe'}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              required
            />
          </div>

          {tab === 'register' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="auth-email">Email</label>
                <input
                  id="auth-email"
                  type="email"
                  className="form-input"
                  placeholder="you@mail.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="auth-display-name">Display Name</label>
                <input
                  id="auth-display-name"
                  type="text"
                  className="form-input"
                  placeholder="How you appear in chat"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                />
              </div>
            </>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              className="form-input"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            id="auth-submit-btn"
            type="submit"
            className="btn-primary"
            disabled={loading}
          >
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
                <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                {tab === 'login' ? 'Signing in…' : 'Creating account…'}
              </span>
            ) : (
              tab === 'login' ? '→ Sign In' : '→ Create Account'
            )}
          </button>
        </form>

        {tab === 'register' && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            You get a permanent UID (e.g. 8F42K9X1) that never changes — even if you rename yourself.
          </div>
        )}

        <div style={{ marginTop: 20, padding: '12px 14px', background: 'rgba(34,211,238,0.06)', border: '1px solid rgba(34,211,238,0.15)', borderRadius: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#22d3ee', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
            ⚡ Fast & Simple Chat
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Instant messages, photos, videos & voice notes. Find anyone with their unique UID or username.
          </div>
        </div>
      </div>
    </div>
  );
}
