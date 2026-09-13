import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import authRouter, { authenticateToken } from './auth.js';
import roomsRouter, { canAccessRoom, roomFullError, pruneLoungeMembership, emitOccupancy, setRoomsIO } from './rooms.js';
import filesRouter from './files.js';
import usersRouter from './users.js';
import adminRouter from './admin.js';
import reportsRouter from './reports.js';
import { messageQueries, roomQueries, userQueries, readQueries, replaceReaction, isChatMuted, isDMBlocked, watchQueries, extractYouTubeId } from './db.js';
import { setupVoiceSignaling, getVoiceChannelState, voiceRouter } from './voice.js';
import { securityHeaders, generalLimiter, messageLimiter, sanitizeMessageContent } from './security.js';
import { MESSAGE_MAX_LENGTH } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod';
const PORT = process.env.PORT || 3001;
// Allow comma-separated list so Pages URL + localhost both work:
// e.g. CLIENT_URL=https://deepak0kr0mishra.github.io,http://localhost:5173
const CLIENT_URLS = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsOrigin = (origin, cb) => {
  if (!origin) return cb(null, true); // curl / health checks
  if (CLIENT_URLS.includes(origin)) return cb(null, true);
  // Allow any github.io subdomain of the owner for preview URLs
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith('.github.io')) return cb(null, true);
  } catch {}
  return cb(new Error('CORS blocked'));
};

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB for file chunks
});

// --- Middleware ---
app.use(securityHeaders());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '25mb' })); // room for /api/admin/restore payloads
app.use('/api/', generalLimiter);

// --- REST Routes ---
app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/files', filesRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/voice', voiceRouter);

// Spec-compatible aliases (reuse same handlers, no duplicate logic):
// GET /api/channels, GET /api/channels/:id/messages, GET/POST /api/conversations, etc.
app.get('/api/channels', authenticateToken, (req, res) => {
  const rooms = roomQueries.findAll.all().filter((r) => r.type === 'channel');
  res.json({ channels: rooms, rooms });
});
app.get('/api/channels/:id/messages', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const rows = messageQueries.getPage.all(req.params.id, before, before, limit);
  const messages = rows.reverse().map((m) => ({
    ...m,
    content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
    reactions: messageQueries.getReactions.all(m.id),
  }));
  res.json({ messages, hasMore: rows.length === limit });
});
app.get('/api/conversations/:id/messages', authenticateToken, (req, res) => {
  const access = canAccessRoom(req.user.userId, req.params.id);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const before = Number(req.query.before) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const rows = messageQueries.getPage.all(req.params.id, before, before, limit);
  const messages = rows.reverse().map((m) => ({
    ...m,
    content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
    reactions: messageQueries.getReactions.all(m.id),
  }));
  res.json({ messages, hasMore: rows.length === limit });
});
app.get('/api/conversations', authenticateToken, (req, res) => {
  const rooms = roomQueries.getUserRooms.all(req.user.userId).filter((r) => r.type === 'dm');
  res.json({ conversations: rooms, rooms });
});
app.post('/api/conversations', authenticateToken, (req, res) => {
  const targetUserId = req.body.targetUserId || req.body.userId;
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
  if (targetUserId === req.user.userId) return res.status(400).json({ error: 'You cannot DM yourself' });
  const myId = req.user.userId;
  const target = userQueries.findById.get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  try {
    if (isDMBlocked(myId, targetUserId)) {
      return res.status(403).json({ error: 'Cannot start this chat (blocked)' });
    }
  } catch {}
  const allRooms = roomQueries.findAll.all();
  const existingDm = allRooms.find(r => {
    if (r.type !== 'dm') return false;
    const ids = roomQueries.getMembers.all(r.id).map(m => m.id);
    return ids.includes(myId) && ids.includes(targetUserId) && ids.length === 2;
  });
  if (existingDm) return res.json({ room: existingDm, conversation: existingDm });
  const id = uuidv4();
  const me = userQueries.findById.get(myId);
  roomQueries.create.run({ id, name: `${me.username}-${target.username}`, description: 'Direct message', type: 'dm', max_members: null, created_by: myId });
  roomQueries.addMember.run(id, myId);
  roomQueries.addMember.run(id, targetUserId);
  const room = roomQueries.findById.get(id);
  res.status(201).json({ room, conversation: room });
});

