/**
 * db.js — Turso (libSQL) edition
 *
 * Swaps better-sqlite3 for @libsql/client while keeping the exact same
 * exported API used by auth.js, rooms.js, index.js, admin.js, users.js, etc.
 *
 * Env vars:
 *   TURSO_URL   — libsql://your-db.turso.io  (production)
 *   TURSO_TOKEN — token from `turso db tokens create`
 *   Leave both unset for local dev → falls back to file:./data/securechat.db
 */

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

// --- Client setup ---
const isProduction = !!(process.env.TURSO_URL && process.env.TURSO_TOKEN);

const client = createClient(
  isProduction
    ? {
        url: process.env.TURSO_URL,
        authToken: process.env.TURSO_TOKEN,
      }
    : {
        // Local SQLite file — identical behaviour to better-sqlite3
        url: `file:${join(DATA_DIR, 'securechat.db')}`,
      }
);

console.log(`[db] Using ${isProduction ? `Turso @ ${process.env.TURSO_URL}` : `local SQLite @ ${DATA_DIR}/securechat.db`}`);

export const MESSAGE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Query wrapper — gives every prepared-statement-like object the same
// .get(args)/.all(args)/.run(args) interface that the rest of the codebase
// expects, but returning Promises so callers can await them.
//
// libSQL uses named @param or positional ? params just like SQLite.
// Named object params (@foo) are passed as { foo: value }.
// Positional ? params are passed as an array.
// ---------------------------------------------------------------------------

function stmt(sql) {
  return {
    sql,
    async get(...args) {
      const result = await client.execute({ sql, args: flatten(args) });
      return result.rows[0] ? toPlain(result.rows[0], result.columns) : undefined;
    },
    async all(...args) {
      const result = await client.execute({ sql, args: flatten(args) });
      return result.rows.map((r) => toPlain(r, result.columns));
    },
    async run(...args) {
      await client.execute({ sql, args: flatten(args) });
      return { changes: 1 }; // libSQL doesn't return changes; most callers ignore it
    },
  };
}

// better-sqlite3 named params are passed as a plain object (last arg).
// libSQL positional params are an array [].
// This helper normalises both conventions into libSQL's `args` format.
function flatten(args) {
  if (args.length === 0) return [];
  // Named object (INSERT ... VALUES (@id, @name, ...)) → libSQL named args object
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0]; // pass as-is; libSQL accepts { id: ..., name: ... }
  }
  // Positional array
  return args;
}

// libSQL Row is array-like; convert to plain object using column names.
function toPlain(row, columns) {
  if (!row || !columns) return row;
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    let val = row[i];
    // BigInt → number (SQLite integers come through as BigInt from libSQL)
    if (typeof val === 'bigint') val = Number(val);
    obj[columns[i]] = val;
  }
  return obj;
}

