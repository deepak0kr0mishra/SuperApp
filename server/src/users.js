import express from 'express';
import { userQueries, favQueries, DEFAULT_REACTION_FAVS, MAX_REACTION_FAVS, blockQueries, muteQueries, getActiveMute, isFixedAdmin } from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

function readFavs(userId) {
  try {
    const row = favQueries.get.get(userId);
    if (!row) return [...DEFAULT_REACTION_FAVS];
    const arr = JSON.parse(row.favs);
    if (!Array.isArray(arr) || arr.length === 0) return [...DEFAULT_REACTION_FAVS];
    return arr.filter((e) => typeof e === 'string').slice(0, MAX_REACTION_FAVS);
  } catch {
    return [...DEFAULT_REACTION_FAVS];
  }
}

// GET /api/users/me/reaction-favorites — my quick-reaction bar
router.get('/me/reaction-favorites', authenticateToken, (req, res) => {
  res.json({ favs: readFavs(req.user.userId) });
});

// PUT /api/users/me/reaction-favorites — { favs: [emoji...] } (own bar only)
router.put('/me/reaction-favorites', authenticateToken, (req, res) => {
  const { favs } = req.body || {};
  if (!Array.isArray(favs) || favs.length === 0 || favs.length > MAX_REACTION_FAVS) {
    return res.status(400).json({ error: `Send 1–${MAX_REACTION_FAVS} emoji.` });
  }
  const clean = [];
  for (const e of favs) {
    if (typeof e !== 'string') return res.status(400).json({ error: 'Each favorite must be an emoji.' });
    const c = e.trim().slice(0, 16);
    if (!c || [...c].length > 8) return res.status(400).json({ error: 'Each favorite must be a single emoji.' });
    if (!clean.includes(c)) clean.push(c);
  }
  if (!clean.length) return res.status(400).json({ error: 'Send at least one emoji.' });
  try {
    favQueries.set.run(req.user.userId, JSON.stringify(clean));
    res.json({ favs: clean });
  } catch (err) {
    console.error('Save favorites error:', err);
    res.status(500).json({ error: 'Could not save favorites' });
  }
});

// GET /api/users/me — current user (alias of /api/auth/me for spec compat)
router.get('/me', authenticateToken, (req, res) => {
  const user = userQueries.findById.get(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

// GET /api/users/me/mutes — my active mutes (voice/chat + expiry)
router.get('/me/mutes', authenticateToken, (req, res) => {
  try {
    const mutes = muteQueries.listFor.all(req.user.userId);
    res.json({ mutes });
  } catch {
    res.json({ mutes: [] });
  }
});

// GET /api/users/me/blocks — users I blocked
router.get('/me/blocks', authenticateToken, (req, res) => {
  try {
    res.json({ blocks: blockQueries.myBlocks.all(req.user.userId) });
  } catch {
    res.json({ blocks: [] });
  }
});

// POST /api/users/block — { targetUserId } (admins can't be blocked)
router.post('/block', authenticateToken, (req, res) => {
  const { targetUserId } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
  if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot block yourself' });
  const target = userQueries.findById.get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' || isFixedAdmin(target)) {
    return res.status(400).json({ error: 'Admins cannot be blocked' });
  }
  try {
    blockQueries.add.run(req.user.userId, targetUserId);
  } catch {}
  res.json({ success: true });
});

// DELETE /api/users/block/:targetUserId — unblock
router.delete('/block/:targetUserId', authenticateToken, (req, res) => {
  try {
    blockQueries.remove.run(req.user.userId, req.params.targetUserId);
  } catch {}
  res.json({ success: true });
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
