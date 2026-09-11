import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR can be overridden on Render via env var pointing at the mounted disk.
// Locally defaults to <repo-root>/data (i.e. server/src/../../data).
export const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'securechat.db'));

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const MESSAGE_MAX_LENGTH = 2000;

// --- Base schema (kept compatible with existing DBs) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    public_key TEXT,
    avatar_color TEXT NOT NULL DEFAULT '#6366f1',
    status TEXT NOT NULL DEFAULT 'offline',
    user_code TEXT UNIQUE,
    bio TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT NOT NULL DEFAULT 'channel',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    encrypted_content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    file_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT,
    reply_to TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    edited_at INTEGER,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (uploader_id) REFERENCES users(id),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

  -- New tables for the rebuild (safe to run on existing DBs) --
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    target_user_id TEXT,
    message_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER,
    resolved_by TEXT,
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS room_reads (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS voice_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// --- Lightweight migrations for existing DBs ---
try { db.exec(`ALTER TABLE users ADD COLUMN user_code TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN uid TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN content TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN updated_at INTEGER`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN deleted_at INTEGER`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(user_code)`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid)`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, user_code)`); } catch {}

// Seed default channels if not exist
const seedRooms = () => {
  const existing = db.prepare('SELECT COUNT(*) as count FROM rooms').get();
  if (existing.count > 0) return;

  const systemId = 'system';
  // Insert a system user for seeding
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, display_name, password_hash, avatar_color)
    VALUES (?, 'system', 'System', 'N/A', '#6366f1')
  `).run(systemId);

  const channels = [
    { id: 'general', name: 'general', description: 'General chat for everyone' },
    { id: 'media', name: 'media', description: 'Share photos, videos, and files' },
    { id: 'audio', name: 'audio', description: 'Share music and audio clips' },
    { id: 'random', name: 'random', description: 'Off-topic conversations' },
  ];

  const insertRoom = db.prepare(
    'INSERT OR IGNORE INTO rooms (id, name, description, type, created_by) VALUES (?, ?, ?, ?, ?)'
  );
  for (const ch of channels) {
    insertRoom.run(ch.id, ch.name, ch.description, 'channel', systemId);
  }
};

seedRooms();

// Seed default voice channels (persistent list; signaling stays dynamic)
const seedVoice = () => {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM voice_channels').get();
    if (count.c > 0) return;
    const ins = db.prepare(
      'INSERT OR IGNORE INTO voice_channels (id, name, description, created_by) VALUES (?, ?, ?, ?)'
    );
    ins.run('voice-general', 'General', 'General voice hangout', 'system');
    ins.run('voice-gaming', 'Gaming', 'Gaming voice channel', 'system');
    ins.run('voice-study', 'Study Room', 'Quiet study room', 'system');
  } catch {}
};
seedVoice();

// Backfill missing user_code / role for existing users
function generateUserCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Permanent 8-char UID, e.g. 8F42K9X1 — never changes, even if username does.
export function generateUID() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function uniqueUID() {
  for (let i = 0; i < 20; i++) {
    const candidate = generateUID();
    const hit = db.prepare('SELECT 1 FROM users WHERE uid = ? OR user_code = ?').get(candidate, candidate);
    if (!hit) return candidate;
  }
  return generateUID() + Date.now().toString(36).slice(-2).toUpperCase();
}

const backfillUsers = () => {
  const withoutCode = db.prepare(`SELECT id FROM users WHERE user_code IS NULL`).all();
  const insertCode = db.prepare(`UPDATE users SET user_code = ? WHERE id = ?`);
  for (const u of withoutCode) {
    // ensure uniqueness with retries
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        insertCode.run(generateUserCode(), u.id);
        break;
      } catch {}
    }
  }
  // Backfill permanent UID: reuse user_code where possible, else generate 8-char.
  try {
    const withoutUid = db.prepare(`SELECT id, user_code FROM users WHERE uid IS NULL`).all();
    const setUid = db.prepare(`UPDATE users SET uid = ? WHERE id = ?`);
    for (const u of withoutUid) {
      let candidate = u.user_code && u.user_code.length === 8 ? u.user_code : uniqueUID();
      // user_code is 6 chars historically — keep it as legacy alias, generate fresh 8-char UID
      if (!u.user_code || u.user_code.length !== 8) candidate = uniqueUID();
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          setUid.run(candidate, u.id);
          break;
        } catch {
          candidate = uniqueUID();
        }
      }
    }
  } catch {}
  // Backfill content from legacy encrypted_content (plaintext era stores plain text there)
  try {
    db.exec(`UPDATE messages SET content = encrypted_content WHERE content IS NULL`);
  } catch {}
  // Ensure at least one admin exists (first real user becomes admin if none)
  try {
    const adminCount = db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin'`).get();
    if (adminCount.c === 0) {
      const first = db.prepare(`SELECT id FROM users WHERE id != 'system' ORDER BY created_at ASC LIMIT 1`).get();
      if (first) db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(first.id);
    }
  } catch {}
};

