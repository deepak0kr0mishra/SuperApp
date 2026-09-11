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
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { room } = await api.createRoom(name, desc, 'channel');
      onCreated(room);
    } catch (err) {
      setError(err.message || 'Could not create space');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Create Space</div>
          <button id="close-create-room-modal" className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="new-channel-name">Space name</label>
            <input
              id="new-channel-name"
              className="form-input"
              placeholder="e.g. announcements"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              required
              maxLength={40}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="new-channel-desc">Description (optional)</label>
            <input
              id="new-channel-desc"
              className="form-input"
              placeholder="What's this space about?"
              value={desc}
              onChange={e => setDesc(e.target.value)}
              maxLength={120}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <button id="create-channel-submit" className="btn-primary" type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create Space'}
          </button>
        </form>
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

function isNarrowScreen() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches;
}

// --- Main Chat Page ---
export default function ChatPage() {
  const { user } = useAuthStore();
  const {
    setRooms, addRoom, setAllUsers, setActiveRoom, setMembers,
    rooms, activeRoomId,
  } = useChatStore();
  const { toasts } = useToast();

  const [activeTab, setActiveTab] = useState('chats');
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showOwnProfile, setShowOwnProfile] = useState(false);
  const [profileUserId, setProfileUserId] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isNarrowScreen());

  const prevRoomId = useRef(null);

  // Keep drawer in sync when resizing / when a room becomes active on mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const onChange = (e) => setSidebarOpen(!e.matches || !useChatStore.getState().activeRoomId);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !user) return;
    let cancelled = false;

    useAuthStore.getState().refreshMe?.().catch(() => {});
    api.getRooms().then(({ rooms: r }) => {
      if (cancelled) return;
      setRooms(r);
      const current = useChatStore.getState().activeRoomId;
      if (!current && r.length > 0) {
        const dms = r.filter(rm => rm.type === 'dm');
        const first = dms[0] || r.find(rm => rm.type === 'channel') || r[0];
        joinRoomAndFetchMembers(socket, first.id, setMembers, null);
        setActiveRoom(first.id);
        prevRoomId.current = first.id;
        if (first.type === 'channel') setActiveTab('spaces');
        if (isNarrowScreen()) setSidebarOpen(false);
      } else if (current) {
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

  const handleRoomSelect = async (roomId) => {
    const socket = getSocket();
    const room = rooms.find(r => r.id === roomId);
    if (room) setActiveTab(room.type === 'dm' ? 'chats' : 'spaces');
    await joinRoomAndFetchMembers(socket, roomId, setMembers, prevRoomId.current);
    setActiveRoom(roomId);
    prevRoomId.current = roomId;
    if (isNarrowScreen()) setSidebarOpen(false);
  };

  const handleRoomCreated = async (room) => {
    addRoom(room);
    const socket = getSocket();
    socket?.emit('room:created', room);
    setShowCreateRoom(false);
    await joinRoomAndFetchMembers(socket, room.id, setMembers, prevRoomId.current);
    setActiveRoom(room.id);
    prevRoomId.current = room.id;
    setActiveTab('spaces');
    if (isNarrowScreen()) setSidebarOpen(false);
  };

  const openPeerProfile = (peerUserId) => {
    if (!peerUserId) return;
    if (peerUserId === user?.id) setShowOwnProfile(true);
    else setProfileUserId(peerUserId);
  };

  return (
    <div className={`app-layout ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <div className="aurora-bg" aria-hidden="true">
        <span className="aurora-orb orb-1" />
        <span className="aurora-orb orb-2" />
        <span className="aurora-orb orb-3" />
      </div>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onCreateRoom={() => setShowCreateRoom(true)}
        onOpenDM={() => setShowSearch(true)}
        onOpenSearch={() => setShowSearch(true)}
        onOpenProfile={() => setShowOwnProfile(true)}
        onOpenAdmin={() => setShowAdmin(true)}
        onRoomSelect={handleRoomSelect}
      />
      <ChatPanel
        onOpenSearch={() => setShowSearch(true)}
        onOpenProfile={openPeerProfile}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      <MembersPanel />

      {showCreateRoom && (
        <CreateRoomModal onClose={() => setShowCreateRoom(false)} onCreated={handleRoomCreated} />
      )}

      {showSearch && (
        <UserSearch
          onClose={() => setShowSearch(false)}
          onOpenDM={(room) => {
            addRoom(room);
            setActiveRoom(room.id);
            prevRoomId.current = room.id;
            setActiveTab('chats');
            if (isNarrowScreen()) setSidebarOpen(false);
          }}
        />
      )}

      {showOwnProfile && <ProfileModal onClose={() => setShowOwnProfile(false)} />}

      {profileUserId && (
        <ProfileModal
          userId={profileUserId}
          onClose={() => setProfileUserId(null)}
          onStartDM={(room) => {
            prevRoomId.current = room.id;
            setActiveTab('chats');
            if (isNarrowScreen()) setSidebarOpen(false);
          }}
        />
      )}

      {showAdmin && <AdminDashboard onClose={() => setShowAdmin(false)} />}

      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}
