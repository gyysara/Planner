// Telegram-бот: отправка уведомлений и привязка чата по /start <код>.
// Работает в режиме long polling, публичный webhook не нужен.
// Ключ бота берётся только из переменной окружения TELEGRAM_BOT_TOKEN.

function createTelegram({ db, token, username, log = console }) {
  if (!token) {
    return { enabled: false, send: async () => false, linkUrl: () => null, start() {}, stop() {} };
  }
  const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

  let botName = username;
  let offset = 0;
  let running = false;

  async function send(chatId, text) {
    if (!chatId) return false;
    try {
      const r = await api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
      if (!r.ok) log.warn('Telegram sendMessage:', r.description);
      return !!r.ok;
    } catch (e) {
      log.warn('Telegram недоступен:', e.message);
      return false;
    }
  }

  async function handle(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = String(msg.chat.id);
    const m = msg.text.match(/^\/start\s+([a-f0-9]{16,64})$/i);
    if (!m) {
      await send(chatId, 'Чтобы получать уведомления, откройте планнер → Настройки → «Подключить Telegram».');
      return;
    }
    const user = db.prepare('SELECT id, name FROM users WHERE tg_link_code = ?').get(m[1]);
    if (!user) {
      await send(chatId, 'Код не найден или устарел. Получите новую ссылку в настройках планнера.');
      return;
    }
    db.prepare('UPDATE users SET tg_chat_id = ?, tg_link_code = NULL WHERE id = ?').run(chatId, user.id);
    await send(chatId, `Готово, ${user.name}! Уведомления планнера будут приходить сюда.`);
  }

  async function loop() {
    while (running) {
      try {
        const r = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        if (r.ok) {
          for (const u of r.result) {
            offset = u.update_id + 1;
            await handle(u);
          }
        } else {
          log.warn('Telegram getUpdates:', r.description);
          await new Promise((res) => setTimeout(res, 10000));
        }
      } catch (e) {
        log.warn('Telegram polling:', e.message);
        await new Promise((res) => setTimeout(res, 10000));
      }
    }
  }

  return {
    enabled: true,
    send,
    linkUrl: (code) => (botName ? `https://t.me/${botName}?start=${code}` : null),
    async start() {
      if (!botName) {
        try {
          const me = await api('getMe');
          if (me.ok) botName = me.result.username;
        } catch (e) { log.warn('Telegram getMe:', e.message); }
      }
      running = true;
      loop();
    },
    stop() { running = false; },
  };
}

module.exports = { createTelegram };
