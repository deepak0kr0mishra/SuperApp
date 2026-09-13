import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { reportQueries, userQueries, messageQueries } from './db.js';
import { authenticateToken } from './auth.js';
import { messageLimiter } from './security.js';

const router = express.Router();

// POST /api/reports
router.post('/', authenticateToken, messageLimiter, async (req, res) => {
  try {
    const { messageId, targetUserId, reason } = req.body;
    if (!messageId && !targetUserId) {
      return res.status(400).json({ error: 'messageId or targetUserId is required' });
    }
    let target = targetUserId || null;
    if (messageId) {
      const msg = await messageQueries.findById.get(messageId);
      if (!msg) return res.status(404).json({ error: 'Message not found' });
      if (!target) target = msg.sender_id;
    }
    if (target) {
      const u = await userQueries.findById.get(target);
      if (!u) return res.status(404).json({ error: 'User not found' });
    }
    const cleanReason = String(reason || '').trim().slice(0, 500);
    if (!cleanReason) return res.status(400).json({ error: 'Reason is required' });

    const id = uuidv4();
    await reportQueries.create.run({
      id,
      reporter_id: req.user.userId,
      target_user_id: target,
      message_id: messageId || null,
      reason: cleanReason,
    });
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

export default router;
