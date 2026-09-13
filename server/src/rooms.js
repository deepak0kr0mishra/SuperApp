import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  roomQueries, userQueries, messageQueries, readQueries,
  muteQueries, getActiveMute, blockQueries, isDMBlocked,
  watchQueries, extractYouTubeId, isFixedAdmin,
} from './db.js';
import { authenticateToken } from './auth.js';
import { messageLimiter } from './security.js';

const router = express.Router();

// Socket server handle (set by index.js) so REST join/leave can also push
// live occupancy. Socket flows emit on their own; this covers REST-only ones.
let roomsIO = null;
export function setRoomsIO(io) { roomsIO = io; }

export function canAccessRoom(userId, roomId) {
  const room = roomQueries.findById.get(roomId);
  if (!room) return { ok: false, status: 404, error: 'Room not found' };
  if (room.type === 'dm') {
    const member = roomQueries.isMember.get(roomId, userId);
    if (!member) return { ok: false, status: 403, error: 'You are not part of this conversation' };
  }
  return { ok: true, room };
}

// --- Lounge occupancy (limited rooms): a seat frees the moment its holder
// stops viewing the room, hangs up, or disconnects. Unlimited rooms (general)
// and DMs keep sticky membership. Admins never occupy seats.
export function userHasSocketIn(userId, socketRoom, io, exceptSocketId = null) {
  try {
    const set = io?.sockets?.adapter?.rooms?.get(socketRoom);
    if (!set) return false;
    for (const sid of set) {
      if (sid === exceptSocketId) continue;
      const s = io.sockets.sockets.get(sid);
      if (s?.userId === userId) return true;
    }
  } catch {}
  return false;
}

// Drop a lounge seat when its holder is truly gone (no tab viewing the room
// and none in its voice call). Emits the fresh count for live sidebars.
export function pruneLoungeMembership(userId, roomId, io, exceptSocketId = null) {
  try {
    if (!userId || !roomId) return;
    const room = roomQueries.findById.get(roomId);
    if (!room || room.type !== 'channel' || room.max_members == null) return;
    const me = userQueries.findById.get(userId);
    if (!me || me.role === 'admin') return; // staff never occupy seats
    if (userHasSocketIn(userId, `room:${roomId}`, io, exceptSocketId)) return;
    if (userHasSocketIn(userId, `voice:${roomId}`, io, exceptSocketId)) return;
    roomQueries.removeMember.run(roomId, userId);
    emitOccupancy(roomId, io);
  } catch {}
}

export function emitOccupancy(roomId, io) {
  try {
    const count = roomQueries.countOccupants.get(roomId)?.c ?? 0;
    io?.emit('room:occupancy', { roomId, count });
  } catch {}
}

// Room is full (admins bypass + don't take spots). DMs never have limits.
export function roomFullError(room, userId) {
  if (!room || room.type === 'dm' || room.max_members == null) return null;
  try {
    const me = userQueries.findById.get(userId);
    if (me?.role === 'admin') return null; // admins join even when full
    const count = roomQueries.countOccupants.get(room.id)?.c ?? 0;
    const already = roomQueries.isMember.get(room.id, userId);
    if (!already && count >= room.max_members) {
      return `Room is full (${count}/${room.max_members})`;
    }
  } catch {}
  return null;
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
    let memberCount = 0;
    try {
      unread = messageQueries.unreadCount.get(req.user.userId, r.id, req.user.userId)?.c ?? 0;
    } catch {}
    try {
      // Occupancy counts regular members (admin staff don't take spots).
      memberCount = roomQueries.countOccupants.get(r.id)?.c ?? 0;
    } catch {}
    return { ...r, unread, last_read_at: reads[r.id] ?? 0, memberCount };
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
  // Block check (either direction blocks a new DM). Admins can't be blocked,
  // but that is enforced at block-time — here we just honor existing rows.
  try {
    if (isDMBlocked(myId, targetUserId)) {
      return res.status(403).json({ error: 'Cannot start this chat (blocked)' });
    }
  } catch {}

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
    max_members: null,
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

// POST /api/rooms — fixed 5-space layout: only admins may create extra spaces
router.post('/', authenticateToken, messageLimiter, (req, res) => {
  const me = userQueries.findById.get(req.user.userId);
  if (!me || me.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create spaces' });
  }
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
    max_members: null,
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
  } else {
    const full = roomFullError(room, req.user.userId);
    if (full) return res.status(403).json({ error: full });
  }
  roomQueries.addMember.run(req.params.id, req.user.userId);
  emitOccupancy(req.params.id, roomsIO);
  res.json({ success: true });
});

// DELETE /api/rooms/:id/leave
router.delete('/:id/leave', authenticateToken, (req, res) => {
  roomQueries.removeMember.run(req.params.id, req.user.userId);
  emitOccupancy(req.params.id, roomsIO);
  res.json({ success: true });
});

// --- Watch together (YouTube, one shared video per room) ---
// GET /api/rooms/:id/watch — current video + playback state
router.get('/:id/watch', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  try {
    const state = watchQueries.get.get(req.params.id);
    res.json({ watch: state || { room_id: req.params.id, video_id: '', url: '', is_playing: 0, position: 0 } });
  } catch {
    res.json({ watch: { room_id: req.params.id, video_id: '', url: '', is_playing: 0, position: 0 } });
  }
});

// PUT /api/rooms/:id/watch — set video / playback state (any member; validated)
router.put('/:id/watch', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const { url, videoId, is_playing, position } = req.body || {};
  const raw = String(videoId || url || '').slice(0, 500);
  if (!raw) {
    // Empty = clear the player
    try { watchQueries.clear.run(req.params.id); } catch {}
    return res.json({ watch: { room_id: req.params.id, video_id: '', url: '', is_playing: 0, position: 0 } });
  }
  const video_id = extractYouTubeId(raw);
  if (!video_id) return res.status(400).json({ error: 'Send a valid YouTube link or 11-char video id' });
  const playing = is_playing ? 1 : 0;
  const pos = Math.max(0, Math.min(Number(position) || 0, 86400));
  try {
    watchQueries.set.run(req.params.id, video_id, `https://www.youtube.com/watch?v=${video_id}`, playing, pos, req.user.userId);
    res.json({ watch: watchQueries.get.get(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Could not save watch state' });
  }
});

export default router;
