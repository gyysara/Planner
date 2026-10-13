// Уведомления: при создании задачи сразу; за 5 дней, за 2 дня и в день дедлайна —
// в выбранный пользователем час (по умолчанию 10:00 по Минску).
// Получатели: исполнитель и автор задачи. Канал: браузер (таблица notifications) + Telegram.
const Deadline = require('../shared/deadline');
const { TASK_SELECT } = require('./access');

function createNotifier({ db, config, telegram }) {
  const fmtDeadline = (iso) => new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));

  const loadTask = (id) => db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);

  function recipients(task) {
    const ids = [...new Set([task.assignee_id, task.author_id])];
    return ids.map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)).filter(Boolean);
  }

  function deliver(user, task, kind, message) {
    db.prepare('INSERT INTO notifications (user_id, task_id, kind, message) VALUES (?, ?, ?, ?)')
      .run(user.id, task.id, kind, message);
    if (user.tg_chat_id) telegram.send(user.tg_chat_id, message);
  }

  // Коротко, без описания: название, проект, срок
  const line = (t) => `«${t.title}»\nПроект: ${t.project_name}\nСрок: ${fmtDeadline(t.deadline)}\nИсполнитель: ${t.assignee_name}`;

  function taskCreated(taskId, now = new Date()) {
    const task = loadTask(taskId);
    const stage = Deadline.reminderStage(task, now, config.tz);
    for (const u of recipients(task)) {
      const msg = u.id === task.assignee_id && u.id !== task.author_id
        ? `🆕 Вам новая задача от ${task.author_name}: ${line(task)}`
        : `🆕 Новая задача: ${line(task)}`;
      deliver(u, task, 'created', msg);
      // Уведомление о создании уже сообщает срок — текущую стадию повторно не шлём
      if (stage !== null) markSent(task.id, u.id, stage);
    }
  }

  function taskReassigned(taskId) {
    const task = loadTask(taskId);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(task.assignee_id);
    if (u && u.id !== task.author_id) deliver(u, task, 'assigned', `👤 Вам назначена задача: ${line(task)}`);
  }

  function taskDone(taskId, byUserId) {
    const task = loadTask(taskId);
    for (const u of recipients(task)) {
      if (u.id === byUserId) continue;
      deliver(u, task, 'done', `✅ Задача завершена: «${task.title}»\nРезультат: ${task.result}`);
    }
  }

  function resetReminders(taskId) {
    db.prepare('DELETE FROM reminders_sent WHERE task_id = ?').run(taskId);
  }

  function markSent(taskId, userId, stage) {
    db.prepare('INSERT OR IGNORE INTO reminders_sent (task_id, user_id, stage) VALUES (?, ?, ?)').run(taskId, userId, stage);
  }

  const reminderText = (stage, t) => {
    if (stage === 0) return `🔥 Сегодня дедлайн: ${line(t)}`;
    if (stage === 2) return `🟥 До дедлайна 2 дня или меньше: ${line(t)}`;
    return `🟨 До дедлайна 5 дней или меньше: ${line(t)}`;
  };

  // Вызывается планировщиком раз в минуту
  function runReminders(now = new Date()) {
    const hour = Deadline.zoned(now, config.tz).hour;
    const since = new Date(now.getTime() - 2 * 86400000).toISOString();
    const tasks = db.prepare(`${TASK_SELECT} WHERE t.status != 'done' AND t.deadline >= ?`).all(since);
    let sent = 0;
    for (const task of tasks) {
      const stage = Deadline.reminderStage(task, now, config.tz);
      if (stage === null) continue;
      for (const u of recipients(task)) {
        // Уже отправлена эта или более срочная стадия
        const done = db.prepare('SELECT 1 FROM reminders_sent WHERE task_id = ? AND user_id = ? AND stage <= ?')
          .get(task.id, u.id, stage);
        if (done || hour < u.notify_hour) continue;
        markSent(task.id, u.id, stage);
        deliver(u, task, `reminder${stage}`, reminderText(stage, task));
        sent++;
      }
    }
    return sent;
  }

  let timer = null;
  return {
    taskCreated, taskReassigned, taskDone, resetReminders, runReminders,
    start() { timer = setInterval(() => { try { runReminders(); } catch (e) { console.error(e); } }, 60000); },
    stop() { clearInterval(timer); },
  };
}

module.exports = { createNotifier };
