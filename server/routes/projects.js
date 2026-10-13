const express = require('express');
const { HttpError, toId } = require('../util');
const { requireAm } = require('./team');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function projectsRouter({ db }) {
  const r = express.Router();

  const withMembers = (p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    memberIds: db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(p.id).map((m) => m.user_id),
    taskCount: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(p.id).n,
  });

  function validMemberIds(amId, ids) {
    if (!Array.isArray(ids)) return [];
    const clean = [...new Set(ids.map(toId).filter(Boolean))];
    for (const id of clean) {
      const ok = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'gm' AND team_id = ?`).get(id, amId);
      if (!ok) throw new HttpError(400, 'В проект можно добавить только гейм-менеджеров своей команды');
    }
    return clean;
  }

  function validate(body) {
    const name = String(body.name || '').trim();
    if (name.length < 1 || name.length > 60) throw new HttpError(400, 'Название проекта: от 1 до 60 символов');
    if (!COLOR_RE.test(body.color || '')) throw new HttpError(400, 'Выберите цвет проекта');
    return { name, color: body.color.toLowerCase() };
  }

  function setMembers(projectId, ids) {
    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
    const ins = db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const id of ids) ins.run(projectId, id);
  }

  const ownProject = (req) => {
    requireAm(req);
    const p = db.prepare('SELECT * FROM projects WHERE id = ? AND team_id = ?').get(toId(req.params.id), req.user.id);
    if (!p) throw new HttpError(404, 'Проект не найден');
    return p;
  };

  r.get('/projects', (req, res) => {
    if (!req.user.team_id) return res.json({ projects: [] });
    const rows = db.prepare('SELECT * FROM projects WHERE team_id = ? ORDER BY name').all(req.user.team_id);
    res.json({ projects: rows.map(withMembers) });
  });

  r.post('/projects', (req, res) => {
    requireAm(req);
    const { name, color } = validate(req.body || {});
    const members = validMemberIds(req.user.id, req.body.memberIds);
    const info = db.prepare('INSERT INTO projects (team_id, name, color) VALUES (?, ?, ?)').run(req.user.id, name, color);
    const id = Number(info.lastInsertRowid);
    setMembers(id, members);
    res.status(201).json({ project: withMembers(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)) });
  });

  r.patch('/projects/:id', (req, res) => {
    const p = ownProject(req);
    const { name, color } = validate({ ...p, ...req.body });
    db.prepare('UPDATE projects SET name = ?, color = ? WHERE id = ?').run(name, color, p.id);
    if (req.body.memberIds !== undefined) setMembers(p.id, validMemberIds(req.user.id, req.body.memberIds));
    res.json({ project: withMembers(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)) });
  });

  // Удаление проекта удаляет и его задачи — интерфейс просит подтверждение
  r.delete('/projects/:id', (req, res) => {
    const p = ownProject(req);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { projectsRouter };
