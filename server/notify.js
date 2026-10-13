// Уведомления приходят только по выбору пользователя (Настройки):
//  — «когда мне ставят задачу», «когда мою задачу завершили»;
//  — за 5, 4, 3, 1 день и в день дедлайна — в выбранный пользователем час (по умолчанию 10:00 по Минску).
// По умолчанию ничего не выбрано. Каналы: браузер (таблица notifications) + личный Telegram-бот.
const Deadline = require('../shared/deadline');
const { TASK_SELECT } = require('./access');

// За сколько дней можно выбрать напоминание (0 — в день дедлайна)
const REMINDER_DAYS = [5, 4, 3, 1, 0];
const parseDays = (str) => String(str || '').split(',').filter((x) => x !== '').map(Number).filter((n) => REMINDER_DAYS.includes(n));

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
    telegram.send(user, message);
  }

  const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

  // Коротко, без описания: название, проект, срок
  const line = (t) => `«${t.title}»\nПроект: ${t.project_name}\nСрок: ${fmtDeadline(t.deadline)}\nИсполнитель: ${t.assignee_name}`;

  // Новая задача — только исполнителю, если её поставил другой человек и он включил эту галочку
  function taskCreated(taskId) {
    const task = loadTask(taskId);
    const u = userById(task.assignee_id);
    if (u && u.id !== task.author_id && u.notify_on_create) {
      deliver(u, task, 'created', `🆕 Вам новая задача от ${task.author_name}: ${line(task)}`);
    }
  }

  function taskReassigned(taskId) {
    const task = loadTask(taskId);
    const u = userById(task.assignee_id);
    if (u && u.id !== task.author_id && u.notify_on_create) {
      deliver(u, task, 'assigned', `👤 Вам назначена задача: ${line(task)}`);
    }
  }

  // Завершение — автору, если завершил другой человек и автор включил эту галочку
  function taskDone(taskId, byUserId) {
    const task = loadTask(taskId);
    const u = userById(task.author_id);
    if (u && u.id !== byUserId && u.notify_on_done) {
      deliver(u, task, 'done', `✅ Задача завершена: «${task.title}»\nРезультат: ${task.result}`);
    }
  }

  function resetReminders(taskId) {
    db.prepare('DELETE FROM reminders_sent WHERE task_id = ?').run(taskId);
  }

  const reminderText = (d, t) => (d === 0
    ? `🔥 Сегодня дедлайн: ${line(t)}`
    : `⏰ До дедлайна ${d} ${d === 1 ? 'день' : d < 5 ? 'дня' : 'дней'}: ${line(t)}`);

  // Вызывается планировщиком раз в минуту. Пропущенные дни задним числом не догоняем.
  function runReminders(now = new Date()) {
    const hour = Deadline.zoned(now, config.tz).hour;
    const since = new Date(now.getTime() - 86400000).toISOString();
    const tasks = db.prepare(`${TASK_SELECT} WHERE t.status != 'done' AND t.deadline >= ?`).all(since);
    let sent = 0;
    for (const task of tasks) {
      const d = Deadline.daysLeft(task.deadline, now, config.tz);
      if (!REMINDER_DAYS.includes(d)) continue;
      for (const u of recipients(task)) {
        if (hour < u.notify_hour || !parseDays(u.notify_days).includes(d)) continue;
        const info = db.prepare('INSERT OR IGNORE INTO reminders_sent (task_id, user_id, stage) VALUES (?, ?, ?)').run(task.id, u.id, d);
        if (!info.changes) continue; // уже отправляли
        deliver(u, task, `reminder${d}`, reminderText(d, task));
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

module.exports = { createNotifier, REMINDER_DAYS, parseDays };
