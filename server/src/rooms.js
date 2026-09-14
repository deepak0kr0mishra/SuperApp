import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  blockQueries, isDMBlocked, isFixedAdmin,
} from './db.js';
import { authenticateToken } from './auth.js';
import { messageLimiter } from './security.js';

const router = express.Router();

let roomsIO = null;
export function setRoomsIO(io) { roomsIO = io; }

export async function canAccessRoom(userId, roomId) {
  const room = await roomQueries.findById.get(roomId);
  if (!room) return { ok: false, status: 404, error: 'Room not found' };
  if (room.type === 'dm') {
    const member = await roomQueries.isMember.get(roomId, userId);
    if (!member) return { ok: false, status: 403, error: 'You are not part of this conversation' };
  }
  return { ok: true, room };
}

export function pruneLoungeMembership() { return; }

export async function emitOccupancy(roomId, io) {
  try {
    const row = await roomQueries.countOccupants.get(roomId);
    const count = row?.c ?? 0;
    io?.emit('room:occupancy', { roomId, count });
  } catch {}
}

export function roomFullError() { return null; }

// GET /api/rooms
router.get('/', authenticateToken, async (req, res) => {
  try {
    const allRooms = await roomQueries.findAll.all();
    const reads = {};
    try {
      const readRows = await readQueries.getReads.all(req.user.userId);
      for (const r of readRows) reads[r.room_id] = r.last_read_at;
    } catch {}

    const rooms = await Promise.all(allRooms.map(async (r) => {
      let unread = 0, memberCount = 0;
      try { unread = (await messageQueries.unreadCount.get(req.user.userId, r.id, req.user.userId))?.c ?? 0; } catch {}
      try { memberCount = (await roomQueries.countOccupants.get(r.id))?.c ?? 0; } catch {}
      return { ...r, unread, last_read_at: reads[r.id] ?? 0, memberCount };
    }));
    res.json({ rooms });
  } catch (err) {
    console.error('GET /rooms error:', err);
    res.status(500).json({ error: 'Failed to load rooms' });
  }
});

router.get('/users/all', authenticateToken, async (req, res) => {
  try {
    const users = await userQueries.findAll.all();
    res.json({ users });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/rooms/:id/messages
router.get('/:id/messages', authenticateToken, async (req, res) => {
  try {
    const access = await canAccessRoom(req.user.userId, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const before = Number(req.query.before) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const rows = await messageQueries.getPage.all(req.params.id, before, before, limit);
    const messages = await Promise.all(rows.reverse().map(async (m) => ({
      ...m,
      content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
      reactions: await messageQueries.getReactions.all(m.id),
    })));
    const oldest = rows.length ? rows[rows.length - 1].created_at : null;
    res.json({ messages, hasMore: rows.length === limit, oldest });
  } catch (err) {
    console.error('GET messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /api/rooms/:id/read
router.post('/:id/read', authenticateToken, async (req, res) => {
  try {
    const access = await canAccessRoom(req.user.userId, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    await readQueries.markRead.run(req.params.id, req.user.userId);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});

// POST /api/rooms/dm
router.post('/dm', authenticateToken, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
    if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot DM yourself' });

    const myId = req.user.userId;
    const target = await userQueries.findById.get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    try {
      if (await isDMBlocked(myId, targetUserId)) {
        return res.status(403).json({ error: 'Cannot start this chat (blocked)' });
      }
    } catch {}

    const allRooms = await roomQueries.findAll.all();
    let existingDm = null;
    for (const r of allRooms) {
      if (r.type !== 'dm') continue;
      const members = await roomQueries.getMembers.all(r.id);
      const ids = members.map((m) => m.id);
      if (ids.includes(myId) && ids.includes(targetUserId) && ids.length === 2) {
        existingDm = r;
        break;
      }
    }
    if (existingDm) return res.json({ room: existingDm });

    const id = uuidv4();
    const me = await userQueries.findById.get(myId);
    await roomQueries.create.run({
      id,
      name: `${me.username}-${target.username}`,
      description: 'Direct message',
      type: 'dm',
      max_members: null,
      created_by: myId,
    });
    await roomQueries.addMember.run(id, myId);
    await roomQueries.addMember.run(id, targetUserId);
    const room = await roomQueries.findById.get(id);
    res.status(201).json({ room });
  } catch (err) {
    console.error('POST /dm error:', err);
    res.status(500).json({ error: 'Failed to create DM' });
  }
});

// GET /api/rooms/:id/members
router.get('/:id/members', authenticateToken, async (req, res) => {
  try {
    const access = await canAccessRoom(req.user.userId, req.params.id);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const members = await roomQueries.getMembers.all(req.params.id);
    res.json({ members });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/rooms
router.post('/', authenticateToken, messageLimiter, async (req, res) => {
  try {
    const me = await userQueries.findById.get(req.user.userId);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Only admins can create spaces' });
    const { name, description, type } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Room name required' });
    if (String(name).length > 40) return res.status(400).json({ error: 'Room name too long (max 40)' });
    if (type && !['channel', 'dm'].includes(type)) return res.status(400).json({ error: 'Invalid room type' });
    const id = uuidv4();
    await roomQueries.create.run({
      id,
      name: String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
      description: String(description || '').slice(0, 200),
      type: type || 'channel',
      max_members: null,
      created_by: req.user.userId,
    });
    await roomQueries.addMember.run(id, req.user.userId);
    const room = await roomQueries.findById.get(id);
    res.status(201).json({ room });
  } catch (err) {
    console.error('POST /rooms error:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// POST /api/rooms/:id/join
router.post('/:id/join', authenticateToken, async (req, res) => {
  try {
    const room = await roomQueries.findById.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.type === 'dm') {
      const member = await roomQueries.isMember.get(req.params.id, req.user.userId);
      if (!member) return res.status(403).json({ error: 'DMs are private' });
    }
    await roomQueries.addMember.run(req.params.id, req.user.userId);
    await emitOccupancy(req.params.id, roomsIO);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// DELETE /api/rooms/:id/leave
router.delete('/:id/leave', authenticateToken, async (req, res) => {
  try {
    await roomQueries.removeMember.run(req.params.id, req.user.userId);
    await emitOccupancy(req.params.id, roomsIO);
    res.json({ success: true });
  } catch { res.json({ success: true }); }
});



export default router;
