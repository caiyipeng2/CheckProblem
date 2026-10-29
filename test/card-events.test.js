import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startCardEvents } from '../src/card-events.js';

const MARKER = '[event] ready event_key=card.action.trigger';
const event = { type: 'card.action.trigger', event: { action: { value: { text: '确认按钮' } } } };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, options = {}) {
  assert.equal(typeof startCardEvents, 'function', 'startCardEvents must be implemented');
  const { platform, ...startOptions } = options;
  if (platform) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
  }
  const child = new EventEmitter();
  Object.assign(child, { pid: 43121, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const signals = [], unrefs = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  child.unref = () => unrefs.push('consumer');
  const killer = new EventEmitter();
  killer.unref = () => unrefs.push('killer');
  const calls = [], seen = [], logs = [];
  const handle = startCardEvents({
    onEvent: (value) => seen.push(value),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    spawnImpl: (...args) => { calls.push(args); return calls.length === 1 ? child : killer; },
    ...startOptions,
  });
  handle.ready.catch(() => {});
  handle.done.catch(() => {});
  t.after(() => { handle.stop(); child.emit('close', 0, null); });
  return { child, killer, handle, seen, calls, logs, signals, unrefs };
}

async function makeReady(f) {
  f.child.stderr.write(`${MARKER}\n`);
  await f.handle.ready;
}

async function finish(f) {
  f.handle.stop();
  f.child.stdout.end();
  f.child.stderr.end();
  await tick();
  f.child.emit('exit', 0, null);
  f.child.emit('close', 0, null);
  await f.handle.done;
}

test('spawns only the fixed bot consumer with open stdin and safe shell arguments', async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.calls, [[
    'lark-cli', ['event', 'consume', 'card.action.trigger', '--as', 'bot'],
    { shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  ]]);
  assert.equal(f.child.stdin.writableEnded, false);
  await makeReady(f);
  await finish(f);
});

test('ready requires the exact stderr marker, including split lines', async (t) => {
  const f = fixture(t);
  let ready = false;
  f.handle.ready.then(() => { ready = true; });
  f.child.stderr.write(`prefix ${MARKER}\n${MARKER} extra\n`);
  await tick();
  assert.equal(ready, false);
  f.child.stderr.write('[event] ready event_key=card.');
  await tick();
  assert.equal(ready, false);
  f.child.stderr.write('action.trigger\r\n');
  await f.handle.ready;
  await finish(f);
});

test('preserves split multibyte UTF-8 and NDJSON records and filters non-card values', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
  // One-byte writes split every multibyte code point and JSON token.
  for (const byte of bytes) f.child.stdout.write(Buffer.from([byte]));
  f.child.stdout.write('null\n[]\n42\n{"type":"other"}\n\n');
  f.child.stdout.write(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
  assert.deepEqual(f.seen, [event, event, event]);
  await finish(f);
});

test('dispatches synchronously without waiting for analysis promises', async (t) => {
  const seen = [];
  const f = fixture(t, { onEvent: (value) => { seen.push(value); return new Promise(() => {}); } });
  await makeReady(f);
  f.child.stdout.write(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
  assert.equal(seen.length, 2);
  await finish(f);
});

test('stop is idempotent, closes stdin and waits for child close', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  let done = false;
  f.handle.done.then(() => { done = true; });
  f.handle.stop(); f.handle.stop();
  assert.equal(f.child.stdin.writableEnded, true);
  f.child.emit('exit', 0, null);
  await tick();
  assert.equal(done, false);
  f.child.emit('close', 0, null);
  await f.handle.done;
});

test('stop before readiness rejects ready but permits graceful completion', async (t) => {
  const f = fixture(t);
  f.handle.stop();
  await assert.rejects(f.handle.ready, /stop.*ready|ready.*stop/i);
  f.child.stderr.write(`${MARKER}\n`);
  f.child.emit('close', 0, null);
  await f.handle.done;
});

