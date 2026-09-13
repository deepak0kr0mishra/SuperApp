import { create } from 'zustand';

// Plain-text chat store (E2E encryption removed).
// `decryptMessage` / `getEncryptionKey` etc. are kept as no-op shims so
// older components keep working during the migration.

export function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content) return msg.content;
  if (typeof msg.encrypted_content === 'string') return msg.encrypted_content;
  return '';
}

// Detect leftover E2E blobs (base64 AES-GCM) so we can label them instead
// of showing gibberish.
export function isLegacyEncryptedBlob(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < 32 || text.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(text);
}

export const useChatStore = create((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messages: {},       // roomId → message[] (oldest-first)
  hasMore: {},        // roomId → bool (older pages available)
  loadingOlder: {},   // roomId → bool
  members: {},        // roomId → member[]
  typingUsers: {},    // roomId → { userId: username }
  userStatuses: {},   // userId → 'online' | 'offline'
  unread: {},         // roomId → count
  allUsers: [],
  voiceChannels: [],
  watch: {},        // roomId → { video_id, url, is_playing, position, ... }
  games: {},        // roomId → { board, turn, status, winner, player_x, player_o }
  myMutes: [],      // my active mutes [{ kind, expires_at, ... }]
  myBlocks: [],     // users I blocked

  setRooms: (rooms) => set((state) => {
    // Preserve server-provided unread counts for rooms we haven't loaded yet.
    const unread = { ...state.unread };
    for (const r of rooms || []) {
      if (typeof r.unread === 'number' && unread[r.id] === undefined) unread[r.id] = r.unread;
    }
    return { rooms, unread };
  }),

  setVoiceChannels: (channels) => set({ voiceChannels: channels || [] }),

  setAllUsers: (users) => set({ allUsers: users }),

  setWatch: (roomId, watch) => set(state => ({
    watch: { ...state.watch, [roomId]: watch },
  })),

  setGame: (roomId, game) => set(state => ({
    games: { ...state.games, [roomId]: game },
  })),

  setMyMutes: (mutes) => set({ myMutes: mutes || [] }),

  setMyBlocks: (blocks) => set({ myBlocks: blocks || [] }),

  setActiveRoom: (roomId) => {
    set({ activeRoomId: roomId });
    set(state => ({ unread: { ...state.unread, [roomId]: 0 } }));
  },

  addRoom: (room) => set(state => ({
    rooms: [...state.rooms.filter(r => r.id !== room.id), room],
  })),

  patchRoom: (roomId, patch) => set(state => ({
    rooms: state.rooms.map(r => (r.id === roomId ? { ...r, ...patch } : r)),
  })),

  setMembers: (roomId, members) => set(state => ({
    members: { ...state.members, [roomId]: members },
  })),

  setMessages: (roomId, messages) => set(state => {
    const normalized = (messages || []).map((m) => ({
      ...m,
      content: messageText(m),
      reactions: m.reactions || [],
    }));
    return {
      messages: { ...state.messages, [roomId]: normalized },
      hasMore: { ...state.hasMore, [roomId]: (messages || []).length >= 50 },
    };
  }),

  // Prepend an older page (infinite scroll up). De-dupes by id.
  prependMessages: (roomId, older) => set(state => {
    const existing = state.messages[roomId] || [];
    const ids = new Set(existing.map(m => m.id));
    const normalized = (older || [])
      .filter(m => !ids.has(m.id))
      .map((m) => ({ ...m, content: messageText(m), reactions: m.reactions || [] }));
    return {
      messages: { ...state.messages, [roomId]: [...normalized, ...existing] },
      hasMore: { ...state.hasMore, [roomId]: (older || []).length >= 50 },
      loadingOlder: { ...state.loadingOlder, [roomId]: false },
    };
  }),

  setLoadingOlder: (roomId, loading) => set(state => ({
    loadingOlder: { ...state.loadingOlder, [roomId]: loading },
  })),

  // Replace a message in place (edits).
  updateMessage: (message) => set(state => {
    const roomMessages = state.messages[message.room_id] || [];
    if (!roomMessages.find(m => m.id === message.id)) {
      // Not loaded yet — treat as new.
      return {};
    }
    const normalized = { ...message, content: messageText(message), reactions: message.reactions || [] };
    return {
      messages: {
        ...state.messages,
        [message.room_id]: roomMessages.map(m => (m.id === message.id ? { ...m, ...normalized } : m)),
      },
    };
  }),

  appendMessage: (message) => set(state => {
    const roomMessages = state.messages[message.room_id] || [];
    if (roomMessages.find(m => m.id === message.id)) return {};
    const normalized = {
      ...message,
      content: messageText(message),
      reactions: message.reactions || [],
    };
    return {
      messages: {
        ...state.messages,
        [message.room_id]: [...roomMessages, normalized],
      },
      unread: {
        ...state.unread,
        [message.room_id]: state.activeRoomId === message.room_id
          ? 0
          : (state.unread[message.room_id] || 0) + 1,
      },
    };
  }),

  // Soft delete: keep the record visible as "This message was deleted."
  deleteMessage: (messageId, roomId) => set(state => ({
    messages: {
      ...state.messages,
      [roomId]: (state.messages[roomId] || []).map(m =>
        m.id === messageId
          ? { ...m, is_deleted: 1, content: 'This message was deleted.', encrypted_content: '' }
          : m
      ),
    },
  })),

  updateReactions: (messageId, reactions) => set(state => {
    const newMessages = {};
    for (const [roomId, msgs] of Object.entries(state.messages)) {
      newMessages[roomId] = msgs.map(m =>
        m.id === messageId ? { ...m, reactions } : m
      );
    }
    return { messages: newMessages };
  }),

  setTyping: (roomId, userId, username, typing) => set(state => {
    const current = { ...(state.typingUsers[roomId] || {}) };
    if (typing) current[userId] = username;
    else delete current[userId];
    return { typingUsers: { ...state.typingUsers, [roomId]: current } };
  }),

  setUserStatus: (userId, status) => set(state => ({
    userStatuses: { ...state.userStatuses, [userId]: status },
  })),

  // --- Selectors ---

  getChannels: () => get().rooms.filter(r => r.type === 'channel'),

  getDMs: () => get().rooms.filter(r => r.type === 'dm'),

  // Resolve the other person in a DM from members (fallback: allUsers,
  // fallback: parse legacy "alice-bob" room names).
  getDMPeer: (room, myUserId) => {
    const { members, allUsers } = get();
    const roomMembers = members[room.id] || [];
    let peer = roomMembers.find(m => m.id !== myUserId) || null;
    if (!peer) {
      const ids = String(room.name || '').split('-');
      const otherName = ids.find(p => p && p !== allUsers.find(u => u.id === myUserId)?.username);
      peer = allUsers.find(u => u.username === otherName) || null;
    }
    return peer;
  },

  getLastMessage: (roomId) => {
    const msgs = get().messages[roomId] || [];
    return msgs.length ? msgs[msgs.length - 1] : null;
  },

  getUnreadCount: (roomId) => get().unread[roomId] || 0,

  clearUnread: (roomId) => set(state => ({ unread: { ...state.unread, [roomId]: 0 } })),

  // --- Legacy crypto shims (no-ops, kept for compat) ---

  encryptMessage: async (text) => text || '',

  decryptMessage: async (ciphertext) => ciphertext || '',

  encryptFileData: async (arrayBuffer) => arrayBuffer,

  decryptFileData: async (arrayBuffer) => arrayBuffer,

  getEncryptionKey: async () => null,
}));
