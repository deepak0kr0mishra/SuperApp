import { io } from 'socket.io-client';
import { BACKEND_URL } from '../config.js';

const SERVER_URL = BACKEND_URL;

let socket = null;

export function createSocket(token) {
  if (socket) {
    socket.disconnect();
  }
  socket = io(SERVER_URL, {
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
