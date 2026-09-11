import express from 'express';
import { userQueries } from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// GET /api/users/me — current user (alias of /api/auth/me for spec compat)
router.get('/me', authenticateToken, (req, res) => {
  const user = userQueries.findById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// GET /api/users/search?q=... — search by username, display_name, user_code, UID, or email
router.get('/search', authenticateToken, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 1) return res.json({ users: [] });
  if (q.length > 100) return res.status(400).json({ error: 'Query too long' });
  const like = `%${q}%`;
  // Exact code/uid matches get priority via ORDER BY in query; also handle "name#CODE" format
  let exactCode = q;
  let exactName = q;
  if (q.includes('#')) {
    const parts = q.split('#');
    exactName = parts[0];
    exactCode = parts[1] || q;
  }
  const upper = exactCode.toUpperCase();
  const users = userQueries.search.all(like, like, like, like, like, upper, upper, exactName);
  res.json({ users });
});

// GET /api/users/:uid — public profile by internal id OR permanent UID OR username
router.get('/:id', authenticateToken, (req, res) => {
  const key = req.params.id;
  let user = userQueries.findById.get(key);
  if (!user) {
    try { user = userQueries.findByUid.get(String(key).toUpperCase()); } catch {}
  }
  if (!user) {
    const raw = userQueries.findByUsername.get(key);
    if (raw) user = userQueries.findById.get(raw.id);
  }
  if (!user || user.id === 'system') return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

export default router;
