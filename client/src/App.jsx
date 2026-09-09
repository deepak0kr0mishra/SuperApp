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
        borderRadius: 18,
        background: 'linear-gradient(135deg, #22d3ee 0%, #8b5cf6 50%, #ec4899 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 28,
        boxShadow: '0 0 30px rgba(139,92,246,0.5)',
        marginBottom: 8,
      }}>
        🌌
      </div>
      <div className="spinner" />
      <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8 }}>
        Aligning to Nebula orbit…
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
