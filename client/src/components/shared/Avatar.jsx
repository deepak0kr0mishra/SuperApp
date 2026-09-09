import React from 'react';

export function Avatar({ name = '?', color = '#6366f1', size = 'md', status, style }) {
  const initial = name ? name[0].toUpperCase() : '?';
  const sizeClass = `avatar avatar-${size}`;
  return (
    <div className={sizeClass} style={{ background: color, ...style }}>
      {initial}
      {status && <span className={`status-dot ${status}`} />}
    </div>
  );
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

export function getFileIcon(mime = '') {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '🗜️';
  if (mime.includes('word') || mime.includes('document')) return '📝';
  if (mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📊';
  if (mime.includes('text')) return '📃';
  return '📁';
}
