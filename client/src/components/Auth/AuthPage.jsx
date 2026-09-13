import React, { useState } from 'react';
import { useAuthStore } from '../../stores/authStore.js';
import packageJson from '../../../package.json';

// Dev backdoor affordance: only on localhost. The server ALSO rejects
// /auth/dev-bypass when NODE_ENV=production, so this can never open the
// live site even if someone crafts the request by hand.
const IS_LOCALHOST = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

function DevBypassModal({ onClose }) {
  const { devBypass } = useAuthStore();
  const [devName, setDevName] = useState('');
  const [devDate, setDevDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await devBypass(devName.trim(), devDate.trim());
      onClose?.();
    } catch (e2) {
      setErr(e2.message || 'Nope — try again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 360 }}>
        <div className="modal-header">
          <div className="modal-title">⚙️ Dev entry</div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="form-group">
            <label className="form-label" htmlFor="dev-username">User name</label>
            <input
              id="dev-username"
              className="form-input"
              placeholder="dev"
              value={devName}
              onChange={e => setDevName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="dev-date">Pick the date</label>
            <input
              id="dev-date"
              type="date"
              className="form-input"
              value={devDate}
              onChange={e => setDevDate(e.target.value)}
              required
            />
          </div>
          {err && <div className="form-error">{err}</div>}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Opening…' : '→ Slip in'}
          </button>
        </form>
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
          Local testing only — dead on the live site.
        </div>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const [tab, setTab] = useState('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDev, setShowDev] = useState(false);

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
      {IS_LOCALHOST && (
        <button
          id="dev-gear-btn"
          className="icon-btn dev-gear-btn"
          onClick={() => setShowDev(true)}
          title="Dev entry"
        >⚙️</button>
      )}

      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-icon">🍵</div>
          <div className="auth-logo-text">TeaChat</div>
        </div>
        <p className="auth-tagline">Pull up a chair — warm chats, spaces, voice rooms & codes ✦</p>

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
            Instant messages, photos & videos. Find anyone with their unique UID or username.
          </div>
        </div>

        <div className="auth-version" style={{ marginTop: 16, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', opacity: 0.8 }}>
          TeaChat v{packageJson.version}
        </div>
      </div>
      {showDev && IS_LOCALHOST && <DevBypassModal onClose={() => setShowDev(false)} />}
    </div>
  );
}