for (const code of [0, 3, null]) {
  test(`unexpected close (${code}) rejects ready and done`, async (t) => {
    const f = fixture(t);
    f.child.emit('close', code, code === null ? 'SIGTERM' : null);
    await assert.rejects(f.handle.ready, /clos|exit/i);
    await assert.rejects(f.handle.done, /clos|exit/i);
  });
  test(`unexpected runtime close (${code}) rejects done`, async (t) => {
    const f = fixture(t);
    await makeReady(f);
    f.child.emit('close', code, code === null ? 'SIGTERM' : null);
    await assert.rejects(f.handle.done, /clos|exit/i);
  });
}

test('nonzero close after stop remains a failure', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.handle.stop();
  f.child.emit('close', 2, null);
  await assert.rejects(f.handle.done, /clos|exit/i);
});

test('startup timeout rejects both promises and gracefully ends stdin', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { startupTimeoutMs: 15 });
  t.mock.timers.tick(15);
  await assert.rejects(f.handle.ready, /timed out|timeout/i);
  await assert.rejects(f.handle.done, /timed out|timeout/i);
  assert.equal(f.child.stdin.writableEnded, true);
});

test('readiness clears startup timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { startupTimeoutMs: 15 });
  await makeReady(f);
  t.mock.timers.tick(100);
  assert.equal(f.child.stdin.writableEnded, false);
  await finish(f);
});

function assertReleased(f) {
  for (const name of ['stdin', 'stdout', 'stderr']) {
    assert.equal(f.child[name].destroyed, true, `${name} must not retain a pipe handle`);
  }
  assert.ok(f.unrefs.includes('consumer'), 'consumer must not keep the parent alive');
  assert.ok(f.logs.some((line) => /bounded shutdown fail/i.test(line)));
  assert.equal(f.logs.some((line) => /SECRET/.test(line)), false);
}

