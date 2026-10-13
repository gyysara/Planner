const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError, publicUser } = require('../util');

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
        telegramLinked: !!u.tg_chat_id,
        telegramEnabled: telegram.enabled,
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
    const { sound, notifyHour } = req.body || {};
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

  r.post('/me/telegram-link', (req, res) => {
    if (!telegram.enabled) throw new HttpError(503, 'Telegram-бот не настроен на сервере');
    const code = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET tg_link_code = ? WHERE id = ?').run(code, req.user.id);
    const url = telegram.linkUrl(code);
    if (!url) throw new HttpError(503, 'Не удалось получить имя бота');
    res.json({ url });
  });

  r.delete('/me/telegram', (req, res) => {
    db.prepare('UPDATE users SET tg_chat_id = NULL, tg_link_code = NULL WHERE id = ?').run(req.user.id);
    req.user.tg_chat_id = null;
    res.json(me(req));
  });

  return r;
}

module.exports = { meRouter };
