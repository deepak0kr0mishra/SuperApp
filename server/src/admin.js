import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  userQueries, roomQueries, messageQueries, reportQueries,
  voiceChannelQueries, isFixedAdmin, MAX_ADMINS, muteQueries,
  MUTE_KINDS, MUTE_DURATIONS, blockQueries,
} from './db.js';
import client from './db.js';
import { authenticateToken } from './auth.js';
import { validatePassword } from './security.js';

const router = express.Router();

async function requireAdmin(req, res, next) {
  const me = await userQueries.findById.get(req.user.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.me = me;
  next();
}

async function adminCount() {
  try {
    const r = await client.execute(`SELECT COUNT(*) as c FROM users WHERE role = 'admin'`);
    return Number(r.rows[0]?.[0] ?? 0);
  } catch { return 0; }
}

async function guardRoleChange(target, role, selfId) {
  if (!target) return 'User not found';
  if (role === 'admin' && target.role !== 'admin' && (await adminCount()) >= MAX_ADMINS) {
    return `Admin limit reached (max ${MAX_ADMINS})`;
  }
  if (isFixedAdmin(target) && role !== 'admin') {
    return `${target.username} is a fixed admin and cannot be demoted`;
  }
  if (target.id === selfId && role !== 'admin') return 'You cannot demote yourself';
  return null;
}

router.use(authenticateToken, requireAdmin);

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const users = (await userQueries.count.get())?.c ?? 0;
    const rooms = (await roomQueries.count.get())?.c ?? 0;
    const messages = (await messageQueries.count.get())?.c ?? 0;
    const onlineR = await client.execute(`SELECT COUNT(*) as c FROM users WHERE status = 'online' AND id != 'system'`);
    const online = Number(onlineR.rows[0]?.[0] ?? 0);
    let messagesToday = 0;
    try { messagesToday = (await messageQueries.countToday.get())?.c ?? 0; } catch {}
    let activeConversations = 0;
    try {
      const r = await client.execute(`SELECT COUNT(DISTINCT room_id) as c FROM messages WHERE created_at >= unixepoch('now', '-7 days')`);
      activeConversations = Number(r.rows[0]?.[0] ?? 0);
    } catch {}
    let openReports = 0;
    try { openReports = (await reportQueries.countOpen.get())?.c ?? 0; } catch {}
    res.json({ stats: { users, rooms, messages, online, messagesToday, activeConversations, reports: openReports } });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// GET /api/admin/users?q=
router.get('/users', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q) {
      const like = `%${q}%`;
      const upper = q.toUpperCase();
      const users = await userQueries.search.all(like, like, like, like, like, upper, upper, q);
      return res.json({ users });
    }
    const users = await userQueries.findAll.all();
    res.json({ users });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// PUT /api/admin/users/:id/role
router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const target = await userQueries.findById.get(req.params.id);
    const problem = await guardRoleChange(target, role, req.user.userId);
    if (problem) {
      const code = problem === 'User not found' ? 404 : 400;
      return res.status(code).json({ error: problem });
    }
    await userQueries.updateRole.run(role, req.params.id);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', async (req, res) => {
  try {
    const target = await userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { role, is_disabled } = req.body;
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
      const problem = await guardRoleChange(target, role, req.user.userId);
      if (problem) {
        const code = problem === 'User not found' ? 404 : 400;
        return res.status(code).json({ error: problem });
      }
      await userQueries.updateRole.run(role, req.params.id);
    }
    if (is_disabled !== undefined) {
      if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
      if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot disable yourself' });
      await userQueries.setDisabled.run(is_disabled ? 1 : 0, req.params.id);
    }
    res.json({ success: true, user: await userQueries.findById.get(req.params.id) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/admin/users/:id/disable
router.post('/users/:id/disable', async (req, res) => {
  try {
    const target = await userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot disable yourself' });
    await userQueries.setDisabled.run(1, req.params.id);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/admin/users/:id/enable
router.post('/users/:id/enable', async (req, res) => {
  try {
    const target = await userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await userQueries.setDisabled.run(0, req.params.id);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const target = await userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' || isFixedAdmin(target)) {
      return res.status(403).json({ error: 'Admin passwords cannot be reset by other admins' });
    }
    const pErr = validatePassword(req.body?.newPassword);
    if (pErr) return res.status(400).json({ error: pErr });
    const password_hash = await bcrypt.hash(req.body.newPassword, 12);
    await userQueries.updatePassword.run(password_hash, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    const target = await userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be deleted` });
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete yourself' });
    await client.execute({ sql: 'DELETE FROM messages WHERE sender_id = ?', args: [req.params.id] });
    await client.execute({ sql: 'DELETE FROM room_members WHERE user_id = ?', args: [req.params.id] });
    await client.execute({ sql: 'DELETE FROM files WHERE uploader_id = ?', args: [req.params.id] });
    try { await client.execute({ sql: 'DELETE FROM user_mutes WHERE user_id = ?', args: [req.params.id] }); } catch {}
    try { await client.execute({ sql: 'DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', args: [req.params.id, req.params.id] }); } catch {}
    await userQueries.deleteById.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/admin/rooms
router.get('/rooms', async (req, res) => {
  try {
    const rooms = await roomQueries.findAll.all();
    const withCounts = await Promise.all(rooms.map(async (r) => {
      const mcR = await client.execute({ sql: 'SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', args: [r.id] });
      const msgR = await client.execute({ sql: 'SELECT COUNT(*) as c FROM messages WHERE room_id = ?', args: [r.id] });
      return { ...r, memberCount: Number(mcR.rows[0]?.[0] ?? 0), msgCount: Number(msgR.rows[0]?.[0] ?? 0) };
    }));
    res.json({ rooms: withCounts });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/admin/rooms
router.post('/rooms', async (req, res) => {
  try {
    const { name, description, max_members } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const id = uuidv4();
    const limit = max_members === null || max_members === undefined || max_members === ''
      ? null : Math.max(2, Math.min(Number(max_members) || 0, 100)) || null;
    await roomQueries.create.run({
      id,
      name: String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
      description: String(description || '').slice(0, 200),
      type: 'channel', max_members: limit, created_by: req.user.userId,
    });
    await roomQueries.addMember.run(id, req.user.userId);
    res.status(201).json({ room: await roomQueries.findById.get(id) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// PATCH /api/admin/rooms/:id
router.patch('/rooms/:id', async (req, res) => {
  try {
    const room = await roomQueries.findById.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { name, description, max_members } = req.body;
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
      if (String(name).length > 40) return res.status(400).json({ error: 'Name too long' });
    }
    await roomQueries.rename.run(
      name === undefined ? room.name : String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
      description === undefined ? null : String(description).slice(0, 200),
      req.params.id
    );
    if (max_members !== undefined && room.type === 'channel') {
      const limit = max_members === null || max_members === '' ? null
        : Math.max(2, Math.min(Number(max_members) || 0, 100)) || null;
      try { await roomQueries.setLimit.run(limit, req.params.id); } catch {}
    }
    res.json({ room: await roomQueries.findById.get(req.params.id) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// DELETE /api/admin/rooms/:id
router.delete('/rooms/:id', async (req, res) => {
  try {
    const protectedIds = ['general', 'developers', 'creatives', 'chill-01', 'chill-02'];
    if (protectedIds.includes(req.params.id)) return res.status(400).json({ error: 'Default spaces cannot be deleted' });
    const room = await roomQueries.findById.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    await roomQueries.delete.run(req.params.id);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// DELETE /api/admin/rooms/:id/members/:userId
router.delete('/rooms/:id/members/:userId', async (req, res) => {
  try {
    const room = await roomQueries.findById.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const target = await userQueries.findById.get(req.params.userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (isFixedAdmin(target) && room.type === 'channel') return res.status(400).json({ error: 'Fixed admins cannot be removed from spaces' });
    await roomQueries.removeMember.run(req.params.id, req.params.userId);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/admin/mutes
router.get('/mutes', async (req, res) => {
  try {
    await muteQueries.clearExpired.run();
    const rows = await muteQueries.listActive.all();
    const mutes = await Promise.all(rows.map(async (m) => {
      let username = m.user_id;
      try { username = (await userQueries.findById.get(m.user_id))?.username || m.user_id; } catch {}
      return { ...m, username };
    }));
    res.json({ mutes });
  } catch { res.json({ mutes: [] }); }
});

// POST /api/admin/mutes
router.post('/mutes', async (req, res) => {
  try {
    const { userId, kind, duration, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!MUTE_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be voice or chat' });
    if (!MUTE_DURATIONS[duration]) return res.status(400).json({ error: 'duration must be hour, day, or week' });
    const target = await userQueries.findById.get(userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' || isFixedAdmin(target)) return res.status(400).json({ error: 'Admins cannot be muted' });
    if (userId === req.user.userId) return res.status(400).json({ error: 'You cannot mute yourself' });
    const expires_at = Math.floor(Date.now() / 1000) + MUTE_DURATIONS[duration];
    await muteQueries.upsert.run(userId, kind, expires_at, req.user.userId, String(reason || '').slice(0, 200));
    res.status(201).json({ mute: { user_id: userId, kind, expires_at, username: target.username } });
  } catch (err) {
    res.status(500).json({ error: 'Could not apply mute' });
  }
});

// DELETE /api/admin/mutes/:userId/:kind
router.delete('/mutes/:userId/:kind', async (req, res) => {
  const { userId, kind } = req.params;
  if (!MUTE_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be voice or chat' });
  try { await muteQueries.revoke.run(userId, kind); } catch {}
  res.json({ success: true });
});

// GET /api/admin/voice
router.get('/voice', async (req, res) => {
  res.json({ channels: await voiceChannelQueries.list.all() });
});

router.post('/voice', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const id = `voice-${uuidv4().slice(0, 8)}`;
    await voiceChannelQueries.create.run({
      id, name: String(name).slice(0, 40),
      description: String(description || '').slice(0, 200), created_by: req.user.userId,
    });
    res.status(201).json({ channel: await voiceChannelQueries.findById.get(id) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.patch('/voice/:id', async (req, res) => {
  try {
    const ch = await voiceChannelQueries.findById.get(req.params.id);
    if (!ch) return res.status(404).json({ error: 'Voice channel not found' });
    const { name, description } = req.body;
    await voiceChannelQueries.rename.run(
      name === undefined ? ch.name : String(name).slice(0, 40),
      description === undefined ? null : String(description).slice(0, 200),
      req.params.id
    );
    res.json({ channel: await voiceChannelQueries.findById.get(req.params.id) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.delete('/voice/:id', async (req, res) => {
  try { await voiceChannelQueries.delete.run(req.params.id); } catch {}
  res.json({ success: true });
});

// GET /api/admin/messages/recent
router.get('/messages/recent', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q) {
      const messages = await messageQueries.search.all(`%${q}%`);
      return res.json({ messages });
    }
    const messages = await messageQueries.getRecentGlobal.all();
    res.json({ messages });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// DELETE /api/admin/messages/:id
router.delete('/messages/:id', async (req, res) => {
  try {
    const msg = await messageQueries.findById.get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    await messageQueries.adminDelete.run(req.params.id);
    res.json({ success: true, room_id: msg.room_id, messageId: msg.id });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// --- Backup & Restore feature removed ---

// GET /api/admin/reports
router.get('/reports', async (req, res) => {
  res.json({ reports: await reportQueries.list.all() });
});

// POST /api/admin/reports/:id/resolve
router.post('/reports/:id', async (req, res) => {
  try {
    const r = await client.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [req.params.id] });
    if (!r.rows[0]) return res.status(404).json({ error: 'Report not found' });
    // Convert row to plain object
    const report = {};
    for (let i = 0; i < r.columns.length; i++) report[r.columns[i]] = r.rows[0][i];

    const { action } = req.body;
    if (action === 'delete_message' && report.message_id) {
      try { await messageQueries.adminDelete.run(report.message_id); } catch {}
    } else if (action === 'disable_user' && report.target_user_id) {
      if (report.target_user_id !== req.user.userId) {
        try { await userQueries.setDisabled.run(1, report.target_user_id); } catch {}
      }
    }
    await reportQueries.setStatus.run(action === 'dismiss' ? 'dismissed' : 'resolved', req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Report resolve error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

export default router;
