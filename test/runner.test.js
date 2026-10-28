import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/runner.js';

// Every child here is the Node binary itself: the runner's shell, quoting,
// stdin and timeout paths are exercised without lark-cli, codex or the network.
const NODE = process.execPath;

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

test('a child that exits before reading stdin does not crash the runner', async () => {
  const res = await run(NODE, ['-e', 'process.exit(0)'], { stdin: 'x'.repeat(1024 * 1024) });

  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
});
