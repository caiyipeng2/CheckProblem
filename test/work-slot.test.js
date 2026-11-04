// Task 11: the single heavy-work slot shared by 故障排查 and 需求拆分.
// The slot owns exactly one decision — is a heavy operation running or not — so
// no other module may keep a second busy flag.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkSlot } from '../src/work-slot.js';

test('a busy slot refuses concurrent heavy work and releases after completion', async () => {
  const slot = createWorkSlot();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = slot.tryStart('bug:r1', () => gate);
  assert.equal(first.accepted, true);
  assert.equal(slot.tryStart('requirements:r2', async () => {}).accepted, false);
  release();
  await first.done;
  assert.equal(slot.isBusy(), false);
});

// The reservation is what makes 忙时明确告知 honest: the caller decides right now,
// so `tryStart` must not be async and `work` must not have run yet.
test('tryStart reserves synchronously and enters the work only afterwards', async () => {
  const slot = createWorkSlot();
  let started = 0;
  const first = slot.tryStart('bug:r1', async () => { started += 1; });

  assert.equal(first.accepted, true);
  assert.equal(started, 0, 'the work is not entered before the caller gets the answer');
  assert.equal(slot.isBusy(), true, 'the slot is taken the moment the reservation is accepted');
  assert.equal(slot.tryStart('requirements:r2', async () => {}).accepted, false);

  await first.done;
  assert.equal(started, 1);
  assert.equal(slot.isBusy(), false);
});

// A leaked reservation would wedge both flows forever, and a swallowed rejection
// would hide a failed analysis or a lost TAPD batch from the operator.
test('a failing operation releases the slot and still rejects its caller', async () => {
  const slot = createWorkSlot();
  const first = slot.tryStart('bug:r1', async () => { throw new Error('codex exec failed'); });

  assert.equal(first.accepted, true);
  await assert.rejects(first.done, /codex exec failed/, 'the failure belongs to the caller');
  assert.equal(slot.isBusy(), false, 'a thrown operation releases the slot');

  const second = slot.tryStart('requirements:r2', async () => {});
  assert.equal(second.accepted, true, 'the next heavy operation may start');
  await second.done;
});

test('a work that throws synchronously releases the slot and rejects the caller', async () => {
  const slot = createWorkSlot();
  const first = slot.tryStart('bug:r1', () => { throw new Error('state file unreadable'); });

  assert.equal(first.accepted, true);
  await assert.rejects(first.done, /state file unreadable/);
  assert.equal(slot.isBusy(), false);
});

// `isBusy()` and `whenIdle()` must be one decision, not two: a shutdown that
// waits on a different flag than the one `tryStart` consults would either hang or
// release the lock while a TAPD write is still in flight.
test('whenIdle settles on the same record that tryStart writes', async () => {
  const slot = createWorkSlot();
  await slot.whenIdle();

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = slot.tryStart('bug:r1', () => gate);
  assert.equal(slot.isBusy(), true);

  let settled = false;
  const waiting = slot.whenIdle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'whenIdle must not resolve while the slot is held');

  release();
  await waiting;
  assert.equal(settled, true);
  assert.equal(slot.isBusy(), false);
  await first.done;
});

test('a refused owner leaves the running operation untouched', async () => {
  const slot = createWorkSlot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = slot.tryStart('bug:r1', () => gate);
  let refusedRan = false;
  const refused = slot.tryStart('requirements:r2', () => { refusedRan = true; });

  assert.deepEqual(refused, { accepted: false }, 'a refusal carries no done to consume');
  release();
  await first.done;
  assert.equal(refusedRan, false, 'refused work is never started behind the caller\'s back');
});

test('work that is not a function is refused and never blocks the slot', () => {
  const slot = createWorkSlot();
  assert.equal(slot.tryStart('bug:r1', undefined).accepted, false);
  assert.equal(slot.isBusy(), false, 'a malformed call must not reserve the slot');
  const next = slot.tryStart('requirements:r2', async () => {});
  assert.equal(next.accepted, true);
  return next.done;
});

// The busy log line is the only place a stuck slot becomes visible to an
// operator, so a broken logger must not change the answer.
test('a logger that throws never changes a slot decision', async () => {
  const log = {
    warn() { throw new Error('log file locked'); },
    info() { throw new Error('log file locked'); },
  };
  const slot = createWorkSlot({ log });
  const first = slot.tryStart('bug:r1', async () => {});
  assert.equal(first.accepted, true);
  assert.equal(slot.tryStart('requirements:r2', async () => {}).accepted, false);
  await first.done;
});
