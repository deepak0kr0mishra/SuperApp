import express from 'express';
import { voiceChannelQueries, roomQueries, userQueries, getActiveMute } from './db.js';
import { emitOccupancy } from './rooms.js';
import { authenticateToken } from './auth.js';

// Public REST: list persistent voice channels (admin manages via /api/admin/voice)
// WebRTC Voice Signaling via Socket.io below: offer/answer/ICE relay.
// Voice data itself travels peer-to-peer — the server only relays signaling.
export const voiceRouter = express.Router();
voiceRouter.get('/', authenticateToken, (req, res) => {
  try {
    res.json({ channels: voiceChannelQueries.list.all() });
  } catch {
    res.json({ channels: [] });
  }
});

// Map of voice channel → Set of user socket IDs
const voiceChannels = new Map();

// Number of users currently in a voice call (the ONLY capped count —
// text chat is unlimited, so max_members limits voice seats, not members).
export function getVoiceCount(channelId) {
  try {
    return voiceChannels.get(channelId)?.size ?? 0;
  } catch { return 0; }
}

export function setupVoiceSignaling(io, authenticatedSockets) {
  io.on('connection', (socket) => {
    // --- Join voice channel ---
    socket.on('voice:join', ({ channelId }) => {
      if (!socket.userId) return;

      // Voice-only capacity: max_members caps CALL participants (admins bypass).
      // Text membership is unlimited and never blocks a call join.
      try {
        const room = roomQueries.findById.get(channelId);
        if (room && room.type === 'channel' && room.max_members != null) {
          const me = userQueries.findById.get(socket.userId);
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

      // Leave any existing voice channel first
      leaveAllVoiceChannels(socket, io);

      // Joining voice also joins the text room (always allowed — unlimited).
      try { roomQueries.addMember.run(channelId, socket.userId); } catch {}
      emitOccupancy(channelId, io);

      if (!voiceChannels.has(channelId)) {
        voiceChannels.set(channelId, new Map());
      }

      const channel = voiceChannels.get(channelId);
      const existingPeers = Array.from(channel.keys());

      // Add this user to the channel
      channel.set(socket.userId, socket.id);
      socket.currentVoiceChannel = channelId;
      socket.join(`voice:${channelId}`);

      // Tell the new user who's already in the channel
      socket.emit('voice:peers', {
        channelId,
        peers: existingPeers.map(uid => ({
          userId: uid,
          socketId: channel.get(uid),
        })),
      });

      // Voice-mute (level 1): join OK but stay listen-only until expiry/revoke.
      try {
        const vm = getActiveMute(socket.userId, 'voice');
        if (vm) {
          socket.emit('voice:muted', {
            channelId,
            kind: 'voice',
            expires_at: vm.expires_at,
            reason: vm.reason || '',
          });
        }
      } catch {}

      // Tell existing peers about the new user
      socket.to(`voice:${channelId}`).emit('voice:peer_joined', {
        channelId,
        userId: socket.userId,
        socketId: socket.id,
      });

      // Broadcast updated voice channel state to all in text rooms
      broadcastVoiceState(io, channelId);
    });

    // --- Leave voice channel ---
    socket.on('voice:leave', () => {
      leaveAllVoiceChannels(socket, io);
    });

    // --- WebRTC offer ---
    socket.on('voice:offer', ({ targetSocketId, offer, channelId }) => {
      io.to(targetSocketId).emit('voice:offer', {
        offer,
        channelId,
        fromSocketId: socket.id,
        fromUserId: socket.userId,
      });
    });

    // --- WebRTC answer ---
    socket.on('voice:answer', ({ targetSocketId, answer, channelId }) => {
      io.to(targetSocketId).emit('voice:answer', {
        answer,
        channelId,
        fromSocketId: socket.id,
        fromUserId: socket.userId,
      });
    });

    // --- ICE candidate ---
    socket.on('voice:ice_candidate', ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit('voice:ice_candidate', {
        candidate,
        fromSocketId: socket.id,
        fromUserId: socket.userId,
      });
    });

    // --- Speaking indicator ---
    socket.on('voice:speaking', ({ channelId, speaking }) => {
      socket.to(`voice:${channelId}`).emit('voice:speaking', {
        userId: socket.userId,
        speaking,
      });
    });

    // --- Disconnect cleanup ---
    socket.on('disconnect', () => {
      leaveAllVoiceChannels(socket, io);
    });
  });
}

function leaveAllVoiceChannels(socket, io) {
  if (!socket.currentVoiceChannel) return;
  const channelId = socket.currentVoiceChannel;
  const channel = voiceChannels.get(channelId);

  if (channel) {
    channel.delete(socket.userId);
    if (channel.size === 0) {
      voiceChannels.delete(channelId);
    }
  }

  socket.leave(`voice:${channelId}`);
  socket.to(`voice:${channelId}`).emit('voice:peer_left', {
    channelId,
    userId: socket.userId,
    socketId: socket.id,
  });

  socket.currentVoiceChannel = null;
  broadcastVoiceState(io, channelId);
  // Text membership is sticky — hanging up never removes the member row.
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
