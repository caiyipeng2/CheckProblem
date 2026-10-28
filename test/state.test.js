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