// REST message send/edit/delete (socket is primary for realtime; REST kept for spec + tests)
app.post('/api/messages', authenticateToken, messageLimiter, (req, res) => {
  const created = createMessage(req.user.userId, req.body);
  if (created.error) return res.status(created.status).json({ error: created.error });
  io.to(`room:${created.message.room_id}`).emit('message:new', created.message);
  res.status(201).json({ message: created.message });
});
app.patch('/api/messages/:id', authenticateToken, (req, res) => {
  const edited = editMessage(req.user.userId, req.params.id, req.body?.content);
  if (edited.error) return res.status(edited.status).json({ error: edited.error });
  io.to(`room:${edited.message.room_id}`).emit('message:edited', edited.message);
  res.json({ message: edited.message });
});
app.delete('/api/messages/:id', authenticateToken, (req, res) => {
  const result = deleteMessage(req.user.userId, req.params.id);
  if (result.error) return res.status(result.status).json({ error: result.error });
  io.to(`room:${result.roomId}`).emit('message:deleted', { messageId: req.params.id, roomId: result.roomId });
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// --- Shared message logic (used by both REST and sockets) ---
function toWireMessage(row) {
  return {
    ...row,
    content: row.is_deleted ? 'This message was deleted.' : (row.content ?? row.encrypted_content ?? ''),
    reactions: messageQueries.getReactions.all(row.id),
  };
}

function createMessage(userId, body) {
  const { roomId, content, encryptedContent, type, fileId, fileName, fileSize, fileMime, replyTo } = body || {};
  if (!roomId) return { error: 'roomId required', status: 400 };
  const room = roomQueries.findById.get(roomId);
  if (!room) return { error: 'Room not found', status: 404 };
  // Level-2 chat mute: no typing/sending in any space or group — DMs still allowed.
  if (room.type !== 'dm' && isChatMuted(userId)) {
    return { error: 'You are muted from chatting (admin mute)', status: 403 };
  }
  if (room.type === 'dm') {
    const member = roomQueries.isMember.get(roomId, userId);
    if (!member) return { error: 'You are not part of this conversation', status: 403 };
    // DM block: if either side blocked the other, nobody can message that DM.
    try {
      const members = roomQueries.getMembers.all(roomId);
      const other = members.find((m) => m.id !== userId);
      if (other && isDMBlocked(userId, other.id)) {
        return { error: 'Cannot message this chat (blocked)', status: 403 };
      }
    } catch {}
  } else {
    // Sending auto-joins public spaces — but never over the member cap
    // (admins bypass, like everywhere else).
    const fullMsg = roomFullError(room, userId);
    if (fullMsg) return { error: fullMsg, status: 403 };
    try { roomQueries.addMember.run(roomId, userId); } catch {}
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
    const parent = messageQueries.findById.get(replyTo);
    if (!parent || parent.room_id !== roomId) return { error: 'Invalid reply target', status: 400 };
  }
  const user = userQueries.findById.get(userId);
  if (!user) return { error: 'User not found', status: 404 };
  const id = uuidv4();
  messageQueries.insert.run({
    id,
    room_id: roomId,
    sender_id: userId,
    encrypted_content: text,
    content: text,
    type: msgType,
    file_id: fileId || null,
    file_name: fileName ? String(fileName).slice(0, 255) : null,
    file_size: fileSize ?? null,
    file_mime: fileMime ? String(fileMime).slice(0, 127) : null,
    reply_to: replyTo || null,
  });
  const row = messageQueries.findById.get(id);
  const message = {
    id,
    room_id: roomId,
    sender_id: userId,
    content: text,
    encrypted_content: text,
    type: msgType,
    file_id: fileId || null,
    file_name: fileName || null,
    file_size: fileSize ?? null,
    file_mime: fileMime || null,
    reply_to: replyTo || null,
    created_at: row?.created_at ?? Math.floor(Date.now() / 1000),
    username: user.username,
    display_name: user.display_name,
    avatar_color: user.avatar_color,
    reactions: [],
  };
  return { message };
}

function editMessage(userId, messageId, content) {
  const existing = messageQueries.findById.get(messageId);
  if (!existing) return { error: 'Message not found', status: 404 };
  if (existing.sender_id !== userId) return { error: 'You can only edit your own messages', status: 403 };
  if (existing.is_deleted) return { error: 'Cannot edit a deleted message', status: 400 };
  const text = sanitizeMessageContent(content || '', MESSAGE_MAX_LENGTH);
  if (!text) return { error: 'Message cannot be empty', status: 400 };
  messageQueries.edit.run(text, text, messageId);
  const row = messageQueries.findById.get(messageId);
  const user = userQueries.findById.get(userId);
  return {
    message: {
      ...row,
      content: text,
      encrypted_content: text,
      username: user?.username,
      display_name: user?.display_name,
      avatar_color: user?.avatar_color,
      reactions: messageQueries.getReactions.all(messageId),
    },
  };
}

function deleteMessage(userId, messageId) {
  const existing = messageQueries.findById.get(messageId);
  if (!existing) return { error: 'Message not found', status: 404 };
  const me = userQueries.findById.get(userId);
  const isAdmin = me?.role === 'admin';
  if (existing.sender_id !== userId && !isAdmin) {
    return { error: 'You can only delete your own messages', status: 403 };
  }
  // Soft delete: keep the record, show placeholder (spec requirement).
  messageQueries.softDelete.run('', '', messageId);
  return { roomId: existing.room_id };
}

// --- Socket.io Auth Middleware (server determines identity — never trust client userId) ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const raw = userQueries.findRawById.get(payload.userId);
    if (!raw) return next(new Error('User not found'));
    if (raw.is_disabled) return next(new Error('Account disabled'));
    socket.userId = payload.userId;
    socket.username = payload.username;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// Track connected users: userId → Set<socketId> (multi-tab safe presence)
const userSockets = new Map(); // userId → Set(socketId)
const connectedUsers = new Map(); // legacy compat: userId → socketId (last seen)

function markOnline(userId, socketId) {
  let set = userSockets.get(userId);
  if (!set) { set = new Set(); userSockets.set(userId, set); }
  const wasOffline = set.size === 0;
  set.add(socketId);
  connectedUsers.set(userId, socketId);
  if (wasOffline) {
    try { userQueries.updateStatus.run('online', userId); } catch {}
    io.emit('user:online', { userId });
    io.emit('user:status', { userId, status: 'online' });
  }
}

function markOfflineSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (set) set.delete(socketId);
  if (!set || set.size === 0) {
    userSockets.delete(userId);
    connectedUsers.delete(userId);
    try { userQueries.updateStatus.run('offline', userId); } catch {}
    io.emit('user:offline', { userId });
    io.emit('user:status', { userId, status: 'offline' });
  }
}

// --- Socket.io Events ---
io.on('connection', (socket) => {
  console.log(`✓ Connected: ${socket.username} (${socket.userId})`);

  markOnline(socket.userId, socket.id);

  // Send current voice state
  socket.emit('voice:initial_state', getVoiceChannelState());

  // --- Join a text room (DM membership enforced server-side) ---
  socket.on('room:join', ({ roomId }) => {
    try {
      if (!roomId) return;
      const access = canAccessRoom(socket.userId, roomId);
      if (!access.ok) {
        socket.emit('error', { message: access.error });
        return;
      }
      const room = access.room;
      // Capacity: admins bypass full rooms, everyone else is rejected.
      if (room.type === 'channel') {
        try {
          const fullMsg = roomFullError(room, socket.userId);
          if (fullMsg) {
            socket.emit('error', { message: fullMsg });
            return;
          }
        } catch {}
        try { roomQueries.addMember.run(roomId, socket.userId); } catch {}
        emitOccupancy(roomId, io); // seat taken → live sidebars
      }
      socket.join(`room:${roomId}`);
      // Send last 50 messages (paginated REST available for older history)
      const raw = messageQueries.getByRoom.all(roomId).slice(-50);
      const messages = raw.map((m) => ({
        ...m,
        content: m.is_deleted ? 'This message was deleted.' : (m.content ?? m.encrypted_content ?? ''),
        reactions: messageQueries.getReactions.all(m.id),
      }));
      socket.emit('messages:history', { roomId, messages });
    } catch (err) {
      console.error('room:join error:', err);
    }
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(`room:${roomId}`);
    // Lounge rooms: switching away frees your seat (general/DMs unaffected).
    pruneLoungeMembership(socket.userId, roomId, io, socket.id);
  });

  // --- Send message (plain text, validated + persisted, then broadcast) ---
  socket.on('message:send', (payload) => {
    try {
      const created = createMessage(socket.userId, payload || {});
      if (created.error) {
        socket.emit('error', { message: created.error });
        return;
      }
      io.to(`room:${created.message.room_id}`).emit('message:new', created.message);
      io.to(`room:${created.message.room_id}`).emit('message:read', {
        roomId: created.message.room_id,
        messageId: created.message.id,
      });
    } catch (err) {
      console.error('Message send error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // --- Edit message (owner only) ---
  socket.on('message:edit', ({ messageId, content }) => {
    try {
      if (!messageId) return;
      const edited = editMessage(socket.userId, messageId, content);
      if (edited.error) {
        socket.emit('error', { message: edited.error });
        return;
      }
      io.to(`room:${edited.message.room_id}`).emit('message:edited', edited.message);
      io.to(`room:${edited.message.room_id}`).emit('message:new', edited.message);
    } catch (err) {
      console.error('Edit error:', err);
    }
  });

  // --- Delete message (owner or admin, soft delete) ---
  socket.on('message:delete', ({ messageId, roomId }) => {
    try {
      if (!messageId) return;
      const result = deleteMessage(socket.userId, messageId);
      if (result.error) {
        socket.emit('error', { message: result.error });
        return;
      }
      const targetRoom = roomId || result.roomId;
      io.to(`room:${targetRoom}`).emit('message:deleted', { messageId, roomId: targetRoom });
    } catch (err) {
      console.error('Delete error:', err);
    }
  });

  // --- Mark room as read (read receipts / unread counts) ---
  socket.on('message:read', ({ roomId }) => {
    try {
      if (!roomId) return;
      const access = canAccessRoom(socket.userId, roomId);
      if (!access.ok) return;
      try { readQueries.markRead.run(roomId, socket.userId); } catch {}
      socket.to(`room:${roomId}`).emit('message:read', {
        roomId,
        userId: socket.userId,
        at: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      console.error('Read error:', err);
    }
  });

  // --- Reactions: exactly one per user per message (new react swaps the old) ---
  socket.on('message:react', ({ messageId, emoji, roomId }) => {
    try {
      if (!messageId || !emoji) return;
      const clean = String(emoji).trim().slice(0, 16);
      // Must be a single emoji grapheme (allow ZWJ sequences), not text.
      if (!clean || [...clean].length > 8) return;
      replaceReaction(messageId, socket.userId, clean);
      const reactions = messageQueries.getReactions.all(messageId);
      io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
    } catch (err) {
      console.error('React error:', err);
    }
  });

  socket.on('message:unreact', ({ messageId, emoji, roomId }) => {
    try {
      if (!messageId || !emoji) return;
      messageQueries.removeReaction.run(messageId, socket.userId, emoji);
      const reactions = messageQueries.getReactions.all(messageId);
      io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
    } catch (err) {
      console.error('Unreact error:', err);
    }
  });

  // --- Typing indicators (chat-muted users stay silent in spaces) ---
  socket.on('typing:start', ({ roomId }) => {
    if (!roomId) return;
    const access = canAccessRoom(socket.userId, roomId);
    if (!access.ok) return;
    if (access.room.type !== 'dm' && isChatMuted(socket.userId)) return;
    socket.to(`room:${roomId}`).emit('typing:start', { userId: socket.userId, username: socket.username, roomId });
    socket.to(`room:${roomId}`).emit('typing:update', {
      userId: socket.userId,
      username: socket.username,
      roomId,
      typing: true,
    });
  });

  socket.on('typing:stop', ({ roomId }) => {
    if (!roomId) return;
    socket.to(`room:${roomId}`).emit('typing:stop', { userId: socket.userId, username: socket.username, roomId });
    socket.to(`room:${roomId}`).emit('typing:update', {
      userId: socket.userId,
      username: socket.username,
      roomId,
      typing: false,
    });
  });

  // --- Room created event relay ---
  socket.on('room:created', (room) => {
    io.emit('room:new', room);
  });

  // --- Watch together: persist + broadcast per-room player state ---
  const emitWatch = (roomId) => {
    try {
      const state = watchQueries.get.get(roomId);
      if (state) io.to(`room:${roomId}`).emit('watch:update', { watch: state });
    } catch {}
  };
  socket.on('watch:set', ({ roomId, url, videoId }) => {
    try {
      if (!roomId) return;
      const access = canAccessRoom(socket.userId, roomId);
      if (!access.ok) {
        socket.emit('error', { message: access.error });
        return;
      }
      const raw = String(videoId || url || '').slice(0, 500);
      if (!raw) {
        try { watchQueries.clear.run(roomId); } catch {}
        io.to(`room:${roomId}`).emit('watch:update', {
          watch: { room_id: roomId, video_id: '', url: '', is_playing: 0, position: 0 },
        });
        return;
      }
      const vid = extractYouTubeId(raw);
      if (!vid) {
        socket.emit('error', { message: 'Send a valid YouTube link' });
        return;
      }
      watchQueries.set.run(roomId, vid, `https://www.youtube.com/watch?v=${vid}`, 1, 0, socket.userId);
      emitWatch(roomId);
    } catch (err) {
      console.error('watch:set error:', err);
    }
  });
  socket.on('watch:state', ({ roomId, is_playing, position }) => {
    try {
      if (!roomId) return;
      const access = canAccessRoom(socket.userId, roomId);
      if (!access.ok) return;
      const cur = watchQueries.get.get(roomId);
      if (!cur?.video_id) return;
      const pos = Math.max(0, Math.min(Number(position) || 0, 86400));
      watchQueries.updateState.run(is_playing ? 1 : 0, pos, roomId);
      emitWatch(roomId);
    } catch (err) {
      console.error('watch:state error:', err);
    }
  });

  // --- Disconnect (multi-tab safe) ---
  socket.on('disconnect', () => {
    console.log(`✗ Disconnected: ${socket.username}`);
    // Lounge rooms: closing/dropping frees all your seats (voice seats are
    // freed by the voice disconnect handler; this covers text-only seats and
    // any seat taken without a socket join, e.g. message auto-join).
    try {
      const mine = roomQueries.getUserRooms.all(socket.userId);
      for (const r of mine) {
        if (r.type === 'channel' && r.max_members != null) {
          pruneLoungeMembership(socket.userId, r.id, io, socket.id);
        }
      }
    } catch {}
    markOfflineSocket(socket.userId, socket.id);
  });
});

// Set up WebRTC voice signaling
setupVoiceSignaling(io, connectedUsers);
setRoomsIO(io);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════╗
  ║   SecureChat Server v2.0.0    ║
  ║   Running on port ${PORT}         ║
  ║   Client(s): ${CLIENT_URLS.join(', ')}  ║
  ╚═══════════════════════════════╝
  `);
});
