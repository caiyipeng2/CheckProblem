import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, loadState, saveState, markSeen } from '../src/state.js';

// Feishu `create_time` is a millisecond timestamp string; keep fixtures 13-digit.
const T1 = '1793162767785';
const T2 = '1793162767999';
const T3 = '1793162768000';

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpFile(t, name = 'state.json') {
  return join(tmpDir(t), 'state', name);
}

test('initialState seeds cursor at nowMs and has no job', () => {
  const s = initialState(Number(T1));
  assert.equal(s.version, 1);
  assert.equal(s.startedAt, Number(T1));
  assert.equal(s.lastSeen.createTimeMs, Number(T1));
  assert.equal(s.job, null);
});

test('saveState creates directories and loadState round-trips', (t) => {
  const file = tmpFile(t);
  const s = initialState(Number(T1));
  s.job = {
    status: 'awaiting',
    triggerMessageId: 'om_1',
    question: 'q',
    context: ['a', 'b'],
    promptMessageId: 'om_2',
    expiresAt: Number(T3),
    confirmer: null,
  };
  saveState(file, s);
  assert.equal(existsSync(file), true);
  assert.deepEqual(loadState(file, 0), s);
});

test('loadState falls back to initialState when file is missing or corrupt', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(loadState(join(dir, 'nope.json'), 777), initialState(777));

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{oops');
  assert.deepEqual(loadState(bad, 888), initialState(888));
});

test('loadState falls back to initialState on wrong version', (t) => {
  const file = tmpFile(t);
  const s = initialState(Number(T1));
  s.version = 2;
  saveState(file, s);
  assert.deepEqual(loadState(file, 999), initialState(999));
});

test('loadState falls back to initialState when lastSeen is missing', (t) => {
  const file = tmpFile(t);
  const s = initialState(Number(T1));
  delete s.lastSeen;
  saveState(file, s);
  assert.deepEqual(loadState(file, 999), initialState(999));
});

test('loadState falls back to initialState when the cursor is an empty object', (t) => {
  const file = tmpFile(t);
  saveState(file, { version: 1, startedAt: 1, lastSeen: {}, job: null });
  assert.equal(loadState(file, 4242).lastSeen.createTimeMs, 4242);
});

test('loadState falls back to initialState when the cursor is a number', (t) => {
  const file = tmpFile(t);
  saveState(file, { version: 1, startedAt: 1, lastSeen: 5, job: null });
  assert.equal(loadState(file, 4243).lastSeen.createTimeMs, 4243);
});

test('loadState normalizes a numeric-string cursor to a number', (t) => {
  const file = tmpFile(t);
  saveState(file, {
    version: 1,
    startedAt: 1,
    lastSeen: { createTimeMs: '5000', messageId: 'om_1' },
    job: null,
  });
  const s = loadState(file, 999);
  assert.equal(s.lastSeen.createTimeMs, 5000);
  assert.equal(typeof s.lastSeen.createTimeMs, 'number');
  assert.equal(s.lastSeen.messageId, 'om_1');
});

test('loadState rejects a null cursor timestamp instead of coercing it to 0', (t) => {
  const file = tmpFile(t);
  saveState(file, {
    version: 1,
    startedAt: 1,
    lastSeen: { createTimeMs: null, messageId: '' },
    job: null,
  });
  // A zero cursor would make the whole chat history look unseen.
  assert.deepEqual(loadState(file, 6000), initialState(6000));
});

test('loadState still loads a fully numeric string cursor as a number', (t) => {
  const file = tmpFile(t);
  saveState(file, {
    version: 1,
    startedAt: 1,
    lastSeen: { createTimeMs: '7000', messageId: 'om_1' },
    job: null,
  });
  const s = loadState(file, 999);
  assert.equal(s.lastSeen.createTimeMs, 7000);
  assert.equal(typeof s.lastSeen.createTimeMs, 'number');
  assert.equal(s.lastSeen.messageId, 'om_1');
});

