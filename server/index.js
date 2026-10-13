const path = require('node:path');
const express = require('express');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createAuth } = require('./auth');
const { createUploads } = require('./uploads');
const { createTelegram } = require('./telegram');
const { createNotifier } = require('./notify');
const { createSeries } = require('./series');
const { loadSecret, createCipher } = require('./secret');
const { HttpError } = require('./util');
const { meRouter } = require('./routes/me');
const { teamRouter } = require('./routes/team');
const { projectsRouter } = require('./routes/projects');
const { tasksRouter } = require('./routes/tasks');
const { reportsRouter } = require('./routes/reports');
const { notificationsRouter } = require('./routes/notifications');

function securityHeaders(_req, res, next) {
  // Внутренний инструмент: закрываем от поисковиков и встраивания
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
}

// Защита от CSRF: изменяющие запросы к API принимаются только с заголовком, который ставит наш фронтенд
function requireAppHeader(req, _res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'planner') {
    return next(new HttpError(403, 'Запрос отклонён'));
  }
  next();
}

function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dbPath);
  const uploads = createUploads(config.uploadDir);
  const secret = loadSecret(config);
  const telegram = createTelegram({ db, cipher: secret ? createCipher(secret) : null, fetchImpl: overrides.telegramFetch, polling: !overrides.telegramFetch });
  const notifier = createNotifier({ db, config, telegram });
  const auth = createAuth({ db, config });
  const series = createSeries({ db, config });
  const deps = { db, config, uploads, telegram, notifier, series };

  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(securityHeaders);

  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  app.use('/api', requireAppHeader, express.json({ limit: '100kb' }), auth.loadUser);
  app.use('/api/auth', auth.router);
  app.use('/api', auth.requireUser,
    meRouter(deps), teamRouter(deps), projectsRouter(deps), tasksRouter(deps), reportsRouter(deps), notificationsRouter(deps));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Не найдено')));

  // Файлы — только после входа
  app.get('/files/:name', auth.loadUser, auth.requireUser, uploads.serve);
  app.use('/assets', auth.loadUser, auth.requireUser, express.static(path.join(config.root, 'assets'), { maxAge: '1d' }));

  // Оболочка страницы (без данных) — публична, чтобы показать форму входа
  app.use('/shared', express.static(path.join(config.root, 'shared')));
  app.use(express.static(path.join(config.root, 'public'), { index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let message = err instanceof HttpError ? err.message : 'Ошибка сервера';
    if (err.type === 'entity.too.large') { status = 413; message = 'Файл слишком большой'; }
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Некорректный запрос'; }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return { app, db, config, notifier, telegram, series };
}

if (require.main === module) {
  const { app, config, notifier, telegram, series } = createApp();
  if (!config.inviteCode) console.warn('ВНИМАНИЕ: INVITE_CODE не задан — регистрация закрыта.');
  telegram.start();
  notifier.start();
  // Повторяющиеся задачи достраиваются заранее (раз в час), чтобы для них приходили напоминания
  series.ensure();
  setInterval(() => { try { series.ensure(); } catch (e) { console.error(e); } }, 3600000);
  app.listen(config.port, () => console.log(`Планнер запущен на порту ${config.port}`));
}

module.exports = { createApp };
