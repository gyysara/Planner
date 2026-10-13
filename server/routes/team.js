const express = require('express');
const { HttpError, publicUser, toId } = require('../util');
const { teamMembers } = require('../access');

const requireAm = (req) => {
  if (req.user.role !== 'am') throw new HttpError(403, 'Доступно только аккаунт-менеджеру');
};

function teamRouter({ db }) {
  const r = express.Router();

  r.get('/team', (req, res) => {
    res.json({ members: teamMembers(db, req.user).map(publicUser) });
  });

  // Привязать гейм-менеджера по логину
  r.post('/team', (req, res) => {
    requireAm(req);
    const login = String((req.body || {}).login || '').trim();
    const gm = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    if (!gm || gm.role !== 'gm') throw new HttpError(404, 'Гейм-менеджер с таким логином не найден');
    if (gm.team_id === req.user.id) throw new HttpError(409, 'Уже в вашей команде');
    if (gm.team_id) throw new HttpError(409, 'Этот гейм-менеджер уже состоит в другой команде');
    db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(req.user.id, gm.id);
    res.status(201).json({ member: publicUser({ ...gm, team_id: req.user.id }) });
  });

  // Отвязать гейм-менеджера (аккаунт и задачи остаются, доступ к команде пропадает)
  r.delete('/team/:id', (req, res) => {
    requireAm(req);
    const id = toId(req.params.id);
    const gm = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'gm' AND team_id = ?`).get(id, req.user.id);
    if (!gm) throw new HttpError(404, 'Не найден в вашей команде');
    db.prepare('UPDATE users SET team_id = NULL WHERE id = ?').run(id);
    db.prepare(`DELETE FROM project_members WHERE user_id = ?
      AND project_id IN (SELECT id FROM projects WHERE team_id = ?)`).run(id, req.user.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { teamRouter, requireAm };