function assertOwnedEscalation(f, platform) {
  if (platform === 'win32') {
    assert.equal(f.calls.length, 2, 'never spawn a shared-bus or global process shutdown');
    assert.deepEqual(f.calls[1], [
      'taskkill', ['/PID', '43121', '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    ]);
    assert.deepEqual(f.signals, [], 'killing only the Windows shell would leave descendants');
    assert.ok(f.unrefs.includes('killer'), 'even a hung taskkill must not hold the parent open');
  } else {
    assert.equal(f.calls.length, 1, 'never spawn a shared-bus or global process shutdown');
    assert.deepEqual(f.signals, ['SIGKILL']);
  }
  assertReleased(f);
}

for (const platform of ['win32', 'linux']) {
  test(`${platform}: stop escalates only the owned consumer at the shutdown deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { platform, shutdownTimeoutMs: 20 });
    await makeReady(f);
    let settled = false;
    f.handle.done.then(() => { settled = true; }, () => { settled = true; });
    f.handle.stop();
    assert.equal(f.child.stdin.writableEnded, true);
    t.mock.timers.tick(19);
    await tick();
    assert.equal(settled, false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.signals, []);
    assert.equal(f.child.stdout.destroyed, false);
    f.handle.stop(); // Repeated stop must not extend the deadline.
    t.mock.timers.tick(1);
    assertOwnedEscalation(f, platform);
    await assert.rejects(f.handle.done, /shutdown.*timed out/i);
    f.child.emit('close', 0, null); // A late close cannot turn failure into success.
    await assert.rejects(f.handle.done, /shutdown.*timed out/i);
    t.mock.timers.tick(100);
    assertOwnedEscalation(f, platform);
  });

  test(`${platform}: startup failure keeps a separate deadline despite rejected done`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { platform, startupTimeoutMs: 15, shutdownTimeoutMs: 20 });
    t.mock.timers.tick(15);
    await assert.rejects(f.handle.ready, /startup timed out/i);
    await assert.rejects(f.handle.done, /startup timed out/i);
    assert.equal(f.child.stdin.writableEnded, true);
    t.mock.timers.tick(19);
    f.child.emit('error', new Error('SECRET'));
    f.handle.stop(); // Mirrors the bin's done.catch(stop) / finally path.
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.signals, []);
    t.mock.timers.tick(1);
    assertOwnedEscalation(f, platform);
    await assert.rejects(f.handle.done, /startup timed out/i);
  });

  for (const ready of [false, true]) {
    test(`${platform}: graceful ${ready ? 'stop' : 'startup cancellation'} cancels escalation`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(t, { platform, startupTimeoutMs: 15, shutdownTimeoutMs: 20 });
      if (ready) await makeReady(f);
      f.handle.stop();
      if (!ready) await assert.rejects(f.handle.ready, /stopped before ready/i);
      t.mock.timers.tick(19);
      f.child.emit('close', 0, null);
      await f.handle.done;
      t.mock.timers.tick(100);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.signals, []);
      assert.deepEqual(f.unrefs, []);
      assert.equal(f.logs.some((line) => /shutdown/i.test(line)), false);
    });
  }
}

test('default shutdown deadline remains bounded after runtime failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { platform: 'linux' });
  await makeReady(f);
  f.child.stdout.write('{SECRET\n');
  await assert.rejects(f.handle.done, /JSON/i);
  t.mock.timers.tick(4999);
  assert.deepEqual(f.signals, []);
  t.mock.timers.tick(1);
  assertOwnedEscalation(f, 'linux');
});

test('failure followed by actual close cancels the shutdown deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { startupTimeoutMs: 15, shutdownTimeoutMs: 20 });
  t.mock.timers.tick(15);
  await assert.rejects(f.handle.done, /startup/i);
  f.child.emit('close', 1, null);
  t.mock.timers.tick(100);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.unrefs, []);
});

test('exit without pipe closure releases handles without targeting an expired PID', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { platform: 'win32', shutdownTimeoutMs: 20 });
  await makeReady(f);
  f.handle.stop();
  f.child.emit('exit', 0, null);
  t.mock.timers.tick(20);
  assertReleased(f);
  assert.equal(f.calls.length, 1, 'an exited PID could already belong to another process');
  await assert.rejects(f.handle.done, /shutdown/i);
});

for (const pid of [undefined, 0, -1, '43121 & SECRET']) {
  test(`Windows refuses unsafe or missing consumer PID (${String(pid)})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { platform: 'win32', shutdownTimeoutMs: 20 });
    f.child.pid = pid;
    await makeReady(f);
    f.handle.stop();
    t.mock.timers.tick(20);
    assertReleased(f);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.signals, []);
    await assert.rejects(f.handle.done, /shutdown/i);
  });
}

for (const failure of ['error', 'nonzero close']) {
  test(`Windows taskkill ${failure} is handled without leaking tokens or handles`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { platform: 'win32', shutdownTimeoutMs: 20 });
    await makeReady(f);
    f.handle.stop();
    t.mock.timers.tick(20);
    assertOwnedEscalation(f, 'win32');
    const before = f.logs.length;
    if (failure === 'error') {
      f.killer.emit('error', new Error('SECRET'));
      f.killer.emit('error', new Error('SECRET again'));
    } else {
      f.killer.emit('close', 1, null);
    }
    assert.ok(f.logs.slice(before).some((line) => /shutdown fail/i.test(line)));
    assertReleased(f);
    await assert.rejects(f.handle.done, /shutdown/i);
  });
}

for (const failure of ['throw', 'false']) {
  test(`Unix SIGKILL ${failure} still releases owned handles`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, { platform: 'linux', shutdownTimeoutMs: 20 });
    f.child.kill = (signal) => {
      f.signals.push(signal);
      if (failure === 'throw') throw new Error('SECRET');
      return false;
    };
    await makeReady(f);
    f.handle.stop();
    t.mock.timers.tick(20);
    assertOwnedEscalation(f, 'linux');
    assert.ok(f.logs.some((line) => /could not terminate/i.test(line)));
    await assert.rejects(f.handle.done, /shutdown/i);
  });
}

