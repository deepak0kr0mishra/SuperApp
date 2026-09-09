import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { mkdirSync, createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { fileQueries, roomQueries } from './db.js';
import { authenticateToken } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '../../data/uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// POST /api/files/upload — upload an encrypted file blob
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { roomId } = req.body;
    if (!roomId) return res.status(400).json({ error: 'roomId required' });

    const room = roomQueries.findById.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const id = uuidv4();
    fileQueries.insert.run({
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

// GET /api/files/:id — download a file
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const file = fileQueries.findById.get(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = join(UPLOADS_DIR, file.path);
    try {
      await stat(filePath);
    } catch {
      return res.status(404).json({ error: 'File data not found' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.file_name)}"`);
    res.setHeader('Content-Type', file.mime_type);
    res.setHeader('Content-Length', file.file_size);
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

export default router;
