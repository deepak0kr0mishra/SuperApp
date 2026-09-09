import { getSocket } from './socket.js';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const ICE_CONFIG = {
  iceServers: STUN_SERVERS,
};

class WebRTCManager {
  constructor() {
    this.peers = new Map(); // userId → { pc, stream }
    this.localStream = null;
    this.currentChannelId = null;
    this.onPeerStream = null;
    this.onPeerDisconnected = null;
    this.onSpeaking = null;
    this.isMuted = false;
    this.audioContext = null;
    this.analyserNodes = new Map();
  }

  async joinVoiceChannel(channelId, callbacks = {}) {
    this.onPeerStream = callbacks.onPeerStream;
    this.onPeerDisconnected = callbacks.onPeerDisconnected;
    this.onSpeaking = callbacks.onSpeaking;

    // Get microphone access
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      throw new Error(`Microphone access denied: ${err.message}`);
    }

    this.currentChannelId = channelId;
    const socket = getSocket();

    // Set up socket listeners for this voice session
    this._setupSocketListeners(socket);

    // Setup audio activity detection
    this._setupSpeakingDetection();

    // Tell server we're joining
    socket.emit('voice:join', { channelId });
  }

  _setupSocketListeners(socket) {
    // Remove old listeners to prevent duplicates
    socket.off('voice:peers');
    socket.off('voice:peer_joined');
    socket.off('voice:peer_left');
    socket.off('voice:offer');
    socket.off('voice:answer');
    socket.off('voice:ice_candidate');

    // Existing peers in channel — initiate offers to each
    socket.on('voice:peers', async ({ peers }) => {
      for (const peer of peers) {
        await this._createOffer(peer.socketId, peer.userId);
      }
    });

    // New peer joined — wait for their offer
    socket.on('voice:peer_joined', async ({ userId, socketId }) => {
      this._createPeerConnection(socketId, userId);
    });

    // Peer left
    socket.on('voice:peer_left', ({ userId, socketId }) => {
      this._removePeer(socketId, userId);
    });

    // Receive offer → send answer
    socket.on('voice:offer', async ({ offer, fromSocketId, fromUserId }) => {
      let pc = this.peers.get(fromSocketId)?.pc;
      if (!pc) {
        pc = this._createPeerConnection(fromSocketId, fromUserId);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('voice:answer', {
        targetSocketId: fromSocketId,
        answer,
        channelId: this.currentChannelId,
      });
    });

    // Receive answer
    socket.on('voice:answer', async ({ answer, fromSocketId }) => {
      const peer = this.peers.get(fromSocketId);
      if (peer?.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    // ICE candidates
    socket.on('voice:ice_candidate', async ({ candidate, fromSocketId }) => {
      const peer = this.peers.get(fromSocketId);
      if (peer?.pc && candidate) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {}
      }
    });
  }

  _createPeerConnection(socketId, userId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        getSocket().emit('voice:ice_candidate', {
          targetSocketId: socketId,
          candidate: event.candidate,
        });
      }
    };

    // Remote stream
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (this.onPeerStream) {
        this.onPeerStream(userId, remoteStream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this._removePeer(socketId, userId);
      }
    };

    this.peers.set(socketId, { pc, userId });
    return pc;
  }

  async _createOffer(targetSocketId, targetUserId) {
    const pc = this._createPeerConnection(targetSocketId, targetUserId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    getSocket().emit('voice:offer', {
      targetSocketId,
      offer,
      channelId: this.currentChannelId,
    });
  }

  _removePeer(socketId, userId) {
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(socketId);
    }
    if (this.onPeerDisconnected) {
      this.onPeerDisconnected(userId);
    }
  }

  _setupSpeakingDetection() {
    if (!this.localStream) return;
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastSpeaking = false;

    const detect = () => {
      if (!this.currentChannelId) return;
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const speaking = avg > 15 && !this.isMuted;

      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        if (this.onSpeaking) this.onSpeaking(speaking);
        getSocket().emit('voice:speaking', {
          channelId: this.currentChannelId,
          speaking,
        });
      }
      requestAnimationFrame(detect);
    };
    detect();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    return this.isMuted;
  }

  leaveVoiceChannel() {
    const socket = getSocket();
    if (socket) {
      socket.emit('voice:leave');
      socket.off('voice:peers');
      socket.off('voice:peer_joined');
      socket.off('voice:peer_left');
      socket.off('voice:offer');
      socket.off('voice:answer');
      socket.off('voice:ice_candidate');
    }

    // Close all peer connections
    this.peers.forEach(({ pc }) => pc.close());
    this.peers.clear();

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.currentChannelId = null;
    this.isMuted = false;
  }
}

export const webRTCManager = new WebRTCManager();
