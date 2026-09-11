import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { userQueries, roomQueries, messageQueries, reportQueries, voiceChannelQueries, isFixedAdmin } from './db.js';
import db from './db.js';
import { authenticateToken } from './auth.js';
import { validatePassword } from './security.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const me = userQueries.findById.get(req.user.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.me = me;
  next();
}

function adminCount() {
  try {
    return db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin'`).get()?.c ?? 0;
  } catch { return 0; }
}

// Only 5 admins exist (Admin_01..Admin_05). Promotions are blocked at the cap,
// and fixed admins can never be demoted, disabled, or deleted.
function guardRoleChange(target, role, selfId) {
  if (!target) return 'User not found';
  if (role === 'admin' && target.role !== 'admin' && adminCount() >= 5) {
    return 'Admin limit reached (max 5)';
  }
  if (isFixedAdmin(target) && role !== 'admin') {
    return `${target.username} is a fixed admin and cannot be demoted`;
  }
  if (target.id === selfId && role !== 'admin') {
    return 'You cannot demote yourself';
  }
  return null;
}

router.use(authenticateToken, requireAdmin);

// GET /api/admin/stats — dashboard overview
router.get('/stats', (req, res) => {
  const users = userQueries.count.get()?.c ?? 0;
  const rooms = roomQueries.count.get()?.c ?? 0;
  const messages = messageQueries.count.get()?.c ?? 0;
  const online = db.prepare(`SELECT COUNT(*) as c FROM users WHERE status = 'online' AND id != 'system'`).get()?.c ?? 0;
  let messagesToday = 0;
  try { messagesToday = messageQueries.countToday.get()?.c ?? 0; } catch {}
  let activeConversations = 0;
  try {
    activeConversations = db.prepare(
      `SELECT COUNT(DISTINCT room_id) as c FROM messages WHERE created_at >= unixepoch('now', '-7 days')`
    ).get()?.c ?? 0;
  } catch {}
  let reports = { open: 0 };
  try { reports.open = reportQueries.countOpen.get()?.c ?? 0; } catch {}
  res.json({ stats: { users, rooms, messages, online, messagesToday, activeConversations, reports: reports.open } });
});

// GET /api/admin/users?q= — search + list users
router.get('/users', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    const upper = q.toUpperCase();
    const users = userQueries.search.all(like, like, like, like, like, upper, upper, q);
    return res.json({ users });
  }
  const users = userQueries.findAll.all();
  res.json({ users });
});

// PUT /api/admin/users/:id/role — { role: 'admin' | 'user' }
router.put('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const target = userQueries.findById.get(req.params.id);
  const problem = guardRoleChange(target, role, req.user.userId);
  if (problem) {
    const code = problem === 'User not found' ? 404 : 400;
    return res.status(code).json({ error: problem });
  }
  userQueries.updateRole.run(role, req.params.id);
  res.json({ success: true });
});

// PATCH /api/admin/users/:id — { role?, is_disabled? } (spec compat)
router.patch('/users/:id', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, is_disabled } = req.body;
  if (role !== undefined) {
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const problem = guardRoleChange(target, role, req.user.userId);
    if (problem) {
      const code = problem === 'User not found' ? 404 : 400;
      return res.status(code).json({ error: problem });
    }
    userQueries.updateRole.run(role, req.params.id);
  }
  if (is_disabled !== undefined) {
    if (isFixedAdmin(target)) {
      return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
    }
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'You cannot disable yourself' });
    }
    userQueries.setDisabled.run(is_disabled ? 1 : 0, req.params.id);
  }
  res.json({ success: true, user: userQueries.findById.get(req.params.id) });
});

// POST /api/admin/users/:id/disable — disable account (keeps data, blocks login)
router.post('/users/:id/disable', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot disable yourself' });
  userQueries.setDisabled.run(1, req.params.id);
  res.json({ success: true });
});

// POST /api/admin/users/:id/enable
router.post('/users/:id/enable', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  userQueries.setDisabled.run(0, req.params.id);
  res.json({ success: true });
});

