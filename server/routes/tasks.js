const express = require('express');
const { HttpError, publicUser, toId } = require('../util');
const access = require('../access');

const STATUSES = ['new', 'in_progress', 'done'];

function taskJson(t, user) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    deadline: t.deadline,
    status: t.status,
    result: t.result,
    completedAt: t.completed_at,
    createdAt: t.created_at,
    project: { id: t.project_id, name: t.project_name, color: t.project_color },
    assignee: { id: t.assignee_id, name: t.assignee_name, avatar: t.assignee_avatar ? `/files/${t.assignee_avatar}` : '/assets/img/avatar-default.svg' },
    author: { id: t.author_id, name: t.author_name },
    repeat: t.series_id && t.series_active ? t.series_repeat : null,
    canEdit: access.canEditTask(user, t),
    canChangeStatus: access.canChangeStatus(user, t),
  };
}

function parseDeadline(v) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw new HttpError(400, 'Укажите дату и время дедлайна');
  return d.toISOString();
}

const REPEAT_VALUES = ['none', ...require('../../shared/deadline').REPEATS];

function tasksRouter({ db, notifier, series }) {
  const r = express.Router();

  const checkAssignee = (user, id) => {
    if (!access.allowedAssignees(db, user).some((u) => u.id === id)) {
      throw new HttpError(403, user.role === 'gm' ? 'Гейм-менеджер может назначить задачу только себе' : 'Исполнитель не из вашей команды');
    }
  };
  const checkProject = (user, id) => {
    if (!access.allowedProjects(db, user).some((p) => p.id === id)) throw new HttpError(403, 'Нет доступа к проекту');
  };
  const cleanTitle = (v) => {
    const s = String(v || '').trim();
    if (!s || s.length > 200) throw new HttpError(400, 'Название задачи: от 1 до 200 символов');
    return s;
  };
  const cleanDesc = (v) => String(v || '').slice(0, 5000);

  // Списки для формы: кого можно назначить и в какие проекты
  r.get('/tasks/options', (req, res) => {
    res.json({
      assignees: access.allowedAssignees(db, req.user).map(publicUser),
      projects: access.allowedProjects(db, req.user).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    });
  });

  r.get('/tasks', (req, res) => {
    const from = req.query.from ? parseDeadline(req.query.from) : undefined;
    const to = req.query.to ? parseDeadline(req.query.to) : undefined;
    if (req.user.team_id) series.ensure({ teamId: req.user.team_id, toIso: to });
    res.json({ tasks: access.listVisibleTasks(db, req.user, { from, to }).map((t) => taskJson(t, req.user)) });
  });

  r.get('/tasks/:id', (req, res) => {
    const t = access.getVisibleTask(db, req.user, toId(req.params.id));
    if (!t) throw new HttpError(404, 'Задача не найдена');
    res.json({ task: taskJson(t, req.user) });
  });

  r.post('/tasks', (req, res) => {
    const b = req.body || {};
    if (!req.user.team_id) throw new HttpError(403, 'Сначала аккаунт-менеджер должен добавить вас в команду');
    const title = cleanTitle(b.title);
    const deadline = parseDeadline(b.deadline);
    const assigneeId = toId(b.assigneeId) || req.user.id;
    const projectId = toId(b.projectId);
    const repeat = b.repeat || 'none';
    if (!REPEAT_VALUES.includes(repeat)) throw new HttpError(400, 'Неизвестный вариант повторения');
    checkAssignee(req.user, assigneeId);
    checkProject(req.user, projectId);
    let id;
    if (repeat === 'none') {
      const info = db.prepare(`INSERT INTO tasks (team_id, title, description, deadline, assignee_id, author_id, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.team_id, title, cleanDesc(b.description), deadline, assigneeId, req.user.id, projectId);
      id = Number(info.lastInsertRowid);
    } else {
      // Уведомление о новой задаче — один раз на всю серию
      id = series.create({ teamId: req.user.team_id, repeat, anchor: deadline, title, description: cleanDesc(b.description),
        assigneeId, authorId: req.user.id, projectId });
    }
    notifier.taskCreated(id);
    res.status(201).json({ task: taskJson(access.getVisibleTask(db, req.user, id), req.user) });
  });

  r.patch('/tasks/:id', (req, res) => {
    const t = access.getVisibleTask(db, req.user, toId(req.params.id));
    if (!t) throw new HttpError(404, 'Задача не найдена');
    const b = req.body || {};
    // Прекратить повторение (только автор): будущие незавершённые повторения удаляются
    if (b.stopRepeat) {
      if (!access.canEditTask(req.user, t)) throw new HttpError(403, 'Остановить повторение может только автор задачи');
      if (!t.series_id) throw new HttpError(400, 'Это не повторяющаяся задача');
      const removed = series.stop(t.series_id, t.deadline);
      const updated = access.getVisibleTask(db, req.user, t.id);
      return res.json({ task: updated ? taskJson(updated, req.user) : null, removed });
    }
    const next = { title: t.title, description: t.description, deadline: t.deadline, assignee_id: t.assignee_id,
      project_id: t.project_id, status: t.status, result: t.result, completed_at: t.completed_at };

    const editsFields = ['title', 'description', 'deadline', 'assigneeId', 'projectId'].some((k) => b[k] !== undefined);
    if (editsFields) {
      if (!access.canEditTask(req.user, t)) throw new HttpError(403, 'Редактировать задачу может только её автор');
      if (b.title !== undefined) next.title = cleanTitle(b.title);
      if (b.description !== undefined) next.description = cleanDesc(b.description);
      if (b.deadline !== undefined) next.deadline = parseDeadline(b.deadline);
      if (b.assigneeId !== undefined) { next.assignee_id = toId(b.assigneeId); checkAssignee(req.user, next.assignee_id); }
      if (b.projectId !== undefined) { next.project_id = toId(b.projectId); if (next.project_id !== t.project_id) checkProject(req.user, next.project_id); }
    }

    if (b.status !== undefined || b.result !== undefined) {
      if (!access.canChangeStatus(req.user, t)) throw new HttpError(403, 'Статус меняют исполнитель и автор задачи');
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Неизвестный статус');
        next.status = b.status;
      }
      if (b.result !== undefined) next.result = String(b.result).trim().slice(0, 5000);
      if (next.status === 'done') {
        if (!next.result) throw new HttpError(400, 'Чтобы завершить задачу, напишите результат');
        if (t.status !== 'done') next.completed_at = new Date().toISOString();
      } else {
        next.completed_at = null;
      }
    }

    db.prepare(`UPDATE tasks SET title = ?, description = ?, deadline = ?, assignee_id = ?, project_id = ?,
      status = ?, result = ?, completed_at = ? WHERE id = ?`).run(next.title, next.description, next.deadline,
      next.assignee_id, next.project_id, next.status, next.result, next.completed_at, t.id);

    if (next.deadline !== t.deadline || next.assignee_id !== t.assignee_id) notifier.resetReminders(t.id);
    if (next.assignee_id !== t.assignee_id) notifier.taskReassigned(t.id);
    if (next.status === 'done' && t.status !== 'done') notifier.taskDone(t.id, req.user.id);

    const updated = access.getVisibleTask(db, req.user, t.id);
    res.json({ task: updated ? taskJson(updated, req.user) : null });
  });

  r.delete('/tasks/:id', (req, res) => {
    const t = access.getVisibleTask(db, req.user, toId(req.params.id));
    if (!t) throw new HttpError(404, 'Задача не найдена');
    if (!access.canEditTask(req.user, t)) throw new HttpError(403, 'Удалить задачу может только её автор');
    db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { tasksRouter, taskJson };
