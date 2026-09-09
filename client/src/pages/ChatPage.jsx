import React, { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { getSocket } from '../services/socket.js';
import { api } from '../services/api.js';
import Sidebar from '../components/Sidebar/Sidebar.jsx';
import ChatPanel from '../components/Chat/ChatPanel.jsx';
import MembersPanel from '../components/Voice/MembersPanel.jsx';

// Modal for creating a room
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

// Modal for starting a DM
function NewDMModal({ allUsers, currentUser, onClose, onDMCreated }) {
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const filtered = allUsers.filter(u =>
    u.id !== currentUser?.id &&
    (u.username.toLowerCase().includes(search.toLowerCase()) ||
      u.display_name?.toLowerCase().includes(search.toLowerCase()))
  );

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
          placeholder="Search users…"
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
              <div
                className="avatar avatar-sm"
                style={{ background: u.avatar_color || '#6366f1' }}
              >
                {(u.display_name || u.username)[0].toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {u.display_name || u.username}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>@{u.username}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Toast system
function useToast() {
  const [toasts, setToasts] = useState([]);

  const addToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  return { toasts, addToast };
}

export default function ChatPage() {
  const { user, keyPair } = useAuthStore();
  const {
    setRooms, addRoom, setAllUsers, setActiveRoom,
    appendMessage, deleteMessage, updateReactions,
    setTyping, setUserStatus, setMembers, rooms,
  } = useChatStore();
  const { setVoiceChannelMembers, setAllVoiceState, setPeerSpeaking } = useVoiceStore();
  const { toasts, addToast } = useToast();

  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showDM, setShowDM] = useState(false);
  const allUsers = useChatStore(s => s.allUsers);

  const socketBound = useRef(false);

  useEffect(() => {
    if (socketBound.current) return;
    const socket = getSocket();
    if (!socket || !user) return;
    socketBound.current = true;

    // Load rooms
    api.getRooms().then(({ rooms }) => setRooms(rooms));
    api.getAllUsers().then(({ users }) => setAllUsers(users));

    // Socket event handlers
    socket.on('messages:history', ({ roomId, messages }) => {
      useChatStore.getState().setMessages(roomId, messages);
    });

    socket.on('message:new', (message) => {
      appendMessage(message);
    });

    socket.on('message:deleted', ({ messageId, roomId }) => {
      deleteMessage(messageId, roomId);
    });

    socket.on('message:reactions_update', ({ messageId, reactions }) => {
      updateReactions(messageId, reactions);
    });

    socket.on('typing:update', ({ userId, username, roomId, typing }) => {
      setTyping(roomId, userId, username, typing);
    });

    socket.on('user:status', ({ userId, status }) => {
      setUserStatus(userId, status);
    });

    socket.on('room:new', (room) => {
      addRoom(room);
    });

    // Voice events
    socket.on('voice:initial_state', (state) => {
      setAllVoiceState(state);
    });

    socket.on('voice:channel_state', ({ channelId, members }) => {
      setVoiceChannelMembers(channelId, members);
    });

    socket.on('voice:speaking', ({ userId, speaking }) => {
      setPeerSpeaking(userId, speaking);
    });

    socket.on('connect_error', (err) => {
      console.error('Socket error:', err.message);
    });

    return () => {
      socket.off('messages:history');
      socket.off('message:new');
      socket.off('message:deleted');
      socket.off('message:reactions_update');
      socket.off('typing:update');
      socket.off('user:status');
      socket.off('room:new');
      socket.off('voice:initial_state');
      socket.off('voice:channel_state');
      socket.off('voice:speaking');
    };
  }, [user]);

  const handleRoomCreated = (room) => {
    addRoom(room);
    const socket = getSocket();
    socket?.emit('room:created', room);
    setShowCreateRoom(false);
    // Join the new room
    socket?.emit('room:join', { roomId: room.id });
    setActiveRoom(room.id);
  };

  const handleDMCreated = (room) => {
    addRoom(room);
    setShowDM(false);
    const socket = getSocket();
    socket?.emit('room:join', { roomId: room.id });
    setActiveRoom(room.id);
  };

  return (
    <div className="app-layout">
      <Sidebar
        onCreateRoom={() => setShowCreateRoom(true)}
        onOpenDM={() => setShowDM(true)}
      />
      <ChatPanel />
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
