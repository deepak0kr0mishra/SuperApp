import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'securechat.db'));

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
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
`);

// Lightweight migrations for existing DBs (SQLite can't ADD COLUMN with UNIQUE — use plain column + index)
try { db.exec(`ALTER TABLE users ADD COLUMN user_code TEXT`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code ON users(user_code)`); } catch {}

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

// Backfill missing user_code / role for existing users
function generateUserCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
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

// --- Query Helpers ---
export const userQueries = {
  create: db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, avatar_color, user_code, bio, role)
    VALUES (@id, @username, @display_name, @password_hash, @avatar_color, @user_code, @bio, @role)
  `),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByCode: db.prepare('SELECT * FROM users WHERE user_code = ?'),
  findById: db.prepare('SELECT id, username, display_name, public_key, avatar_color, status, user_code, bio, role, created_at FROM users WHERE id = ?'),
  findAll: db.prepare(`SELECT id, username, display_name, public_key, avatar_color, status, user_code, bio, role, created_at FROM users WHERE id != 'system' ORDER BY username`),
  search: db.prepare(`
    SELECT id, username, display_name, avatar_color, status, user_code, bio, role, created_at
    FROM users
    WHERE id != 'system' AND (username LIKE ? OR display_name LIKE ? OR user_code LIKE ?)
    ORDER BY
      CASE WHEN user_code = ? THEN 0 WHEN username = ? THEN 1 ELSE 2 END,
      username
    LIMIT 30
  `),
  updatePublicKey: db.prepare('UPDATE users SET public_key = ? WHERE id = ?'),
  updateStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  updateProfile: db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio) WHERE id = ?'),
  updateRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
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
  getMembers: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_color, u.status, u.public_key, u.user_code, u.bio, u.role
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

export const messageQueries = {
  insert: db.prepare(`
    INSERT INTO messages (id, room_id, sender_id, encrypted_content, type, file_id, file_name, file_size, file_mime, reply_to)
    VALUES (@id, @room_id, @sender_id, @encrypted_content, @type, @file_id, @file_name, @file_size, @file_mime, @reply_to)
  `),
  getByRoom: db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC
    LIMIT 100
  `),
  getRecent: db.prepare(`
    SELECT m.*, u.username, u.display_name, u.avatar_color
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ? AND m.created_at > ?
    ORDER BY m.created_at ASC
  `),
  getRecentGlobal: db.prepare(`
    SELECT m.*, u.username, u.display_name, r.name as room_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN rooms r ON m.room_id = r.id
    ORDER BY m.created_at DESC
    LIMIT 50
  `),
  delete: db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?'),
  adminDelete: db.prepare('DELETE FROM messages WHERE id = ?'),
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
