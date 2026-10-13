// Загрузка пользовательских файлов (аватарки, мелодии) в хранилище на сервере (DATA_DIR/uploads)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./util');

const KINDS = {
  avatar: {
    maxBytes: 2 * 1024 * 1024,
    detect(b) {
      if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
      if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
      if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
      return null;
    },
    error: 'Аватар: PNG, JPEG или WEBP до 2 МБ',
  },
  sound: {
    maxBytes: 5 * 1024 * 1024,
    detect(b) {
      if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
      if (b.length > 4 && b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
      if (b.length > 3 && b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
      if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
      return null;
    },
    error: 'Мелодия: MP3, WAV или OGG до 5 МБ',
  },
};

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' };

function createUploads(uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });

  function save(kind, body) {
    const spec = KINDS[kind];
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, spec.error);
    if (body.length > spec.maxBytes) throw new HttpError(413, spec.error);
    const ext = spec.detect(body);
    if (!ext) throw new HttpError(415, spec.error);
    const name = `${kind}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, name), body);
    return name;
  }

  function remove(name) {
    if (!name || !/^[a-z]+-[a-f0-9]{24}\.[a-z0-9]+$/.test(name)) return;
    fs.rm(path.join(uploadDir, name), { force: true }, () => {});
  }

  // Отдача файла (только для вошедших — проверка в index.js)
  function serve(req, res, next) {
    const name = req.params.name;
    if (!/^[a-z]+-[a-f0-9]{24}\.[a-z0-9]+$/.test(name)) return next(new HttpError(404, 'Файл не найден'));
    const file = path.join(uploadDir, name);
    if (!fs.existsSync(file)) return next(new HttpError(404, 'Файл не найден'));
    res.setHeader('Content-Type', MIME[name.split('.').pop()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }

  return { save, remove, serve, maxBytes: Math.max(KINDS.avatar.maxBytes, KINDS.sound.maxBytes) };
}

module.exports = { createUploads };