for (const source of ['child', 'stdin', 'stdout', 'stderr']) {
  for (const ready of [false, true]) {
    test(`${source} errors ${ready ? 'after' : 'before'} readiness reject lifecycle promises safely`, async (t) => {
      const f = fixture(t);
      if (ready) await makeReady(f);
      const emitter = source === 'child' ? f.child : f.child[source];
      emitter.emit('error', new Error('SECRET payload token'));
      if (!ready) await assert.rejects(f.handle.ready);
      await assert.rejects(f.handle.done, (err) => !err.message.includes('SECRET'));
      assert.equal(f.child.stdin.writableEnded, true);
    });
  }
}

test('synchronous spawn errors reject both promises', async (t) => {
  const f = fixture(t, { spawnImpl: () => { throw new Error('SECRET'); } });
  await assert.rejects(f.handle.ready);
  await assert.rejects(f.handle.done, (err) => !err.message.includes('SECRET'));
});

test('malformed JSON fails without exposing callback payload', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.child.stdout.write('{SECRET token\n');
  await assert.rejects(f.handle.done, (err) => /JSON/i.test(err.message) && !err.message.includes('SECRET'));
  f.child.stdout.write(`${JSON.stringify(event)}\n`);
  assert.equal(f.seen.length, 0);
});

test('synchronous enqueue failure rejects done without exposing payload', async (t) => {
  const f = fixture(t, { onEvent: () => { throw new Error('SECRET'); } });
  await makeReady(f);
  f.child.stdout.write(`${JSON.stringify(event)}\n`);
  await assert.rejects(f.handle.done, (err) => /onEvent|enqueue/i.test(err.message) && !err.message.includes('SECRET'));
});

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} rejects lines over 256 KiB even without newline`, async (t) => {
    const f = fixture(t);
    await makeReady(f);
    f.child[stream].write('中'.repeat(87381)); // 262143 bytes.
    f.child[stream].write('xx');
    await assert.rejects(f.handle.done, /256|line.*limit|too large/i);
  });
  test(`${stream} unexpected EOF is not silently ignored`, async (t) => {
    const f = fixture(t);
    await makeReady(f);
    f.child[stream].end();
    await assert.rejects(f.handle.done, /EOF|end|clos/i);
  });
  test(`${stream} premature stream close is not silently ignored`, async (t) => {
    const f = fixture(t);
    await makeReady(f);
    f.child[stream].destroy();
    await assert.rejects(f.handle.done, /clos/i);
  });
}

test('accepts exactly 256 KiB lines and does not bound the total stream size', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  const prefix = '{"type":"card.action.trigger","text":"';
  const line = prefix + 'x'.repeat(262144 - Buffer.byteLength(prefix) - 2) + '"}';
  f.child.stdout.write(`${line}\n${line}\n`);
  assert.equal(f.seen.length, 2);
  await finish(f);
});

test('flushes a final JSON record without newline during graceful shutdown', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.child.stdout.write(JSON.stringify(event));
  await finish(f);
  assert.deepEqual(f.seen, [event]);
});

test('malformed trailing JSON is still a failure after stop', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.handle.stop();
  f.child.stdout.end('{SECRET');
  await assert.rejects(f.handle.done, /JSON/i);
});

test('runtime WARN/drop diagnostics stay observable without logging payloads or tokens', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.child.stderr.write('WARN jq failed; dropping event token=SECRET payload={"secret":"VALUE"}\n');
  f.child.stderr.write('unrecognized diagnostic SECRET\n');
  assert.ok(f.logs.some((line) => /warn/i.test(line) && /drop/i.test(line)));
  assert.ok(f.logs.length >= 3);
  assert.equal(f.logs.some((line) => /SECRET|VALUE|payload=/.test(line)), false);
  await finish(f);
});

test('structured CLI error envelopes fail without exposing their messages', async (t) => {
  const f = fixture(t);
  await makeReady(f);
  f.child.stderr.write('{"ok":false,"error":{"type":"auth","message":"SECRET"}}\n');
  await assert.rejects(f.handle.done, (err) => /CLI|diagnostic/i.test(err.message) && !err.message.includes('SECRET'));
});
