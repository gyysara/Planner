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

  return { zoned, dayKey, addDays, diffDays, mondayOf, daysLeft, borderStage, toInstant };
});
