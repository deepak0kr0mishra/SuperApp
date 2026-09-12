import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { userQueries, roomQueries, messageQueries, reportQueries, voiceChannelQueries, isFixedAdmin, MAX_ADMINS } from './db.js';
import db from './db.js';
import { authenticateToken } from './auth.js';
import { validatePassword } from './security.js';

const router = express.Router();

function requireAdmin(req, res, next) {
  const me = userQueries.findById.get(req.user.userId);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.me = me;
  next();
}

function adminCount() {
  try {
    return db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin'`).get()?.c ?? 0;
  } catch { return 0; }
}

// 5 fixed admins (Admin_01..Admin_05) + up to 5 promotable slots = max 10.
// Fixed admins can never be demoted, disabled, or deleted.
function guardRoleChange(target, role, selfId) {
  if (!target) return 'User not found';
  if (role === 'admin' && target.role !== 'admin' && adminCount() >= MAX_ADMINS) {
    return `Admin limit reached (max ${MAX_ADMINS})`;
  }
  if (isFixedAdmin(target) && role !== 'admin') {
    return `${target.username} is a fixed admin and cannot be demoted`;
  }
  if (target.id === selfId && role !== 'admin') {
    return 'You cannot demote yourself';
  }
  return null;
}

router.use(authenticateToken, requireAdmin);

// GET /api/admin/stats — dashboard overview
router.get('/stats', (req, res) => {
  const users = userQueries.count.get()?.c ?? 0;
  const rooms = roomQueries.count.get()?.c ?? 0;
  const messages = messageQueries.count.get()?.c ?? 0;
  const online = db.prepare(`SELECT COUNT(*) as c FROM users WHERE status = 'online' AND id != 'system'`).get()?.c ?? 0;
  let messagesToday = 0;
  try { messagesToday = messageQueries.countToday.get()?.c ?? 0; } catch {}
  let activeConversations = 0;
  try {
    activeConversations = db.prepare(
      `SELECT COUNT(DISTINCT room_id) as c FROM messages WHERE created_at >= unixepoch('now', '-7 days')`
    ).get()?.c ?? 0;
  } catch {}
  let reports = { open: 0 };
  try { reports.open = reportQueries.countOpen.get()?.c ?? 0; } catch {}
  res.json({ stats: { users, rooms, messages, online, messagesToday, activeConversations, reports: reports.open } });
});

// GET /api/admin/users?q= — search + list users
router.get('/users', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    const like = `%${q}%`;
    const upper = q.toUpperCase();
    const users = userQueries.search.all(like, like, like, like, like, upper, upper, q);
    return res.json({ users });
  }
  const users = userQueries.findAll.all();
  res.json({ users });
});

// PUT /api/admin/users/:id/role — { role: 'admin' | 'user' }
router.put('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const target = userQueries.findById.get(req.params.id);
  const problem = guardRoleChange(target, role, req.user.userId);
  if (problem) {
    const code = problem === 'User not found' ? 404 : 400;
    return res.status(code).json({ error: problem });
  }
  userQueries.updateRole.run(role, req.params.id);
  res.json({ success: true });
});

// PATCH /api/admin/users/:id — { role?, is_disabled? } (spec compat)
router.patch('/users/:id', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const { role, is_disabled } = req.body;
  if (role !== undefined) {
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const problem = guardRoleChange(target, role, req.user.userId);
    if (problem) {
      const code = problem === 'User not found' ? 404 : 400;
      return res.status(code).json({ error: problem });
    }
    userQueries.updateRole.run(role, req.params.id);
  }
  if (is_disabled !== undefined) {
    if (isFixedAdmin(target)) {
      return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
    }
    if (req.params.id === req.user.userId) {
      return res.status(400).json({ error: 'You cannot disable yourself' });
    }
    userQueries.setDisabled.run(is_disabled ? 1 : 0, req.params.id);
  }
  res.json({ success: true, user: userQueries.findById.get(req.params.id) });
});

