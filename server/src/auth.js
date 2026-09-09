import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { userQueries, roomQueries, generateUserCode } from './db.js';

const router = express.Router();

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#06b6d4',
];

const randomColor = () => AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, display_name, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
    }

    const existing = userQueries.findByUsername.get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const displayName = display_name?.trim() || username;

    // Generate unique 6-char user code
    let user_code = null;
    for (let i = 0; i < 10; i++) {
      const candidate = generateUserCode();
      if (!userQueries.findByCode.get(candidate)) { user_code = candidate; break; }
    }
    if (!user_code) user_code = generateUserCode() + Date.now().toString(36).slice(-2).toUpperCase();

    // First real user becomes admin
    let role = 'user';
    try {
      const count = userQueries.count.get();
      if (count.c === 0) role = 'admin';
    } catch {}

    userQueries.create.run({
      id,
      username,
      display_name: displayName,
      password_hash,
      avatar_color: randomColor(),
      user_code,
      bio: '',
      role,
    });

    // Auto-join all default channels
    const allRooms = roomQueries.findAll.all();
    for (const room of allRooms) {
      if (room.type === 'channel') {
        roomQueries.addMember.run(room.id, id);
      }
    }

    const token = jwt.sign({ userId: id, username }, process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod', {
      expiresIn: '30d',
    });

    const user = userQueries.findById.get(id);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const userRecord = userQueries.findByUsername.get(username);
    if (!userRecord) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, userRecord.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { userId: userRecord.id, username: userRecord.username },
      process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod',
      { expiresIn: '30d' }
    );

    const user = userQueries.findById.get(userRecord.id);
    res.json({ token, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const user = userQueries.findById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// PUT /api/auth/public-key
router.put('/public-key', authenticateToken, (req, res) => {
  const { publicKey } = req.body;
  if (!publicKey) return res.status(400).json({ error: 'Public key required' });
  userQueries.updatePublicKey.run(publicKey, req.user.userId);
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
    // Ensure code exists for legacy users hitting this endpoint
    let user = userQueries.findById.get(req.user.userId);
    if (!user.user_code) {
      let code = generateUserCode();
      for (let i = 0; i < 10 && userQueries.findByCode.get(code); i++) code = generateUserCode();
      try {
        const db = (await import('./db.js')).default;
        db.prepare('UPDATE users SET user_code = ? WHERE id = ?').run(code, req.user.userId);
        user = userQueries.findById.get(req.user.userId);
      } catch {}
    }
    res.json({ user });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod');
    req.user = payload;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
}

export default router;
