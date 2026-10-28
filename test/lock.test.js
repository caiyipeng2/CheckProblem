import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../src/lock.js';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'checkproblem-lock-')), 'run.lock');

test('a free lock is taken and records the pid', () => {
  const file = lockPath();
  const lock = acquireLock(file, { pid: 111, alive: () => false });
  assert.equal(lock.ok, true);
  assert.equal(readFileSync(file, 'utf8'), '111');
});

test('a lock held by a live process is refused', () => {
  const file = lockPath();
  acquireLock(file, { pid: 111, alive: () => false });
  const second = acquireLock(file, { pid: 222, alive: (pid) => pid === 111 });
  assert.equal(second.ok, false);
  assert.equal(second.pid, 111);
  assert.equal(readFileSync(file, 'utf8'), '111', 'the holder keeps the lock');
});

test('a lock left behind by a dead process is taken over', () => {
  const file = lockPath();
  acquireLock(file, { pid: 111, alive: () => false });
  const second = acquireLock(file, { pid: 222, alive: () => false });
  assert.equal(second.ok, true);
  assert.equal(readFileSync(file, 'utf8'), '222');
});

test('an unreadable lock file does not block startup', () => {
  const file = lockPath();
  writeFileSync(file, 'not-a-pid');
  // Mimics the real probe, which treats a non-pid as dead.
  const lock = acquireLock(file, { pid: 333, alive: (pid) => Number.isInteger(pid) && pid > 0 });
  assert.equal(lock.ok, true);
  assert.equal(readFileSync(file, 'utf8'), '333');
});

test('release removes the lock only when it is ours', () => {
  const file = lockPath();
  acquireLock(file, { pid: 111, alive: () => false });
  releaseLock(file, 222);
  assert.equal(existsSync(file), true, 'a foreign release must not delete the lock');
  releaseLock(file, 111);
  assert.equal(existsSync(file), false);
});