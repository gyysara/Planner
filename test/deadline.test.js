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

test('стадии напоминаний', () => {
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(6) }, now, TZ), null);
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(5) }, now, TZ), 5);
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(3) }, now, TZ), 5);
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(2) }, now, TZ), 2);
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(0) }, now, TZ), 0);
  assert.equal(D.reminderStage({ status: 'new', deadline: inDays(-1) }, now, TZ), null);
  assert.equal(D.reminderStage({ status: 'done', deadline: inDays(1) }, now, TZ), null);
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
