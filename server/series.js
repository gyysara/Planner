// Повторяющиеся задачи. Серия хранит правило (каждый день / раз в неделю / раз в две недели / раз в месяц),
// а повторения создаются заранее обычными задачами — со своим статусом, результатом и местом в отчёте.
// Горизонт: 60 дней вперёд (и дальше, если календарь открыт на более поздний период, но не дальше года).
const Deadline = require('../shared/deadline');

const HORIZON_DAYS = 60;
const MAX_DAYS = 366;
const DAY = 86400000;

function createSeries({ db, config }) {
  const insertTask = db.prepare(`INSERT INTO tasks (team_id, title, description, deadline, assignee_id, author_id, project_id, series_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  // Создать повторения серии с дедлайнами до until (ISO)
  function extendOne(series, untilIso) {
    let n = series.next_index;
    let created = 0;
    for (; created < 500; n++) {
      const deadline = Deadline.occurrence(series.anchor, series.repeat, n, config.tz);
      if (deadline > untilIso) break;
      insertTask.run(series.team_id, series.title, series.description, deadline, series.assignee_id, series.author_id, series.project_id, series.id);
      created++;
    }
    if (n !== series.next_index) db.prepare('UPDATE task_series SET next_index = ? WHERE id = ?').run(n, series.id);
    return created;
  }

  function clampUntil(toIso, now = new Date()) {
    const min = new Date(now.getTime() + HORIZON_DAYS * DAY).toISOString();
    const max = new Date(now.getTime() + MAX_DAYS * DAY).toISOString();
    const want = toIso && toIso > min ? toIso : min;
    return want < max ? want : max;
  }

  // Создать серию и её первые повторения; возвращает id первой задачи
  function create({ teamId, repeat, anchor, title, description, assigneeId, authorId, projectId }) {
    const info = db.prepare(`INSERT INTO task_series (team_id, repeat, anchor, title, description, assignee_id, author_id, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(teamId, repeat, anchor, title, description, assigneeId, authorId, projectId);
    const series = db.prepare('SELECT * FROM task_series WHERE id = ?').get(Number(info.lastInsertRowid));
    // Первое повторение создаётся всегда, даже если дедлайн дальше горизонта
    insertTask.run(series.team_id, title, description, anchor, assigneeId, authorId, projectId, series.id);
    db.prepare('UPDATE task_series SET next_index = 1 WHERE id = ?').run(series.id);
    const firstId = db.prepare('SELECT id FROM tasks WHERE series_id = ? ORDER BY deadline LIMIT 1').get(series.id).id;
    extendOne({ ...series, next_index: 1 }, clampUntil(null));
    return firstId;
  }

  // Достроить повторения команды (или всех команд) до нужной даты
  function ensure({ teamId, toIso } = {}) {
    const until = clampUntil(toIso);
    const rows = teamId
      ? db.prepare('SELECT * FROM task_series WHERE active = 1 AND team_id = ?').all(teamId)
      : db.prepare('SELECT * FROM task_series WHERE active = 1').all();
    let n = 0;
    for (const s of rows) n += extendOne(s, until);
    return n;
  }

  // Прекратить повторение: будущие незавершённые повторения после этой задачи удаляются
  function stop(seriesId, afterDeadline) {
    db.prepare('UPDATE task_series SET active = 0 WHERE id = ?').run(seriesId);
    const info = db.prepare(`DELETE FROM tasks WHERE series_id = ? AND deadline > ? AND status != 'done'`).run(seriesId, afterDeadline);
    return Number(info.changes);
  }

  return { create, ensure, stop };
}

module.exports = { createSeries };
