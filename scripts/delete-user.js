// Удаление пользователя владельцем планнера (запускает человек на сервере):
//   docker compose exec app node --disable-warning=ExperimentalWarning scripts/delete-user.js <логин>
// Задачи, где пользователь автор или исполнитель, удаляются вместе с ним. Восстановления нет.
const readline = require('node:readline/promises');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');

(async () => {
  const login = process.argv[2];
  if (!login) { console.error('Укажите логин'); process.exit(1); }
  const db = openDb(loadConfig().dbPath);
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!user) { console.error('Пользователь не найден'); process.exit(1); }
  const tasks = db.prepare('SELECT COUNT(*) n FROM tasks WHERE author_id = ? OR assignee_id = ?').get(user.id, user.id).n;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Удалить «${user.name}» (${user.role === 'am' ? 'аккаунт-менеджер, вместе с его проектами' : 'гейм-менеджер'}) и ${tasks} задач? Введите логин для подтверждения: `);
  rl.close();
  if (answer.trim() !== login) { console.log('Отменено'); return; }
  db.exec('BEGIN');
  db.prepare('DELETE FROM tasks WHERE author_id = ? OR assignee_id = ?').run(user.id, user.id);
  if (user.role === 'am') db.prepare('UPDATE users SET team_id = NULL WHERE team_id = ? AND id != ?').run(user.id, user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  db.exec('COMMIT');
  console.log('Удалено');
})();
