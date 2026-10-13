// Тестовый сценарий из ТЗ на одном гейм-менеджере. Только тестовые данные.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const INVITE = 'test-invite-code';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Подмена Telegram Bot API: getMe, sendMessage, getUpdates
const TOKEN_A = '111111111:' + 'A'.repeat(35);
const TOKEN_SHARED = '222222222:' + 'B'.repeat(35);
function fakeTelegram() {
  const sent = [];
  const updates = {};
  const names = { [TOKEN_A]: 'alpha_test_bot', [TOKEN_SHARED]: 'team_test_bot' };
  const fetchImpl = async (url, opts) => {
    const [, token, method] = url.match(/\/bot([^/]+)\/(\w+)$/);
    const body = JSON.parse(opts.body || '{}');
    const ok = (result) => ({ json: async () => ({ ok: true, result }) });
    if (!names[token]) return { json: async () => ({ ok: false, description: 'Unauthorized' }) };
    if (method === 'getMe') return ok({ username: names[token] });
    if (method === 'sendMessage') { sent.push({ token, chat: String(body.chat_id), text: body.text }); return ok({}); }
    if (method === 'getUpdates') { const u = updates[token] || []; updates[token] = []; return ok(u); }
    return ok({});
  };
  let id = 1;
  const start = (token, chatId, text) => (updates[token] ||= []).push({ update_id: id++, message: { chat: { id: chatId }, text } });
  return { sent, fetchImpl, start };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));
  const tg = fakeTelegram();
  const sent = tg.sent;
  const ctx = createApp({ dataDir: dir, inviteCode: INVITE, secretKey: 'test-secret', telegramFetch: tg.fetchImpl });
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, server, base, sent, dir, tg };
}

function client(base) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'X-Requested-With': 'planner', ...(cookie ? { Cookie: cookie } : {}), ...(body && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? (isBuf ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b),
    put: (u, b, h) => call('PUT', u, b, h), del: (u) => call('DELETE', u),
  };
}

const register = (c, name, login, role) => c.post('/api/auth/register', { name, login, password: 'test-password-1', role, inviteCode: INVITE });
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

