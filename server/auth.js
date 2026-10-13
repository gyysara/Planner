const crypto = require('node:crypto');
const express = require('express');
const { HttpError, publicUser } = require('./util');

const COOKIE = 'sid';
const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Простой ограничитель попыток входа: 10 неудач за 15 минут на IP+логин
function createLimiter(max = 10, windowMs = 15 * 60 * 1000) {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.first > windowMs) return false;
      return h.count >= max;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.first > windowMs) hits.set(key, { first: Date.now(), count: 1 });
      else h.count++;
    },
    reset(key) { hits.delete(key); },
  };
}

function createAuth({ db, config }) {
  const limiter = createLimiter();

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.sessionDays * 86400000);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, expires.toISOString());
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${expires.toUTCString()}`];
    if (config.production) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  // Подставляет req.user, если сессия действительна
  function loadUser(req, _res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), new Date().toISOString());
      if (row) { req.user = row; req.sessionHash = sha256(token); }
    }
    next();
  }

  function requireUser(req, _res, next) {
    if (!req.user) return next(new HttpError(401, 'Нужно войти'));
    next();
  }

  const router = express.Router();

  router.post('/register', (req, res) => {
    const { name, login, password, role, inviteCode } = req.body || {};
    if (!config.inviteCode) throw new HttpError(403, 'Регистрация закрыта: на сервере не задан код приглашения');
    if (!safeEqual(inviteCode || '', config.inviteCode)) throw new HttpError(403, 'Неверный код приглашения');
    const cleanName = String(name || '').trim();
    const cleanLogin = String(login || '').trim();
    if (cleanName.length < 2 || cleanName.length > 80) throw new HttpError(400, 'Имя: от 2 до 80 символов');
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(cleanLogin)) throw new HttpError(400, 'Логин: 3–40 символов, латиница, цифры, . _ -');
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Пароль: не короче 8 символов');
    if (!['am', 'gm'].includes(role)) throw new HttpError(400, 'Выберите роль');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(cleanLogin)) throw new HttpError(409, 'Такой логин уже занят');

    const info = db.prepare(`INSERT INTO users (name, login, password_hash, role, notify_hour) VALUES (?, ?, ?, ?, ?)`)
      .run(cleanName, cleanLogin, hashPassword(password), role, config.defaultNotifyHour);
    const id = Number(info.lastInsertRowid);
    if (role === 'am') db.prepare('UPDATE users SET team_id = id WHERE id = ?').run(id);
    startSession(res, id);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });

  router.post('/login', (req, res) => {
    const { login, password } = req.body || {};
    const key = `${req.ip}|${String(login || '').toLowerCase()}`;
    if (limiter.blocked(key)) throw new HttpError(429, 'Слишком много попыток. Подождите 15 минут');
    const user = db.prepare('SELECT * FROM users WHERE login = ?').get(String(login || '').trim());
    if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    limiter.reset(key);
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  return { router, loadUser, requireUser };
}

module.exports = { createAuth, hashPassword, verifyPassword };
