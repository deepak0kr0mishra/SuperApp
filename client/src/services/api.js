import { API_URL, LIVE_BACKEND_CONFIGURED } from '../config.js';

const BASE_URL = API_URL;

function getHeaders(isFormData = false) {
  const token = localStorage.getItem('sc_token');
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';
  return headers;
}

async function request(method, path, body = null, isFormData = false) {
  const options = {
    method,
    headers: getHeaders(isFormData),
  };
  if (body) {
    options.body = isFormData ? body : JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, options);
  } catch (err) {
    throw new Error('Cannot reach backend. Is the server running? (' + err.message + ')');
  }
  const contentType = res.headers.get('content-type') || '';
  // GitHub Pages serves HTML for unknown paths — that means VITE_SERVER_URL
  // was not set at build time and the app fell back to same-origin /api.
  if (!contentType.includes('application/json')) {
    const preview = (await res.text()).slice(0, 80);
    if (preview.includes('<html') || preview.includes('<!DOCTYPE')) {
      throw new Error(
        'Backend not reachable (got HTML instead of JSON). ' +
        'The live backend URL is missing or wrong — check the URL in client/src/config.js, then redeploy.'
      );
    }
    throw new Error(`Server returned non-JSON response (status ${res.status}). Is the backend running?`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Warn in console when running on the live site without a backend configured,
// so the cause is obvious in DevTools.
if (typeof window !== 'undefined' && !LIVE_BACKEND_CONFIGURED) {
  console.warn(
    '[TeaChat] Live backend URL not configured. ' +
    'Paste your backend URL into client/src/config.js and redeploy.'
  );
}

export const api = {
  // Auth
  register: (username, displayName, password, email) =>
    request('POST', '/auth/register', { username, display_name: displayName, password, email }),
  login: (login, password) =>
    request('POST', '/auth/login', { login, username: login, password }),
  logout: () => request('POST', '/auth/logout'),
  me: () => request('GET', '/auth/me'),
  uploadPublicKey: (publicKey) =>
    request('PUT', '/auth/public-key', { publicKey: JSON.stringify(publicKey) }),
  updateProfile: (display_name, bio) =>
    request('PUT', '/auth/profile', { display_name, bio }),
  changePassword: (currentPassword, newPassword) =>
    request('PUT', '/auth/password', { currentPassword, newPassword }),

  // Users — profile system with unique code search
  getAllUsers: () => request('GET', '/rooms/users/all'),
  searchUsers: (q) => request('GET', `/users/search?q=${encodeURIComponent(q)}`),
  getUser: (id) => request('GET', `/users/${id}`),

  // Admin
  adminStats: () => request('GET', '/admin/stats'),
  adminGetUsers: (q) => request('GET', q ? `/admin/users?q=${encodeURIComponent(q)}` : '/admin/users'),
  adminSetRole: (id, role) => request('PUT', `/admin/users/${id}/role`, { role }),
  adminPatchUser: (id, patch) => request('PATCH', `/admin/users/${id}`, patch),
  adminDisableUser: (id) => request('POST', `/admin/users/${id}/disable`),
  adminEnableUser: (id) => request('POST', `/admin/users/${id}/enable`),
  adminResetPassword: (id, newPassword) => request('POST', `/admin/users/${id}/reset-password`, { newPassword }),
  adminDeleteUser: (id) => request('DELETE', `/admin/users/${id}`),
  adminGetRooms: () => request('GET', '/admin/rooms'),
  adminCreateRoom: (name, description) => request('POST', '/admin/rooms', { name, description }),
  adminRenameRoom: (id, patch) => request('PATCH', `/admin/rooms/${id}`, patch),
  adminDeleteRoom: (id) => request('DELETE', `/admin/rooms/${id}`),
  adminRecentMessages: (q) => request('GET', q ? `/admin/messages/recent?q=${encodeURIComponent(q)}` : '/admin/messages/recent'),
  adminDeleteMessage: (id) => request('DELETE', `/admin/messages/${id}`),
  adminGetReports: () => request('GET', '/admin/reports'),
  adminResolveReport: (id, action) => request('POST', `/admin/reports/${id}`, { action }),
  adminBackup: () => request('GET', '/admin/backup'),
  adminRestore: (backup) => request('POST', '/admin/restore', { backup }),
  adminGetVoice: () => request('GET', '/admin/voice'),
  adminCreateVoice: (name, description) => request('POST', '/admin/voice', { name, description }),
  adminRenameVoice: (id, patch) => request('PATCH', `/admin/voice/${id}`, patch),
  adminDeleteVoice: (id) => request('DELETE', `/admin/voice/${id}`),

  // Rooms
  getRooms: () => request('GET', '/rooms'),
  getMembers: (roomId) => request('GET', `/rooms/${roomId}/members`),
  getMessages: (roomId, { before = 0, limit = 50 } = {}) =>
    request('GET', `/rooms/${roomId}/messages?before=${before}&limit=${limit}`),
  markRead: (roomId) => request('POST', `/rooms/${roomId}/read`),
  createRoom: (name, description, type) =>
    request('POST', '/rooms', { name, description, type }),
  joinRoom: (roomId) => request('POST', `/rooms/${roomId}/join`),
  leaveRoom: (roomId) => request('DELETE', `/rooms/${roomId}/leave`),
  createDM: (targetUserId) => request('POST', '/rooms/dm', { targetUserId }),

  // Messages (REST mirror of socket events)
  editMessage: (id, content) => request('PATCH', `/messages/${id}`, { content }),
  deleteMessage: (id) => request('DELETE', `/messages/${id}`),

  // Reports
  report: (payload) => request('POST', '/reports', payload),

  // Voice channels (persistent list)
  getVoiceChannels: () => request('GET', '/voice'),

  // Files
  uploadFile: async (file, roomId, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('roomId', roomId);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE_URL}/files/upload`);

      const token = localStorage.getItem('sc_token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || 'Upload failed'));
        } catch { reject(new Error('Upload failed')); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });
  },

  getFileUrl: (fileId) => `${BASE_URL}/files/${fileId}?token=${localStorage.getItem('sc_token')}`,
};
