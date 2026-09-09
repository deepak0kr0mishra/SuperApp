import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { roomQueries, userQueries } from './db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// GET /api/rooms — list all rooms user belongs to + all public channels
router.get('/', authenticateToken, (req, res) => {
  const allRooms = roomQueries.findAll.all();
  res.json({ rooms: allRooms });
});

// NOTE: specific routes must come before param routes
// GET /api/rooms/users/all — list all users (legacy path, kept for compat)
router.get('/users/all', authenticateToken, (req, res) => {
  const users = userQueries.findAll.all();
  res.json({ users });
});

// POST /api/rooms/dm — get or create DM room between two users
router.post('/dm', authenticateToken, (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });

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
  const members = roomQueries.getMembers.all(req.params.id);
  res.json({ members });
});

// POST /api/rooms — create new room
router.post('/', authenticateToken, (req, res) => {
  const { name, description, type } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });

  const id = uuidv4();
  roomQueries.create.run({
    id,
    name: name.toLowerCase().replace(/\s+/g, '-'),
    description: description || '',
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
  roomQueries.addMember.run(req.params.id, req.user.userId);
  res.json({ success: true });
});

// DELETE /api/rooms/:id/leave
router.delete('/:id/leave', authenticateToken, (req, res) => {
  roomQueries.removeMember.run(req.params.id, req.user.userId);
  res.json({ success: true });
});

export default router;
