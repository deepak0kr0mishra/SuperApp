import { create } from 'zustand';
import { api } from '../services/api.js';
import { createSocket, disconnectSocket } from '../services/socket.js';

// Auth store — E2E keypair removed. `keyPair` stays as null shim so old
// components that read it don't crash.
export const useAuthStore = create((set, get) => ({
  user: null,
  token: localStorage.getItem('sc_token'),
  isLoading: true,
  error: null,
  keyPair: null,

  initialize: async () => {
    const token = localStorage.getItem('sc_token');
    if (!token) {
      set({ isLoading: false });
      return;
    }
    try {
      const { user } = await api.me();
      const socket = createSocket(token);
      set({ user, token, keyPair: null, isLoading: false });
      return { user, socket };
    } catch {
      localStorage.removeItem('sc_token');
      set({ user: null, token: null, isLoading: false });
    }
  },

  register: async (username, displayName, password) => {
    set({ error: null });
    try {
      const { token, user } = await api.register(username, displayName, password);
      localStorage.setItem('sc_token', token);
      const socket = createSocket(token);
      set({ user, token, keyPair: null });
      return { user, socket };
    } catch (err) {
      set({ error: err.message });
      throw err;
    }
  },

  login: async (username, password) => {
    set({ error: null });
    try {
      const { token, user } = await api.login(username, password);
      localStorage.setItem('sc_token', token);
      const socket = createSocket(token);
      set({ user, token, keyPair: null });
      return { user, socket };
    } catch (err) {
      set({ error: err.message });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('sc_token');
    disconnectSocket();
    set({ user: null, token: null, keyPair: null });
  },

  updateProfile: async (display_name, bio) => {
    const { user } = await api.updateProfile(display_name, bio);
    set({ user });
    return user;
  },

  refreshMe: async () => {
    try {
      const { user } = await api.me();
      set({ user });
      return user;
    } catch { return null; }
  },

  clearError: () => set({ error: null }),
}));
