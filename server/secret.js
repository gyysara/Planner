// Шифрование ключей Telegram-ботов пользователей (AES-256-GCM).
// Ключ шифрования — SECRET_KEY из секретных настроек сервера.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function loadSecret(config, log = console) {
  if (config.secretKey) return crypto.createHash('sha256').update(config.secretKey).digest();
  if (config.production) {
    log.warn('ВНИМАНИЕ: SECRET_KEY не задан — подключение Telegram-ботов недоступно.');
    return null;
  }
  // Локальная разработка: ключ создаётся рядом с базой
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest();
}

function createCipher(key) {
  return {
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(stored) {
      const [v, iv, tag, data] = String(stored).split(':');
      if (v !== 'v1') throw new Error('unknown format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    },
  };
}

module.exports = { loadSecret, createCipher };
