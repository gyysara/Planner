const express = require('express');
const Deadline = require('../../shared/deadline');
const { HttpError } = require('../util');
const access = require('../access');
const { taskJson } = require('./tasks');

// Недельный отчёт: понедельник–воскресенье в часовом поясе команды
function reportsRouter({ db, config }) {
  const r = express.Router();

  r.get('/reports/week', (req, res) => {
    let start = String(req.query.start || Deadline.dayKey(new Date(), config.tz));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) throw new HttpError(400, 'Неверная дата');
    start = Deadline.mondayOf(start);
    const end = Deadline.addDays(start, 6);
    const all = access.listVisibleTasks(db, req.user);
    const inWeek = (iso) => { const k = Deadline.dayKey(iso, config.tz); return k >= start && k <= end; };

    const completed = all.filter((t) => t.status === 'done' && t.completed_at && inWeek(t.completed_at))
      .sort((a, b) => a.completed_at.localeCompare(b.completed_at));
    const now = new Date();
    const overdue = all.filter((t) => t.status !== 'done' && new Date(t.deadline) < now && inWeek(t.deadline));
    const lateDone = completed.filter((t) => t.completed_at > t.deadline).length;

    res.json({
      start, end,
      completed: completed.map((t) => taskJson(t, req.user)),
      overdue: overdue.map((t) => taskJson(t, req.user)),
      stats: { completed: completed.length, lateDone, overdue: overdue.length },
    });
  });

  return r;
}

module.exports = { reportsRouter };
