import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// Security headers (helmet) — compatible with Socket.IO + inline media.
export function securityHeaders() {
  return helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // client is a separate static host; keep API permissive
  });
}

// Rate limiters (in-memory; single instance on Render free — see render.yaml numInstances: 1)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
});

export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Slow down — too many requests.' },
});

export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const USERNAME_RE = /^[a-zA-Z0-9_]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateUsername(username) {
  if (!username || typeof username !== 'string') return 'Username is required';
  if (username.length < 3 || username.length > 20) return 'Username must be 3-20 characters';
  if (!USERNAME_RE.test(username)) return 'Username can only contain letters, numbers and underscores';
  return null;
}

export function validateEmail(email, { required = true } = {}) {
  if (email == null || email === '') {
    return required ? 'Email is required' : null;
  }
  if (typeof email !== 'string' || email.length > 254) return 'Invalid email';
  if (!EMAIL_RE.test(email.trim())) return 'Invalid email';
  return null;
}

export function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 6) return 'Password must be at least 6 characters';
  if (password.length > 128) return 'Password is too long';
  return null;
}

export function sanitizeMessageContent(content, max = 2000) {
  if (typeof content !== 'string') return '';
  return content.trim().slice(0, max);
}