// Execute raw SQL (for migrations, pragma, etc.)
async function exec(sql) {
  // Split on semicolons so multi-statement strings work
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) {
    try {
      await client.execute(s + ';');
    } catch (err) {
      // Swallow "already exists" / "duplicate column" silently — same as better-sqlite3
      if (
        err.message?.includes('already exists') ||
        err.message?.includes('duplicate column') ||
        err.message?.includes('UNIQUE constraint') ||
        err.message?.includes('no such table') // ignore DROP on missing
      ) {
        // expected on re-run
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

await exec(`
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
    email TEXT UNIQUE,
    uid TEXT UNIQUE,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    type TEXT NOT NULL DEFAULT 'channel',
    max_members INTEGER,
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
    content TEXT,
    type TEXT NOT NULL DEFAULT 'text',
    file_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT,
    reply_to TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    edited_at INTEGER,
    updated_at INTEGER,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reaction_favorites (
    user_id TEXT PRIMARY KEY,
    favs TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
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

  CREATE TABLE IF NOT EXISTS user_mutes (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    expires_at INTEGER NOT NULL,
    created_by TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, kind)
  );

  CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (blocker_id, blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
  );



  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_users_search ON users(username, user_code);
`);

// ---------------------------------------------------------------------------
// Space definitions
// ---------------------------------------------------------------------------
export const SPACE_DEFS = [
  { id: 'general', name: 'general', description: 'General chat for everyone', max_members: null },
  { id: 'developers', name: 'Developers', description: 'Builders room · voice max 6', max_members: 6 },
  { id: 'creatives', name: 'Creatives', description: 'Creatives room · voice max 6', max_members: 6 },
  { id: 'chill-01', name: 'Chill_01', description: 'Chill duo · voice max 2', max_members: 2 },
  { id: 'chill-02', name: 'Chill_02', description: 'Chill duo · voice max 2', max_members: 2 },
];
const LEGACY_SPACE_IDS = ['media', 'audio', 'random'];
const LEGACY_VOICE_IDS = ['voice-general', 'voice-gaming', 'voice-study'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateUserCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function generateUID() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function uniqueUID() {
  for (let i = 0; i < 20; i++) {
    const candidate = generateUID();
    const hit = await client.execute({
      sql: 'SELECT 1 FROM users WHERE uid = ? OR user_code = ?',
      args: [candidate, candidate],
    });
    if (hit.rows.length === 0) return candidate;
  }
  return generateUID() + Date.now().toString(36).slice(-2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Seeding (all async now)
// ---------------------------------------------------------------------------
const seedRooms = async () => {
  const systemId = 'system';
  await client.execute({
    sql: `INSERT OR IGNORE INTO users (id, username, display_name, password_hash, avatar_color) VALUES (?, 'system', 'System', 'N/A', '#6366f1')`,
    args: [systemId],
  });

  for (const ch of SPACE_DEFS) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO rooms (id, name, description, type, max_members, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [ch.id, ch.name, ch.description, 'channel', ch.max_members ?? null, systemId],
    });
    await client.execute({
      sql: 'UPDATE rooms SET name = ?, description = ?, max_members = ? WHERE id = ?',
      args: [ch.name, ch.description, ch.max_members ?? null, ch.id],
    });
  }

  // Remove legacy spaces
  for (const legacyId of LEGACY_SPACE_IDS) {
    for (const table of ['room_members', 'messages', 'room_reads']) {
      try { await client.execute({ sql: `DELETE FROM ${table} WHERE room_id = ?`, args: [legacyId] }); } catch {}
    }
    try { await client.execute({ sql: 'DELETE FROM rooms WHERE id = ?', args: [legacyId] }); } catch {}
  }
};

const seedVoice = async () => {
  for (const ch of SPACE_DEFS) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO voice_channels (id, name, description, created_by) VALUES (?, ?, ?, ?)',
      args: [ch.id, ch.name, `${ch.name} voice`, 'system'],
    });
  }
  for (const legacyId of LEGACY_VOICE_IDS) {
    try { await client.execute({ sql: 'DELETE FROM voice_channels WHERE id = ?', args: [legacyId] }); } catch {}
  }
};

const backfillUsers = async () => {
  // user_code
  const withoutCode = await client.execute(`SELECT id FROM users WHERE user_code IS NULL`);
  for (const row of withoutCode.rows) {
    const id = row[0];
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await client.execute({ sql: 'UPDATE users SET user_code = ? WHERE id = ?', args: [generateUserCode(), id] });
        break;
      } catch {}
    }
  }

  // uid
  const withoutUid = await client.execute(`SELECT id, user_code FROM users WHERE uid IS NULL`);
  for (const row of withoutUid.rows) {
    const id = row[0];
    const user_code = row[1];
    let candidate = (!user_code || user_code.length !== 8) ? await uniqueUID() : user_code;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await client.execute({ sql: 'UPDATE users SET uid = ? WHERE id = ?', args: [candidate, id] });
        break;
      } catch {
        candidate = await uniqueUID();
      }
    }
  }

  // backfill content from encrypted_content
  try {
    await client.execute(`UPDATE messages SET content = encrypted_content WHERE content IS NULL`);
  } catch {}

  // ensure admin exists
  try {
    const r = await client.execute(`SELECT COUNT(*) as c FROM users WHERE role = 'admin'`);
    const c = Number(r.rows[0][0]);
    if (c === 0) {
      const first = await client.execute(`SELECT id FROM users WHERE id != 'system' ORDER BY created_at ASC LIMIT 1`);
      if (first.rows[0]) {
        await client.execute({ sql: `UPDATE users SET role = 'admin' WHERE id = ?`, args: [first.rows[0][0]] });
      }
    }
  } catch {}
};

