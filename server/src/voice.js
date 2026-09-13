import express from 'express';
import { voiceChannelQueries, roomQueries, userQueries, getActiveMute } from './db.js';
import { emitOccupancy } from './rooms.js';
import { authenticateToken } from './auth.js';

export const voiceRouter = express.Router();
voiceRouter.get('/', authenticateToken, async (req, res) => {
  try {
    res.json({ channels: await voiceChannelQueries.list.all() });
  } catch {
    res.json({ channels: [] });
  }
});

const voiceChannels = new Map();

export function getVoiceCount(channelId) {
  try { return voiceChannels.get(channelId)?.size ?? 0; } catch { return 0; }
}

export function setupVoiceSignaling(io, authenticatedSockets) {
  io.on('connection', (socket) => {
    socket.on('voice:join', async ({ channelId }) => {
      if (!socket.userId) return;

      try {
        const room = await roomQueries.findById.get(channelId);
        if (room && room.type === 'channel' && room.max_members != null) {
          const me = await userQueries.findById.get(socket.userId);
          const isAdmin = me?.role === 'admin';
          if (!isAdmin) {
            const inVoice = voiceChannels.get(channelId)?.has(socket.userId);
            const count = getVoiceCount(channelId);
            if (!inVoice && count >= room.max_members) {
              socket.emit('error', { message: `Voice call is full (${count}/${room.max_members})` });
              return;
            }
          }
        }
      } catch {}

      leaveAllVoiceChannels(socket, io);

      try { await roomQueries.addMember.run(channelId, socket.userId); } catch {}
      await emitOccupancy(channelId, io);

      if (!voiceChannels.has(channelId)) voiceChannels.set(channelId, new Map());
      const channel = voiceChannels.get(channelId);
      const existingPeers = Array.from(channel.keys());

      channel.set(socket.userId, socket.id);
      socket.currentVoiceChannel = channelId;
      socket.join(`voice:${channelId}`);

      socket.emit('voice:peers', {
        channelId,
        peers: existingPeers.map((uid) => ({ userId: uid, socketId: channel.get(uid) })),
      });

      try {
        const vm = await getActiveMute(socket.userId, 'voice');
        if (vm) {
          socket.emit('voice:muted', { channelId, kind: 'voice', expires_at: vm.expires_at, reason: vm.reason || '' });
        }
      } catch {}

      socket.to(`voice:${channelId}`).emit('voice:peer_joined', {
        channelId, userId: socket.userId, socketId: socket.id,
      });
      broadcastVoiceState(io, channelId);
    });

    socket.on('voice:leave', () => leaveAllVoiceChannels(socket, io));

    socket.on('voice:offer', ({ targetSocketId, offer, channelId }) => {
      io.to(targetSocketId).emit('voice:offer', {
        offer, channelId, fromSocketId: socket.id, fromUserId: socket.userId,
      });
    });

    socket.on('voice:answer', ({ targetSocketId, answer, channelId }) => {
      io.to(targetSocketId).emit('voice:answer', {
        answer, channelId, fromSocketId: socket.id, fromUserId: socket.userId,
      });
    });

    socket.on('voice:ice_candidate', ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit('voice:ice_candidate', {
        candidate, fromSocketId: socket.id, fromUserId: socket.userId,
      });
    });

    socket.on('voice:speaking', ({ channelId, speaking }) => {
      socket.to(`voice:${channelId}`).emit('voice:speaking', { userId: socket.userId, speaking });
    });

    socket.on('disconnect', () => leaveAllVoiceChannels(socket, io));
  });
}

function leaveAllVoiceChannels(socket, io) {
  if (!socket.currentVoiceChannel) return;
  const channelId = socket.currentVoiceChannel;
  const channel = voiceChannels.get(channelId);
  if (channel) {
    channel.delete(socket.userId);
    if (channel.size === 0) voiceChannels.delete(channelId);
  }
  socket.leave(`voice:${channelId}`);
  socket.to(`voice:${channelId}`).emit('voice:peer_left', {
    channelId, userId: socket.userId, socketId: socket.id,
  });
  socket.currentVoiceChannel = null;
  broadcastVoiceState(io, channelId);
}

function broadcastVoiceState(io, channelId) {
  const channel = voiceChannels.get(channelId);
  const members = channel ? Array.from(channel.keys()) : [];
  io.emit('voice:channel_state', { channelId, members });
}

export function getVoiceChannelState() {
  const state = {};
  for (const [channelId, members] of voiceChannels.entries()) {
    state[channelId] = Array.from(members.keys());
  }
  return state;
}
