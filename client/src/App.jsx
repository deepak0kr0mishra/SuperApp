import React, { useEffect } from 'react';
import { useAuthStore } from './stores/authStore.js';
import AuthPage from './components/Auth/AuthPage.jsx';
import ChatPage from './pages/ChatPage.jsx';
import './index.css';

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div style={{
        width: 56,
        height: 56,
        borderRadius: 16,
        background: 'linear-gradient(135deg, #7c6aff 0%, #a855f7 50%, #ec4899 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 28,
        boxShadow: '0 0 30px rgba(124,106,255,0.4)',
        marginBottom: 8,
      }}>
        🔐
      </div>
      <div className="spinner" />
      <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8 }}>
        Initializing encrypted session…
      </div>
    </div>
  );
}

export default function App() {
  const { user, isLoading, initialize } = useAuthStore();

  useEffect(() => {
    initialize();
  }, []);

  if (isLoading) return <LoadingScreen />;
  if (!user) return <AuthPage />;
  return <ChatPage />;
}
