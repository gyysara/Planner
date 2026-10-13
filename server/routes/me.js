const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, publicUser } = require('../util');
const { REMINDER_DAYS, parseDays } = require('../notify');

const SOUND_TITLES = {
  'alarm-classic.wav': 'Классический будильник',
  'chime.wav': 'Колокольчик',
  'jackpot.wav': 'Джекпот',
  'neon.wav': 'Неон',
};

function defaultSounds(root) {
  const dir = path.join(root, 'assets', 'audio');
  return fs.readdirSync(dir).filter((f) => /\.(wav|mp3|ogg)$/.test(f)).sort()
    .map((f) => ({ id: `default:${f}`, title: SOUND_TITLES[f] || f, url: `/assets/audio/${f}` }));
}

function soundUrl(sound) {
  if (!sound) return '/assets/audio/alarm-classic.wav';
  const [type, file] = sound.split(':');
  return type === 'custom' ? `/files/${file}` : `/assets/audio/${file}`;
}

function meRouter({ db, config, uploads, telegram }) {
  const r = express.Router();
  const raw = express.raw({ type: () => true, limit: uploads.maxBytes });

  const me = (req) => {
    const u = req.user;
    return {
      user: publicUser(u),
      settings: {
        sound: u.sound,
        soundUrl: soundUrl(u.sound),
        notifyHour: u.notify_hour,
        notifyOnCreate: !!u.notify_on_create,
        notifyOnDone: !!u.notify_on_done,
        notifyDays: parseDays(u.notify_days),
        telegram: telegram.status(u),
      },
      config: { tz: config.tz },
    };
  };

  r.get('/me', (req, res) => res.json(me(req)));

  r.get('/sounds', (_req, res) => res.json({ sounds: defaultSounds(config.root) }));

  r.put('/me/avatar', raw, (req, res) => {
    const name = uploads.save('avatar', req.body);
    uploads.remove(req.user.avatar);
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(name, req.user.id);
    req.user.avatar = name;
    res.json(me(req));
  });

  r.put('/me/sound-file', raw, (req, res) => {
    const name = uploads.save('sound', req.body);
    const old = req.user.sound || '';
    if (old.startsWith('custom:')) uploads.remove(old.slice(7));
    req.user.sound = `custom:${name}`;
    db.prepare('UPDATE users SET sound = ? WHERE id = ?').run(req.user.sound, req.user.id);
    res.json(me(req));
  });

  r.patch('/me/settings', (req, res) => {
    const { sound, notifyHour, notifyOnCreate, notifyOnDone, notifyDays } = req.body || {};
    const set = (col, val) => { db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, req.user.id); req.user[col] = val; };
    if (notifyOnCreate !== undefined) set('notify_on_create', notifyOnCreate ? 1 : 0);
    if (notifyOnDone !== undefined) set('notify_on_done', notifyOnDone ? 1 : 0);
    if (notifyDays !== undefined) {
      if (!Array.isArray(notifyDays) || !notifyDays.every((d) => REMINDER_DAYS.includes(d))) {
        throw new HttpError(400, 'Дни напоминаний: 5, 4, 3, 1 или 0 (день дедлайна)');
      }
      set('notify_days', [...new Set(notifyDays)].sort((a, b) => b - a).join(','));
    }
    if (sound !== undefined) {
      const ok = defaultSounds(config.root).some((s) => s.id === sound)
        || (sound === req.user.sound && sound.startsWith('custom:'));
      if (!ok) throw new HttpError(400, 'Неизвестная мелодия');
      const old = req.user.sound || '';
      if (old !== sound && old.startsWith('custom:')) uploads.remove(old.slice(7));
      db.prepare('UPDATE users SET sound = ? WHERE id = ?').run(sound, req.user.id);
      req.user.sound = sound;
    }
    if (notifyHour !== undefined) {
      const h = Number(notifyHour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, 'Час напоминаний: от 0 до 23');
      db.prepare('UPDATE users SET notify_hour = ? WHERE id = ?').run(h, req.user.id);
      req.user.notify_hour = h;
    }
    res.json(me(req));
  });

  // Подключить свой (или общий) Telegram-бот: ключ проверяется и хранится зашифрованным
  r.put('/me/telegram', async (req, res, next) => {
    try {
      const link = await telegram.connect(req.user, (req.body || {}).token);
      res.json({ ...link, ...me({ user: db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) }) });
    } catch (e) { next(e); }
  });

  // Новая ссылка для /start (например, если открыли не тот аккаунт Telegram)
  r.post('/me/telegram/link', (req, res) => {
    res.json(telegram.relink(req.user));
  });

  r.post('/me/telegram/test', async (req, res, next) => {
    try {
      if (!req.user.tg_chat_id) throw new HttpError(400, 'Сначала откройте бота по ссылке и нажмите Start');
      const ok = await telegram.send(req.user, '✅ Планнер подключён. Сюда будут приходить выбранные вами уведомления.');
      if (!ok) throw new HttpError(502, 'Telegram не принял сообщение. Проверьте, что бот не заблокирован');
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.delete('/me/telegram', (req, res) => {
    telegram.disconnect(req.user);
    res.json(me({ user: db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) }));
  });

  return r;
}

module.exports = { meRouter };
