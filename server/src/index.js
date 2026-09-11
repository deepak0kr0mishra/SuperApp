import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import authRouter from './auth.js';
import roomsRouter from './rooms.js';
import filesRouter from './files.js';
import usersRouter from './users.js';
import adminRouter from './admin.js';
import { messageQueries, roomQueries, userQueries } from './db.js';
import { setupVoiceSignaling, getVoiceChannelState } from './voice.js';

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
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// --- REST Routes ---
app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/files', filesRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// --- Socket.io Auth Middleware ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.userId;
    socket.username = payload.username;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// Track connected users: userId → socket
const connectedUsers = new Map();

// --- Socket.io Events ---
io.on('connection', (socket) => {
  console.log(`✓ Connected: ${socket.username} (${socket.userId})`);

  // Register user as online
  connectedUsers.set(socket.userId, socket.id);
  userQueries.updateStatus.run('online', socket.userId);
  io.emit('user:status', { userId: socket.userId, status: 'online' });

  // Send current voice state
  socket.emit('voice:initial_state', getVoiceChannelState());

  // --- Join a text room ---
  socket.on('room:join', ({ roomId }) => {
    try {
      if (!roomId) return;
      const room = roomQueries.findById.get(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      // Auto-join public channels so default channels always work
      if (room.type === 'channel') {
        try { roomQueries.addMember.run(roomId, socket.userId); } catch {}
      }
      socket.join(`room:${roomId}`);
      // Send last 100 messages
      const messages = messageQueries.getByRoom.all(roomId);
      socket.emit('messages:history', { roomId, messages });
    } catch (err) {
      console.error('room:join error:', err);
    }
  });

  socket.on('room:leave', ({ roomId }) => {
    socket.leave(`room:${roomId}`);
  });

  // --- Send message (encrypted) ---
  socket.on('message:send', ({ roomId, encryptedContent, type, fileId, fileName, fileSize, fileMime, replyTo }) => {
    try {
      const id = uuidv4();
      const user = userQueries.findById.get(socket.userId);

      messageQueries.insert.run({
        id,
        room_id: roomId,
        sender_id: socket.userId,
        encrypted_content: encryptedContent,
        type: type || 'text',
        file_id: fileId || null,
        file_name: fileName || null,
        file_size: fileSize || null,
        file_mime: fileMime || null,
        reply_to: replyTo || null,
      });

      const message = {
        id,
        room_id: roomId,
        sender_id: socket.userId,
        encrypted_content: encryptedContent,
        type: type || 'text',
        file_id: fileId || null,
        file_name: fileName || null,
        file_size: fileSize || null,
        file_mime: fileMime || null,
        reply_to: replyTo || null,
        created_at: Math.floor(Date.now() / 1000),
        username: user.username,
        display_name: user.display_name,
        avatar_color: user.avatar_color,
      };

      io.to(`room:${roomId}`).emit('message:new', message);
    } catch (err) {
      console.error('Message send error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // --- Delete message (owner or admin) ---
  socket.on('message:delete', ({ messageId, roomId }) => {
    try {
      const me = userQueries.findById.get(socket.userId);
      if (me?.role === 'admin') {
        messageQueries.adminDelete.run(messageId);
      } else {
        messageQueries.delete.run(messageId, socket.userId);
      }
      io.to(`room:${roomId}`).emit('message:deleted', { messageId, roomId });
    } catch (err) {
      console.error('Delete error:', err);
    }
  });

  // --- Reactions ---
  socket.on('message:react', ({ messageId, emoji, roomId }) => {
    messageQueries.addReaction.run(messageId, socket.userId, emoji);
    const reactions = messageQueries.getReactions.all(messageId);
    io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
  });

  socket.on('message:unreact', ({ messageId, emoji, roomId }) => {
    messageQueries.removeReaction.run(messageId, socket.userId, emoji);
    const reactions = messageQueries.getReactions.all(messageId);
    io.to(`room:${roomId}`).emit('message:reactions_update', { messageId, reactions });
  });

  // --- Typing indicators ---
  socket.on('typing:start', ({ roomId }) => {
    socket.to(`room:${roomId}`).emit('typing:update', {
      userId: socket.userId,
      username: socket.username,
      roomId,
      typing: true,
    });
  });

  socket.on('typing:stop', ({ roomId }) => {
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

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`✗ Disconnected: ${socket.username}`);
    connectedUsers.delete(socket.userId);
    userQueries.updateStatus.run('offline', socket.userId);
    io.emit('user:status', { userId: socket.userId, status: 'offline' });
  });
});

// Set up WebRTC voice signaling
setupVoiceSignaling(io, connectedUsers);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════╗
  ║   SecureChat Server v1.0.0    ║
  ║   Running on port ${PORT}         ║
  ║   Client(s): ${CLIENT_URLS.join(', ')}  ║
  ╚═══════════════════════════════╝
  `);
});