// POST /api/admin/users/:id/reset-password — { newPassword }
// Admins may reset any REGULAR user's password. Admin passwords can never
// be changed by another admin (not even fixed ones); admins change their own
// via PUT /api/auth/password.
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const target = userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' || isFixedAdmin(target)) {
      return res.status(403).json({ error: 'Admin passwords cannot be reset by other admins' });
    }
    const pErr = validatePassword(req.body?.newPassword);
    if (pErr) return res.status(400).json({ error: pErr });
    const password_hash = await bcrypt.hash(req.body.newPassword, 12);
    userQueries.updatePassword.run(password_hash, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be deleted` });
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete yourself' });
  // Delete user's messages, memberships, files records (keep files on disk, harmless)
  db.prepare('DELETE FROM messages WHERE sender_id = ?').run(req.params.id);
  db.prepare('DELETE FROM room_members WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM files WHERE uploader_id = ?').run(req.params.id);
  userQueries.deleteById.run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/rooms
router.get('/rooms', (req, res) => {
  const rooms = roomQueries.findAll.all();
  const withCounts = rooms.map(r => {
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?').get(r.id)?.c ?? 0;
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_id = ?').get(r.id)?.c ?? 0;
    return { ...r, memberCount, msgCount };
  });
  res.json({ rooms: withCounts });
});

// POST /api/admin/rooms — create channel (admin)
router.post('/rooms', (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  roomQueries.create.run({
    id,
    name: String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
    description: String(description || '').slice(0, 200),
    type: 'channel',
    created_by: req.user.userId,
  });
  roomQueries.addMember.run(id, req.user.userId);
  res.status(201).json({ room: roomQueries.findById.get(id) });
});

// PATCH /api/admin/rooms/:id — rename channel
router.patch('/rooms/:id', (req, res) => {
  const room = roomQueries.findById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { name, description } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    if (String(name).length > 40) return res.status(400).json({ error: 'Name too long' });
  }
  roomQueries.rename.run(
    name === undefined ? room.name : String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
    description === undefined ? null : String(description).slice(0, 200),
    req.params.id
  );
  res.json({ room: roomQueries.findById.get(req.params.id) });
});

// DELETE /api/admin/rooms/:id
router.delete('/rooms/:id', (req, res) => {
  const protectedIds = ['general', 'media', 'audio', 'random'];
  if (protectedIds.includes(req.params.id)) {
    return res.status(400).json({ error: 'Default channels cannot be deleted' });
  }
  const room = roomQueries.findById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  roomQueries.delete.run(req.params.id);
  res.json({ success: true });
});

// --- Voice channels (persistent list; WebRTC signaling stays in voice.js) ---
// GET /api/admin/voice — also served publicly via /api/voice below; admin sees same list
router.get('/voice', (req, res) => {
  res.json({ channels: voiceChannelQueries.list.all() });
});

router.post('/voice', (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const id = `voice-${uuidv4().slice(0, 8)}`;
  voiceChannelQueries.create.run({
    id,
    name: String(name).slice(0, 40),
    description: String(description || '').slice(0, 200),
    created_by: req.user.userId,
  });
  res.status(201).json({ channel: voiceChannelQueries.findById.get(id) });
});

router.patch('/voice/:id', (req, res) => {
  const ch = voiceChannelQueries.findById.get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Voice channel not found' });
  const { name, description } = req.body;
  voiceChannelQueries.rename.run(
    name === undefined ? ch.name : String(name).slice(0, 40),
    description === undefined ? null : String(description).slice(0, 200),
    req.params.id
  );
  res.json({ channel: voiceChannelQueries.findById.get(req.params.id) });
});

router.delete('/voice/:id', (req, res) => {
  voiceChannelQueries.delete.run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/messages/recent + ?q= search (moderate General etc.)
router.get('/messages/recent', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    const messages = messageQueries.search.all(`%${q}%`);
    return res.json({ messages });
  }
  const messages = messageQueries.getRecentGlobal.all();
  res.json({ messages });
});

// DELETE /api/admin/messages/:id
router.delete('/messages/:id', (req, res) => {
  const msg = messageQueries.findById.get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  messageQueries.adminDelete.run(req.params.id);
  res.json({ success: true, room_id: msg.room_id, messageId: msg.id });
});

// --- Reports moderation ---
// GET /api/admin/reports
router.get('/reports', (req, res) => {
  res.json({ reports: reportQueries.list.all() });
});

// POST /api/admin/reports/:id/resolve — { action?: 'dismiss' | 'delete_message' | 'disable_user' }
router.post('/reports/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { action } = req.body;
  if (action === 'delete_message' && report.message_id) {
    try { messageQueries.adminDelete.run(report.message_id); } catch {}
  } else if (action === 'disable_user' && report.target_user_id) {
    if (report.target_user_id !== req.user.userId) {
      try { userQueries.setDisabled.run(1, report.target_user_id); } catch {}
    }
  }
  // 'dismiss' or any moderation action resolves the report
  reportQueries.setStatus.run(action === 'dismiss' ? 'dismissed' : 'resolved', req.user.userId, req.params.id);
  res.json({ success: true });
});

export default router;