// --- Fixed admins ---
export const MAX_ADMINS = 10;
export const FIXED_ADMIN_USERNAMES = ['Admin_01', 'Admin_02', 'Admin_03', 'Admin_04', 'Admin_05'];
export const FIXED_ADMIN_IDS = ['admin-01', 'admin-02', 'admin-03', 'admin-04', 'admin-05'];
export const isFixedAdmin = (user) =>
  !!user && (FIXED_ADMIN_IDS.includes(user.id) || FIXED_ADMIN_USERNAMES.includes(user.username));

const DEFAULT_ADMIN_PASSWORD = 'firepower';

const seedFixedAdmins = async () => {
  try {
    const envPassword = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const envOverride = !!process.env.ADMIN_PASSWORD;
    const hash = bcrypt.hashSync(envPassword, 12);

    for (let i = 0; i < 5; i++) {
      const username = FIXED_ADMIN_USERNAMES[i];
      const id = FIXED_ADMIN_IDS[i];

      const byId = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
      const byName = byId.rows.length ? null : await client.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
      const existingRow = byId.rows[0] || byName?.rows[0];
      const existing = existingRow ? toPlain(existingRow, (byId.rows[0] ? byId : byName).columns) : null;

      if (!existing) {
        let user_code = generateUserCode();
        for (let a = 0; a < 10; a++) {
          const ck = await client.execute({ sql: 'SELECT 1 FROM users WHERE user_code = ?', args: [user_code] });
          if (ck.rows.length === 0) break;
          user_code = generateUserCode();
        }
        let uid = generateUID();
        for (let a = 0; a < 10; a++) {
          const uk = await client.execute({ sql: 'SELECT 1 FROM users WHERE uid = ?', args: [uid] });
          if (uk.rows.length === 0) break;
          uid = generateUID();
        }
        await client.execute({
          sql: `INSERT INTO users (id, uid, username, email, display_name, password_hash, avatar_color, user_code, bio, role, is_disabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 0)`,
          args: [id, uid, username, `admin_0${i + 1}@teachat.local`, `Admin 0${i + 1}`, hash, '#b06a1f', user_code, 'TeaChat administrator'],
        });
        console.log(`  [seed] created fixed admin ${username}`);
      } else {
        await client.execute({ sql: `UPDATE users SET role = 'admin', is_disabled = 0 WHERE id = ?`, args: [existing.id] });
        if (envOverride) {
          await client.execute({ sql: `UPDATE users SET password_hash = ? WHERE id = ?`, args: [hash, existing.id] });
        }
      }

      // Fixed admins join all channels
      try {
        const channels = await client.execute(`SELECT id FROM rooms WHERE type = 'channel'`);
        for (const ch of channels.rows) {
          await client.execute({
            sql: 'INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)',
            args: [ch[0], existing?.id || id],
          });
        }
      } catch {}
    }

    // Trim extra non-fixed admins
    const placeholders = FIXED_ADMIN_USERNAMES.map(() => '?').join(',');
    const extras = await client.execute({
      sql: `SELECT id FROM users WHERE role = 'admin' AND username NOT IN (${placeholders}) AND id != 'system' ORDER BY rowid DESC`,
      args: FIXED_ADMIN_USERNAMES,
    });
    const over = extras.rows.length - (MAX_ADMINS - FIXED_ADMIN_USERNAMES.length);
    if (over > 0) {
      for (let k = 0; k < over; k++) {
        await client.execute({ sql: `UPDATE users SET role = 'user' WHERE id = ?`, args: [extras.rows[k][0]] });
      }
      console.log(`  [seed] demoted ${over} extra admin(s) to user (cap ${MAX_ADMINS})`);
    }
  } catch (err) {
    console.error('  [seed] fixed-admin seeding failed:', err.message);
  }
};

// Run all seeding sequentially
await seedRooms();
await seedVoice();
await backfillUsers();
await seedFixedAdmins();

// ---------------------------------------------------------------------------
// Dedupe reactions (one per user per message — keep latest)
// ---------------------------------------------------------------------------
try {
  // Turso/SQLite supports this subquery form
  await client.execute(`
    DELETE FROM reactions WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM reactions GROUP BY message_id, user_id
    )
  `);
} catch {}