test('сценарий проверки из ТЗ', async (t) => {
  const s = setup();
  t.after(() => { s.telegram.stop(); s.server.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  const am = client(s.base);
  const gm = client(s.base);
  const stranger = client(s.base);

  // Без кода приглашения регистрации нет
  const noCode = await client(s.base).post('/api/auth/register', { name: 'Посторонний', login: 'outsider', password: 'test-password-1', role: 'am', inviteCode: 'wrong' });
  assert.equal(noCode.status, 403);

  // 1. Регистрация и привязка
  assert.equal((await register(am, 'Тестовый Аккаунт', 'test-am', 'am')).status, 201);
  const gmReg = await register(gm, 'Иван Тестов', 'ivan-test', 'gm');
  assert.equal(gmReg.status, 201);
  const gmId = gmReg.body.user.id;

  // До привязки гейм-менеджер не может ставить задачи и ничего не видит
  assert.deepEqual((await gm.get('/api/tasks')).body.tasks, []);

  assert.equal((await am.post('/api/team', { login: 'ivan-test' })).status, 201);
  const avatar = await gm.put('/api/me/avatar', PNG, { 'Content-Type': 'image/png' });
  assert.equal(avatar.status, 200);
  assert.match(avatar.body.user.avatar, /^\/files\/avatar-/);
  assert.equal((await gm.put('/api/me/avatar', Buffer.from('not an image'), { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await gm.get(avatar.body.user.avatar)).status, 200);
  assert.equal((await client(s.base).get(avatar.body.user.avatar)).status, 401);

  // 2. Проект «Альфа» фиолетовый, задача гейм-менеджеру через 6 дней
  const proj = await am.post('/api/projects', { name: 'Проект Альфа', color: '#8b5cf6', memberIds: [gmId] });
  assert.equal(proj.status, 201);
  const created = await am.post('/api/tasks', {
    title: 'Пре-релиз новинки TestGames', description: 'Согласовать дату пре-релиза с TestGames',
    deadline: daysFromNow(6), assigneeId: gmId, projectId: proj.body.project.id,
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  assert.equal(created.body.task.project.color, '#8b5cf6');

  const gmTasks = (await gm.get('/api/tasks')).body.tasks;
  assert.equal(gmTasks.length, 1);
  assert.equal(gmTasks[0].assignee.avatar, avatar.body.user.avatar);
  assert.equal((await am.get('/api/tasks')).body.tasks.length, 1);

  // По умолчанию ничего не отправляется
  assert.deepEqual((await gm.get('/api/notifications/unread')).body.notifications, []);
  const at = (hour) => { const d = new Date(); d.setUTCHours(hour - 3, 5, 0, 0); return d; }; // час по Минску
  assert.equal(s.notifier.runReminders(at(10)), 0, 'без галочек напоминаний нет');

  // Гейм-менеджер выбирает: о новых задачах, за 4 дня и за 1 день; подключает свой бот
  const st = await gm.patch('/api/me/settings', { notifyOnCreate: true, notifyDays: [4, 1] });
  assert.deepEqual(st.body.settings.notifyDays, [4, 1]);
  assert.equal((await gm.patch('/api/me/settings', { notifyDays: [2] })).status, 400);
  assert.equal((await gm.put('/api/me/telegram', { token: '123:bad' })).status, 400);
  const link = await gm.put('/api/me/telegram', { token: TOKEN_A });
  assert.equal(link.status, 200);
  assert.equal(link.body.botUsername, 'alpha_test_bot');
  const code = link.body.url.split('start=')[1];
  s.tg.start(TOKEN_A, 100, `/start ${code}`);
  await s.telegram.pollOnce(TOKEN_A, s.telegram.tokenHash(TOKEN_A), 0);
  const meGm = (await gm.get('/api/me')).body;
  assert.equal(meGm.settings.telegram.linked, true);
  assert.ok(!JSON.stringify(meGm).includes(TOKEN_A), 'ключ бота не отдаётся в браузер');
  const enc = s.db.prepare('SELECT tg_token_enc FROM users WHERE id = ?').get(gmId).tg_token_enc;
  assert.ok(enc && !enc.includes(TOKEN_A), 'ключ бота хранится зашифрованным');
  assert.equal((await gm.post('/api/me/telegram/test')).status, 200);

  const second = await am.post('/api/tasks', { title: 'Скидки на слоты TestGames', deadline: daysFromNow(10), assigneeId: gmId, projectId: proj.body.project.id });
  assert.equal(second.status, 201);
  let unread = (await gm.get('/api/notifications/unread')).body.notifications;
  assert.deepEqual(unread.map((n) => n.kind), ['created']);
  assert.ok(s.sent.some((m) => m.chat === '100' && m.token === TOKEN_A && m.text.includes('Скидки на слоты')));

  // 3. Дедлайн через 4 дня → напоминание только тому, кто выбрал «за 4 дня»; через 1 день → «за 1 день»
  await am.patch(`/api/tasks/${taskId}`, { deadline: new Date(at(12).getTime() + 4 * 86400000).toISOString() });
  assert.equal(s.notifier.runReminders(at(9)), 0, 'до выбранного часа напоминаний нет');
  assert.equal(s.notifier.runReminders(at(10)), 1, 'только гейм-менеджеру, у автора галочек нет');
  assert.equal(s.notifier.runReminders(at(11)), 0, 'повторно не шлём');
  await am.patch(`/api/tasks/${taskId}`, { deadline: new Date(at(12).getTime() + 3 * 86400000).toISOString() });
  assert.equal(s.notifier.runReminders(at(10)), 0, 'за 3 дня не выбрано');
  await am.patch(`/api/tasks/${taskId}`, { deadline: new Date(at(12).getTime() + 1 * 86400000).toISOString() });
  assert.equal(s.notifier.runReminders(at(10)), 1);
  unread = (await gm.get('/api/notifications/unread')).body.notifications;
  assert.deepEqual(unread.map((n) => n.kind), ['created', 'reminder4', 'reminder1']);
  assert.ok(!s.sent.some((m) => m.text.includes('Согласовать дату')), 'описание в Telegram не уходит');
  assert.deepEqual((await am.get('/api/notifications/unread')).body.notifications, [], 'автор ничего не выбирал');

  // Аккаунт-менеджер выбирает «когда мою задачу завершили» и свой час напоминаний
  await am.patch('/api/me/settings', { notifyOnDone: true });
  assert.equal((await gm.patch('/api/me/settings', { notifyHour: 8 })).body.settings.notifyHour, 8);

  // Гейм-менеджер может назначить задачу только себе и не может редактировать чужую
  const amId = (await am.get('/api/me')).body.user.id;
  assert.equal((await gm.post('/api/tasks', { title: 'x', deadline: daysFromNow(3), assigneeId: amId, projectId: proj.body.project.id })).status, 403);
  assert.equal((await gm.patch(`/api/tasks/${taskId}`, { title: 'Другое' })).status, 403);

  // 4. Статусы и результат
  assert.equal((await gm.patch(`/api/tasks/${taskId}`, { status: 'in_progress' })).body.task.status, 'in_progress');
  assert.equal((await gm.patch(`/api/tasks/${taskId}`, { status: 'done' })).status, 400);
  const done = await gm.patch(`/api/tasks/${taskId}`, { status: 'done', result: 'Дата пре-релиза согласована с TestGames' });
  assert.equal(done.status, 200);
  assert.ok(done.body.task.completedAt);

  const report = (await am.get('/api/reports/week')).body;
  assert.equal(report.completed.length, 1);
  assert.equal(report.completed[0].id, taskId);
  assert.equal(report.completed[0].result, 'Дата пре-релиза согласована с TestGames');
  assert.equal((await gm.get('/api/reports/week')).body.completed.length, 1);
  assert.ok((await am.get('/api/notifications/unread')).body.notifications.some((n) => n.kind === 'done'));

  // 5. Пользователь другой команды задачу не видит
  await register(stranger, 'Другой Менеджер', 'other-am', 'am');
  assert.deepEqual((await stranger.get('/api/tasks')).body.tasks, []);
  assert.equal((await stranger.get(`/api/tasks/${taskId}`)).status, 404);
  assert.equal((await stranger.patch(`/api/tasks/${taskId}`, { status: 'new' })).status, 404);
  assert.equal((await stranger.get('/api/reports/week')).body.completed.length, 0);
  assert.equal((await stranger.post('/api/team', { login: 'ivan-test' })).status, 409, 'чужого гейм-менеджера не забрать');
});

test('общий Telegram-бот на несколько пользователей', async (t) => {
  const s = setup();
  t.after(() => { s.telegram.stop(); s.server.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  const am = client(s.base);
  const gm = client(s.base);
  await register(am, 'Тестовый Аккаунт', 'test-am3', 'am');
  const gmId = (await register(gm, 'Иван Тестов', 'ivan-test3', 'gm')).body.user.id;
  await am.post('/api/team', { login: 'ivan-test3' });
  const proj = (await am.post('/api/projects', { name: 'Проект Альфа', color: '#8b5cf6', memberIds: [gmId] })).body.project;

  // Оба вставляют один и тот же ключ — каждый привязывает свой чат своим кодом
  const l1 = (await am.put('/api/me/telegram', { token: TOKEN_SHARED })).body.url.split('start=')[1];
  const l2 = (await gm.put('/api/me/telegram', { token: TOKEN_SHARED })).body.url.split('start=')[1];
  assert.notEqual(l1, l2);
  s.tg.start(TOKEN_SHARED, 501, `/start ${l1}`);
  s.tg.start(TOKEN_SHARED, 502, `/start ${l2}`);
  await s.telegram.pollOnce(TOKEN_SHARED, s.telegram.tokenHash(TOKEN_SHARED), 0);

  await am.patch('/api/me/settings', { notifyOnDone: true });
  await gm.patch('/api/me/settings', { notifyOnCreate: true });
  const task = (await am.post('/api/tasks', { title: 'Релиз игры TestGames', deadline: daysFromNow(8), assigneeId: gmId, projectId: proj.id })).body.task;
  await gm.patch(`/api/tasks/${task.id}`, { status: 'done', result: 'Релиз прошёл' });
  await new Promise((r) => setImmediate(r));

  const toGm = s.sent.filter((m) => m.chat === '502').map((m) => m.text);
  const toAm = s.sent.filter((m) => m.chat === '501').map((m) => m.text);
  assert.ok(toGm.some((x) => x.includes('Вам новая задача')) && !toGm.some((x) => x.includes('завершена')));
  assert.ok(toAm.some((x) => x.includes('Задача завершена')) && !toAm.some((x) => x.includes('Вам новая задача')));

  // Отключение: сообщения больше не уходят
  await gm.del('/api/me/telegram');
  assert.equal((await gm.get('/api/me')).body.settings.telegram.botUsername, null);
});

test('безопасность: вход, индексация, CSRF', async (t) => {
  const s = setup();
  t.after(() => { s.telegram.stop(); s.server.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
  const anon = client(s.base);
  assert.equal((await anon.get('/api/tasks')).status, 401);
  assert.equal((await anon.get('/assets/audio/chime.wav')).status, 401);
  const robots = await anon.get('/robots.txt');
  assert.match(robots.body, /Disallow: \//);
  assert.match(robots.headers.get('x-robots-tag'), /noindex/);

  const c = client(s.base);
  await register(c, 'Тестовый Аккаунт', 'test-am2', 'am');
  const row = s.db.prepare('SELECT password_hash FROM users WHERE login = ?').get('test-am2');
  assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes('test-password-1'));
  assert.equal((await c.get('/assets/audio/chime.wav')).status, 200);

  // Без служебного заголовка изменяющий запрос отклоняется
  const res = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);

  assert.equal((await anon.post('/api/auth/login', { login: 'test-am2', password: 'wrong-pass' })).status, 401);
  assert.equal((await anon.post('/api/auth/login', { login: 'test-am2', password: 'test-password-1' })).status, 200);
});
