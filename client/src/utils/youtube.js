// Shared YouTube helpers (client mirrors server/src/db.js extractYouTubeId).

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return '';
  const s = input.trim();
  if (ID_RE.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split(/[?#/]/)[0];
      return ID_RE.test(id) ? id : '';
    }
    if (host.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v && ID_RE.test(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex((p) => ['embed', 'shorts', 'live'].includes(p));
      if (idx >= 0 && parts[idx + 1] && ID_RE.test(parts[idx + 1])) return parts[idx + 1];
    }
  } catch {}
  return '';
}

// First YouTube video id found anywhere inside free text (chat messages).
export function findYouTubeId(text) {
  if (!text || typeof text !== 'string') return '';
  // Fast path: raw 11-char id on its own is ambiguous — only match URLs here.
  const urlRe = /https?:\/\/[^\s]+/g;
  const urls = text.match(urlRe) || [];
  for (const u of urls) {
    const id = extractYouTubeId(u.replace(/[),.;!?]+$/, ''));
    if (id) return id;
  }
  return '';
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
