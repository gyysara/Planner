const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../shared/deadline');

const TZ = 'Europe/Minsk';
const now = new Date('2026-10-13T09:00:00Z'); // 12:00 по Минску, вторник
const inDays = (n, hour = 15) => new Date(Date.UTC(2026, 9, 13 + n, hour - 3)).toISOString();

test('рамка по сроку', () => {
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(6) }, now, TZ), 'normal');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(5) }, now, TZ), 'yellow');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(4) }, now, TZ), 'yellow');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(2) }, now, TZ), 'red');
  assert.equal(D.borderStage({ status: 'in_progress', deadline: inDays(1) }, now, TZ), 'red');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(0) }, now, TZ), 'red');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(0, 11) }, now, TZ), 'overdue');
  assert.equal(D.borderStage({ status: 'new', deadline: inDays(-1) }, now, TZ), 'overdue');
  assert.equal(D.borderStage({ status: 'done', deadline: inDays(-1) }, now, TZ), 'none');
  assert.equal(D.borderStage({ status: 'done', deadline: inDays(1) }, now, TZ), 'none');
});

test('дни до дедлайна', () => {
  assert.equal(D.daysLeft(inDays(5), now, TZ), 5);
  assert.equal(D.daysLeft(inDays(0, 23), now, TZ), 0);
  assert.equal(D.daysLeft(inDays(-1), now, TZ), -1);
});

test('неделя с понедельника', () => {
  assert.equal(D.mondayOf('2026-10-13'), '2026-10-12');
  assert.equal(D.mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(D.mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(D.dayKey('2026-10-12T21:30:00Z', TZ), '2026-10-13'); // 00:30 по Минску
});

test('перевод даты и времени пояса в UTC', () => {
  assert.equal(D.toInstant('2026-10-18', '15:00', TZ), '2026-10-18T12:00:00.000Z');
  assert.equal(D.toInstant('2026-10-13', '00:30', TZ), '2026-10-12T21:30:00.000Z');
});

test('даты повторений', () => {
  const a = D.toInstant('2026-01-31', '15:00', TZ);
  assert.equal(D.dayKey(D.occurrence(a, 'daily', 1, TZ), TZ), '2026-02-01');
  assert.equal(D.dayKey(D.occurrence(a, 'weekly', 1, TZ), TZ), '2026-02-07');
  assert.equal(D.dayKey(D.occurrence(a, 'biweekly', 2, TZ), TZ), '2026-02-28');
  assert.equal(D.dayKey(D.occurrence(a, 'monthly', 1, TZ), TZ), '2026-02-28', '31-е → последний день февраля');
  assert.equal(D.dayKey(D.occurrence(a, 'monthly', 2, TZ), TZ), '2026-03-31', 'дальше снова 31-е');
  assert.equal(D.zoned(D.occurrence(a, 'monthly', 5, TZ), TZ).hour, 15, 'время сохраняется');
});
