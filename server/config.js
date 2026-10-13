const path = require('node:path');

const root = path.join(__dirname, '..');

function loadConfig(overrides = {}) {
  const env = process.env;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(root, 'data');
  return {
    port: Number(env.PORT || 3000),
    production: env.NODE_ENV === 'production',
    dataDir,
    dbPath: overrides.dbPath || path.join(dataDir, 'planner.db'),
    uploadDir: overrides.uploadDir || path.join(dataDir, 'uploads'),
    tz: env.TZ_NAME || 'Europe/Minsk',
    inviteCode: overrides.inviteCode !== undefined ? overrides.inviteCode : (env.INVITE_CODE || ''),
    // Ключ шифрования для ключей Telegram-ботов пользователей
    secretKey: overrides.secretKey !== undefined ? overrides.secretKey : (env.SECRET_KEY || ''),
    defaultNotifyHour: 10,
    sessionDays: 30,
    root,
    ...overrides,
  };
}

module.exports = { loadConfig };
