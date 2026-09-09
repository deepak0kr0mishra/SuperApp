import express from 'express';
import { userQueries } from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// GET /api/users/search?q=... — search by username, display_name, or user_code
router.get('/search', authenticateToken, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 1) return res.json({ users: [] });
  const like = `%${q}%`;
  // Exact code match gets priority via ORDER BY in query; also handle "name#CODE" format
  let exactCode = q;
  let exactName = q;
  if (q.includes('#')) {
    const parts = q.split('#');
    exactName = parts[0];
    exactCode = parts[1] || q;
  }
  const users = userQueries.search.all(like, like, like, exactCode.toUpperCase(), exactName);
  // Filter out self? No — let client decide. Return all.
  res.json({ users });
});

// GET /api/users/:id — public profile
router.get('/:id', authenticateToken, (req, res) => {
  const user = userQueries.findById.get(req.params.id);
  if (!user || user.id === 'system') return res.status(404).json({ error: 'User not found' });
  // Don't leak public_key? It's needed for E2E, so keep it but it's fine.
  res.json({ user });
});

export default router;