backfillUsers();

const PUBLIC_USER_COLS =
  'id, uid, username, display_name, avatar_color, status, user_code, bio, role, email, is_disabled, created_at';

// --- Query Helpers ---
export const userQueries = {
  create: db.prepare(`
    INSERT INTO users (id, uid, username, email, display_name, password_hash, avatar_color, user_code, bio, role)
    VALUES (@id, @uid, @username, @email, @display_name, @password_hash, @avatar_color, @user_code, @bio, @role)
  `),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  findByLogin: db.prepare('SELECT * FROM users WHERE username = ? OR email = ?'),
  findByCode: db.prepare('SELECT * FROM users WHERE user_code = ?'),
  findByUid: db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE uid = ?`),
  findById: db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`),
  findRawById: db.prepare('SELECT * FROM users WHERE id = ?'),
  findAll: db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id != 'system' ORDER BY username`),
  search: db.prepare(`
    SELECT ${PUBLIC_USER_COLS}
    FROM users
    WHERE id != 'system' AND (username LIKE ? OR display_name LIKE ? OR user_code LIKE ? OR uid LIKE ? OR email LIKE ?)
    ORDER BY
      CASE WHEN uid = ? THEN 0 WHEN user_code = ? THEN 1 WHEN username = ? THEN 2 ELSE 3 END,
      username
    LIMIT 30
  `),
  updatePublicKey: db.prepare('UPDATE users SET public_key = ? WHERE id = ?'),
  updateStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  updateProfile: db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio) WHERE id = ?'),
  updateRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  setDisabled: db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?'),
  deleteById: db.prepare('DELETE FROM users WHERE id = ?'),
  count: db.prepare(`SELECT COUNT(*) as c FROM users WHERE id != 'system'`),
};

export const roomQueries = {
  findAll: db.prepare(`
    SELECT r.*, u.username as creator_username
    FROM rooms r LEFT JOIN users u ON r.created_by = u.id
    ORDER BY r.created_at ASC
  `),
  findById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  create: db.prepare(`
    INSERT INTO rooms (id, name, description, type, created_by)
    VALUES (@id, @name, @description, @type, @created_by)
  `),
  rename: db.prepare('UPDATE rooms SET name = ?, description = COALESCE(?, description) WHERE id = ?'),
  getMembers: db.prepare(`
    SELECT u.id, u.uid, u.username, u.display_name, u.avatar_color, u.status, u.public_key, u.user_code, u.bio, u.role
    FROM room_members rm JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ?
  `),
  addMember: db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)'),
  removeMember: db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?'),
  isMember: db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'),
  getUserRooms: db.prepare(`
    SELECT r.* FROM rooms r
    JOIN room_members rm ON r.id = rm.room_id
    WHERE rm.user_id = ?
    ORDER BY r.created_at ASC
  `),
  delete: db.prepare('DELETE FROM rooms WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) as c FROM rooms'),
};

const MESSAGE_SELECT = `
  SELECT m.id, m.room_id, m.sender_id,
    COALESCE(m.content, m.encrypted_content, '') as content,
    COALESCE(m.content, m.encrypted_content, '') as encrypted_content,
    m.type, m.file_id, m.file_name, m.file_size, m.file_mime,
    m.reply_to, m.created_at, m.edited_at, m.updated_at,
    m.is_deleted, m.deleted_at,
    u.username, u.display_name, u.avatar_color
  FROM messages m JOIN users u ON m.sender_id = u.id
