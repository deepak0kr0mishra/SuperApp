import React, { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { getSocket } from '../services/socket.js';
import { api } from '../services/api.js';
import Sidebar from '../components/Sidebar/Sidebar.jsx';
import ChatPanel from '../components/Chat/ChatPanel.jsx';
import MembersPanel from '../components/Voice/MembersPanel.jsx';
import UserSearch from '../components/Chat/UserSearch.jsx';
import ProfileModal from '../components/Profile/ProfileModal.jsx';
import AdminDashboard from '../components/Admin/AdminDashboard.jsx';

// --- Create Channel Modal ---
function CreateRoomModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const { room } = await api.createRoom(name, desc, 'channel');
      onCreated(room);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Create Channel</div>
          <button id="close-create-room-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="new-channel-name">Channel Name</label>
            <input
              id="new-channel-name"
              className="form-input"
              placeholder="e.g. announcements"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-channel-desc">Description (optional)</label>
            <input
              id="new-channel-desc"
              className="form-input"
              placeholder="What's this channel about?"
              value={desc}
              onChange={e => setDesc(e.target.value)}
            />
          </div>
          <button id="create-channel-submit" className="btn-primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create Channel'}
          </button>
        </form>
      </div>
    </div>
  );
}

// --- New DM Modal (quick path — full search in UserSearch) ---
function NewDMModal({ allUsers, currentUser, onClose, onDMCreated }) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const q = search.trim().toLowerCase();
  const filtered = allUsers.filter(u => {
    if (u.id === currentUser?.id) return false;
    if (!q) return true;
    return (
      u.username.toLowerCase().includes(q) ||
      (u.display_name || '').toLowerCase().includes(q) ||
      (u.user_code || '').toLowerCase().includes(q)
    );
  });

  const handleSelect = async (targetUser) => {
    setLoading(true);
    try {
      const { room } = await api.createDM(targetUser.id);
      onDMCreated(room);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">New Direct Message</div>
          <button id="close-dm-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <input
          id="dm-search-input"
          className="form-input"
          placeholder="Search by name or #code (e.g. HPUQG2)…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
          style={{ marginBottom: 12 }}
        />
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {filtered.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
              No users found
            </div>
          )}
          {filtered.map(u => (
            <div
              key={u.id}
              id={`dm-user-${u.id}`}
              className="member-row"
              style={{ cursor: 'pointer' }}
              onClick={() => !loading && handleSelect(u)}
            >
              <div className="avatar avatar-sm" style={{ background: u.avatar_color || '#6366f1' }}>
                {(u.display_name || u.username)[0].toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {u.display_name || u.username}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{u.username} {u.user_code ? `• #${u.user_code}` : ''}</div>
              </div>
              {u.user_code && (
                <span className="code-chip">#{u.user_code}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Toast system ---
function useToast() {
  const [toasts, setToasts] = useState([]);
  const addToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };
  return { toasts, addToast };
}

// --- Utility: join room and fetch members ---
async function joinRoomAndFetchMembers(socket, roomId, setMembers, previousRoomId) {
  if (previousRoomId && previousRoomId !== roomId) {
    socket?.emit('room:leave', { roomId: previousRoomId });
  }
  socket?.emit('room:join', { roomId });
  try {
    const { members } = await api.getMembers(roomId);
    setMembers(roomId, members);
  } catch (err) {
    console.error('Failed to fetch members:', err);
  }
}

// --- Main Chat Page ---
export default function ChatPage() {
  const { user } = useAuthStore();
  const {
    setRooms, addRoom, setAllUsers, setActiveRoom, setMembers,
    appendMessage, deleteMessage, updateReactions,
    setTyping, setUserStatus, rooms, activeRoomId,
  } = useChatStore();
  const { setVoiceChannelMembers, setAllVoiceState, setPeerSpeaking } = useVoiceStore();
  const { toasts } = useToast();

  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showDM, setShowDM] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const allUsers = useChatStore(s => s.allUsers);

  const prevRoomId = useRef(null);

  // FIX: Proper socket wiring — no stale socketBound guard (broke under StrictMode).
  // Re-subscribes cleanly on user change / remount.
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !user) return;

    let cancelled = false;

    // Initial data load — channels (general/media/random/audio) + users
    // Refresh own profile too (gets user_code / role for sessions created before upgrade)
    useAuthStore.getState().refreshMe?.().catch(() => {});
    api.getRooms().then(({ rooms: r }) => {
      if (cancelled) return;
      setRooms(r);
      // Auto-join first channel if none active
      const current = useChatStore.getState().activeRoomId;
      if (!current && r.length > 0) {
        const first = r.find(rm => rm.type === 'channel') || r[0];
        joinRoomAndFetchMembers(socket, first.id, setMembers, null);
        setActiveRoom(first.id);
        prevRoomId.current = first.id;
      } else if (current) {
        // Re-join active room after reconnect/remount to restore history
        joinRoomAndFetchMembers(socket, current, setMembers, null);
        prevRoomId.current = current;
      }
    }).catch(err => console.error('getRooms failed:', err));
    api.getAllUsers().then(({ users }) => { if (!cancelled) setAllUsers(users); })
      .catch(err => console.error('getAllUsers failed:', err));

    const onHistory = ({ roomId, messages }) => {
      useChatStore.getState().setMessages(roomId, messages);
    };
    const onNew = (message) => useChatStore.getState().appendMessage(message);
    const onDeleted = ({ messageId, roomId }) => useChatStore.getState().deleteMessage(messageId, roomId);
    const onReactions = ({ messageId, reactions }) => useChatStore.getState().updateReactions(messageId, reactions);
    const onTyping = ({ userId, username, roomId, typing }) => useChatStore.getState().setTyping(roomId, userId, username, typing);
    const onStatus = ({ userId, status }) => {
      useChatStore.getState().setUserStatus(userId, status);
      // Keep allUsers status in sync for voice lists / search
      const users = useChatStore.getState().allUsers.map(u => u.id === userId ? { ...u, status } : u);
      useChatStore.getState().setAllUsers(users);
    };
    const onRoomNew = (room) => useChatStore.getState().addRoom(room);
    const onVoiceInit = (state) => useVoiceStore.getState().setAllVoiceState(state);
    const onVoiceState = ({ channelId, members }) => useVoiceStore.getState().setVoiceChannelMembers(channelId, members);
    const onSpeaking = ({ userId, speaking }) => useVoiceStore.getState().setPeerSpeaking(userId, speaking);

    socket.on('messages:history', onHistory);
    socket.on('message:new', onNew);
    socket.on('message:deleted', onDeleted);
    socket.on('message:reactions_update', onReactions);
    socket.on('typing:update', onTyping);
    socket.on('user:status', onStatus);
    socket.on('room:new', onRoomNew);
    socket.on('voice:initial_state', onVoiceInit);
    socket.on('voice:channel_state', onVoiceState);
    socket.on('voice:speaking', onSpeaking);

    return () => {
      cancelled = true;
      socket.off('messages:history', onHistory);
      socket.off('message:new', onNew);
      socket.off('message:deleted', onDeleted);
      socket.off('message:reactions_update', onReactions);
      socket.off('typing:update', onTyping);
      socket.off('user:status', onStatus);
      socket.off('room:new', onRoomNew);
      socket.off('voice:initial_state', onVoiceInit);
      socket.off('voice:channel_state', onVoiceState);
      socket.off('voice:speaking', onSpeaking);
    };
  }, [user?.id]);

  // Handle room switch from sidebar — emit room:join + fetch members
  const handleRoomSelect = async (roomId) => {
    const socket = getSocket();
    await joinRoomAndFetchMembers(socket, roomId, setMembers, prevRoomId.current);
    setActiveRoom(roomId);
    prevRoomId.current = roomId;
  };

  const handleRoomCreated = async (room) => {
    addRoom(room);
    const socket = getSocket();
    socket?.emit('room:created', room);
    setShowCreateRoom(false);
    await joinRoomAndFetchMembers(socket, room.id, setMembers, prevRoomId.current);
    setActiveRoom(room.id);
    prevRoomId.current = room.id;
  };

  const handleDMCreated = async (room) => {
    addRoom(room);
    setShowDM(false);
    const socket = getSocket();
    await joinRoomAndFetchMembers(socket, room.id, setMembers, prevRoomId.current);
    setActiveRoom(room.id);
    prevRoomId.current = room.id;
  };

  return (
    <div className="app-layout">
      <div className="aurora-bg" aria-hidden="true">
        <span className="aurora-orb orb-1" />
        <span className="aurora-orb orb-2" />
        <span className="aurora-orb orb-3" />
      </div>
      <Sidebar
        onCreateRoom={() => setShowCreateRoom(true)}
        onOpenDM={() => setShowDM(true)}
        onOpenSearch={() => setShowSearch(true)}
        onOpenProfile={() => setShowProfile(true)}
        onOpenAdmin={() => setShowAdmin(true)}
        onRoomSelect={handleRoomSelect}
      />
      <ChatPanel onOpenSearch={() => setShowSearch(true)} />
      <MembersPanel />

      {showCreateRoom && (
        <CreateRoomModal
          onClose={() => setShowCreateRoom(false)}
          onCreated={handleRoomCreated}
        />
      )}

      {showDM && (
        <NewDMModal
          allUsers={allUsers}
          currentUser={user}
          onClose={() => setShowDM(false)}
          onDMCreated={handleDMCreated}
        />
      )}

      {showSearch && (
        <UserSearch
          onClose={() => setShowSearch(false)}
          onOpenDM={(room) => {
            addRoom(room);
            setActiveRoom(room.id);
            prevRoomId.current = room.id;
          }}
        />
      )}

      {showProfile && (
        <ProfileModal onClose={() => setShowProfile(false)} />
      )}

      {showAdmin && (
        <AdminDashboard onClose={() => setShowAdmin(false)} />
      )}

      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'success' && '✅'}
            {t.type === 'error' && '❌'}
            {t.type === 'info' && 'ℹ️'}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
