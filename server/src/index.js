import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import authRouter, { authenticateToken } from './auth.js';
import roomsRouter, { canAccessRoom, emitOccupancy, setRoomsIO, applyGameMove, resetGame, emitGame } from './rooms.js';
import filesRouter from './files.js';
import usersRouter from './users.js';
import adminRouter from './admin.js';
import reportsRouter from './reports.js';
import {
  messageQueries, roomQueries, userQueries, readQueries,
  replaceReaction, isChatMuted, isDMBlocked, watchQueries, extractYouTubeId,
  MESSAGE_MAX_LENGTH,
} from './db.js';
import { setupVoiceSignaling, getVoiceChannelState, voiceRouter } from './voice.js';
import { securityHeaders, generalLimiter, messageLimiter, sanitizeMessageContent } from './security.js';

const JWT_SECRET = process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod';
const PORT = process.env.PORT || 3001;
const CLIENT_URLS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (CLIENT_URLS.includes(origin)) return cb(null, true);
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.github.io')) return cb(null, true);
  } catch {}
  return cb(new Error('CORS blocked'));
};

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  maxHttpBufferSize: 50 * 1024 * 1024,
});

app.use(securityHeaders());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/api/', generalLimiter);

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/files', filesRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/voice', voiceRouter);

// Spec-compatible aliases
app.get('/api/channels', authenticateToken, async (req, res) => {
  try {
    const rooms = (await roomQueries.findAll.all()).filter((r) => r.type === 'channel');
    res.json({ channels: rooms, rooms });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/channels/:id/messages', authenticateToken, async (req, res) => {
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
    res.json({ messages, hasMore: rows.length === limit });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
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
    res.json({ messages, hasMore: rows.length === limit });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const rooms = (await roomQueries.getUserRooms.all(req.user.userId)).filter((r) => r.type === 'dm');
    res.json({ conversations: rooms, rooms });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const targetUserId = req.body.targetUserId || req.body.userId;
    if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
    if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot DM yourself' });
    const myId = req.user.userId;
    const target = await userQueries.findById.get(targetUserId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    try {
      if (await isDMBlocked(myId, targetUserId)) return res.status(403).json({ error: 'Cannot start this chat (blocked)' });
    } catch {}
    const allRooms = await roomQueries.findAll.all();
    let existingDm = null;
    for (const r of allRooms) {
      if (r.type !== 'dm') continue;
      const members = await roomQueries.getMembers.all(r.id);
      const ids = members.map((m) => m.id);
      if (ids.includes(myId) && ids.includes(targetUserId) && ids.length === 2) { existingDm = r; break; }
    }
    if (existingDm) return res.json({ room: existingDm, conversation: existingDm });
    const id = uuidv4();
    const me = await userQueries.findById.get(myId);
    await roomQueries.create.run({ id, name: `${me.username}-${target.username}`, description: 'Direct message', type: 'dm', max_members: null, created_by: myId });
    await roomQueries.addMember.run(id, myId);
    await roomQueries.addMember.run(id, targetUserId);
    const room = await roomQueries.findById.get(id);
    res.status(201).json({ room, conversation: room });
  } catch (err) {
    console.error('POST /conversations error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// REST message endpoints
app.post('/api/messages', authenticateToken, messageLimiter, async (req, res) => {
  try {
    const created = await createMessage(req.user.userId, req.body);
    if (created.error) return res.status(created.status).json({ error: created.error });
    io.to(`room:${created.message.room_id}`).emit('message:new', created.message);
    res.status(201).json({ message: created.message });
  } catch (err) {
    console.error('POST /messages error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.patch('/api/messages/:id', authenticateToken, async (req, res) => {
  try {
    const edited = await editMessage(req.user.userId, req.params.id, req.body?.content);
    if (edited.error) return res.status(edited.status).json({ error: edited.error });
    io.to(`room:${edited.message.room_id}`).emit('message:edited', edited.message);
    res.json({ message: edited.message });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
  try {
    const result = await deleteMessage(req.user.userId, req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    io.to(`room:${result.roomId}`).emit('message:deleted', { messageId: req.params.id, roomId: result.roomId });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// --- Shared async message helpers ---
async function toWireMessage(row) {
  return {
    ...row,
    content: row.is_deleted ? 'This message was deleted.' : (row.content ?? row.encrypted_content ?? ''),
    reactions: await messageQueries.getReactions.all(row.id),
  };
}

async function createMessage(userId, body) {
  const { roomId, content, encryptedContent, type, fileId, fileName, fileSize, fileMime, replyTo } = body || {};
  if (!roomId) return { error: 'roomId required', status: 400 };
  const room = await roomQueries.findById.get(roomId);
  if (!room) return { error: 'Room not found', status: 404 };

  if (room.type !== 'dm' && (await isChatMuted(userId))) {
    return { error: 'You are muted from chatting (admin mute)', status: 403 };
  }
  if (room.type === 'dm') {
    const member = await roomQueries.isMember.get(roomId, userId);
    if (!member) return { error: 'You are not part of this conversation', status: 403 };
    try {
      const members = await roomQueries.getMembers.all(roomId);
      const other = members.find((m) => m.id !== userId);
      if (other && (await isDMBlocked(userId, other.id))) {
        return { error: 'Cannot message this chat (blocked)', status: 403 };
      }
    } catch {}
  } else {
    try { await roomQueries.addMember.run(roomId, userId); } catch {}
  }

  const text = sanitizeMessageContent(
    (typeof content === 'string' && content) || encryptedContent || '',
    MESSAGE_MAX_LENGTH
  );
  const msgType = type || 'text';
  if (!['text', 'image', 'video', 'audio', 'file'].includes(msgType)) {
    return { error: 'Invalid message type', status: 400 };
  }
  if (msgType === 'text' && !text) return { error: 'Message cannot be empty', status: 400 };
  if (replyTo) {
    const parent = await messageQueries.findById.get(replyTo);
    if (!parent || parent.room_id !== roomId) return { error: 'Invalid reply target', status: 400 };
  }
  const user = await userQueries.findById.get(userId);
  if (!user) return { error: 'User not found', status: 404 };

  const id = uuidv4();
  await messageQueries.insert.run({
    id, room_id: roomId, sender_id: userId,
    encrypted_content: text, content: text,
    type: msgType,
    file_id: fileId || null,
    file_name: fileName ? String(fileName).slice(0, 255) : null,
    file_size: fileSize ?? null,
    file_mime: fileMime ? String(fileMime).slice(0, 127) : null,
    reply_to: replyTo || null,
  });
  const row = await messageQueries.findById.get(id);
  const message = {
    id, room_id: roomId, sender_id: userId,
    content: text, encrypted_content: text, type: msgType,
    file_id: fileId || null, file_name: fileName || null,
    file_size: fileSize ?? null, file_mime: fileMime || null,
    reply_to: replyTo || null,
    created_at: row?.created_at ?? Math.floor(Date.now() / 1000),
    username: user.username, display_name: user.display_name, avatar_color: user.avatar_color,
    reactions: [],
  };
  return { message };
}

async function editMessage(userId, messageId, content) {
  const existing = await messageQueries.findById.get(messageId);
  if (!existing) return { error: 'Message not found', status: 404 };
  if (existing.sender_id !== userId) return { error: 'You can only edit your own messages', status: 403 };
  if (existing.is_deleted) return { error: 'Cannot edit a deleted message', status: 400 };
  const text = sanitizeMessageContent(content || '', MESSAGE_MAX_LENGTH);
  if (!text) return { error: 'Message cannot be empty', status: 400 };
  await messageQueries.edit.run(text, text, messageId);
  const row = await messageQueries.findById.get(messageId);
  const user = await userQueries.findById.get(userId);
  return {
    message: {
      ...row, content: text, encrypted_content: text,
      username: user?.username, display_name: user?.display_name, avatar_color: user?.avatar_color,
      reactions: await messageQueries.getReactions.all(messageId),
    },
  };
}

async function deleteMessage(userId, messageId) {
  const existing = await messageQueries.findById.get(messageId);
  if (!existing) return { error: 'Message not found', status: 404 };
  const me = await userQueries.findById.get(userId);
  const isAdmin = me?.role === 'admin';
  if (existing.sender_id !== userId && !isAdmin) {
    return { error: 'You can only delete your own messages', status: 403 };
  }
  await messageQueries.softDelete.run('', '', messageId);
  return { roomId: existing.room_id };
}

// --- Socket.io Auth Middleware ---
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const raw = await userQueries.findRawById.get(payload.userId);
    if (!raw) return next(new Error('User not found'));
    if (raw.is_disabled) return next(new Error('Account disabled'));
    socket.userId = payload.userId;
    socket.username = payload.username;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// Presence tracking
const userSockets = new Map();
const connectedUsers = new Map();

async function markOnline(userId, socketId) {
  let set = userSockets.get(userId);
  if (!set) { set = new Set(); userSockets.set(userId, set); }
  const wasOffline = set.size === 0;
  set.add(socketId);
  connectedUsers.set(userId, socketId);
  if (wasOffline) {
    try { await userQueries.updateStatus.run('online', userId); } catch {}
    io.emit('user:online', { userId });
    io.emit('user:status', { userId, status: 'online' });
  }
}

async function markOfflineSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (set) set.delete(socketId);
  if (!set || set.size === 0) {
    userSockets.delete(userId);
    connectedUsers.delete(userId);
    try { await userQueries.updateStatus.run('offline', userId); } catch {}
    io.emit('user:offline', { userId });
    io.emit('user:status', { userId, status: 'offline' });
  }
}

// --- Socket.io Events ---
io.on('connection', (socket) => {
  console.log(`✓ Connected: ${socket.username} (${socket.userId})`);

  markOnline(socket.userId, socket.id);
  socket.emit('voice:initial_state', getVoiceChannelState());

  socket.on('room:join', async ({ roomId }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) { socket.emit('error', { message: access.error }); return; }
      const room = access.room;
      if (room.type === 'channel') {
        try { await roomQueries.addMember.run(roomId, socket.userId); } catch {}
        await emitOccupancy(roomId, io);
      }
      socket.join(`room:${roomId}`);
      const raw = (await messageQueries.getByRoom.all(roomId)).slice(-50);
      const messages = await Promise.all(raw.map(async (m) => ({
        ...m,
        content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
        reactions: await messageQueries.getReactions.all(m.id),
      })));
      socket.emit('messages:history', { roomId, messages });
    } catch (err) {
      console.error('room:join error:', err);
    }
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(`room:${roomId}`);
  });

  socket.on('message:send', async (payload) => {
    try {
      const created = await createMessage(socket.userId, payload || {});
      if (created.error) { socket.emit('error', { message: created.error }); return; }
      io.to(`room:${created.message.room_id}`).emit('message:new', created.message);
      io.to(`room:${created.message.room_id}`).emit('message:read', {
        roomId: created.message.room_id, messageId: created.message.id,
      });
    } catch (err) {
      console.error('Message send error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('message:edit', async ({ messageId, content }) => {
    try {
      if (!messageId) return;
      const edited = await editMessage(socket.userId, messageId, content);
      if (edited.error) { socket.emit('error', { message: edited.error }); return; }
      io.to(`room:${edited.message.room_id}`).emit('message:edited', edited.message);
      io.to(`room:${edited.message.room_id}`).emit('message:new', edited.message);
    } catch (err) {
      console.error('Edit error:', err);
    }
  });

  socket.on('message:delete', async ({ messageId, roomId }) => {
    try {
      if (!messageId) return;
      const result = await deleteMessage(socket.userId, messageId);
      if (result.error) { socket.emit('error', { message: result.error }); return; }
      const targetRoom = roomId || result.roomId;
      io.to(`room:${targetRoom}`).emit('message:deleted', { messageId, roomId: targetRoom });
    } catch (err) {
      console.error('Delete error:', err);
    }
  });

  socket.on('message:read', async ({ roomId }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) return;
      try { await readQueries.markRead.run(roomId, socket.userId); } catch {}
      socket.to(`room:${roomId}`).emit('message:read', {
        roomId, userId: socket.userId, at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      console.error('Read error:', err);
    }
  });

  socket.on('message:react', async ({ messageId, emoji, roomId }) => {
    try {
      if (!messageId || !emoji) return;
      const clean = String(emoji).trim().slice(0, 16);
      if (!clean || [...clean].length > 8) return;
      await replaceReaction(messageId, socket.userId, clean);
      const reactions = await messageQueries.getReactions.all(messageId);
      io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
    } catch (err) {
      console.error('React error:', err);
    }
  });

  socket.on('message:unreact', async ({ messageId, emoji, roomId }) => {
    try {
      if (!messageId || !emoji) return;
      await messageQueries.removeReaction.run(messageId, socket.userId, emoji);
      const reactions = await messageQueries.getReactions.all(messageId);
      io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
    } catch (err) {
      console.error('Unreact error:', err);
    }
  });

  socket.on('typing:start', async ({ roomId }) => {
    if (!roomId) return;
    try {
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) return;
      if (access.room.type !== 'dm' && (await isChatMuted(socket.userId))) return;
      socket.to(`room:${roomId}`).emit('typing:start', { userId: socket.userId, username: socket.username, roomId });
      socket.to(`room:${roomId}`).emit('typing:update', { userId: socket.userId, username: socket.username, roomId, typing: true });
    } catch {}
  });

  socket.on('typing:stop', ({ roomId }) => {
    if (!roomId) return;
    socket.to(`room:${roomId}`).emit('typing:stop', { userId: socket.userId, username: socket.username, roomId });
    socket.to(`room:${roomId}`).emit('typing:update', { userId: socket.userId, username: socket.username, roomId, typing: false });
  });

  socket.on('room:created', (room) => {
    io.emit('room:new', room);
  });

  // Watch together
  const emitWatch = async (roomId) => {
    try {
      const state = await watchQueries.get.get(roomId);
      if (state) io.to(`room:${roomId}`).emit('watch:update', { watch: state });
    } catch {}
  };

  socket.on('watch:set', async ({ roomId, url, videoId }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) { socket.emit('error', { message: access.error }); return; }
      const raw = String(videoId || url || '').slice(0, 500);
      if (!raw) {
        try { await watchQueries.clear.run(roomId); } catch {}
        io.to(`room:${roomId}`).emit('watch:update', { watch: { room_id: roomId, video_id: '', url: '', is_playing: 0, position: 0 } });
        return;
      }
      const vid = extractYouTubeId(raw);
      if (!vid) { socket.emit('error', { message: 'Send a valid YouTube link' }); return; }
      await watchQueries.set.run(roomId, vid, `https://www.youtube.com/watch?v=${vid}`, 1, 0, socket.userId);
      await emitWatch(roomId);
    } catch (err) {
      console.error('watch:set error:', err);
    }
  });

  socket.on('watch:state', async ({ roomId, is_playing, position }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) return;
      const cur = await watchQueries.get.get(roomId);
      if (!cur?.video_id) return;
      const pos = Math.max(0, Math.min(Number(position) || 0, 86400));
      await watchQueries.updateState.run(is_playing ? 1 : 0, pos, roomId);
      await emitWatch(roomId);
    } catch (err) {
      console.error('watch:state error:', err);
    }
  });

  // Tic-tac-toe
  socket.on('game:move', async ({ roomId, index }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) { socket.emit('error', { message: access.error }); return; }
      const result = await applyGameMove(roomId, socket.userId, index);
      if (result.error) { socket.emit('error', { message: result.error }); return; }
      await emitGame(roomId, io);
    } catch (err) {
      console.error('game:move error:', err);
    }
  });

  socket.on('game:reset', async ({ roomId }) => {
    try {
      if (!roomId) return;
      const access = await canAccessRoom(socket.userId, roomId);
      if (!access.ok) { socket.emit('error', { message: access.error }); return; }
      await resetGame(roomId);
      await emitGame(roomId, io);
    } catch (err) {
      console.error('game:reset error:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`✗ Disconnected: ${socket.username}`);
    markOfflineSocket(socket.userId, socket.id);
  });
});

setupVoiceSignaling(io, connectedUsers);
setRoomsIO(io);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════╗
  ║   TeaChat Server v3.0.0       ║
  ║   Running on port ${PORT}         ║
  ║   DB: ${process.env.TURSO_URL ? 'Turso Cloud' : 'Local SQLite'}          ║
  ╚═══════════════════════════════╝
  `);
});