`;

export const messageQueries = {
  insert: db.prepare(`
    INSERT INTO messages (id, room_id, sender_id, encrypted_content, content, type, file_id, file_name, file_size, file_mime, reply_to)
    VALUES (@id, @room_id, @sender_id, @encrypted_content, @content, @type, @file_id, @file_name, @file_size, @file_mime, @reply_to)
  `),
  // Paginated history: newest-first with ?before=<unix ts>&limit= (default 50, max 100).
  // Pass before=0/undefined for the latest page.
  getPage: db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ? AND (? = 0 OR m.created_at < ?)
    ORDER BY m.created_at DESC
    LIMIT ?
  `),
  // Legacy: last 100 ascending (kept for socket history compat).
  getByRoom: db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC
    LIMIT 100
  `),
  getRecent: db.prepare(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ? AND m.created_at > ?
    ORDER BY m.created_at ASC
  `),
  getRecentGlobal: db.prepare(`
    SELECT m.id, m.room_id, m.sender_id,
      COALESCE(m.content, m.encrypted_content, '') as content,
      m.type, m.created_at, m.edited_at, m.is_deleted,
      u.username, u.display_name, r.name as room_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN rooms r ON m.room_id = r.id
    ORDER BY m.created_at DESC
    LIMIT 50
  `),
  search: db.prepare(`
    SELECT m.id, m.room_id, m.sender_id,
      COALESCE(m.content, m.encrypted_content, '') as content,
      m.type, m.created_at, u.username, r.name as room_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN rooms r ON m.room_id = r.id
    WHERE COALESCE(m.content, m.encrypted_content, '') LIKE ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `),
  // Hard delete (legacy). Prefer softDelete for user-facing deletes.
  delete: db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?'),
  adminDelete: db.prepare('DELETE FROM messages WHERE id = ?'),
  softDelete: db.prepare('UPDATE messages SET is_deleted = 1, deleted_at = unixepoch(), content = ?, encrypted_content = ? WHERE id = ?'),
  edit: db.prepare('UPDATE messages SET content = ?, encrypted_content = ?, edited_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'),
  findById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  addReaction: db.prepare(`
    INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
  `),
  removeReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  getReactions: db.prepare(`
    SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
    FROM reactions WHERE message_id = ?
    GROUP BY emoji
  `),
  count: db.prepare('SELECT COUNT(*) as c FROM messages'),
  countToday: db.prepare(`SELECT COUNT(*) as c FROM messages WHERE created_at >= unixepoch('now', 'start of day')`),
  unreadCount: db.prepare(`
    SELECT COUNT(*) as c FROM messages m
    LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ?
    WHERE m.room_id = ? AND m.created_at > COALESCE(rr.last_read_at, 0) AND m.sender_id != ?
  `),
};

export const readQueries = {
  markRead: db.prepare(`
    INSERT INTO room_reads (room_id, user_id, last_read_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(room_id, user_id) DO UPDATE SET last_read_at = unixepoch()
  `),
  getReads: db.prepare('SELECT room_id, last_read_at FROM room_reads WHERE user_id = ?'),
};

export const reportQueries = {
  create: db.prepare(`
    INSERT INTO reports (id, reporter_id, target_user_id, message_id, reason, status)
    VALUES (@id, @reporter_id, @target_user_id, @message_id, @reason, 'open')
  `),
  list: db.prepare(`
    SELECT r.*, u.username as reporter_name, m.room_id as room_id
    FROM reports r
    LEFT JOIN users u ON r.reporter_id = u.id
    LEFT JOIN messages m ON r.message_id = m.id
    ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC
    LIMIT 100
  `),
  setStatus: db.prepare(`UPDATE reports SET status = ?, resolved_at = unixepoch(), resolved_by = ? WHERE id = ?`),
  countOpen: db.prepare(`SELECT COUNT(*) as c FROM reports WHERE status = 'open'`),
};

export const voiceChannelQueries = {
  list: db.prepare('SELECT * FROM voice_channels ORDER BY created_at ASC'),
  findById: db.prepare('SELECT * FROM voice_channels WHERE id = ?'),
  create: db.prepare(`INSERT INTO voice_channels (id, name, description, created_by) VALUES (@id, @name, @description, @created_by)`),
  rename: db.prepare('UPDATE voice_channels SET name = ?, description = COALESCE(?, description) WHERE id = ?'),
  delete: db.prepare('DELETE FROM voice_channels WHERE id = ?'),
};

export const fileQueries = {
  insert: db.prepare(`
    INSERT INTO files (id, uploader_id, room_id, file_name, file_size, mime_type, path)
    VALUES (@id, @uploader_id, @room_id, @file_name, @file_size, @mime_type, @path)
  `),
  findById: db.prepare('SELECT * FROM files WHERE id = ?'),
};

export { generateUserCode };

export default db;
