/* Планнер задач — клиент (без сборки). Даты считаются в поясе команды (config.tz). */
(() => {
  'use strict';
  const D = window.Deadline;
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');

  const state = {
    me: null, settings: null, tz: 'Europe/Minsk',
    view: localStorageGet('view') || 'month',
    cursor: null, // 'YYYY-MM-DD' — опорная дата календаря
    tasks: [], options: { assignees: [], projects: [] },
    seenNotifications: new Set(), pollTimer: null, firstPoll: true,
  };

  const STATUS = { new: 'Новая', in_progress: 'В работе', done: 'Завершено' };
  const REPEAT = { none: 'Не повторять', daily: 'Каждый день', weekly: 'Раз в неделю', biweekly: 'Раз в две недели', monthly: 'Раз в месяц' };
  const PALETTE = [
    ['#8b5cf6', 'Фиолетовый'], ['#3b82f6', 'Синий'], ['#06b6d4', 'Бирюзовый'], ['#14b8a6', 'Морская волна'],
    ['#22c55e', 'Зелёный'], ['#ec4899', 'Розовый'], ['#f97316', 'Оранжевый'], ['#64748b', 'Сланцевый'],
  ];
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  function localStorageGet(k) { try { return localStorage.getItem('planner.' + k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem('planner.' + k, v); } catch { /* недоступно */ } }

  // ---------- DOM-помощник (без innerHTML для пользовательских данных) ----------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k === 'vars') for (const [n, val] of Object.entries(v)) node.style.setProperty(n, val);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // Текст со ссылками: http(s)://… и www.… становятся активными ссылками (открываются в новой вкладке)
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"«»]+/gi;
  function linkify(text) {
    const out = [];
    let last = 0;
    for (const m of String(text || '').matchAll(URL_RE)) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]]+$/); // знаки препинания в конце — не часть ссылки
      if (trail) url = url.slice(0, -trail[0].length);
      if (m.index > last) out.push(text.slice(last, m.index));
      const href = url.toLowerCase().startsWith('www.') ? 'https://' + url : url;
      out.push(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, url));
      last = m.index + url.length;
    }
    if (last < String(text || '').length) out.push(String(text).slice(last));
    return out;
  }

  // ---------- API ----------
  async function api(method, url, body, rawType) {
    const headers = { 'X-Requested-With': 'planner' };
    let payload;
    if (rawType !== undefined) { headers['Content-Type'] = rawType || 'application/octet-stream'; payload = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (res.status === 401 && !url.startsWith('/api/auth')) { stopPolling(); state.me = null; renderAuth(); }
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }

  // ---------- Даты ----------
  const today = () => D.dayKey(new Date(), state.tz);
  const fmt = (iso, opts) => new Intl.DateTimeFormat('ru-RU', { timeZone: state.tz, ...opts }).format(new Date(iso));
  const fmtDateTime = (iso) => fmt(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
  const keyToDate = (key) => new Date(key + 'T12:00:00Z');
  const fmtKey = (key, opts) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', ...opts }).format(keyToDate(key));
  const ddmm = (key) => fmtKey(key, { day: '2-digit', month: '2-digit' });

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return L > 0.33 ? '#121218' : '#ffffff';
  }
  const projectVars = (color) => ({ '--pc': color, '--fg': textColorFor(color) });

  // ---------- Вход и регистрация ----------
  function renderAuth(mode = 'login') {
    $app.replaceChildren();
    const err = el('div', { class: 'error', role: 'alert' });
    const isReg = mode === 'register';

    const form = el('form', { onsubmit: submit },
      isReg && el('label', {}, 'Имя', el('input', { type: 'text', name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
      el('label', {}, 'Логин', el('input', { type: 'text', name: 'login', required: true, autocomplete: 'username', pattern: '[a-zA-Z0-9._\\-]{3,40}', title: '3–40 символов: латиница, цифры, . _ -' })),
      el('label', {}, 'Пароль', el('input', { type: 'password', name: 'password', required: true, minlength: isReg ? 8 : undefined, autocomplete: isReg ? 'new-password' : 'current-password' })),
      isReg && [
        el('div', { class: 'muted' }, 'Роль'),
        el('div', { class: 'roles' },
          el('label', {}, el('input', { type: 'radio', name: 'role', value: 'am', required: true }), 'Аккаунт-менеджер'),
          el('label', {}, el('input', { type: 'radio', name: 'role', value: 'gm', checked: true }), 'Гейм-менеджер')),
        el('label', {}, 'Аватарка (PNG, JPEG, WEBP до 2 МБ)', el('input', { type: 'file', name: 'avatar', accept: 'image/png,image/jpeg,image/webp' })),
        el('label', {}, 'Код приглашения', el('input', { type: 'password', name: 'inviteCode', required: true, autocomplete: 'off' })),
      ],
      err,
      el('button', { class: 'btn-primary', type: 'submit', style: { width: '100%' } }, isReg ? 'Зарегистрироваться' : 'Войти'));

    $app.append(el('div', { class: 'auth' }, el('div', { class: 'auth-box' },
      el('div', { class: 'logo' }, 'TASK ', el('span', {}, 'PLANNER')),
      el('div', { class: 'muted' }, 'Задачи аккаунт- и гейм-менеджеров'),
      el('div', { class: 'tabs' },
        el('button', { type: 'button', class: !isReg ? 'active' : '', onclick: () => renderAuth('login') }, 'Вход'),
        el('button', { type: 'button', class: isReg ? 'active' : '', onclick: () => renderAuth('register') }, 'Регистрация')),
      form)));

    async function submit(e) {
      e.preventDefault();
      err.textContent = '';
      const f = new FormData(form);
      try {
        if (isReg) {
          await api('POST', '/api/auth/register', {
            name: f.get('name'), login: f.get('login'), password: f.get('password'), role: f.get('role'), inviteCode: f.get('inviteCode'),
          });
          const file = f.get('avatar');
          if (file && file.size) {
            try { await api('PUT', '/api/me/avatar', file, file.type); } catch (e2) { alert('Аккаунт создан, но аватарка не загрузилась: ' + e2.message); }
          }
        } else {
          await api('POST', '/api/auth/login', { login: f.get('login'), password: f.get('password') });
        }
        await boot();
      } catch (e2) { err.textContent = e2.message; }
    }
  }

  // ---------- Каркас ----------
  const ROUTES = { calendar: 'Календарь', projects: 'Проекты', team: 'Команда', reports: 'Отчёты', settings: 'Настройки' };
  const route = () => (location.hash.replace('#/', '') || 'calendar').split('?')[0];

  function renderShell() {
    const r = ROUTES[route()] ? route() : 'calendar';
    // Плавное появление страницы — только при переходе на другую страницу, не при обновлении данных
    const main = el('main', { id: 'main', class: state.lastRoute !== r ? 'page-enter' : '' });
    state.lastRoute = r;
    $app.replaceChildren(
      el('header', { class: 'topbar' },
        el('div', { class: 'logo' }, 'TASK ', el('span', {}, 'PLANNER')),
        el('nav', { class: 'nav' }, Object.entries(ROUTES).map(([k, title]) => el('a', { href: '#/' + k, class: k === r ? 'active' : '' }, title))),
        el('div', { class: 'me' },
          el('img', { class: 'avatar', src: state.me.avatar, alt: '' }),
          el('div', {}, el('div', {}, state.me.name), el('div', { class: 'muted', style: { fontSize: '12px' } }, state.me.role === 'am' ? 'Аккаунт-менеджер' : 'Гейм-менеджер')),
          el('button', { class: 'btn-small btn-logout', onclick: logout }, 'Выйти'))),
      main);
    if (state.me.role === 'gm' && !state.me.teamId) {
      main.append(el('div', { class: 'banner' }, 'Вы ещё не в команде. Сообщите аккаунт-менеджеру свой логин ', el('b', {}, state.me.login), ' — после привязки здесь появятся задачи.'));
    }
    ({ calendar: renderCalendar, projects: renderProjects, team: renderTeam, reports: renderReports, settings: renderSettings })[r](main);
  }

  async function logout() {
    await api('POST', '/api/auth/logout').catch(() => {});
    stopPolling();
    state.me = null;
    renderAuth();
  }

  // ---------- Календарь ----------
  function calendarRange() {
    if (state.view === 'week') {
      const start = D.mondayOf(state.cursor);
      return { start, days: 7 };
    }
    const first = state.cursor.slice(0, 8) + '01';
    const start = D.mondayOf(first);
    return { start, days: 42 };
  }

  async function loadTasks() {
    const { start, days } = calendarRange();
    const from = D.toInstant(start, '00:00', state.tz);
    const to = D.toInstant(D.addDays(start, days), '00:00', state.tz);
    const [t, o] = await Promise.all([
      api('GET', `/api/tasks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      api('GET', '/api/tasks/options'),
    ]);
    state.tasks = t.tasks;
    state.options = o;
  }

  async function renderCalendar(main) {
    const title = state.view === 'week'
      ? (() => { const s = D.mondayOf(state.cursor); return `${ddmm(s)}–${ddmm(D.addDays(s, 6))}.${s.slice(0, 4)}`; })()
      : capitalize(fmtKey(state.cursor, { month: 'long', year: 'numeric' }).replace(' г.', ''));
    const shift = (dir) => {
      state.cursor = state.view === 'week' ? D.addDays(state.cursor, 7 * dir) : shiftMonth(state.cursor, dir);
      state.slide = dir > 0 ? 'next' : 'prev';
      renderShell();
    };
    const setView = (v) => { state.view = v; localStorageSet('view', v); state.slide = 'fade'; renderShell(); };
    const t0 = today();
    const isCurrent = state.view === 'week' ? D.mondayOf(state.cursor) === D.mondayOf(t0) : state.cursor.slice(0, 7) === t0.slice(0, 7);
    const unit = state.view === 'week' ? 'неделя' : 'месяц';

    main.append(el('div', { class: 'toolbar' },
      el('div', { class: 'period' },
        el('button', { class: 'period-arrow', onclick: () => shift(-1), 'aria-label': state.view === 'week' ? 'Предыдущая неделя' : 'Предыдущий месяц' }, '‹'),
        el('h1', { class: 'period-title' }, title),
        el('button', { class: 'period-arrow', onclick: () => shift(1), 'aria-label': state.view === 'week' ? 'Следующая неделя' : 'Следующий месяц' }, '›')),
      !isCurrent && el('button', { class: 'btn-small btn-link', onclick: () => { state.cursor = t0; state.slide = 'fade'; renderShell(); } }, `К текущему: ${unit === 'неделя' ? 'эта неделя' : 'этот месяц'}`),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Вид календаря' },
        el('button', { class: state.view === 'month' ? 'active' : '', onclick: () => setView('month') }, 'Месяц'),
        el('button', { class: state.view === 'week' ? 'active' : '', onclick: () => setView('week') }, 'Неделя')),
      el('button', { class: 'btn-primary', onclick: () => openTaskForm({ date: state.cursor === today() ? today() : state.cursor, time: '10:00' }) }, '+ Задача'),
      el('div', { class: 'legend' },
        el('span', {}, el('i', { style: { borderColor: 'var(--due-yellow)' } }), '≤ 5 дней'),
        el('span', {}, el('i', { style: { borderColor: 'var(--due-red)' } }), '≤ 2 дней'),
        el('span', {}, el('i', { class: 'od', style: { borderColor: 'var(--due-overdue)' } }), '⚠ просрочено'))));

    const holder = el('div', {}, el('div', { class: 'muted' }, 'Загрузка…'));
    main.append(holder);
    try { await loadTasks(); } catch (e) { holder.replaceChildren(el('div', { class: 'error' }, e.message)); return; }
    const grid = state.view === 'week' ? weekGrid() : monthGrid();
    if (state.slide) { grid.classList.add('slide-' + state.slide); state.slide = null; }
    holder.replaceChildren(grid);
    if (state.view === 'week') {
      const body = holder.querySelector('.week-body');
      if (body) body.scrollTop = 8 * 58; // начинаем с 08:00
    }
  }

  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);

  function shiftMonth(key, dir) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + dir, 1));
    return d.toISOString().slice(0, 10);
  }

  function tasksByDay() {
    const map = {};
    for (const t of state.tasks) (map[D.dayKey(t.deadline, state.tz)] ||= []).push(t);
    return map;
  }

  function monthGrid() {
    const { start, days } = calendarRange();
    const month = state.cursor.slice(0, 7);
    const byDay = tasksByDay();
    const t0 = today();
    const grid = el('div', { class: 'month' }, WEEKDAYS.map((w) => el('div', { class: 'dow' }, w)));
    for (let i = 0; i < days; i++) {
      const key = D.addDays(start, i);
      const list = byDay[key] || [];
      grid.append(el('div', {
        class: `day${key.slice(0, 7) !== month ? ' other' : ''}${key === t0 ? ' today' : ''}`,
        role: 'button', tabindex: 0, 'aria-label': `${fmtKey(key, { day: 'numeric', month: 'long' })}: новая задача`,
        onclick: (e) => { if (e.target.closest('.card')) return; openTaskForm({ date: key, time: '10:00' }); },
        onkeydown: (e) => { if (e.key === 'Enter' && e.target.classList.contains('day')) openTaskForm({ date: key, time: '10:00' }); },
      },
      el('div', { class: 'num' }, Number(key.slice(8))),
      el('div', { class: 'cards' }, list.map((t) => taskCard(t)))));
    }
    return grid;
  }

  function weekGrid() {
    const start = D.mondayOf(state.cursor);
    const t0 = today();
    const keys = Array.from({ length: 7 }, (_, i) => D.addDays(start, i));
    const bySlot = {};
    for (const t of state.tasks) {
      const z = D.zoned(t.deadline, state.tz);
      (bySlot[`${z.key}|${z.hour}`] ||= []).push(t);
    }
    const grid = el('div', { class: 'week' },
      el('div', { class: 'wh' }),
      keys.map((k, i) => el('div', { class: `wh${k === t0 ? ' today' : ''}` }, WEEKDAYS[i], el('b', {}, Number(k.slice(8))), fmtKey(k, { month: 'short' }))));
    const body = el('div', { class: 'week-body' });
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      body.append(el('div', { class: 'hour-label' }, `${hh}:00`));
      for (const k of keys) {
        body.append(el('div', {
          class: `slot${k === t0 ? ' today' : ''}`, role: 'button', tabindex: 0, 'aria-label': `${fmtKey(k, { day: 'numeric', month: 'long' })}, ${hh}:00: новая задача`,
          onclick: (e) => { if (e.target.closest('.card')) return; openTaskForm({ date: k, time: `${hh}:00` }); },
          onkeydown: (e) => { if (e.key === 'Enter' && e.target.classList.contains('slot')) openTaskForm({ date: k, time: `${hh}:00` }); },
        }, (bySlot[`${k}|${h}`] || []).map((t) => taskCard(t))));
      }
    }
    grid.append(body);
    return grid;
  }

  function taskCard(t) {
    const stage = D.borderStage(t, new Date(), state.tz);
    return el('div', {
      class: `card due-${stage}${t.status === 'done' ? ' done' : ''}`, vars: { '--pc': t.project.color },
      role: 'button', tabindex: 0, title: `${t.title} — ${t.project.name}`,
      onclick: () => openTask(t.id), onkeydown: (e) => { if (e.key === 'Enter') openTask(t.id); },
    },
    stage === 'overdue' && el('span', { class: 'warn', 'aria-label': 'Просрочено' }, '⚠'),
    stage === 'red' && el('span', { class: 'warn soon', 'aria-label': 'До дедлайна 2 дня или меньше' }, '⚠'),
    el('div', { class: 'tag' }, t.project.name, t.repeat && el('span', { class: 'rep', title: REPEAT[t.repeat], 'aria-label': REPEAT[t.repeat] }, '↻')),
    el('div', { class: 't' }, el('span', { class: 'time' }, fmtTime(t.deadline) + ' '), t.title),
    el('div', { class: 'who' }, el('img', { class: 'avatar sm', src: t.assignee.avatar, alt: '' }), t.assignee.name));
  }

  // ---------- Модальные окна ----------
  function modal(titleNode, ...content) {
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
      el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('div', { class: 'modal-head' }, el('h2', {}, titleNode), el('button', { class: 'close', onclick: close, 'aria-label': 'Закрыть' }, '×')),
        ...content));
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    const first = overlay.querySelector('input, textarea, select');
    if (first) first.focus();
    return close;
  }

  async function openTaskForm({ date, time, task }) {
    if (!state.me.teamId) { alert('Сначала аккаунт-менеджер должен добавить вас в команду.'); return; }
    try { state.options = await api('GET', '/api/tasks/options'); } catch (e) { alert(e.message); return; }
    const { assignees, projects } = state.options;
    if (!projects.length) {
      alert(state.me.role === 'am' ? 'Сначала создайте проект на странице «Проекты».' : 'Вас ещё не добавили ни в один проект. Обратитесь к аккаунт-менеджеру.');
      return;
    }
    const editing = !!task;
    const z = editing ? D.zoned(task.deadline, state.tz) : null;
    const err = el('div', { class: 'error', role: 'alert' });
    const form = el('form', { onsubmit: submit },
      el('label', {}, 'Название', el('input', { type: 'text', name: 'title', required: true, maxlength: 200, value: editing ? task.title : '' })),
      el('label', {}, 'Описание', el('textarea', { name: 'description', maxlength: 5000, value: editing ? task.description : '' })),
      el('div', { class: 'row' },
        el('label', {}, 'Дата дедлайна', el('input', { type: 'date', name: 'date', required: true, value: editing ? z.key : date })),
        el('label', {}, 'Время', el('input', { type: 'time', name: 'time', required: true, value: editing ? `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}` : time }))),
      el('div', { class: 'row' },
        el('label', {}, 'Исполнитель', el('select', { name: 'assigneeId', required: true, disabled: assignees.length === 1 },
          assignees.map((u) => el('option', { value: u.id, selected: editing ? u.id === task.assignee.id : u.id === state.me.id }, u.id === state.me.id ? `${u.name} (я)` : u.name)))),
        el('label', {}, 'Проект', el('select', { name: 'projectId', required: true },
          projects.map((p) => el('option', { value: p.id, selected: editing && p.id === task.project.id }, p.name))))),
      editing
        ? task.repeat && el('div', { class: 'muted', style: { marginBottom: '8px' } }, `↻ ${REPEAT[task.repeat]}. Изменения коснутся только этого повторения.`)
        : el('label', {}, 'Повторять', el('select', { name: 'repeat' },
          Object.entries(REPEAT).map(([k, v]) => el('option', { value: k }, v)))),
      state.me.role === 'gm' && el('div', { class: 'muted', style: { marginBottom: '8px' } }, 'Гейм-менеджер может поставить задачу только себе.'),
      err,
      el('div', { class: 'actions' },
        el('button', { type: 'button', onclick: () => close() }, 'Отмена'),
        el('button', { type: 'submit', class: 'btn-primary' }, editing ? 'Сохранить' : 'Создать задачу')));
    const close = modal(editing ? 'Редактирование задачи' : 'Новая задача', form);

    async function submit(e) {
      e.preventDefault();
      const f = new FormData(form);
      const body = {
        title: f.get('title'), description: f.get('description'),
        deadline: D.toInstant(f.get('date'), f.get('time'), state.tz),
        assigneeId: Number(f.get('assigneeId') || form.assigneeId.value), projectId: Number(f.get('projectId')),
        ...(editing ? {} : { repeat: f.get('repeat') || 'none' }),
      };
      try {
        if (editing) await api('PATCH', `/api/tasks/${task.id}`, body);
        else await api('POST', '/api/tasks', body);
        close();
        state.cursor = f.get('date');
        renderShell();
        pollNotifications();
      } catch (e2) { err.textContent = e2.message; }
    }
  }

  async function openTask(id) {
    let task;
    try { ({ task } = await api('GET', `/api/tasks/${id}`)); } catch (e) { alert(e.message); return; }
    const stage = D.borderStage(task, new Date(), state.tz);
    const left = D.daysLeft(task.deadline, new Date(), state.tz);
    const dueText = { overdue: '⚠ Срок прошёл', red: left === 0 ? 'Сегодня' : `Осталось ${left} дн.`, yellow: `Осталось ${left} дн.` }[stage];
    const err = el('div', { class: 'error', role: 'alert' });
    const statusSel = el('select', { name: 'status', disabled: !task.canChangeStatus, onchange: syncResult },
      Object.entries(STATUS).map(([k, v]) => el('option', { value: k, selected: k === task.status }, v)));
    const result = el('textarea', { name: 'result', maxlength: 5000, value: task.result, disabled: !task.canChangeStatus, placeholder: 'Что сделано, договорённости, ссылки…' });
    const resultLabel = el('label', {}, 'Результат', result);
    // Ссылки из результата — кликабельные (в самом поле ввода ссылки не нажимаются)
    const resultLinks = el('div', { class: 'links-preview' });
    const syncLinks = () => {
      const links = linkify(result.value).filter((n) => n instanceof Node);
      resultLinks.replaceChildren(...(links.length ? [el('span', { class: 'muted' }, 'Ссылки: '), ...links.flatMap((a, i) => (i ? [', ', a] : [a]))] : []));
    };
    result.addEventListener('input', syncLinks);
    syncLinks();
    function syncResult() {
      const done = statusSel.value === 'done';
      result.required = done;
      resultLabel.firstChild.textContent = done ? 'Результат (обязательно для завершения)' : 'Результат';
    }
    syncResult();

    const close = modal(task.title,
      el('dl', { class: 'meta' },
        el('dt', {}, 'Проект'), el('dd', {}, el('span', { class: 'chip', vars: projectVars(task.project.color) }, task.project.name)),
        el('dt', {}, 'Исполнитель'), el('dd', {}, el('img', { class: 'avatar', src: task.assignee.avatar, alt: '' }), task.assignee.name),
        el('dt', {}, 'Автор'), el('dd', {}, task.author.name),
        el('dt', {}, 'Дедлайн'), el('dd', {}, fmtDateTime(task.deadline), dueText && el('span', { class: `due-badge due-${stage}` }, dueText)),
        task.repeat && [el('dt', {}, 'Повтор'), el('dd', {}, '↻ ' + REPEAT[task.repeat],
          task.canEdit && el('button', { type: 'button', class: 'btn-small btn-link', onclick: stopRepeat }, 'Прекратить повторение'))],
        task.completedAt && [el('dt', {}, 'Завершена'), el('dd', {}, fmtDateTime(task.completedAt))]),
      task.description && el('div', { class: 'desc' }, linkify(task.description)),
      el('form', { onsubmit: save, style: { marginTop: '16px' } },
        el('label', {}, 'Статус', statusSel),
        resultLabel,
        resultLinks,
        err,
        el('div', { class: 'actions' },
          task.canEdit && el('button', { type: 'button', class: 'btn-danger left', onclick: remove }, 'Удалить'),
          task.canEdit && el('button', { type: 'button', onclick: () => { close(); openTaskForm({ task }); } }, 'Изменить'),
          task.canChangeStatus && el('button', { type: 'submit', class: 'btn-primary' }, 'Сохранить'))));

    async function save(e) {
      e.preventDefault();
      try {
        await api('PATCH', `/api/tasks/${task.id}`, { status: statusSel.value, result: result.value });
        close();
        renderShell();
        pollNotifications();
      } catch (e2) { err.textContent = e2.message; }
    }
    async function stopRepeat() {
      if (!confirm(`Прекратить повторение «${task.title}»? Будущие повторения после этой задачи будут удалены, эта и прошлые останутся.`)) return;
      try { await api('PATCH', `/api/tasks/${task.id}`, { stopRepeat: true }); close(); renderShell(); } catch (e2) { err.textContent = e2.message; }
    }
    async function remove() {
      if (!confirm(`Удалить задачу «${task.title}»? Восстановить её будет нельзя.`)) return;
      try { await api('DELETE', `/api/tasks/${task.id}`); close(); renderShell(); } catch (e2) { err.textContent = e2.message; }
    }
  }

  // ---------- Проекты ----------
  async function renderProjects(main) {
    const isAm = state.me.role === 'am';
    let projects = [], members = [];
    try {
      [{ projects }, { members }] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/team')]);
    } catch (e) { main.append(el('div', { class: 'error' }, e.message)); return; }
    const gms = members.filter((m) => m.role === 'gm');
    const nameOf = (id) => (members.find((m) => m.id === id) || {}).name || '—';

    main.append(el('h1', {}, 'Проекты'));
    if (isAm) main.append(el('div', { class: 'panel' }, el('h2', {}, 'Новый проект'), projectForm(null, gms)));

    main.append(el('div', { class: 'panel' },
      el('h2', {}, isAm ? 'Мои проекты' : 'Проекты команды'),
      projects.length ? el('div', { class: 'list' }, projects.map((p) => el('div', { class: 'item' },
        el('span', { class: 'dot', vars: projectVars(p.color) }),
        el('div', { class: 'grow' }, el('b', {}, p.name),
          el('div', { class: 'muted' }, p.memberIds.length ? 'Гейм-менеджеры: ' + p.memberIds.map(nameOf).join(', ') : 'Гейм-менеджеры не привязаны', ` · задач: ${p.taskCount}`)),
        isAm && el('button', { class: 'btn-small', onclick: () => { const close = modal('Проект: ' + p.name, projectForm(p, gms, () => close())); } }, 'Изменить'),
        isAm && el('button', { class: 'btn-small btn-danger', onclick: () => removeProject(p) }, 'Удалить'))))
        : el('div', { class: 'muted' }, isAm ? 'Проектов пока нет.' : 'Проектов пока нет или вы не в команде.')));

    async function removeProject(p) {
      const msg = p.taskCount
        ? `Удалить проект «${p.name}» вместе с ${p.taskCount} задач(ами)? Восстановить будет нельзя.`
        : `Удалить проект «${p.name}»?`;
      if (!confirm(msg)) return;
      try { await api('DELETE', `/api/projects/${p.id}`); renderShell(); } catch (e) { alert(e.message); }
    }
  }

  function projectForm(p, gms, onDone) {
    let color = p ? p.color : PALETTE[0][0];
    const err = el('div', { class: 'error', role: 'alert' });
    const custom = el('input', { type: 'color', value: color, 'aria-label': 'Свой цвет', oninput: () => pick(custom.value) });
    const swatches = el('div', { class: 'swatches' },
      PALETTE.map(([c, name]) => el('button', { type: 'button', class: 'swatch', vars: { '--pc': c }, title: name, 'aria-label': name, 'data-c': c, onclick: () => pick(c) })),
      el('span', { class: 'muted' }, 'или свой:'), custom);
    function pick(c) {
      color = c.toLowerCase();
      custom.value = color;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.c === color));
    }
    pick(color);
    const form = el('form', { onsubmit: submit },
      el('label', {}, 'Название', el('input', { type: 'text', name: 'name', required: true, maxlength: 60, value: p ? p.name : '', placeholder: 'Например, Проект Альфа' })),
      el('div', { class: 'muted' }, 'Цвет'), swatches,
      el('div', { class: 'muted' }, 'Гейм-менеджеры проекта'),
      gms.length ? el('div', { class: 'checks' }, gms.map((g) => el('label', {},
        el('input', { type: 'checkbox', name: 'm', value: g.id, checked: p && p.memberIds.includes(g.id) }),
        el('img', { class: 'avatar sm', src: g.avatar, alt: '' }), g.name)))
        : el('div', { class: 'muted', style: { margin: '6px 0 12px' } }, 'Сначала добавьте гейм-менеджеров на странице «Команда».'),
      err,
      el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'btn-primary' }, p ? 'Сохранить' : 'Создать проект')));

    async function submit(e) {
      e.preventDefault();
      const f = new FormData(form);
      const body = { name: f.get('name'), color, memberIds: f.getAll('m').map(Number) };
      try {
        if (p) await api('PATCH', `/api/projects/${p.id}`, body);
        else await api('POST', '/api/projects', body);
        if (onDone) onDone();
        renderShell();
      } catch (e2) { err.textContent = e2.message; }
    }
    return form;
  }

  // ---------- Команда ----------
  async function renderTeam(main) {
    const isAm = state.me.role === 'am';
    let members = [];
    try { ({ members } = await api('GET', '/api/team')); } catch (e) { main.append(el('div', { class: 'error' }, e.message)); return; }
    main.append(el('h1', {}, 'Команда'));
    if (isAm) {
      const err = el('div', { class: 'error', role: 'alert' });
      const input = el('input', { type: 'text', name: 'login', required: true, placeholder: 'Логин гейм-менеджера' });
      main.append(el('div', { class: 'panel' },
        el('h2', {}, 'Добавить гейм-менеджера'),
        el('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Гейм-менеджер регистрируется по коду приглашения и сообщает вам свой логин. Без привязки он не видит ничего.'),
        el('form', { class: 'row', style: { alignItems: 'flex-start' }, onsubmit: async (e) => {
          e.preventDefault();
          try { await api('POST', '/api/team', { login: input.value.trim() }); renderShell(); } catch (e2) { err.textContent = e2.message; }
        } }, input, el('button', { class: 'btn-primary', type: 'submit', style: { flex: '0 0 auto' } }, 'Привязать')),
        err));
    }
    main.append(el('div', { class: 'panel' },
      el('h2', {}, 'Участники'),
      el('div', { class: 'list' }, members.map((m) => el('div', { class: 'item' },
        el('img', { class: 'avatar', src: m.avatar, alt: '' }),
        el('div', { class: 'grow' }, el('b', {}, m.name, m.id === state.me.id ? ' (я)' : ''),
          el('div', { class: 'muted' }, `${m.role === 'am' ? 'Аккаунт-менеджер' : 'Гейм-менеджер'} · ${m.login}`)),
        isAm && m.role === 'gm' && el('button', { class: 'btn-small btn-danger', onclick: async () => {
          if (!confirm(`Отвязать ${m.name} от команды? Он потеряет доступ к задачам команды.`)) return;
          try { await api('DELETE', `/api/team/${m.id}`); renderShell(); } catch (e) { alert(e.message); }
        } }, 'Отвязать'))))));
  }

  // ---------- Отчёты ----------
  async function renderReports(main) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const start = D.mondayOf(params.get('week') || today());
    let rep;
    try { rep = await api('GET', `/api/reports/week?start=${start}`); } catch (e) { main.append(el('div', { class: 'error' }, e.message)); return; }
    const go = (n) => { location.hash = `#/reports?week=${D.addDays(start, 7 * n)}`; };
    const period = `${ddmm(rep.start)}–${ddmm(rep.end)}`;

    main.append(el('div', { class: 'toolbar' },
      el('button', { onclick: () => go(-1), 'aria-label': 'Прошлая неделя' }, '‹'),
      el('button', { onclick: () => { location.hash = '#/reports'; } }, 'Эта неделя'),
      el('button', { onclick: () => go(1), 'aria-label': 'Следующая неделя' }, '›'),
      el('h1', {}, `Отчёт за ${period}`)));

    main.append(el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', {}, rep.stats.completed), el('span', {}, 'завершено')),
      el('div', { class: `stat${rep.stats.lateDone ? ' bad' : ''}` }, el('b', {}, rep.stats.lateDone), el('span', {}, 'завершено с опозданием')),
      el('div', { class: `stat${rep.stats.overdue ? ' bad' : ''}` }, el('b', {}, rep.stats.overdue), el('span', {}, 'просрочено и не завершено'))));

    main.append(el('div', { class: 'panel' },
      el('h2', {}, 'Завершённые задачи'),
      rep.completed.length ? el('div', { class: 'list' }, rep.completed.map((t) => el('div', { class: 'report-line', vars: projectVars(t.project.color) },
        el('div', {}, `Отчёт за ${period}: завершена задача «`, el('b', {}, t.title), '»'),
        el('div', { class: 'res' }, el('span', { class: 'muted' }, 'Результат: '), linkify(t.result)),
        el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '12px' } },
          `${t.project.name} · ${t.assignee.name} · завершена ${fmtDateTime(t.completedAt)} · срок ${fmtDateTime(t.deadline)}`,
          t.completedAt > t.deadline ? ' · ⚠ с опозданием' : ''))))
        : el('div', { class: 'muted' }, 'За эту неделю завершённых задач нет.')));

    if (rep.overdue.length) {
      main.append(el('div', { class: 'panel' },
        el('h2', {}, '⚠ Просрочено'),
        el('div', { class: 'list' }, rep.overdue.map((t) => el('div', { class: 'item', role: 'button', style: { cursor: 'pointer' }, onclick: () => openTask(t.id) },
          el('span', { class: 'dot', vars: projectVars(t.project.color) }),
          el('div', { class: 'grow' }, el('b', {}, t.title), el('div', { class: 'muted' }, `${t.project.name} · ${t.assignee.name} · срок ${fmtDateTime(t.deadline)} · ${STATUS[t.status]}`)))))));
    }
  }

  // ---------- Настройки ----------
  async function renderSettings(main) {
    let sounds = [];
    try { ({ sounds } = await api('GET', '/api/sounds')); } catch (e) { main.append(el('div', { class: 'error' }, e.message)); return; }
    const s = state.settings;
    const msg = el('div', { class: 'error', role: 'status' });
    const show = (t, ok) => { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : ''; };
    const apply = (data) => { state.me = data.user; state.settings = data.settings; };

    const avatarInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async () => {
      const f = avatarInput.files[0];
      if (!f) return;
      try { apply(await api('PUT', '/api/me/avatar', f, f.type)); renderShell(); } catch (e) { show(e.message); }
    } });

    const preview = (url) => { const a = new Audio(url); a.play().catch(() => {}); };
    const soundList = el('div', {},
      sounds.map((snd) => el('label', { class: 'sound-row' },
        el('input', { type: 'radio', name: 'sound', value: snd.id, checked: s.sound === snd.id, onchange: () => setSound(snd.id) }),
        el('span', {}, snd.title),
        el('button', { type: 'button', class: 'btn-small', onclick: (e) => { e.preventDefault(); preview(snd.url); } }, '▶ Прослушать'))),
      s.sound.startsWith('custom:') && el('label', { class: 'sound-row' },
        el('input', { type: 'radio', name: 'sound', value: s.sound, checked: true }),
        el('span', {}, 'Своя мелодия'),
        el('button', { type: 'button', class: 'btn-small', onclick: (e) => { e.preventDefault(); preview(s.soundUrl); } }, '▶ Прослушать')));
    async function setSound(id) {
      try { apply(await api('PATCH', '/api/me/settings', { sound: id })); show('Мелодия сохранена', true); renderShell(); } catch (e) { show(e.message); }
    }
    const soundInput = el('input', { type: 'file', accept: 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg', onchange: async () => {
      const f = soundInput.files[0];
      if (!f) return;
      try { apply(await api('PUT', '/api/me/sound-file', f, f.type || 'application/octet-stream')); renderShell(); } catch (e) { show(e.message); }
    } });

    const hourSel = el('select', { onchange: async () => {
      try { apply(await api('PATCH', '/api/me/settings', { notifyHour: Number(hourSel.value) })); show('Время напоминаний сохранено', true); } catch (e) { show(e.message); }
    } }, Array.from({ length: 24 }, (_, h) => el('option', { value: h, selected: h === s.notifyHour }, `${String(h).padStart(2, '0')}:00`)));

    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const permText = { granted: 'разрешены', denied: 'запрещены в браузере', default: 'не настроены', unsupported: 'не поддерживаются браузером' }[perm];

    main.append(el('h1', {}, 'Настройки'), msg, el('div', { class: 'grid-2' },
      el('div', { class: 'panel' },
        el('h2', {}, 'Профиль'),
        el('div', { class: 'item', style: { marginBottom: '12px' } },
          el('img', { class: 'avatar lg', src: state.me.avatar, alt: '' }),
          el('div', { class: 'grow' }, el('b', {}, state.me.name), el('div', { class: 'muted' }, state.me.login))),
        el('label', {}, 'Загрузить аватарку (PNG, JPEG, WEBP до 2 МБ)', avatarInput)),
      el('div', { class: 'panel' },
        el('h2', {}, 'Звук уведомлений'),
        el('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Мелодия играет только при всплывающем уведомлении.'),
        soundList,
        el('label', { style: { marginTop: '12px' } }, 'Загрузить свою мелодию (MP3, WAV, OGG до 5 МБ)', soundInput)),
      notifyPanel(s, hourSel, perm, permText, apply, show),
      telegramPanel(s, apply, show)));
  }

  // Когда присылать уведомления — только то, что выбрал сам пользователь
  function notifyPanel(s, hourSel, perm, permText, apply, show) {
    const plural = (d) => (d === 1 ? 'день' : d < 5 ? 'дня' : 'дней');
    const DAY_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((d) => [d, d === 0 ? 'В день дедлайна' : `За ${d} ${plural(d)}`]);
    const hint = el('div', { class: 'muted', style: { marginTop: '8px' } });
    const box = (id, label, checked, onchange) => el('label', { class: 'check-row' },
      el('input', { type: 'checkbox', id, checked, onchange }), el('span', {}, label));
    const days = new Set(s.notifyDays);
    const updateHint = () => {
      const any = state.settings.notifyOnCreate || state.settings.notifyOnDone || state.settings.notifyDays.length;
      hint.textContent = any ? '' : 'Уведомления выключены: ничего не выбрано.';
    };
    const save = async (patch) => {
      try { apply(await api('PATCH', '/api/me/settings', patch)); show('Сохранено', true); updateHint(); } catch (e) { show(e.message); }
    };
    // Выпадающий список с галочками: можно выбрать несколько дней
    function daysDropdown() {
      const summary = el('span', { class: 'dd-summary' });
      const refresh = () => {
        const sorted = [...days].sort((a, b) => b - a);
        if (!sorted.length) { summary.textContent = 'Не выбрано'; return; }
        const nums = sorted.filter((d) => d > 0);
        const parts = [];
        if (nums.length) parts.push(`за ${nums.join(', ')} ${nums.length > 1 ? 'дн.' : plural(nums[0])}`);
        if (days.has(0)) parts.push('в день дедлайна');
        summary.textContent = parts.join(' и ').replace(/^./, (c) => c.toUpperCase());
      };
      const list = el('div', { class: 'dd-list', role: 'group', 'aria-label': 'Дни напоминаний' },
        DAY_OPTIONS.map(([d, label]) => el('label', { class: 'dd-item' },
          el('input', { type: 'checkbox', id: 'n-day-' + d, checked: days.has(d), onchange: (e) => {
            if (e.target.checked) days.add(d); else days.delete(d);
            refresh();
            save({ notifyDays: [...days] });
          } }), el('span', {}, label))));
      const dd = el('details', { class: 'dd' },
        el('summary', { class: 'dd-btn' }, summary, el('span', { class: 'dd-arrow', 'aria-hidden': 'true' }, '▾')),
        list);
      // Закрываем список кликом мимо него
      const outside = (e) => { if (!dd.contains(e.target)) dd.open = false; };
      dd.addEventListener('toggle', () => {
        if (dd.open) document.addEventListener('click', outside);
        else document.removeEventListener('click', outside);
      });
      refresh();
      return dd;
    }

    const panel = el('div', { class: 'panel' },
      el('h2', {}, 'Когда присылать уведомления'),
      el('div', { class: 'muted', style: { marginBottom: '10px' } }, 'Отметьте всё, что нужно. Уведомления приходят всплывающим окном со звуком и в ваш Telegram, если он подключён.'),
      el('div', { class: 'check-group' },
        box('n-create', 'Когда мне ставят задачу', s.notifyOnCreate, (e) => save({ notifyOnCreate: e.target.checked })),
        box('n-done', 'Когда мою задачу завершили', s.notifyOnDone, (e) => save({ notifyOnDone: e.target.checked }))),
      el('div', { class: 'eyebrow', style: { margin: '14px 0 8px' } }, 'Напоминания о дедлайне'),
      daysDropdown(),
      el('label', { style: { marginTop: '12px' } }, `Во сколько присылать напоминания (${state.tz})`, hourSel),
      hint,
      el('div', { style: { marginTop: '10px' } }, `Системные уведомления браузера: ${permText}. `,
        perm === 'default' && el('button', { class: 'btn-small', onclick: async () => { await Notification.requestPermission(); renderShell(); } }, 'Разрешить')));
    updateHint();
    return panel;
  }

  // Свой Telegram-бот: личный или общий на нескольких человек
  function telegramPanel(s, apply, show) {
    const tg = s.telegram;
    const err = el('div', { class: 'error', role: 'alert' });
    const panel = el('div', { class: 'panel' }, el('h2', {}, 'Telegram'));
    if (!tg.available) {
      panel.append(el('div', { class: 'muted' }, 'Подключение Telegram пока недоступно: владелец планнера должен задать SECRET_KEY на сервере.'));
      return panel;
    }
    const linkBlock = (url) => el('div', { class: 'tg-link' },
      el('div', {}, '1. Откройте бота и нажмите «Start»:'),
      el('a', { href: url, target: '_blank', rel: 'noopener', class: 'btn btn-primary', style: { display: 'inline-block', marginTop: '6px', textDecoration: 'none' } }, `Открыть @${tg.botUsername || ''}`),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, '2. Вернитесь сюда и обновите страницу — статус сменится на «подключён».'));

    if (tg.botUsername) {
      panel.append(el('div', { class: 'item', style: { marginBottom: '12px' } },
        el('div', { class: 'grow' }, el('b', {}, '@' + tg.botUsername),
          el('div', { class: tg.linked ? 'ok-text' : 'muted' }, tg.linked ? '✅ Подключён, уведомления приходят сюда' : 'Ждём, когда вы нажмёте «Start» в боте'))));
      const actions = el('div', { class: 'actions', style: { justifyContent: 'flex-start' } });
      if (tg.linked) {
        actions.append(el('button', { class: 'btn-small', onclick: async () => {
          try { await api('POST', '/api/me/telegram/test'); show('Тестовое сообщение отправлено', true); } catch (e) { show(e.message); }
        } }, 'Отправить тест'));
      } else {
        actions.append(el('button', { class: 'btn-small', onclick: async () => {
          try { state.tgLinkUrl = (await api('POST', '/api/me/telegram/link')).url; renderShell(); } catch (e) { err.textContent = e.message; }
        } }, 'Получить новую ссылку'));
        if (state.tgLinkUrl) panel.append(linkBlock(state.tgLinkUrl));
      }
      actions.append(el('button', { class: 'btn-small btn-danger', onclick: async () => {
        try { apply(await api('DELETE', '/api/me/telegram')); renderShell(); } catch (e) { show(e.message); }
      } }, 'Отключить'));
      panel.append(actions, err);
      return panel;
    }

    const input = el('input', { type: 'password', id: 'tg-token', autocomplete: 'off', placeholder: '123456789:AA…', required: true });
    panel.append(
      el('div', { class: 'muted', style: { marginBottom: '10px' } },
        'Создайте бота в @BotFather (команда /newbot) и вставьте его ключ. Можно указать общий ключ — один бот на несколько человек: каждый получит только свои уведомления.'),
      el('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const r = await api('PUT', '/api/me/telegram', { token: input.value.trim() });
          apply(r);
          input.value = '';
          state.tgLinkUrl = r.url;
          renderShell();
        } catch (e2) { err.textContent = e2.message; }
      } },
      el('label', { for: 'tg-token' }, 'Ключ бота', input),
      err,
      el('button', { type: 'submit', class: 'btn-primary' }, 'Подключить')));
    return panel;
  }

  // ---------- Уведомления: всплывающее окно + звук ----------
  function playSound() {
    if (!state.settings) return;
    const a = new Audio(state.settings.soundUrl);
    a.play().catch(() => { /* браузер запретил звук до первого действия пользователя */ });
  }

  async function pollNotifications() {
    if (!state.me) return;
    let list;
    try {
      const [n, me] = await Promise.all([api('GET', '/api/notifications/unread'), api('GET', '/api/me')]);
      list = n.notifications;
      // Привязку к команде мог изменить аккаунт-менеджер — обновляем профиль
      const teamChanged = me.user.teamId !== state.me.teamId;
      state.me = me.user;
      state.settings = me.settings;
      if (teamChanged && !document.querySelector('.overlay')) renderShell();
    } catch { return; }
    const fresh = list.filter((n) => !state.seenNotifications.has(n.id));
    fresh.forEach((n) => state.seenNotifications.add(n.id));
    if (!fresh.length) { state.firstPoll = false; return; }
    for (const n of fresh) showToast(n);
    // Звук — только для уведомлений, пришедших во время работы со страницей, не при её открытии
    if (!state.firstPoll) {
      playSound();
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        for (const n of fresh) new Notification('Планнер задач', { body: n.message, tag: 'planner-' + n.id });
      }
      if (route() === 'calendar' && !document.querySelector('.overlay')) renderShell();
    }
    state.firstPoll = false;
  }

  const MAX_TOASTS = 3;
  const TOAST_HEAD = {
    created: ['🔔', 'Новая задача'], assigned: ['👤', 'Вам назначена задача'],
    reminder: ['⏰', 'Напоминание о дедлайне'], done: ['✅', 'Задача завершена'],
  };
  let hiddenToasts = [];

  function showToast(n) {
    if ($toasts.querySelectorAll('.toast:not(.more)').length >= MAX_TOASTS) {
      hiddenToasts.push(n);
      renderMoreToast();
      return;
    }
    const markRead = () => { api('POST', `/api/notifications/${n.id}/read`).catch(() => {}); setTimeout(showHidden, 0); };
    const head = TOAST_HEAD[n.kind] || TOAST_HEAD[n.kind.startsWith('reminder') ? 'reminder' : 'created'];
    const body = n.message.replace(/^\S+\s/, ''); // без эмодзи в начале
    const toast = el('div', { class: 'toast', role: 'alert' },
      el('div', { class: 'row' },
        el('div', { class: 'ic', 'aria-hidden': 'true' }, n.kind === 'reminder0' ? '🔥' : head[0]),
        el('div', {}, el('div', { class: 'tt' }, n.kind === 'reminder0' ? 'Сегодня дедлайн' : head[1]), el('div', { class: 'msg' }, body))),
      el('div', { class: 'actions' },
        n.taskId && el('button', { class: 'btn-small', onclick: () => { markRead(); toast.remove(); openTask(n.taskId); } }, 'Открыть задачу'),
        el('button', { class: 'btn-small main', onclick: () => { markRead(); toast.remove(); } }, 'OK')));
    const more = $toasts.querySelector('.toast.more');
    $toasts.insertBefore(toast, more);
  }

  function showHidden() {
    const n = hiddenToasts.shift();
    renderMoreToast();
    if (n) showToast(n);
  }

  function renderMoreToast() {
    let more = $toasts.querySelector('.toast.more');
    if (!hiddenToasts.length) { if (more) more.remove(); return; }
    if (!more) {
      more = el('div', { class: 'toast more' });
      $toasts.append(more);
    }
    more.replaceChildren(
      el('div', { class: 'msg' }, `Ещё уведомлений: ${hiddenToasts.length}`),
      el('div', { class: 'actions' }, el('button', { class: 'btn-small', onclick: async () => {
        await api('POST', '/api/notifications/read-all').catch(() => {});
        hiddenToasts = [];
        $toasts.replaceChildren();
      } }, 'Отметить все прочитанными')));
  }

  function startPolling() {
    stopPolling();
    state.firstPoll = true;
    pollNotifications();
    state.pollTimer = setInterval(pollNotifications, 15000);
  }
  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    state.seenNotifications.clear();
    hiddenToasts = [];
    $toasts.replaceChildren();
  }

  // ---------- Запуск ----------
  async function boot() {
    try {
      const data = await api('GET', '/api/me');
      state.me = data.user;
      state.settings = data.settings;
      state.tz = data.config.tz;
      state.cursor = state.cursor || today();
      renderShell();
      startPolling();
    } catch {
      renderAuth();
    }
  }

  // При переходе между страницами обновляем профиль: привязку к команде мог изменить аккаунт-менеджер
  window.addEventListener('hashchange', async () => {
    if (!state.me) return;
    try { const data = await api('GET', '/api/me'); state.me = data.user; state.settings = data.settings; } catch { /* покажем то, что есть */ }
    if (state.me) renderShell();
  });
  boot();
})();
