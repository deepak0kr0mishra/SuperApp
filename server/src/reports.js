import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { reportQueries, userQueries, messageQueries } from './db.js';
import { authenticateToken } from './auth.js';
import { messageLimiter } from './security.js';

const router = express.Router();

// POST /api/reports — report a message and/or user. { messageId?, targetUserId?, reason }
router.post('/', authenticateToken, messageLimiter, (req, res) => {
  const { messageId, targetUserId, reason } = req.body;
  if (!messageId && !targetUserId) {
    return res.status(400).json({ error: 'messageId or targetUserId is required' });
  }
  let target = targetUserId || null;
  if (messageId) {
    const msg = messageQueries.findById.get(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (!target) target = msg.sender_id;
  }
  if (target) {
    const u = userQueries.findById.get(target);
    if (!u) return res.status(404).json({ error: 'User not found' });
  }
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (!cleanReason) return res.status(400).json({ error: 'Reason is required' });

  const id = uuidv4();
  reportQueries.create.run({
    id,
    reporter_id: req.user.userId,
    target_user_id: target,
    message_id: messageId || null,
    reason: cleanReason,
  });
  res.status(201).json({ success: true, id });
});

export default router;
