// Telegram: у каждого пользователя свой ключ бота (личный или общий на несколько человек).
// Ключи хранятся в базе в зашифрованном виде. Для каждого уникального ключа работает один
// цикл long polling — он принимает /start <код> и привязывает чат пользователя.
const crypto = require('node:crypto');
const { HttpError } = require('./util');

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createTelegram({ db, cipher, fetchImpl = fetch, polling = true, log = console }) {
  const pollers = new Map(); // tokenHash → { running, offset }

  async function api(token, method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  function tokenOf(user) {
    if (!cipher || !user.tg_token_enc) return null;
    try { return cipher.decrypt(user.tg_token_enc); } catch { return null; }
  }

  async function sendRaw(token, chatId, text) {
    try {
      const r = await api(token, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      if (!r.ok) log.warn('Telegram sendMessage:', r.description);
      return !!r.ok;
    } catch (e) {
      log.warn('Telegram недоступен:', e.message);
      return false;
    }
  }

  async function send(user, text) {
    const token = tokenOf(user);
    if (!token || !user.tg_chat_id) return false;
    return sendRaw(token, user.tg_chat_id, text);
  }

  async function handle(token, hash, update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const m = msg.text.trim().match(/^\/start\s+([a-f0-9]{32})$/i);
    if (!m) {
      await sendRaw(token, chatId, 'Чтобы получать уведомления, откройте планнер → Настройки → Telegram и перейдите по ссылке оттуда.');
      return;
    }
    const user = db.prepare('SELECT id, name FROM users WHERE tg_link_code = ? AND tg_token_hash = ?').get(m[1], hash);
    if (!user) {
      await sendRaw(token, chatId, 'Ссылка устарела. Получите новую в настройках планнера.');
      return;
    }
    db.prepare('UPDATE users SET tg_chat_id = ?, tg_link_code = NULL WHERE id = ?').run(chatId, user.id);
    await sendRaw(token, chatId, `Готово, ${user.name}! Уведомления планнера будут приходить сюда.`);
  }

  // Один шаг опроса (вынесен отдельно для тестов)
  async function pollOnce(token, hash, timeout = 30) {
    const p = pollers.get(hash) || { offset: 0 };
    const r = await api(token, 'getUpdates', { offset: p.offset, timeout, allowed_updates: ['message'] });
    if (!r.ok) throw new Error(r.description || 'getUpdates failed');
    for (const u of r.result) {
      p.offset = u.update_id + 1;
      await handle(token, hash, u);
    }
  }

  function ensurePoller(token) {
    const hash = tokenHash(token);
    if (!polling || pollers.has(hash)) return;
    const p = { running: true, offset: 0 };
    pollers.set(hash, p);
    (async () => {
      while (p.running) {
        try { await pollOnce(token, hash); } catch (e) {
          log.warn('Telegram polling:', e.message);
          await new Promise((res) => setTimeout(res, 15000));
        }
      }
    })();
  }

  function stopPollerIfUnused(hash) {
    if (!hash) return;
    const used = db.prepare('SELECT 1 FROM users WHERE tg_token_hash = ?').get(hash);
    const p = pollers.get(hash);
    if (!used && p) { p.running = false; pollers.delete(hash); }
  }

  const newCode = () => crypto.randomBytes(16).toString('hex');
  const linkUrl = (username, code) => `https://t.me/${username}?start=${code}`;

  // Подключить бота пользователю: проверка ключа, шифрование, ссылка для /start
  async function connect(user, rawToken) {
    if (!cipher) throw new HttpError(503, 'На сервере не задан SECRET_KEY — подключение Telegram недоступно');
    const token = String(rawToken || '').trim();
    if (!TOKEN_RE.test(token)) throw new HttpError(400, 'Это не похоже на ключ бота. Скопируйте его из @BotFather целиком, например 123456789:AA…');
    let me;
    try { me = await api(token, 'getMe'); } catch { throw new HttpError(502, 'Не удалось связаться с Telegram. Попробуйте позже'); }
    if (!me.ok) throw new HttpError(400, 'Telegram не принял ключ. Проверьте его в @BotFather');
    const oldHash = user.tg_token_hash;
    const hash = tokenHash(token);
    const code = newCode();
    db.prepare(`UPDATE users SET tg_token_enc = ?, tg_token_hash = ?, tg_bot_username = ?, tg_link_code = ?, tg_chat_id = NULL
      WHERE id = ?`).run(cipher.encrypt(token), hash, me.result.username, code, user.id);
    if (oldHash && oldHash !== hash) stopPollerIfUnused(oldHash);
    ensurePoller(token);
    return { botUsername: me.result.username, url: linkUrl(me.result.username, code) };
  }

  function relink(user) {
    if (!user.tg_bot_username) throw new HttpError(400, 'Сначала укажите ключ бота');
    const code = newCode();
    db.prepare('UPDATE users SET tg_link_code = ?, tg_chat_id = NULL WHERE id = ?').run(code, user.id);
    return { botUsername: user.tg_bot_username, url: linkUrl(user.tg_bot_username, code) };
  }

  function disconnect(user) {
    db.prepare(`UPDATE users SET tg_token_enc = NULL, tg_token_hash = NULL, tg_bot_username = NULL,
      tg_link_code = NULL, tg_chat_id = NULL WHERE id = ?`).run(user.id);
    stopPollerIfUnused(user.tg_token_hash);
  }

  function status(user) {
    return {
      available: !!cipher,
      botUsername: user.tg_bot_username || null,
      linked: !!(user.tg_bot_username && user.tg_chat_id),
    };
  }

  return {
    connect, relink, disconnect, status, send, pollOnce, tokenHash,
    start() {
      if (!cipher) return;
      const rows = db.prepare('SELECT tg_token_enc FROM users WHERE tg_token_hash IS NOT NULL GROUP BY tg_token_hash').all();
      for (const r of rows) {
        const token = tokenOf(r);
        if (token) ensurePoller(token);
      }
    },
    stop() { for (const p of pollers.values()) p.running = false; pollers.clear(); },
  };
}

module.exports = { createTelegram };
