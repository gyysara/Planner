// Расчёт сроков: дни до дедлайна и рамка карточки.
// Один файл для сервера (require) и браузера (window.Deadline).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Deadline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400000;
  const formatters = {};

  function fmt(tz) {
    const key = tz || '';
    if (!formatters[key]) {
      formatters[key] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    }
    return formatters[key];
  }

  // Части даты в часовом поясе tz: { key: 'YYYY-MM-DD', hour, minute }
  function zoned(date, tz) {
    const p = {};
    for (const part of fmt(tz).formatToParts(new Date(date))) p[part.type] = part.value;
    return { key: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
  }

  function dayKey(date, tz) {
    return zoned(date, tz).key;
  }

  function addDays(key, n) {
    return new Date(Date.parse(key + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  }

  function diffDays(fromKey, toKey) {
    return Math.round((Date.parse(toKey + 'T00:00:00Z') - Date.parse(fromKey + 'T00:00:00Z')) / DAY);
  }

  // Понедельник недели, в которую попадает key
  function mondayOf(key) {
    const dow = new Date(key + 'T00:00:00Z').getUTCDay(); // 0 = вс
    return addDays(key, dow === 0 ? -6 : 1 - dow);
  }

  // Сколько календарных дней до дедлайна (0 = сегодня, отрицательное = прошёл)
  function daysLeft(deadline, now, tz) {
    return diffDays(dayKey(now, tz), dayKey(deadline, tz));
  }

  // Рамка карточки: none | normal | yellow | red | overdue
  function borderStage(task, now, tz) {
    if (task.status === 'done') return 'none';
    const dl = new Date(task.deadline);
    if (dl.getTime() < new Date(now).getTime()) return 'overdue';
    const d = daysLeft(dl, now, tz);
    if (d <= 2) return 'red';
    if (d <= 5) return 'yellow';
    return 'normal';
  }

  // Дата 'YYYY-MM-DD' и время 'HH:MM' в поясе tz → ISO-строка UTC
  function toInstant(key, time, tz) {
    const guess = Date.parse(`${key}T${time}:00Z`);
    let t = guess;
    for (let i = 0; i < 2; i++) {
      const z = zoned(t, tz);
      const asUtc = Date.parse(`${z.key}T${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}:00Z`);
      t -= asUtc - guess;
    }
    return new Date(t).toISOString();
  }

  // Повторяющиеся задачи: n-е повторение (n = 0 — первое) от исходного дедлайна.
  // Раз в месяц — то же число; если в месяце его нет (31-е), берётся последний день месяца.
  const REPEATS = ['daily', 'weekly', 'biweekly', 'monthly'];
  function occurrence(anchorIso, repeat, n, tz) {
    const z = zoned(anchorIso, tz);
    const time = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
    let key;
    if (repeat === 'daily') key = addDays(z.key, n);
    else if (repeat === 'weekly') key = addDays(z.key, 7 * n);
    else if (repeat === 'biweekly') key = addDays(z.key, 14 * n);
    else if (repeat === 'monthly') {
      const [y, m, d] = z.key.split('-').map(Number);
      const first = new Date(Date.UTC(y, m - 1 + n, 1));
      const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      key = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
    } else throw new Error('unknown repeat');
    return toInstant(key, time, tz);
  }

  return { zoned, dayKey, addDays, diffDays, mondayOf, daysLeft, borderStage, toInstant, REPEATS, occurrence };
});
