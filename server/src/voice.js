/**
 * WebRTC Voice Signaling via Socket.io
 * Handles offer/answer/ICE candidate relay for WebRTC peer connections.
 * Voice data itself travels peer-to-peer — the server only relays signaling.
 */

// Map of voice channel → Set of user socket IDs
const voiceChannels = new Map();

export function setupVoiceSignaling(io, authenticatedSockets) {
  io.on('connection', (socket) => {
    // --- Join voice channel ---
    socket.on('voice:join', ({ channelId }) => {
      if (!socket.userId) return;

      // Leave any existing voice channel first
      leaveAllVoiceChannels(socket, io);

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
