import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { roomQueries, userQueries, messageQueries, readQueries } from './db.js';
import { authenticateToken } from './auth.js';
import { messageLimiter } from './security.js';

const router = express.Router();

export function canAccessRoom(userId, roomId) {
  const room = roomQueries.findById.get(roomId);
  if (!room) return { ok: false, status: 404, error: 'Room not found' };
  if (room.type === 'dm') {
    const member = roomQueries.isMember.get(roomId, userId);
    if (!member) return { ok: false, status: 403, error: 'You are not part of this conversation' };
  }
  return { ok: true, room };
}

// GET /api/rooms — list all rooms user belongs to + all public channels
router.get('/', authenticateToken, (req, res) => {
  const allRooms = roomQueries.findAll.all();
  const reads = {};
  try {
    for (const r of readQueries.getReads.all(req.user.userId)) reads[r.room_id] = r.last_read_at;
  } catch {}
  const rooms = allRooms.map((r) => {
    let unread = 0;
    try {
      unread = messageQueries.unreadCount.get(req.user.userId, r.id, req.user.userId)?.c ?? 0;
    } catch {}
    return { ...r, unread, last_read_at: reads[r.id] ?? 0 };
  });
  res.json({ rooms });
});

// NOTE: specific routes must come before param routes
// GET /api/rooms/users/all — list all users (legacy path, kept for compat)
router.get('/users/all', authenticateToken, (req, res) => {
  const users = userQueries.findAll.all();
  res.json({ users });
});

// GET /api/rooms/:id/messages?before=<unix>&limit=<n> — paginated history (DB is source of truth)
router.get('/:id/messages', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const rows = messageQueries.getPage.all(req.params.id, before, before, limit);
  // getPage is newest-first; return oldest-first for the UI, plus reactions
  const messages = rows.reverse().map((m) => ({
    ...m,
    content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
    reactions: messageQueries.getReactions.all(m.id),
  }));
  const oldest = rows.length ? rows[rows.length - 1].created_at : null;
  res.json({ messages, hasMore: rows.length === limit, oldest });
});

// POST /api/rooms/:id/read — mark room as read (drives unread counts)
router.post('/:id/read', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  try {
    readQueries.markRead.run(req.params.id, req.user.userId);
  } catch {}
  res.json({ success: true });
});

// POST /api/rooms/dm — get or create DM room between two users
router.post('/dm', authenticateToken, (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
  if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot DM yourself' });

  const myId = req.user.userId;
  const target = userQueries.findById.get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Find existing DM
  const allRooms = roomQueries.findAll.all();
  const existingDm = allRooms.find(r => {
    if (r.type !== 'dm') return false;
    const members = roomQueries.getMembers.all(r.id);
    const ids = members.map(m => m.id);
    return ids.includes(myId) && ids.includes(targetUserId) && ids.length === 2;
  });

  if (existingDm) {
    return res.json({ room: existingDm });
  }

  // Create new DM
  const id = uuidv4();
  const me = userQueries.findById.get(myId);
  roomQueries.create.run({
    id,
    name: `${me.username}-${target.username}`,
    description: 'Direct message',
    type: 'dm',
    created_by: myId,
  });
  roomQueries.addMember.run(id, myId);
  roomQueries.addMember.run(id, targetUserId);

  const room = roomQueries.findById.get(id);
  res.status(201).json({ room });
});

// GET /api/rooms/:id/members
router.get('/:id/members', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const members = roomQueries.getMembers.all(req.params.id);
  res.json({ members });
});

// POST /api/rooms — create new room (channel)
router.post('/', authenticateToken, messageLimiter, (req, res) => {
  const { name, description, type } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Room name required' });
  if (String(name).length > 40) return res.status(400).json({ error: 'Room name too long (max 40)' });
  if (type && !['channel', 'dm'].includes(type)) return res.status(400).json({ error: 'Invalid room type' });

  const id = uuidv4();
  roomQueries.create.run({
    id,
    name: String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
    description: String(description || '').slice(0, 200),
    type: type || 'channel',
    created_by: req.user.userId,
  });
  roomQueries.addMember.run(id, req.user.userId);

  const room = roomQueries.findById.get(id);
  res.status(201).json({ room });
});

// POST /api/rooms/:id/join
router.post('/:id/join', authenticateToken, (req, res) => {
  const room = roomQueries.findById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.type === 'dm') {
    // DMs are invite-only: only existing members can re-join, never strangers.
    const member = roomQueries.isMember.get(req.params.id, req.user.userId);
    if (!member) return res.status(403).json({ error: 'DMs are private' });
  }
  roomQueries.addMember.run(req.params.id, req.user.userId);
  res.json({ success: true });
});

// DELETE /api/rooms/:id/leave
router.delete('/:id/leave', authenticateToken, (req, res) => {
  roomQueries.removeMember.run(req.params.id, req.user.userId);
  res.json({ success: true });
});

export default router;
