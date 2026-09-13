import express from 'express';
import { userQueries, favQueries, DEFAULT_REACTION_FAVS, MAX_REACTION_FAVS, blockQueries, muteQueries, isFixedAdmin } from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

async function readFavs(userId) {
  try {
    const row = await favQueries.get.get(userId);
    if (!row) return [...DEFAULT_REACTION_FAVS];
    const arr = JSON.parse(row.favs);
    if (!Array.isArray(arr) || arr.length === 0) return [...DEFAULT_REACTION_FAVS];
    return arr.filter((e) => typeof e === 'string').slice(0, MAX_REACTION_FAVS);
  } catch {
    return [...DEFAULT_REACTION_FAVS];
  }
}

// GET /api/users/me/reaction-favorites
router.get('/me/reaction-favorites', authenticateToken, async (req, res) => {
  res.json({ favs: await readFavs(req.user.userId) });
});

// PUT /api/users/me/reaction-favorites
router.put('/me/reaction-favorites', authenticateToken, async (req, res) => {
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
    await favQueries.set.run(req.user.userId, JSON.stringify(clean));
    res.json({ favs: clean });
  } catch (err) {
    console.error('Save favorites error:', err);
    res.status(500).json({ error: 'Could not save favorites' });
  }
});

// GET /api/users/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await userQueries.findById.get(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/users/me/mutes
router.get('/me/mutes', authenticateToken, async (req, res) => {
  try {
    const mutes = await muteQueries.listFor.all(req.user.userId);
    res.json({ mutes });
  } catch { res.json({ mutes: [] }); }
});

// GET /api/users/me/blocks
router.get('/me/blocks', authenticateToken, async (req, res) => {
  try {
    res.json({ blocks: await blockQueries.myBlocks.all(req.user.userId) });
  } catch { res.json({ blocks: [] }); }
});

// POST /api/users/block
router.post('/block', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.body || {};
    if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
    if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot block yourself' });
    const target = await userQueries.findById.get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' || isFixedAdmin(target)) {
      return res.status(400).json({ error: 'Admins cannot be blocked' });
    }
    await blockQueries.add.run(req.user.userId, targetUserId);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// DELETE /api/users/block/:targetUserId
router.delete('/block/:targetUserId', authenticateToken, async (req, res) => {
  try {
    await blockQueries.remove.run(req.user.userId, req.params.targetUserId);
  } catch {}
  res.json({ success: true });
});

// GET /api/users/search?q=...
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 1) return res.json({ users: [] });
    if (q.length > 100) return res.status(400).json({ error: 'Query too long' });
    const like = `%${q}%`;
    let exactCode = q, exactName = q;
    if (q.includes('#')) {
      const parts = q.split('#');
      exactName = parts[0];
      exactCode = parts[1] || q;
    }
    const upper = exactCode.toUpperCase();
    const users = await userQueries.search.all(like, like, like, like, like, upper, upper, exactName);
    res.json({ users });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/users/:id — by internal id, UID, or username
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const key = req.params.id;
    let user = await userQueries.findById.get(key);
    if (!user) {
      try { user = await userQueries.findByUid.get(String(key).toUpperCase()); } catch {}
    }
    if (!user) {
      const raw = await userQueries.findByUsername.get(key);
      if (raw) user = await userQueries.findById.get(raw.id);
    }
    if (!user || user.id === 'system') return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

export default router;
