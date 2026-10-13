// Тестовый сценарий из ТЗ на одном гейм-менеджере. Только тестовые данные.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const INVITE = 'test-invite-code';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));
  const sent = [];
  const telegram = { enabled: true, send: async (chat, text) => { sent.push({ chat, text }); return true; }, linkUrl: (c) => `https://t.me/test_bot?start=${c}`, start() {}, stop() {} };
  const ctx = createApp({ dataDir: dir, inviteCode: INVITE, telegram });
  const server = ctx.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, server, base, sent, dir };
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
  t.after(() => { s.server.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
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

  const unread = (await gm.get('/api/notifications/unread')).body.notifications;
  assert.equal(unread.length, 1);
  assert.equal(unread[0].kind, 'created');

  // Telegram: после привязки чата уведомления уходят туда
  s.db.prepare('UPDATE users SET tg_chat_id = ? WHERE id = ?').run('100', gmId);

  // 3. Дедлайн через 4 дня → напоминание; через 1 день → ещё одно
  const at = (hour) => { const d = new Date(); d.setUTCHours(hour - 3, 5, 0, 0); return d; }; // час по Минску
  await am.patch(`/api/tasks/${taskId}`, { deadline: new Date(at(12).getTime() + 4 * 86400000).toISOString() });
  assert.equal(s.notifier.runReminders(at(9)), 0, 'до 10:00 напоминаний нет');
  assert.equal(s.notifier.runReminders(at(10)), 2, 'исполнителю и автору');
  assert.equal(s.notifier.runReminders(at(11)), 0, 'повторно не шлём');
  await am.patch(`/api/tasks/${taskId}`, { deadline: new Date(at(12).getTime() + 1 * 86400000).toISOString() });
  assert.equal(s.notifier.runReminders(at(10)), 2);
  const kinds = (await gm.get('/api/notifications/unread')).body.notifications.map((n) => n.kind);
  assert.deepEqual(kinds, ['created', 'reminder5', 'reminder2']);
  assert.ok(s.sent.some((m) => m.chat === '100' && m.text.includes('2 дня')));
  assert.ok(!s.sent.some((m) => m.text.includes('Согласовать дату')), 'описание в Telegram не уходит');

  // Время напоминаний — своё у каждого пользователя
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

test('безопасность: вход, индексация, CSRF', async (t) => {
  const s = setup();
  t.after(() => { s.server.close(); fs.rmSync(s.dir, { recursive: true, force: true }); });
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
