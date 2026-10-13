// Сборка демо-версии без сервера: node scripts/build-demo.js <папка>
// Берёт интерфейс из public/ как есть и подключает demo/fake-api.js вместо настоящего API.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'demo-dist'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(out, to));
};

// Стили: пути к шрифтам — относительные, плюс плашка демо-режима
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8').replace(/url\(\/fonts\//g, 'url(fonts/') + `
/* Демо-режим */
.demo-bar {
  position: fixed; left: 16px; bottom: 16px; z-index: 70; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  max-width: calc(100vw - 32px); padding: 8px 10px; border-radius: 12px; background: var(--panel); border: 1px solid var(--accent-line);
  box-shadow: 0 10px 30px rgba(0, 0, 0, .45); font-size: 12px;
}
.demo-bar b { font-family: var(--font-mono); color: var(--coral); letter-spacing: 1px; }
.demo-bar span { color: var(--muted); }
`;
fs.writeFileSync(path.join(out, 'styles.css'), css);
copy('public/app.js', 'app.js');
copy('shared/deadline.js', 'deadline.js');
copy('demo/fake-api.js', 'fake-api.js');
for (const f of fs.readdirSync(path.join(root, 'public/fonts'))) if (f.endsWith('.woff2')) copy(`public/fonts/${f}`, `fonts/${f}`);
for (const f of fs.readdirSync(path.join(root, 'assets/audio'))) copy(`assets/audio/${f}`, `assets/audio/${f}`);
copy('assets/img/avatar-default.svg', 'assets/img/avatar-default.svg');

// Страница: без <html>/<head>/<body> — их добавляет площадка публикации
fs.writeFileSync(path.join(out, 'index.html'), `<title>Планнер задач — демо</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="styles.css">
<div id="app"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="deadline.js"></script>
<script src="fake-api.js"></script>
<script src="app.js"></script>
`);
console.log('Демо собрано в', out);
