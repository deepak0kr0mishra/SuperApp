import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { userQueries, roomQueries, generateUserCode } from './db.js';
import { generateUID } from './db.js';
import {
  authLimiter,
  validateUsername,
  validateEmail,
  validatePassword,
} from './security.js';

const router = express.Router();

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#06b6d4',
];

const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

function signToken(user) {
  return jwt.sign(
    { userId: user.id ?? user.userId, username: user.username },
    process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod',
    { expiresIn: '30d' }
  );
}

// POST /api/auth/register — { username, email, password, display_name? }
// Every account receives a permanent 8-char UID (uid) that never changes.
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, display_name, password } = req.body;

    const uErr = validateUsername(username);
    if (uErr) return res.status(400).json({ error: uErr });
    const eErr = validateEmail(email);
    if (eErr) return res.status(400).json({ error: eErr });
    const pErr = validatePassword(password);
    if (pErr) return res.status(400).json({ error: pErr });

    const cleanEmail = String(email).trim().toLowerCase();

    if (userQueries.findByUsername.get(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    if (userQueries.findByEmail.get(cleanEmail)) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const displayName = (display_name?.trim() || username).slice(0, 40);

    // Generate unique 6-char legacy code + permanent 8-char UID
    let user_code = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateUserCode();
      if (!userQueries.findByCode.get(candidate)) { user_code = candidate; break; }
    }
    if (!user_code) user_code = generateUserCode() + Date.now().toString(36).slice(-2).toUpperCase();

    let uid = null;
    for (let i = 0; i < 20; i++) {
      const candidate = generateUID();
      try {
        const hit = userQueries.findByUid.get(candidate);
        if (!hit) { uid = candidate; break; }
      } catch { uid = candidate; break; }
    }
    if (!uid) uid = generateUID();

    // First real user becomes admin
    let role = 'user';
    try {
      const count = userQueries.count.get();
      if (count.c === 0) role = 'admin';
    } catch {}

    userQueries.create.run({
      id,
      uid,
      username,
      email: cleanEmail,
      display_name: displayName,
      password_hash,
      avatar_color: randomColor(),
      user_code,
      bio: '',
      role,
    });

    // Auto-join unlimited spaces only (general). Limited rooms
    // (Developers/Creatives/Chill) are joined explicitly, honoring caps.
    const allRooms = roomQueries.findAll.all();
    for (const room of allRooms) {
      if (room.type === 'channel' && room.max_members == null) {
        roomQueries.addMember.run(room.id, id);
      }
    }

    const token = signToken({ id, username });
    const user = userQueries.findById.get(id);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login — { login (username or email), password } + legacy { username, password }
router.post('/login', authLimiter, async (req, res) => {
  try {
    const loginId = (req.body.login || req.body.username || req.body.email || '').trim();
    const { password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    const lowered = loginId.toLowerCase();
    const userRecord =
      userQueries.findByUsername.get(loginId) ||
      userQueries.findByEmail.get(lowered) ||
      userQueries.findByLogin.get(loginId, lowered);

    if (!userRecord) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (userRecord.is_disabled) {
      return res.status(403).json({ error: 'Account has been disabled. Contact an admin.' });
    }

    const valid = await bcrypt.compare(password, userRecord.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken({ id: userRecord.id, username: userRecord.username });
    const user = userQueries.findById.get(userRecord.id);
    res.json({ token, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout — stateless JWT; client drops token. Presence handled via socket disconnect.
router.post('/logout', authenticateToken, (req, res) => {
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const user = userQueries.findById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_disabled) return res.status(403).json({ error: 'Account disabled' });
  res.json({ user });
});

// PUT /api/auth/public-key — legacy E2E endpoint, now a no-op.
router.put('/public-key', authenticateToken, (req, res) => {
  res.json({ success: true });
});

// PUT /api/auth/profile — update own display_name / bio
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    let { display_name, bio } = req.body;
    if (display_name !== undefined) {
      display_name = String(display_name).trim().slice(0, 40);
      if (!display_name) return res.status(400).json({ error: 'Display name cannot be empty' });
    }
    if (bio !== undefined) {
      bio = String(bio).slice(0, 200);
    }
    userQueries.updateProfile.run(
      display_name === undefined ? null : display_name,
      bio === undefined ? null : bio,
      req.user.userId
    );
    // Ensure code/uid exist for legacy users hitting this endpoint
    let user = userQueries.findById.get(req.user.userId);
    if (!user.user_code || !user.uid) {
      try {
        const db = (await import('./db.js')).default;
        if (!user.user_code) {
          let code = generateUserCode();
          for (let i = 0; i < 10 && userQueries.findByCode.get(code); i++) code = generateUserCode();
          db.prepare('UPDATE users SET user_code = ? WHERE id = ?').run(code, req.user.userId);
        }
        if (!user.uid) {
          let uid = generateUID();
          for (let i = 0; i < 10 && userQueries.findByUid.get(uid); i++) uid = generateUID();
          db.prepare('UPDATE users SET uid = ? WHERE id = ?').run(uid, req.user.userId);
        }
        user = userQueries.findById.get(req.user.userId);
      } catch {}
    }
    res.json({ user });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /api/auth/password — change own password. { currentPassword, newPassword }
router.put('/password', authenticateToken, authLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    const pErr = validatePassword(newPassword);
    if (pErr) return res.status(400).json({ error: pErr });
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different' });
    }
    const raw = userQueries.findRawById?.get(req.user.userId) || userQueries.findByUsername.get(req.user.username);
    if (!raw) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, raw.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const password_hash = await bcrypt.hash(newPassword, 12);
    userQueries.updatePassword.run(password_hash, req.user.userId);
    res.json({ success: true });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod');
    req.user = payload;
    // Reject disabled accounts on every authenticated request
    try {
      const raw = userQueries.findRawById.get(payload.userId);
      if (raw?.is_disabled) return res.status(403).json({ error: 'Account disabled' });
    } catch {}
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

export default router;