// POST /api/admin/users/:id/disable — disable account (keeps data, blocks login)
router.post('/users/:id/disable', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be disabled` });
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot disable yourself' });
  userQueries.setDisabled.run(1, req.params.id);
  res.json({ success: true });
});

// POST /api/admin/users/:id/enable
router.post('/users/:id/enable', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  userQueries.setDisabled.run(0, req.params.id);
  res.json({ success: true });
});

// POST /api/admin/users/:id/reset-password — { newPassword }
// Admins may reset any REGULAR user's password. Admin passwords can never
// be changed by another admin (not even fixed ones); admins change their own
// via PUT /api/auth/password.
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const target = userQueries.findById.get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' || isFixedAdmin(target)) {
      return res.status(403).json({ error: 'Admin passwords cannot be reset by other admins' });
    }
    const pErr = validatePassword(req.body?.newPassword);
    if (pErr) return res.status(400).json({ error: pErr });
    const password_hash = await bcrypt.hash(req.body.newPassword, 12);
    userQueries.updatePassword.run(password_hash, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Admin reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  const target = userQueries.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isFixedAdmin(target)) return res.status(400).json({ error: `${target.username} is a fixed admin and cannot be deleted` });
  if (req.params.id === req.user.userId) return res.status(400).json({ error: 'You cannot delete yourself' });
  // Delete user's messages, memberships, files records (keep files on disk, harmless)
  db.prepare('DELETE FROM messages WHERE sender_id = ?').run(req.params.id);
  db.prepare('DELETE FROM room_members WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM files WHERE uploader_id = ?').run(req.params.id);
  userQueries.deleteById.run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/rooms
router.get('/rooms', (req, res) => {
  const rooms = roomQueries.findAll.all();
  const withCounts = rooms.map(r => {
    const memberCount = db.prepare('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?').get(r.id)?.c ?? 0;
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE room_id = ?').get(r.id)?.c ?? 0;
    return { ...r, memberCount, msgCount };
  });
  res.json({ rooms: withCounts });
});

// POST /api/admin/rooms — create channel (admin)
router.post('/rooms', (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  roomQueries.create.run({
    id,
    name: String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
    description: String(description || '').slice(0, 200),
    type: 'channel',
    created_by: req.user.userId,
  });
  roomQueries.addMember.run(id, req.user.userId);
  res.status(201).json({ room: roomQueries.findById.get(id) });
});

// PATCH /api/admin/rooms/:id — rename channel
router.patch('/rooms/:id', (req, res) => {
  const room = roomQueries.findById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { name, description } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    if (String(name).length > 40) return res.status(400).json({ error: 'Name too long' });
  }
  roomQueries.rename.run(
    name === undefined ? room.name : String(name).toLowerCase().replace(/\s+/g, '-').slice(0, 40),
    description === undefined ? null : String(description).slice(0, 200),
    req.params.id
  );
  res.json({ room: roomQueries.findById.get(req.params.id) });
});

// DELETE /api/admin/rooms/:id
router.delete('/rooms/:id', (req, res) => {
  const protectedIds = ['general', 'media', 'audio', 'random'];
  if (protectedIds.includes(req.params.id)) {
    return res.status(400).json({ error: 'Default channels cannot be deleted' });
  }
  const room = roomQueries.findById.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  roomQueries.delete.run(req.params.id);
  res.json({ success: true });
});

// --- Voice channels (persistent list; WebRTC signaling stays in voice.js) ---
// GET /api/admin/voice — also served publicly via /api/voice below; admin sees same list
router.get('/voice', (req, res) => {
  res.json({ channels: voiceChannelQueries.list.all() });
});

router.post('/voice', (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const id = `voice-${uuidv4().slice(0, 8)}`;
  voiceChannelQueries.create.run({
    id,
    name: String(name).slice(0, 40),
    description: String(description || '').slice(0, 200),
    created_by: req.user.userId,
  });
  res.status(201).json({ channel: voiceChannelQueries.findById.get(id) });
});

router.patch('/voice/:id', (req, res) => {
  const ch = voiceChannelQueries.findById.get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Voice channel not found' });
  const { name, description } = req.body;
  voiceChannelQueries.rename.run(
    name === undefined ? ch.name : String(name).slice(0, 40),
    description === undefined ? null : String(description).slice(0, 200),
    req.params.id
  );
  res.json({ channel: voiceChannelQueries.findById.get(req.params.id) });
});

router.delete('/voice/:id', (req, res) => {
  voiceChannelQueries.delete.run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/messages/recent + ?q= search (moderate General etc.)
router.get('/messages/recent', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    const messages = messageQueries.search.all(`%${q}%`);
    return res.json({ messages });
  }
  const messages = messageQueries.getRecentGlobal.all();
  res.json({ messages });
});

// DELETE /api/admin/messages/:id
router.delete('/messages/:id', (req, res) => {
  const msg = messageQueries.findById.get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  messageQueries.adminDelete.run(req.params.id);
  res.json({ success: true, room_id: msg.room_id, messageId: msg.id });
});

// --- Backup & restore (survive Render free-tier wipes) ---
// Render free has no persistent disk: every redeploy/restart wipes SQLite +
// uploads. Download a backup BEFORE updating, restore AFTER the new version
// is live. Includes users (with password hashes), rooms, memberships,
// messages (+edits/deletes), reactions, reports, reads, voice channels.
// File *metadata* is included but uploaded *blobs* can't survive a wipe,
// so old media messages may show as missing after a restore.
const BACKUP_APP = 'TeaChat';
const BACKUP_VERSION = 1;
const BACKUP_TABLES = [
  'users', 'rooms', 'room_members', 'messages', 'reactions',
  'files', 'reports', 'room_reads', 'voice_channels', 'reaction_favorites',
];

// Columns allowed per table on restore. Backup files are admin-supplied JSON,
// so without this whitelist crafted column names would be interpolated into SQL.
const BACKUP_COLUMNS = {
  users: ['id', 'username', 'display_name', 'password_hash', 'public_key', 'avatar_color', 'status', 'user_code', 'bio', 'role', 'created_at', 'email', 'uid', 'is_disabled'],
  rooms: ['id', 'name', 'description', 'type', 'created_by', 'created_at'],
  room_members: ['room_id', 'user_id', 'joined_at'],
  messages: ['id', 'room_id', 'sender_id', 'encrypted_content', 'type', 'file_id', 'file_name', 'file_size', 'file_mime', 'reply_to', 'created_at', 'edited_at', 'content', 'updated_at', 'is_deleted', 'deleted_at'],
  reactions: ['message_id', 'user_id', 'emoji', 'created_at'],
  files: ['id', 'uploader_id', 'room_id', 'file_name', 'file_size', 'mime_type', 'path', 'created_at'],
  reports: ['id', 'reporter_id', 'target_user_id', 'message_id', 'reason', 'status', 'created_at', 'resolved_at', 'resolved_by'],
  room_reads: ['room_id', 'user_id', 'last_read_at'],
  voice_channels: ['id', 'name', 'description', 'created_by', 'created_at'],
  reaction_favorites: ['user_id', 'favs', 'updated_at'],
};

// GET /api/admin/backup — download full JSON dump (admin only, see router.use)
router.get('/backup', (req, res) => {
  try {
    const tables = {};
    const counts = {};
    for (const t of BACKUP_TABLES) {
      try {
        tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
      } catch { tables[t] = []; }
      counts[t] = tables[t].length;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    res.setHeader('Content-Disposition', `attachment; filename="teachat-backup-${stamp}.json"`);
    res.json({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: Math.floor(Date.now() / 1000), counts, tables });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Backup failed' });
  }
});

function validateBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    return 'Backup is empty or unreadable.';
  }
  if (backup.app !== BACKUP_APP) return 'Not a TeaChat backup file.';
  if (backup.version !== BACKUP_VERSION) {
    return `Unsupported backup version (v${backup.version ?? '?'} — this server reads v${BACKUP_VERSION}).`;
  }
  if (!backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) {
    return 'Backup has no data tables.';
  }
  for (const t of Object.keys(backup.tables)) {
    if (!BACKUP_TABLES.includes(t)) return `Unknown table in backup: ${t}.`;
    if (!Array.isArray(backup.tables[t])) return `Table "${t}" is corrupted.`;
  }
  return null;
}

// POST /api/admin/restore — { backup } full replace from a previous dump
router.post('/restore', (req, res) => {
  const backup = req.body?.backup;
  const problem = validateBackup(backup);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const tables = backup.tables;
    // Strip unknown columns / malformed rows before touching the DB.
    const cleanRows = {};
    const skipped = {};
    for (const t of BACKUP_TABLES) {
      const allowed = BACKUP_COLUMNS[t];
      cleanRows[t] = [];
      skipped[t] = 0;
      for (const row of tables[t] || []) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) { skipped[t]++; continue; }
        const clean = {};
        for (const c of allowed) if (row[c] !== undefined) clean[c] = row[c];
        if (!Object.keys(clean).length) { skipped[t]++; continue; }
        cleanRows[t].push(clean);
      }
    }
    const txn = db.transaction(() => {
      // Clear in dependency-safe order (children before parents; FKs are ON)
      for (const t of ['reactions', 'room_reads', 'reports', 'messages', 'room_members', 'files', 'rooms', 'voice_channels', 'reaction_favorites']) {
        try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
      }
      // Users: delete all except none — full replace (fixed admins re-seeded
      // on next boot if missing, but restore brings them back with their rows).
      try { db.prepare('DELETE FROM users').run(); } catch {}
      // Safety net: rooms/files may reference the system user — make sure it
      // exists before inserting (a backup row overwrites it below if present).
      try {
        db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, password_hash, avatar_color) VALUES ('system', 'system', 'System', 'N/A', '#6366f1')`).run();
      } catch {}
      const insert = (t, row) => {
        const cols = Object.keys(row);
        const ph = cols.map(() => '?').join(',');
        db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${ph})`).run(...cols.map(c => row[c]));
      };
      // Insert parents before children (FKs are ON)
      for (const t of ['users', 'rooms', 'voice_channels', 'room_members', 'files', 'messages', 'reactions', 'reports', 'room_reads', 'reaction_favorites']) {
        for (const row of cleanRows[t]) insert(t, row);
      }
    });
    txn();
    // Real counts straight from the DB — not the file's claims.
    const restored = {};
    for (const t of BACKUP_TABLES) {
      try { restored[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get()?.c ?? 0; }
      catch { restored[t] = 0; }
    }
    res.json({ success: true, restored, skipped });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});
// --- Reports moderation ---
// GET /api/admin/reports
router.get('/reports', (req, res) => {
  res.json({ reports: reportQueries.list.all() });
});

// POST /api/admin/reports/:id/resolve — { action?: 'dismiss' | 'delete_message' | 'disable_user' }
router.post('/reports/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { action } = req.body;
  if (action === 'delete_message' && report.message_id) {
    try { messageQueries.adminDelete.run(report.message_id); } catch {}
  } else if (action === 'disable_user' && report.target_user_id) {
    if (report.target_user_id !== req.user.userId) {
      try { userQueries.setDisabled.run(1, report.target_user_id); } catch {}
    }
  }
  // 'dismiss' or any moderation action resolves the report
  reportQueries.setStatus.run(action === 'dismiss' ? 'dismissed' : 'resolved', req.user.userId, req.params.id);
  res.json({ success: true });
});

export default router;