test('loadState rejects every cursor timestamp that only coercion would make numeric', (t) => {
  const invalid = [null, '', ' ', false, [], {}, NaN, Infinity, ' 7000 ', '12abc', '0x10'];
  const file = tmpFile(t);
  for (const createTimeMs of invalid) {
    saveState(file, {
      version: 1,
      startedAt: 1,
      lastSeen: { createTimeMs, messageId: 'om_1' },
      job: null,
    });
    assert.deepEqual(
      loadState(file, 7000),
      initialState(7000),
      `expected rejection for ${JSON.stringify(createTimeMs)}`,
    );
  }
});

test('a normalized cursor still advances when a newer message arrives', (t) => {
  const file = tmpFile(t);
  saveState(file, {
    version: 1,
    startedAt: 1,
    lastSeen: { createTimeMs: '5000', messageId: 'om_1' },
    job: null,
  });
  const s = loadState(file, 999);
  markSeen(s, { message_id: 'om_2', create_time: '6000' });
  assert.deepEqual(s.lastSeen, { createTimeMs: 6000, messageId: 'om_2' });
});

test('initialState with no argument yields a finite cursor timestamp', () => {
  assert.ok(Number.isFinite(initialState().lastSeen.createTimeMs));
});

test('markSeen advances cursor and leaves job untouched', () => {
  const s = initialState(0);
  s.job = { status: 'running', triggerMessageId: 'om_1', question: 'q' };
  const job = s.job;
  markSeen(s, { message_id: 'om_9', create_time: T1 });
  assert.deepEqual(s.lastSeen, { createTimeMs: Number(T1), messageId: 'om_9' });
  assert.equal(s.job, job);
});

test('markSeen ignores an older message after a newer one', () => {
  const s = initialState(0);
  markSeen(s, { message_id: 'om_9', create_time: T2 });
  markSeen(s, { message_id: 'om_99', create_time: T1 });
  assert.deepEqual(s.lastSeen, { createTimeMs: Number(T2), messageId: 'om_9' });
});

test('markSeen does not let a smaller id win at an equal timestamp', () => {
  const s = initialState(0);
  markSeen(s, { message_id: 'om_b', create_time: T1 });
  markSeen(s, { message_id: 'om_a', create_time: T1 });
  assert.deepEqual(s.lastSeen, { createTimeMs: Number(T1), messageId: 'om_b' });
});

test('markSeen accepts a same-timestamp message with a larger id', () => {
  const s = initialState(0);
  markSeen(s, { message_id: 'om_a', create_time: T1 });
  markSeen(s, { message_id: 'om_b', create_time: T1 });
  assert.deepEqual(s.lastSeen, { createTimeMs: Number(T1), messageId: 'om_b' });
});

test('saveState writes readable JSON with the persisted job', (t) => {
  const file = tmpFile(t);
  const s = initialState(Number(T1));
  s.job = { status: 'awaiting', triggerMessageId: 'om_1', question: 'q', context: [] };
  saveState(file, s);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), s);
});

test('saveState leaves no .tmp file behind', (t) => {
  const file = tmpFile(t);
  saveState(file, initialState(Number(T1)));
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).lastSeen, {
    createTimeMs: Number(T1),
    messageId: '',
  });
});

test('loadState keeps recent reports and drops a corrupt ones field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({
    version: 1, startedAt: 1, lastSeen: { createTimeMs: 5, messageId: 'om_5' }, job: null,
    reports: Array.from({ length: 25 }, (_, i) => ({ requestId: `r${i}`, status: 'completed' })),
  }));
  assert.equal(loadState(file).reports.length, 20);
  assert.equal(loadState(file).reports.at(-1).requestId, 'r24');

  writeFileSync(file, JSON.stringify({
    version: 1, startedAt: 1, lastSeen: { createTimeMs: 5, messageId: 'om_5' }, job: null, reports: 'oops',
  }));
  assert.deepEqual(loadState(file).reports, []);
});
