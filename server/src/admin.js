import express from 'express';
import { userQueries, roomQueries, messageQueries } from './db.js';
import db from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const me = userQueries.findById.get(req.user.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.me = me;
  next();
}

router.use(authenticateToken, requireAdmin);

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  const users = userQueries.count.get()?.c ?? 0;
  const rooms = roomQueries.count.get()?.c ?? 0;
  const messages = messageQueries.count.get()?.c ?? 0;
  const online = db.prepare(`SELECT COUNT(*) as c FROM users WHERE status = 'online' AND id != 'system'`).get()?.c ?? 0;
  res.json({ stats: { users, rooms, messages, online } });
});

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = userQueries.findAll.all();
  res.json({ users });
});

// PUT /api/admin/users/:id/role — { role: 'admin' | 'user' }
router.put('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (req.params.id === req.user.userId && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot demote yourself' });
  }
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  userQueries.updateRole.run(role, req.params.id);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete yourself' });
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
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

// GET /api/admin/messages/recent
router.get('/messages/recent', (req, res) => {
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

export default router;