// ---------------------------------------------------------------------------
// Exported query objects (same API as before, now async)
// ---------------------------------------------------------------------------

const PUBLIC_USER_COLS = 'id, uid, username, display_name, avatar_color, status, user_code, bio, role, email, is_disabled, created_at';

export const userQueries = {
  create: stmt(`
    INSERT INTO users (id, uid, username, email, display_name, password_hash, avatar_color, user_code, bio, role)
    VALUES (@id, @uid, @username, @email, @display_name, @password_hash, @avatar_color, @user_code, @bio, @role)
  `),
  findByUsername: stmt('SELECT * FROM users WHERE username = ?'),
  findByEmail: stmt('SELECT * FROM users WHERE email = ?'),
  findByLogin: stmt('SELECT * FROM users WHERE username = ? OR email = ?'),
  findByCode: stmt('SELECT * FROM users WHERE user_code = ?'),
  findByUid: stmt(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE uid = ?`),
  findById: stmt(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`),
  findRawById: stmt('SELECT * FROM users WHERE id = ?'),
  findAll: stmt(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id != 'system' ORDER BY username`),
  search: stmt(`
    SELECT ${PUBLIC_USER_COLS}
    FROM users
    WHERE id != 'system' AND (username LIKE ? OR display_name LIKE ? OR user_code LIKE ? OR uid LIKE ? OR email LIKE ?)
    ORDER BY
      CASE WHEN uid = ? THEN 0 WHEN user_code = ? THEN 1 WHEN username = ? THEN 2 ELSE 3 END,
      username
    LIMIT 30
  `),
  updatePublicKey: stmt('UPDATE users SET public_key = ? WHERE id = ?'),
  updateStatus: stmt('UPDATE users SET status = ? WHERE id = ?'),
  updateProfile: stmt('UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio) WHERE id = ?'),
  updatePassword: stmt('UPDATE users SET password_hash = ? WHERE id = ?'),
  updateRole: stmt('UPDATE users SET role = ? WHERE id = ?'),
  setDisabled: stmt('UPDATE users SET is_disabled = ? WHERE id = ?'),
  deleteById: stmt('DELETE FROM users WHERE id = ?'),
  count: stmt(`SELECT COUNT(*) as c FROM users WHERE id != 'system'`),
};

export const roomQueries = {
  findAll: stmt(`
    SELECT r.*, u.username as creator_username
    FROM rooms r LEFT JOIN users u ON r.created_by = u.id
    ORDER BY r.created_at ASC
  `),
  findById: stmt('SELECT * FROM rooms WHERE id = ?'),
  create: stmt(`
    INSERT INTO rooms (id, name, description, type, max_members, created_by)
    VALUES (@id, @name, @description, @type, @max_members, @created_by)
  `),
  rename: stmt('UPDATE rooms SET name = ?, description = COALESCE(?, description) WHERE id = ?'),
  setLimit: stmt('UPDATE rooms SET max_members = ? WHERE id = ?'),
  countMembers: stmt('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?'),
  countOccupants: stmt(`
    SELECT COUNT(*) as c FROM room_members rm
    JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ? AND COALESCE(u.role, 'user') != 'admin'
  `),
  getMembers: stmt(`
    SELECT u.id, u.uid, u.username, u.display_name, u.avatar_color, u.status, u.public_key, u.user_code, u.bio, u.role
    FROM room_members rm JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ?
  `),
  addMember: stmt('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)'),
  removeMember: stmt('DELETE FROM room_members WHERE room_id = ? AND user_id = ?'),
  isMember: stmt('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?'),
  getUserRooms: stmt(`
    SELECT r.* FROM rooms r
    JOIN room_members rm ON r.id = rm.room_id
    WHERE rm.user_id = ?
    ORDER BY r.created_at ASC
  `),
  delete: stmt('DELETE FROM rooms WHERE id = ?'),
  count: stmt('SELECT COUNT(*) as c FROM rooms'),
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
  insert: stmt(`
    INSERT INTO messages (id, room_id, sender_id, encrypted_content, content, type, file_id, file_name, file_size, file_mime, reply_to)
    VALUES (@id, @room_id, @sender_id, @encrypted_content, @content, @type, @file_id, @file_name, @file_size, @file_mime, @reply_to)
  `),
  getPage: stmt(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ? AND (? = 0 OR m.created_at < ?)
    ORDER BY m.created_at DESC
    LIMIT ?
  `),
  getByRoom: stmt(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ?
    ORDER BY m.created_at ASC
    LIMIT 100
  `),
  getRecent: stmt(`
    ${MESSAGE_SELECT}
    WHERE m.room_id = ? AND m.created_at > ?
    ORDER BY m.created_at ASC
  `),
  getRecentGlobal: stmt(`
    SELECT m.id, m.room_id, m.sender_id,
      COALESCE(m.content, m.encrypted_content, '') as content,
      m.type, m.created_at, m.edited_at, m.is_deleted,
      u.username, u.display_name, r.name as room_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN rooms r ON m.room_id = r.id
    ORDER BY m.created_at DESC
    LIMIT 50
  `),
  search: stmt(`
    SELECT m.id, m.room_id, m.sender_id,
      COALESCE(m.content, m.encrypted_content, '') as content,
      m.type, m.created_at, u.username, r.name as room_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    LEFT JOIN rooms r ON m.room_id = r.id
    WHERE COALESCE(m.content, m.encrypted_content, '') LIKE ?
    ORDER BY m.created_at DESC
    LIMIT 50
  `),
  delete: stmt('DELETE FROM messages WHERE id = ? AND sender_id = ?'),
  adminDelete: stmt('DELETE FROM messages WHERE id = ?'),
  softDelete: stmt('UPDATE messages SET is_deleted = 1, deleted_at = unixepoch(), content = ?, encrypted_content = ? WHERE id = ?'),
  edit: stmt('UPDATE messages SET content = ?, encrypted_content = ?, edited_at = unixepoch(), updated_at = unixepoch() WHERE id = ?'),
  findById: stmt('SELECT * FROM messages WHERE id = ?'),
  addReaction: stmt(`INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`),
  removeReaction: stmt('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
  getReactions: stmt(`
    SELECT emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as users
    FROM reactions WHERE message_id = ?
    GROUP BY emoji
  `),
  removeAllUserReactions: stmt('DELETE FROM reactions WHERE message_id = ? AND user_id = ?'),
  count: stmt('SELECT COUNT(*) as c FROM messages'),
  countToday: stmt(`SELECT COUNT(*) as c FROM messages WHERE created_at >= unixepoch('now', 'start of day')`),
  unreadCount: stmt(`
    SELECT COUNT(*) as c FROM messages m
    LEFT JOIN room_reads rr ON rr.room_id = m.room_id AND rr.user_id = ?
    WHERE m.room_id = ? AND m.created_at > COALESCE(rr.last_read_at, 0) AND m.sender_id != ?
  `),
};

// Reactions
export const DEFAULT_REACTION_FAVS = ['🥴', '😊', '😂', '🙄', '🥺', '❤️'];
export const MAX_REACTION_FAVS = 6;

// replaceReaction — swap in one reaction (remove other, insert new) using batch
export async function replaceReaction(messageId, userId, emoji) {
  await client.batch([
    { sql: 'DELETE FROM reactions WHERE message_id = ? AND user_id = ?', args: [messageId, userId] },
    { sql: 'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', args: [messageId, userId, emoji] },
  ], 'write');
}

export const favQueries = {
  get: stmt('SELECT favs FROM reaction_favorites WHERE user_id = ?'),
  set: stmt(`
    INSERT INTO reaction_favorites (user_id, favs, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET favs = excluded.favs, updated_at = unixepoch()
  `),
};

export async function isSpecialDMRoom(roomId) {
  try {
    const room = await roomQueries.findById.get(roomId);
    if (!room || room.type !== 'dm') return false;
    const members = await roomQueries.getMembers.all(roomId);
    const ids = members.map((m) => m.id).sort();
    return ids.length === 2 && ids[0] === 'admin-01' && ids[1] === 'admin-02';
  } catch {
    return false;
  }
}

export const readQueries = {
  markRead: stmt(`
    INSERT INTO room_reads (room_id, user_id, last_read_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(room_id, user_id) DO UPDATE SET last_read_at = unixepoch()
  `),
  getReads: stmt('SELECT room_id, last_read_at FROM room_reads WHERE user_id = ?'),
};

export const reportQueries = {
  create: stmt(`
    INSERT INTO reports (id, reporter_id, target_user_id, message_id, reason, status)
    VALUES (@id, @reporter_id, @target_user_id, @message_id, @reason, 'open')
  `),
  list: stmt(`
    SELECT r.*, u.username as reporter_name, m.room_id as room_id
    FROM reports r
    LEFT JOIN users u ON r.reporter_id = u.id
    LEFT JOIN messages m ON r.message_id = m.id
    ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC
    LIMIT 100
  `),
  setStatus: stmt(`UPDATE reports SET status = ?, resolved_at = unixepoch(), resolved_by = ? WHERE id = ?`),
  countOpen: stmt(`SELECT COUNT(*) as c FROM reports WHERE status = 'open'`),
};

export const voiceChannelQueries = {
  list: stmt('SELECT * FROM voice_channels ORDER BY created_at ASC'),
  findById: stmt('SELECT * FROM voice_channels WHERE id = ?'),
  create: stmt(`INSERT INTO voice_channels (id, name, description, created_by) VALUES (@id, @name, @description, @created_by)`),
  rename: stmt('UPDATE voice_channels SET name = ?, description = COALESCE(?, description) WHERE id = ?'),
  delete: stmt('DELETE FROM voice_channels WHERE id = ?'),
};

export const fileQueries = {
  insert: stmt(`
    INSERT INTO files (id, uploader_id, room_id, file_name, file_size, mime_type, path)
    VALUES (@id, @uploader_id, @room_id, @file_name, @file_size, @mime_type, @path)
  `),
  findById: stmt('SELECT * FROM files WHERE id = ?'),
};

export const MUTE_KINDS = ['voice', 'chat'];
export const MUTE_DURATIONS = { hour: 3600, day: 86400, week: 604800 };

export const muteQueries = {
  get: stmt('SELECT * FROM user_mutes WHERE user_id = ? AND kind = ?'),
  listActive: stmt('SELECT * FROM user_mutes WHERE expires_at > unixepoch()'),
  listFor: stmt('SELECT * FROM user_mutes WHERE user_id = ? AND expires_at > unixepoch()'),
  upsert: stmt(`
    INSERT INTO user_mutes (user_id, kind, expires_at, created_by, reason, created_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id, kind) DO UPDATE SET expires_at = excluded.expires_at,
      created_by = excluded.created_by, reason = excluded.reason, created_at = unixepoch()
  `),
  revoke: stmt('DELETE FROM user_mutes WHERE user_id = ? AND kind = ?'),
  clearExpired: stmt('DELETE FROM user_mutes WHERE expires_at <= unixepoch()'),
  clearUser: stmt('DELETE FROM user_mutes WHERE user_id = ?'),
};

export async function getActiveMute(userId, kind) {
  try {
    const row = await muteQueries.get.get(userId, kind);
    if (!row) return null;
    if (row.expires_at <= Math.floor(Date.now() / 1000)) {
      try { await muteQueries.revoke.run(userId, kind); } catch {}
      return null;
    }
    return row;
  } catch { return null; }
}
export const isVoiceMuted = async (userId) => !!(await getActiveMute(userId, 'voice'));
export const isChatMuted = async (userId) => !!(await getActiveMute(userId, 'chat'));

export const blockQueries = {
  add: stmt('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)'),
  remove: stmt('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'),
  isBlocked: stmt('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'),
  blockedBy: stmt('SELECT blocker_id FROM user_blocks WHERE blocked_id = ?'),
  myBlocks: stmt(`
    SELECT u.id, u.uid, u.username, u.display_name, u.avatar_color, u.status, u.user_code
    FROM user_blocks b JOIN users u ON b.blocked_id = u.id WHERE b.blocker_id = ?
  `),
  clearUser: stmt('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?'),
};

export async function isDMBlocked(a, b) {
  try {
    if (await blockQueries.isBlocked.get(a, b)) return true;
    if (await blockQueries.isBlocked.get(b, a)) return true;
    return false;
  } catch { return false; }
}



export { generateUserCode };

// Export client for any direct usage if needed
export default client;
