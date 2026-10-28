import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { run } from '../src/runner.js';

// Every child here is the Node binary itself: the runner's shell, quoting,
// stdin and timeout paths are exercised without lark-cli, codex or the network.
const NODE = process.execPath;

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// `tasklist /FO CSV /NH` prints one quoted row per match, and a single quoted
// INFO line when nothing matches; only an exact pid column counts.
async function pidExists(pid) {
  const { stdout } = await execFileAsync(
    'tasklist',
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { windowsHide: true },
  );
  return stdout
    .trim()
    .split(/\r?\n/)
    .some((line) => line.split('","').map((col) => col.replace(/^"|"$/g, ''))[1] === String(pid));
}

async function waitForPid(file, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`grandchild pid file never appeared: ${file}`);
    await delay(50);
  }
}

test('captures stdout and a zero exit code', async () => {
  const res = await run(NODE, ['-e', "process.stdout.write('done')"]);
  assert.deepEqual(res, { code: 0, stdout: 'done', stderr: '' });
});

test('delivers stdin to the child and returns its stdout', async () => {
  const echo = [
    "let d='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { d += c; });",
    "process.stdin.on('end', () => process.stdout.write(d));",
  ].join('');
  const res = await run(NODE, ['-e', echo], { stdin: '你好, stdin' });

  assert.equal(res.code, 0);
  assert.equal(res.stdout, '你好, stdin');
  assert.equal(res.stderr, '');
});

test('returns a non-zero exit code and stderr instead of throwing', async () => {
  const res = await run(NODE, ['-e', "process.stderr.write('boom');process.exit(3)"]);

  assert.equal(res.code, 3);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, 'boom');
});

test('a command that outlives timeoutMs resolves as 124 with the timeout notice', async () => {
  const started = Date.now();
  const res = await run(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.equal(res.code, 124);
  assert.match(res.stderr, /分析超时（0\.3 秒）/);
  // Resolving must not wait for the killed child to be reaped.
  assert.ok(elapsed < 2000, `resolved after ${elapsed}ms`);
});

test('a nonexistent command resolves as 127 rather than throwing', async () => {
  const res = await run('checkproblem-no-such-command-xyz', []);

  assert.equal(res.code, 127);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /checkproblem-no-such-command-xyz/);
});

test('a minified JSON argument keeps its quotes through the shell', async () => {
  // lark-cli receives --params as JSON.stringify output in argv; the shell
  // would strip its quotes without the runner's escaping.
  const json = JSON.stringify({ container_id_type: 'chat', page_size: 5 });
  const res = await run(NODE, ['-e', 'process.stdout.write(process.argv[1])', json]);

  assert.equal(res.code, 0);
  assert.equal(res.stdout, json);
});

test('an argument with a quote that is not our JSON is refused', () => {
  assert.throws(() => run(NODE, ['-e', 'process.exit(0)', 'a"b']), /quote character/);
});

test('the real lark-cli params JSON round-trips to the child intact', async () => {
  const json = JSON.stringify({
    chat_id: 'oc_dd37d502d8e49d7e2f5f993a4841b819',
    page_size: 50,
    sort_type: 'ByCreateTimeDesc',
  });
  const res = await run(NODE, ['-e', 'process.stdout.write(process.argv[1])', json]);

  assert.equal(res.code, 0);
  assert.equal(res.stdout, json);
});

test('minified JSON with a hostile string is refused like any other quoted argument', () => {
  // cmd.exe does not honour `\"`, so this would end the quoted run early and
  // hand `&ver` back to cmd, which runs `ver` as a second command.
  const hostile = JSON.stringify({ k: 'v""&ver' });
  assert.equal(hostile, '{"k":"v\\"\\"&ver"}');
  assert.throws(() => run(NODE, ['-e', 'process.exit(0)', hostile]), /quote character/);
  // Metacharacters need no quote of their own to break out of the JSON string.
  assert.throws(() => run(NODE, ['-e', 'process.exit(0)', '{"k":"a&b"}']), /quote character/);
  // Object keys travel on the same command line, so they get the same check.
  assert.throws(() => run(NODE, ['-e', 'process.exit(0)', '{"a&b":1}']), /quote character/);
});

test(
  'a timeout kills the whole process tree, including the grandchild',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = tmpDir(t);
    const pidFile = join(dir, 'grandchild.pid');
    writeFileSync(
      join(dir, 'grandchild.js'),
      [
        "const { writeFileSync } = require('node:fs');",
        'writeFileSync(process.argv[2], String(process.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'parent.js'),
      [
        "const { spawn } = require('node:child_process');",
        "const { join } = require('node:path');",
        "spawn(process.execPath, [join(__dirname, 'grandchild.js'), join(__dirname, 'grandchild.pid')], {",
        "  stdio: 'ignore',",
        '});',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const running = run(NODE, [join(dir, 'parent.js')], { timeoutMs: 1500 });
    const pid = await waitForPid(pidFile, 1200);
    const res = await running;

    assert.equal(res.code, 124);

    // taskkill is started without awaiting it, so poll briefly for the tree to die.
    const deadline = Date.now() + 1000;
    let alive = true;
    while (Date.now() < deadline) {
      alive = await pidExists(pid);
      if (!alive) break;
      await delay(100);
    }
    if (alive) {
      // Never leak a stray node process even when the assertion below fails.
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
    assert.equal(alive, false, `grandchild ${pid} survived the tree kill`);
  },
);

test(
  'a .cmd shim runs through the shell and returns its stdout',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = tmpDir(t);
    const shim = join(dir, 'probe.cmd');
    // The exact shape that made `shell: true` mandatory: npm installs lark-cli
    // and codex as .cmd shims, which cannot be spawned directly on Windows.
    writeFileSync(shim, '@echo off\r\necho shim-ok\r\n');

    const res = await run(shim, [], { timeoutMs: 30_000 });

    assert.equal(res.code, 0);
    assert.match(res.stdout, /shim-ok/);
  },
);

test('a child that exits before reading stdin does not crash the runner', async () => {
  const res = await run(NODE, ['-e', 'process.exit(0)'], { stdin: 'x'.repeat(1024 * 1024) });

  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
});
