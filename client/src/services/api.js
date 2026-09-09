const BASE_URL = '/api';

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
  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
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

  // Rooms
  getRooms: () => request('GET', '/rooms'),
  getMembers: (roomId) => request('GET', `/rooms/${roomId}/members`),
  createRoom: (name, description, type) =>
    request('POST', '/rooms', { name, description, type }),
  joinRoom: (roomId) => request('POST', `/rooms/${roomId}/join`),
  leaveRoom: (roomId) => request('DELETE', `/rooms/${roomId}/leave`),
  createDM: (targetUserId) => request('POST', '/rooms/dm', { targetUserId }),
  getAllUsers: () => request('GET', '/rooms/users/all'),

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
