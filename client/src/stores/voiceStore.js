import { create } from 'zustand';
import { webRTCManager } from '../services/webrtc.js';

export const useVoiceStore = create((set, get) => ({
  currentChannelId: null,
  isMuted: false,
  isConnecting: false,
  voiceMuted: null, // { expires_at, reason } when admin voice-mutes me (listen-only)
  peerStreams: {}, // userId → MediaStream
  speakingUsers: new Set(), // Set of userIds currently speaking
  voiceChannelMembers: {}, // channelId → [userId]
  error: null,

  joinVoiceChannel: async (channelId) => {
    const { currentChannelId } = get();
    if (currentChannelId === channelId) return;
    if (currentChannelId) {
      get().leaveVoiceChannel();
    }

    set({ isConnecting: true, error: null, voiceMuted: null });

    try {
      await webRTCManager.joinVoiceChannel(channelId, {
        onPeerStream: (userId, stream) => {
          // Create and play audio element
          const audio = document.createElement('audio');
          audio.srcObject = stream;
          audio.autoplay = true;
          audio.id = `voice-audio-${userId}`;
          document.body.appendChild(audio);

          set(state => ({
            peerStreams: { ...state.peerStreams, [userId]: stream },
          }));
        },
        onPeerDisconnected: (userId) => {
          // Remove audio element
          const audio = document.getElementById(`voice-audio-${userId}`);
          if (audio) audio.remove();

          set(state => {
            const { [userId]: _, ...rest } = state.peerStreams;
            const newSpeaking = new Set(state.speakingUsers);
            newSpeaking.delete(userId);
            return { peerStreams: rest, speakingUsers: newSpeaking };
          });
        },
        onSpeaking: (speaking) => {
          // Speaking detection is handled by the WebRTC manager via socket directly
        },
      });

      set({ currentChannelId: channelId, isConnecting: false });
    } catch (err) {
      set({ isConnecting: false, error: err.message });
    }
  },

  leaveVoiceChannel: () => {
    webRTCManager.leaveVoiceChannel();

    // Remove all audio elements
    const { peerStreams } = get();
    Object.keys(peerStreams).forEach(userId => {
      const audio = document.getElementById(`voice-audio-${userId}`);
      if (audio) audio.remove();
    });

    set({
      currentChannelId: null,
      isMuted: false,
      isConnecting: false,
      voiceMuted: null,
      peerStreams: {},
      speakingUsers: new Set(),
    });
  },

  toggleMute: () => {
    // Admin voice-mute (level 1): listen-only, cannot unmute until expiry/revoke.
    if (get().voiceMuted) return true;
    const muted = webRTCManager.toggleMute();
    set({ isMuted: muted });
    return muted;
  },

  // Server says I am voice-muted: force local mic off + lock it.
  applyVoiceMute: (info) => {
    try {
      if (webRTCManager.localStream && !webRTCManager.isMuted) {
        webRTCManager.toggleMute();
      }
    } catch {}
    set({ voiceMuted: info || { expires_at: 0 }, isMuted: true });
  },

  setPeerSpeaking: (userId, speaking) => set(state => {
    const newSpeaking = new Set(state.speakingUsers);
    if (speaking) newSpeaking.add(userId);
    else newSpeaking.delete(userId);
    return { speakingUsers: newSpeaking };
  }),

  setVoiceChannelMembers: (channelId, members) => set(state => ({
    voiceChannelMembers: { ...state.voiceChannelMembers, [channelId]: members },
  })),

  setAllVoiceState: (state) => {
    const voiceChannelMembers = {};
    for (const [channelId, members] of Object.entries(state)) {
      voiceChannelMembers[channelId] = members;
    }
    set({ voiceChannelMembers });
  },

  clearError: () => set({ error: null }),
}));
