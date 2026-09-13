import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { join, extname } from 'path';
import { mkdirSync, createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { fileQueries, roomQueries, DATA_DIR } from './db.js';
import { authenticateToken } from './auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'securechat_secret_key_change_in_prod';
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 55 * 1024 * 1024 } });

function authenticateMedia(req, res, next) {
  const header = req.headers['authorization'];
  let token = header && header.split(' ')[1];
  if (!token && typeof req.query.token === 'string') token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

const INLINE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/bmp', 'image/x-icon',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/aac', 'application/pdf', 'text/plain',
]);

function safeInlineType(mime) {
  if (!mime) return 'application/octet-stream';
  const base = String(mime).split(';')[0].trim().toLowerCase();
  if (INLINE_TYPES.has(base)) return base;
  if (base.startsWith('image/') || base.startsWith('video/') || base.startsWith('audio/')) return base;
  return base || 'application/octet-stream';
}

// POST /api/files/upload
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });

    const room = await roomQueries.findById.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.type === 'dm') {
      const member = await roomQueries.isMember.get(roomId, req.user.userId);
      if (!member) return res.status(403).json({ error: 'You are not part of this conversation' });
    } else {
      try { await roomQueries.addMember.run(roomId, req.user.userId); } catch {}
    }

    const id = uuidv4();
    await fileQueries.insert.run({
      id,
      uploader_id: req.user.userId,
      room_id: roomId,
      file_name: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      path: req.file.filename,
    });

    res.status(201).json({
      fileId: id,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /api/files/:id
router.get('/:id', authenticateMedia, async (req, res) => {
  try {
    const file = await fileQueries.findById.get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = join(UPLOADS_DIR, file.path);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return res.status(404).json({ error: 'File data not found on disk' });
    }

    const contentType = safeInlineType(file.mime_type);
    const isInline =
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === 'application/pdf' ||
      contentType === 'text/plain';
    const disposition = isInline
      ? `inline; filename="${encodeURIComponent(file.file_name)}"`
      : `attachment; filename="${encodeURIComponent(file.file_name)}"`;
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=31536000');

    const range = req.headers.range;
    if (range && (contentType.startsWith('video/') || contentType.startsWith('audio/'))) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : fileStat.size - 1;
        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end >= fileStat.size) end = fileStat.size - 1;
        if (start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${fileStat.size}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }

    res.setHeader('Content-Length', fileStat.size);
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
