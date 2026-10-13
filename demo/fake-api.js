/* Демо-версия планнера без сервера: перехватывает запросы к /api и отвечает из данных в браузере.
   Правила доступа повторяют server/access.js. Данные только тестовые и живут в localStorage этого браузера.
   Telegram в демо ничего не отправляет. */
(() => {
  'use strict';
  const D = window.Deadline;
  const TZ = 'Europe/Minsk';
  const KEY = 'planner.demo.v1';
  const REMINDER_DAYS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  const SOUNDS = [
    ['alarm-classic.wav', 'Классический будильник'], ['chime.wav', 'Колокольчик'], ['jackpot.wav', 'Джекпот'], ['neon.wav', 'Неон'],
  ];
  const DEFAULT_AVATAR = 'assets/img/avatar-default.svg';

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const now = () => new Date();
  const iso = () => now().toISOString();

  // ---------- Тестовые данные ----------
  function seed() {
    const today = D.dayKey(now(), TZ);
    const at = (n, time = '15:00') => D.toInstant(D.addDays(today, n), time, TZ);
    const s = {
      nextId: 100, currentUserId: null, reminders: {},
      users: [
        { id: 1, name: 'Тестовый Аккаунт', login: 'test-am', password: 'demo1234', role: 'am', teamId: 1 },
        { id: 2, name: 'Иван Тестов', login: 'ivan-test', password: 'demo1234', role: 'gm', teamId: 1 },
        { id: 3, name: 'Пётр Тестов', login: 'petr-test', password: 'demo1234', role: 'gm', teamId: null },
      ].map((u) => ({ avatar: null, sound: 'default:alarm-classic.wav', notifyHour: 10, notifyOnCreate: u.role === 'gm', notifyOnDone: u.role === 'am', notifyDays: u.role === 'gm' ? [4, 1, 0] : [], tg: null, ...u })),
      projects: [
        { id: 10, teamId: 1, name: 'Проект Альфа', color: '#8b5cf6', memberIds: [2] },
        { id: 11, teamId: 1, name: 'TestGames релизы', color: '#06b6d4', memberIds: [2] },
      ],
      tasks: [
        [20, 'Подключить провайдера TestGames', 'Собрать документы для подключения TestGames', -1, 11, 'in_progress'],
        [21, 'Сетевой турнир TestGames', 'Согласовать призовой фонд и даты (тестовые)', 1, 11, 'new'],
        [22, 'Релиз игры TestGames', 'Проверить игру на стенде перед релизом', 2, 11, 'new'],
        [23, 'Скидки на слоты', 'Подготовить список слотов для акции', 4, 10, 'new'],
        [24, 'Пре-релиз новинки TestGames', 'Согласовать дату пре-релиза с TestGames', 6, 10, 'new'],
        [25, 'Локальный турнир Альфа', 'Подготовить правила турнира', 9, 10, 'new'],
      ].map(([id, title, description, n, projectId, status]) => ({
        id, teamId: 1, title, description, deadline: at(n), assigneeId: 2, authorId: 1, projectId, status,
        result: '', completedAt: null, createdAt: iso(),
      })),
      notifications: [],
    };
    s.tasks.push({
      id: 26, teamId: 1, title: 'Отчёт по прошлому турниру', description: 'Свести итоги турнира',
      deadline: at(0, '12:00'), assigneeId: 2, authorId: 1, projectId: 10, status: 'done',
      result: 'Итоги сведены и отправлены (тестовые данные)', completedAt: iso(), createdAt: iso(),
    });
    s.tasks.push({
      id: 27, teamId: 1, title: 'Созвон с TestGames', description: 'Личная задача аккаунт-менеджера',
      deadline: at(3, '11:30'), assigneeId: 1, authorId: 1, projectId: 11, status: 'new', result: '', completedAt: null, createdAt: iso(),
    });
    s.notifications.push({ id: 30, userId: 2, taskId: 25, kind: 'created', read: false, createdAt: iso(),
      message: '🆕 Вам новая задача от Тестовый Аккаунт: «Локальный турнир Альфа»\nПроект: Проект Альфа\nИсполнитель: Иван Тестов' });
    return s;
  }

  let db;
  function load() {
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch { db = null; }
    if (!db || !db.users) db = seed();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* приватный режим */ } }
  load();
  const nextId = () => ++db.nextId;

  // ---------- Помощники как на сервере ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const projectById = (id) => db.projects.find((p) => p.id === id);
  const publicUser = (u) => ({ id: u.id, name: u.name, login: u.login, role: u.role, teamId: u.teamId, avatar: u.avatar || DEFAULT_AVATAR });
  const soundUrl = (s) => (s && s.startsWith('custom:') ? s.slice(7) : `assets/audio/${(s || 'default:alarm-classic.wav').split(':')[1]}`);

  function visible(user, t) {
    if (user.role === 'am') return t.teamId === user.id;
    if (!user.teamId) return false;
    const a = userById(t.assigneeId);
    return t.teamId === user.teamId && a && a.role === 'gm' && a.teamId === t.teamId;
  }
  const visibleTasks = (user) => db.tasks.filter((t) => visible(user, t)).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const allowedAssignees = (user) => (user.role === 'am'
    ? db.users.filter((u) => u.id === user.id || (u.role === 'gm' && u.teamId === user.id))
    : user.teamId ? [user] : []);
  const allowedProjects = (user) => (user.role === 'am'
    ? db.projects.filter((p) => p.teamId === user.id)
    : db.projects.filter((p) => p.teamId === user.teamId && p.memberIds.includes(user.id)));

  function taskJson(t, user) {
    const p = projectById(t.projectId) || { name: '—', color: '#64748b' };
    const a = userById(t.assigneeId) || { name: '—' };
    const au = userById(t.authorId) || { name: '—' };
    return {
      id: t.id, title: t.title, description: t.description, deadline: t.deadline, status: t.status, result: t.result,
      completedAt: t.completedAt, createdAt: t.createdAt,
      project: { id: t.projectId, name: p.name, color: p.color },
      assignee: { id: t.assigneeId, name: a.name, avatar: a.avatar || DEFAULT_AVATAR },
      author: { id: t.authorId, name: au.name },
      canEdit: t.authorId === user.id,
      canChangeStatus: t.assigneeId === user.id || t.authorId === user.id,
    };
  }

  function me(user) {
    return {
      user: publicUser(user),
      settings: {
        sound: user.sound, soundUrl: soundUrl(user.sound), notifyHour: user.notifyHour,
        notifyOnCreate: user.notifyOnCreate, notifyOnDone: user.notifyOnDone, notifyDays: user.notifyDays,
        telegram: { available: true, botUsername: user.tg ? user.tg.botUsername : null, linked: !!(user.tg && user.tg.linked) },
      },
      config: { tz: TZ },
    };
  }

  // ---------- Уведомления (как server/notify.js) ----------
  const fmtDeadline = (s) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(s));
  const line = (t) => `«${t.title}»\nПроект: ${(projectById(t.projectId) || {}).name}\nСрок: ${fmtDeadline(t.deadline)}\nИсполнитель: ${(userById(t.assigneeId) || {}).name}`;
  const deliver = (u, t, kind, message) => db.notifications.push({ id: nextId(), userId: u.id, taskId: t.id, kind, message, read: false, createdAt: iso() });

  function runReminders() {
    const hour = D.zoned(now(), TZ).hour;
    for (const t of db.tasks) {
      if (t.status === 'done') continue;
      const d = D.daysLeft(t.deadline, now(), TZ);
      if (!REMINDER_DAYS.includes(d)) continue;
      for (const uid of new Set([t.assigneeId, t.authorId])) {
        const u = userById(uid);
        const key = `${t.id}|${uid}|${d}`;
        if (!u || hour < u.notifyHour || !u.notifyDays.includes(d) || db.reminders[key]) continue;
        db.reminders[key] = true;
        const word = d === 1 ? 'день' : d < 5 ? 'дня' : 'дней';
        deliver(u, t, `reminder${d}`, d === 0 ? `🔥 Сегодня дедлайн: ${line(t)}` : `⏰ До дедлайна ${d} ${word}: ${line(t)}`);
      }
    }
  }
  const resetReminders = (taskId) => { for (const k of Object.keys(db.reminders)) if (k.startsWith(taskId + '|')) delete db.reminders[k]; };

  // ---------- Маршруты ----------
  const requireAm = (u) => { if (u.role !== 'am') throw new HttpError(403, 'Доступно только аккаунт-менеджеру'); };
  const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const cleanTitle = (v) => { const s = String(v || '').trim(); if (!s || s.length > 200) throw new HttpError(400, 'Название задачи: от 1 до 200 символов'); return s; };
  const parseDeadline = (v) => { const d = new Date(v); if (!v || Number.isNaN(d.getTime())) throw new HttpError(400, 'Укажите дату и время дедлайна'); return d.toISOString(); };
  const projectJson = (p) => ({ id: p.id, name: p.name, color: p.color, memberIds: p.memberIds, taskCount: db.tasks.filter((t) => t.projectId === p.id).length });

  function route(method, path, query, body, user) {
    const m = (re) => path.match(re);
    let x;

    // Вход
    if (method === 'POST' && path === '/api/auth/login') {
      const u = db.users.find((v) => v.login.toLowerCase() === String(body.login || '').trim().toLowerCase());
      if (!u || u.password !== body.password) throw new HttpError(401, 'Неверный логин или пароль. В демо: test-am или ivan-test, пароль demo1234');
      db.currentUserId = u.id;
      return { user: publicUser(u) };
    }
    if (method === 'POST' && path === '/api/auth/register') {
      if (body.inviteCode !== 'demo') throw new HttpError(403, 'Неверный код приглашения. В демо код: demo');
      const login = String(body.login || '').trim();
      if (!/^[a-zA-Z0-9._-]{3,40}$/.test(login)) throw new HttpError(400, 'Логин: 3–40 символов, латиница, цифры, . _ -');
      if (db.users.some((v) => v.login.toLowerCase() === login.toLowerCase())) throw new HttpError(409, 'Такой логин уже занят');
      if (String(body.password || '').length < 8) throw new HttpError(400, 'Пароль: не короче 8 символов');
      const id = nextId();
      const u = { id, name: String(body.name || '').trim() || login, login, password: body.password, role: body.role === 'am' ? 'am' : 'gm',
        teamId: body.role === 'am' ? id : null, avatar: null, sound: 'default:alarm-classic.wav', notifyHour: 10,
        notifyOnCreate: false, notifyOnDone: false, notifyDays: [], tg: null };
      db.users.push(u);
      db.currentUserId = id;
      return { user: publicUser(u) };
    }
    if (method === 'POST' && path === '/api/auth/logout') { db.currentUserId = null; return { ok: true }; }

    if (!user) throw new HttpError(401, 'Нужно войти');

    // Профиль и настройки
    if (method === 'GET' && path === '/api/me') return me(user);
    if (method === 'GET' && path === '/api/sounds') return { sounds: SOUNDS.map(([f, title]) => ({ id: `default:${f}`, title, url: `assets/audio/${f}` })) };
    if (method === 'PUT' && path === '/api/me/avatar') { user.avatar = URL.createObjectURL(body); return me(user); }
    if (method === 'PUT' && path === '/api/me/sound-file') { user.sound = 'custom:' + URL.createObjectURL(body); return me(user); }
    if (method === 'PATCH' && path === '/api/me/settings') {
      if (body.sound !== undefined) user.sound = body.sound;
      if (body.notifyHour !== undefined) user.notifyHour = Number(body.notifyHour);
      if (body.notifyOnCreate !== undefined) user.notifyOnCreate = !!body.notifyOnCreate;
      if (body.notifyOnDone !== undefined) user.notifyOnDone = !!body.notifyOnDone;
      if (body.notifyDays !== undefined) {
        if (!body.notifyDays.every((d) => REMINDER_DAYS.includes(d))) throw new HttpError(400, 'Дни напоминаний: от 10 до 1 или 0');
        user.notifyDays = [...new Set(body.notifyDays)].sort((a, b) => b - a);
      }
      return me(user);
    }
    if (method === 'PUT' && path === '/api/me/telegram') {
      if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(String(body.token || '').trim())) {
        throw new HttpError(400, 'Это не похоже на ключ бота. В демо подойдёт любой ключ вида 123456789: и 35 латинских букв');
      }
      user.tg = { botUsername: 'demo_planner_bot', linked: true }; // в демо считаем, что Start уже нажат
      return { botUsername: 'demo_planner_bot', url: '#/settings', ...me(user) };
    }
    if (method === 'POST' && path === '/api/me/telegram/link') return { botUsername: 'demo_planner_bot', url: '#/settings' };
    if (method === 'POST' && path === '/api/me/telegram/test') return { ok: true };
    if (method === 'DELETE' && path === '/api/me/telegram') { user.tg = null; return me(user); }

    // Команда
    if (method === 'GET' && path === '/api/team') {
      const members = user.teamId ? db.users.filter((u) => u.teamId === user.teamId) : [user];
      return { members: members.sort((a, b) => (a.role + a.name).localeCompare(b.role + b.name)).map(publicUser) };
    }
    if (method === 'POST' && path === '/api/team') {
      requireAm(user);
      const gm = db.users.find((u) => u.login.toLowerCase() === String(body.login || '').trim().toLowerCase());
      if (!gm || gm.role !== 'gm') throw new HttpError(404, 'Гейм-менеджер с таким логином не найден. В демо есть свободный: petr-test');
      if (gm.teamId === user.id) throw new HttpError(409, 'Уже в вашей команде');
      if (gm.teamId) throw new HttpError(409, 'Этот гейм-менеджер уже состоит в другой команде');
      gm.teamId = user.id;
      return { member: publicUser(gm) };
    }
    if (method === 'DELETE' && (x = m(/^\/api\/team\/(\d+)$/))) {
      requireAm(user);
      const gm = userById(Number(x[1]));
      if (!gm || gm.role !== 'gm' || gm.teamId !== user.id) throw new HttpError(404, 'Не найден в вашей команде');
      gm.teamId = null;
      db.projects.filter((p) => p.teamId === user.id).forEach((p) => { p.memberIds = p.memberIds.filter((id) => id !== gm.id); });
      return { ok: true };
    }

    // Проекты
    if (method === 'GET' && path === '/api/projects') {
      return { projects: user.teamId ? db.projects.filter((p) => p.teamId === user.teamId).map(projectJson) : [] };
    }
    const validProject = (b, base = {}) => {
      const name = String(b.name !== undefined ? b.name : base.name || '').trim();
      const color = b.color !== undefined ? b.color : base.color;
      if (!name || name.length > 60) throw new HttpError(400, 'Название проекта: от 1 до 60 символов');
      if (!/^#[0-9a-fA-F]{6}$/.test(color || '')) throw new HttpError(400, 'Выберите цвет проекта');
      const memberIds = Array.isArray(b.memberIds) ? [...new Set(b.memberIds.map(toId).filter(Boolean))] : base.memberIds || [];
      if (memberIds.some((id) => { const u = userById(id); return !u || u.role !== 'gm' || u.teamId !== user.id; })) {
        throw new HttpError(400, 'В проект можно добавить только гейм-менеджеров своей команды');
      }
      return { name, color: color.toLowerCase(), memberIds };
    };
    if (method === 'POST' && path === '/api/projects') {
      requireAm(user);
      const p = { id: nextId(), teamId: user.id, ...validProject(body) };
      db.projects.push(p);
      return { project: projectJson(p) };
    }
    if ((x = m(/^\/api\/projects\/(\d+)$/))) {
      requireAm(user);
      const p = db.projects.find((v) => v.id === Number(x[1]) && v.teamId === user.id);
      if (!p) throw new HttpError(404, 'Проект не найден');
      if (method === 'PATCH') { Object.assign(p, validProject(body, p)); return { project: projectJson(p) }; }
      if (method === 'DELETE') {
        db.projects = db.projects.filter((v) => v !== p);
        db.tasks = db.tasks.filter((t) => t.projectId !== p.id);
        return { ok: true };
      }
    }

    // Задачи
    if (method === 'GET' && path === '/api/tasks/options') {
      return {
        assignees: allowedAssignees(user).map(publicUser),
        projects: allowedProjects(user).map((p) => ({ id: p.id, name: p.name, color: p.color })),
      };
    }
    if (method === 'GET' && path === '/api/tasks') {
      const from = query.get('from'), to = query.get('to');
      return { tasks: visibleTasks(user).filter((t) => (!from || t.deadline >= from) && (!to || t.deadline < to)).map((t) => taskJson(t, user)) };
    }
    const checkAssignee = (id) => {
      if (!allowedAssignees(user).some((u) => u.id === id)) {
        throw new HttpError(403, user.role === 'gm' ? 'Гейм-менеджер может назначить задачу только себе' : 'Исполнитель не из вашей команды');
      }
    };
    const checkProject = (id) => { if (!allowedProjects(user).some((p) => p.id === id)) throw new HttpError(403, 'Нет доступа к проекту'); };
    if (method === 'POST' && path === '/api/tasks') {
      if (!user.teamId) throw new HttpError(403, 'Сначала аккаунт-менеджер должен добавить вас в команду');
      const t = {
        id: nextId(), teamId: user.teamId, title: cleanTitle(body.title), description: String(body.description || '').slice(0, 5000),
        deadline: parseDeadline(body.deadline), assigneeId: toId(body.assigneeId) || user.id, authorId: user.id,
        projectId: toId(body.projectId), status: 'new', result: '', completedAt: null, createdAt: iso(),
      };
      checkAssignee(t.assigneeId);
      checkProject(t.projectId);
      db.tasks.push(t);
      const a = userById(t.assigneeId);
      if (a.id !== user.id && a.notifyOnCreate) deliver(a, t, 'created', `🆕 Вам новая задача от ${user.name}: ${line(t)}`);
      return { task: taskJson(t, user) };
    }
    if ((x = m(/^\/api\/tasks\/(\d+)$/))) {
      const t = db.tasks.find((v) => v.id === Number(x[1]));
      if (!t || !visible(user, t)) throw new HttpError(404, 'Задача не найдена');
      if (method === 'GET') return { task: taskJson(t, user) };
      if (method === 'DELETE') {
        if (t.authorId !== user.id) throw new HttpError(403, 'Удалить задачу может только её автор');
        db.tasks = db.tasks.filter((v) => v !== t);
        return { ok: true };
      }
      if (method === 'PATCH') {
        const next = { ...t };
        if (['title', 'description', 'deadline', 'assigneeId', 'projectId'].some((k) => body[k] !== undefined)) {
          if (t.authorId !== user.id) throw new HttpError(403, 'Редактировать задачу может только её автор');
          if (body.title !== undefined) next.title = cleanTitle(body.title);
          if (body.description !== undefined) next.description = String(body.description).slice(0, 5000);
          if (body.deadline !== undefined) next.deadline = parseDeadline(body.deadline);
          if (body.assigneeId !== undefined) { next.assigneeId = toId(body.assigneeId); checkAssignee(next.assigneeId); }
          if (body.projectId !== undefined) { next.projectId = toId(body.projectId); if (next.projectId !== t.projectId) checkProject(next.projectId); }
        }
        if (body.status !== undefined || body.result !== undefined) {
          if (!(t.assigneeId === user.id || t.authorId === user.id)) throw new HttpError(403, 'Статус меняют исполнитель и автор задачи');
          if (body.status !== undefined) next.status = body.status;
          if (body.result !== undefined) next.result = String(body.result).trim();
          if (next.status === 'done') {
            if (!next.result) throw new HttpError(400, 'Чтобы завершить задачу, напишите результат');
            if (t.status !== 'done') next.completedAt = iso();
          } else next.completedAt = null;
        }
        const wasDone = t.status === 'done';
        if (next.deadline !== t.deadline || next.assigneeId !== t.assigneeId) resetReminders(t.id);
        Object.assign(t, next);
        if (t.status === 'done' && !wasDone) {
          const author = userById(t.authorId);
          if (author.id !== user.id && author.notifyOnDone) deliver(author, t, 'done', `✅ Задача завершена: «${t.title}»\nРезультат: ${t.result}`);
        }
        return { task: visible(user, t) ? taskJson(t, user) : null };
      }
    }

    // Отчёт
    if (method === 'GET' && path === '/api/reports/week') {
      const start = D.mondayOf(query.get('start') || D.dayKey(now(), TZ));
      const end = D.addDays(start, 6);
      const inWeek = (s) => { const k = D.dayKey(s, TZ); return k >= start && k <= end; };
      const all = visibleTasks(user);
      const completed = all.filter((t) => t.status === 'done' && t.completedAt && inWeek(t.completedAt)).sort((a, b) => a.completedAt.localeCompare(b.completedAt));
      const overdue = all.filter((t) => t.status !== 'done' && new Date(t.deadline) < now() && inWeek(t.deadline));
      return {
        start, end, completed: completed.map((t) => taskJson(t, user)), overdue: overdue.map((t) => taskJson(t, user)),
        stats: { completed: completed.length, lateDone: completed.filter((t) => t.completedAt > t.deadline).length, overdue: overdue.length },
      };
    }

    // Уведомления
    if (method === 'GET' && path === '/api/notifications/unread') {
      runReminders();
      return { notifications: db.notifications.filter((n) => n.userId === user.id && !n.read).slice(0, 20)
        .map((n) => ({ id: n.id, taskId: n.taskId, kind: n.kind, message: n.message, createdAt: n.createdAt })) };
    }
    if (method === 'POST' && (x = m(/^\/api\/notifications\/(\d+)\/read$/))) {
      const n = db.notifications.find((v) => v.id === Number(x[1]) && v.userId === user.id);
      if (n) n.read = true;
      return { ok: true };
    }
    if (method === 'POST' && path === '/api/notifications/read-all') {
      db.notifications.forEach((n) => { if (n.userId === user.id) n.read = true; });
      return { ok: true };
    }
    throw new HttpError(404, 'Не найдено');
  }

  // ---------- Подмена fetch ----------
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^.*?(\/api\/)/, '/api/');
    if (!path.startsWith('/api/')) return realFetch(input, opts);
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const user = userById(db.currentUserId) || null;
    let status = 200, data;
    try {
      data = route(method, path, url.searchParams, body, user);
      if (method === 'POST' && (path === '/api/tasks' || path === '/api/projects' || path === '/api/team' || path === '/api/auth/register')) status = 201;
    } catch (e) {
      status = e.status || 500;
      data = { error: e.message };
    }
    save();
    await new Promise((r) => setTimeout(r, 60)); // как будто по сети
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };

  // В окне просмотра браузерные alert/confirm не показываются — заменяем своими
  function dialog(text, withCancel) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'overlay';
      box.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="desc" style="background:none;border:0;padding:0"></div><div class="actions"></div></div>';
      box.querySelector('.desc').textContent = text;
      const actions = box.querySelector('.actions');
      const btn = (label, cls, value) => {
        const b = document.createElement('button');
        b.textContent = label; b.className = cls;
        b.onclick = () => { box.remove(); resolve(value); };
        actions.append(b);
      };
      if (withCancel) btn('Отмена', '', false);
      btn('OK', 'btn-primary', true);
      document.body.append(box);
    });
  }
  window.alert = (text) => { dialog(String(text), false); };
  // confirm в приложении синхронный; в демо подтверждаем сразу и показываем, что действие выполнено
  window.confirm = (text) => { dialog(String(text).replace(/\?.*$/, '') + ' — выполнено (демо).', false); return true; };

  // Плашка демо-режима: быстрый вход под тестовыми пользователями и сброс данных
  function demoBar() {
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<b>ДЕМО</b><span>тестовые данные, только в этом браузере</span>';
    const add = (label, fn) => { const b = document.createElement('button'); b.className = 'btn-small'; b.textContent = label; b.onclick = fn; bar.append(b); };
    const as = (login) => async () => {
      await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ login, password: 'demo1234' }) });
      location.hash = '#/calendar';
      location.reload();
    };
    add('Войти как аккаунт-менеджер', as('test-am'));
    add('Войти как гейм-менеджер', as('ivan-test'));
    add('Сбросить демо', () => { db = seed(); save(); location.hash = ''; location.reload(); });
    document.body.append(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demoBar); else demoBar();
})();
