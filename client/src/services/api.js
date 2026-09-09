const BASE_URL = import.meta.env.VITE_API_URL || '/api';

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
        'The Pages build is calling /api on GitHub itself. ' +
        'Set the VITE_SERVER_URL repo variable to your Render backend URL and redeploy.'
      );
    }
    throw new Error(`Server returned non-JSON response (status ${res.status}). Is the backend running?`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Warn in console when running on Pages without a backend configured,
// so the cause is obvious in DevTools.
if (
  typeof window !== 'undefined' &&
  window.location.hostname.endsWith('.github.io') &&
  (!import.meta.env.VITE_SERVER_URL || !import.meta.env.VITE_API_URL)
) {
  console.warn(
    '[Nebula] VITE_SERVER_URL / VITE_API_URL missing at build time. ' +
    'Set the VITE_SERVER_URL repository variable and redeploy the Pages workflow.'
  );
}

export const api = {
  // Auth
  register: (username, displayName, password) =>
    request('POST', '/auth/register', { username, display_name: displayName, password }),
  login: (username, password) =>
    request('POST', '/auth/login', { username, password }),
  me: () => request('GET', '/auth/me'),
  uploadPublicKey: (publicKey) =>
    request('PUT', '/auth/public-key', { publicKey: JSON.stringify(publicKey) }),
  updateProfile: (display_name, bio) =>
    request('PUT', '/auth/profile', { display_name, bio }),

  // Users — profile system with unique code search
  getAllUsers: () => request('GET', '/rooms/users/all'),
  searchUsers: (q) => request('GET', `/users/search?q=${encodeURIComponent(q)}`),
  getUser: (id) => request('GET', `/users/${id}`),

  // Admin
  adminStats: () => request('GET', '/admin/stats'),
  adminGetUsers: () => request('GET', '/admin/users'),
  adminSetRole: (id, role) => request('PUT', `/admin/users/${id}/role`, { role }),
  adminDeleteUser: (id) => request('DELETE', `/admin/users/${id}`),
  adminGetRooms: () => request('GET', '/admin/rooms'),
  adminDeleteRoom: (id) => request('DELETE', `/admin/rooms/${id}`),
  adminRecentMessages: () => request('GET', '/admin/messages/recent'),
  adminDeleteMessage: (id) => request('DELETE', `/admin/messages/${id}`),

  // Rooms
  getRooms: () => request('GET', '/rooms'),
  getMembers: (roomId) => request('GET', `/rooms/${roomId}/members`),
  createRoom: (name, description, type) =>
    request('POST', '/rooms', { name, description, type }),
  joinRoom: (roomId) => request('POST', `/rooms/${roomId}/join`),
  leaveRoom: (roomId) => request('DELETE', `/rooms/${roomId}/leave`),
  createDM: (targetUserId) => request('POST', '/rooms/dm', { targetUserId }),

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
