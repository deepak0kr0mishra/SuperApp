import { create } from 'zustand';
import { getKeyForRoom, encryptText, decryptText, encryptFile, decryptFile } from '../crypto/e2e.js';

export const useChatStore = create((set, get) => ({
  rooms: [],
  activeRoomId: null,
  messages: {},       // roomId → message[]
  members: {},        // roomId → member[]
  typingUsers: {},    // roomId → { userId: username }
  userStatuses: {},   // userId → 'online' | 'offline'
  unread: {},         // roomId → count
  allUsers: [],

  setRooms: (rooms) => set({ rooms }),

  setAllUsers: (users) => set({ allUsers: users }),

  // FIX: only set activeRoomId (removed spurious activeRoom key)
  setActiveRoom: (roomId) => {
    set({ activeRoomId: roomId });
    set(state => ({ unread: { ...state.unread, [roomId]: 0 } }));
  },

  addRoom: (room) => set(state => ({
    rooms: [...state.rooms.filter(r => r.id !== room.id), room],
  })),

  setMembers: (roomId, members) => set(state => ({
    members: { ...state.members, [roomId]: members },
  })),

  setMessages: (roomId, messages) => set(state => ({
    messages: { ...state.messages, [roomId]: messages },
  })),

  appendMessage: (message) => set(state => {
    const roomMessages = state.messages[message.room_id] || [];
    if (roomMessages.find(m => m.id === message.id)) return {};
    return {
      messages: {
        ...state.messages,
        [message.room_id]: [...roomMessages, message],
      },
      unread: {
        ...state.unread,
        [message.room_id]: state.activeRoomId === message.room_id
          ? 0
          : (state.unread[message.room_id] || 0) + 1,
      },
    };
  }),

  deleteMessage: (messageId, roomId) => set(state => ({
    messages: {
      ...state.messages,
      [roomId]: (state.messages[roomId] || []).filter(m => m.id !== messageId),
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

  // --- Crypto helpers ---

  // FIX: pass real myUserId; await encryptText properly
  encryptMessage: async (text, roomId, keyPair, myUserId) => {
    const { members, rooms } = get();
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    const key = await getKeyForRoom(
      roomId,
      room?.type || 'channel',
      keyPair.privateKey,
      roomMembers,
      myUserId
    );
    return await encryptText(text, key);
  },

  decryptMessage: async (encryptedContent, roomId, keyPair, myUserId) => {
    if (!encryptedContent) return '';
    const { members, rooms } = get();
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    try {
      const key = await getKeyForRoom(
        roomId,
        room?.type || 'channel',
        keyPair.privateKey,
        roomMembers,
        myUserId
      );
      return await decryptText(encryptedContent, key);
    } catch {
      return '[🔒 Unable to decrypt]';
    }
  },

  encryptFileData: async (arrayBuffer, roomId, keyPair, myUserId) => {
    const { members, rooms } = get();
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    const key = await getKeyForRoom(
      roomId, room?.type || 'channel',
      keyPair.privateKey, roomMembers, myUserId
    );
    return encryptFile(arrayBuffer, key);
  },

  decryptFileData: async (arrayBuffer, roomId, keyPair, myUserId) => {
    const { members, rooms } = get();
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    const key = await getKeyForRoom(
      roomId, room?.type || 'channel',
      keyPair.privateKey, roomMembers, myUserId
    );
    return decryptFile(arrayBuffer, key);
  },

  // Helper used by MessageInput directly
  getEncryptionKey: async (roomId, keyPair, myUserId) => {
    const { members, rooms } = get();
    const room = rooms.find(r => r.id === roomId);
    const roomMembers = members[roomId] || [];
    return getKeyForRoom(
      roomId, room?.type || 'channel',
      keyPair.privateKey, roomMembers, myUserId
    );
  },
}));
