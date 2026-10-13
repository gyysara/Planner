const express = require('express');
const { toId } = require('../util');

function notificationsRouter({ db }) {
  const r = express.Router();

  r.get('/notifications/unread', (req, res) => {
    const rows = db.prepare(`SELECT id, task_id, kind, message, created_at FROM notifications
      WHERE user_id = ? AND read_at IS NULL ORDER BY id LIMIT 20`).all(req.user.id);
    res.json({ notifications: rows.map((n) => ({ id: n.id, taskId: n.task_id, kind: n.kind, message: n.message, createdAt: n.created_at })) });
  });

  r.post('/notifications/:id/read', (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .run(new Date().toISOString(), toId(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  r.post('/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), req.user.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { notificationsRouter };
