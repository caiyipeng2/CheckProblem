import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncRepo } from '../src/repo.js';

const URL = 'https://example.com/x.git';

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every test injects this mock; real git must never run in the suite.
function recordRun(reply) {
  const calls = [];
  const options = [];
  const run = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    options.push(opts);
    return typeof reply === 'function' ? reply(cmd, args) : reply;
  };
  return { run, calls, options };
}

test('clones when directory is not a git repo', async (t) => {
  const base = tmpDir(t);
  const dir = join(base, 'clone');
  const { run, calls, options } = recordRun({ code: 0, stdout: 'a1b2c3d\n', stderr: '' });
  const res = await syncRepo({ dir, url: URL, branch: 'master', run });
  assert.equal(res.commit, 'a1b2c3d');
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0].slice(1, 3), ['clone', '--branch']);
  assert.deepEqual(calls[0], ['git', 'clone', '--branch', 'master', URL, dir]);
  // A multi-gigabyte clone needs far more than the runner's default budget.
  assert.ok(options[0].timeoutMs >= 60_000, `clone budget was ${options[0].timeoutMs}`);
  assert.deepEqual(calls.at(-1), ['git', '-C', dir, 'rev-parse', '--short', 'HEAD']);
});

test('fetches and resets when directory already exists', async (t) => {
  const base = tmpDir(t);
  const dir = join(base, 'clone');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const { run, calls, options } = recordRun((cmd, args) =>
    args.includes('rev-parse')
      ? { code: 0, stdout: 'deadbee\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );
  const res = await syncRepo({ dir, url: URL, branch: 'master', run });
  assert.equal(res.commit, 'deadbee');
  assert.ok(calls.some((c) => c.includes('fetch')));
  assert.ok(calls.some((c) => c.includes('reset')));
  assert.ok(calls.some((c) => c.includes('clean')));
  assert.deepEqual(
    calls.map((c) => (c[1] === '-C' ? c[3] : c[1])),
    ['fetch', 'reset', 'clean', 'rev-parse'],
  );
  assert.deepEqual(calls.find((c) => c.includes('clean')), ['git', '-C', dir, 'clean', '-fd']);
  // fetch is the other network call; reset/clean/rev-parse stay on the default.
  const fetchIndex = calls.findIndex((c) => c.includes('fetch'));
  assert.ok(options[fetchIndex].timeoutMs >= 60_000, `fetch budget was ${options[fetchIndex].timeoutMs}`);
});

test('throws with git stderr on failure', async (t) => {
  const base = tmpDir(t);
  const { run } = recordRun({ code: 128, stdout: '', stderr: 'fatal: could not read' });
  await assert.rejects(
    () => syncRepo({ dir: join(base, 'x'), url: 'u', branch: 'master', run }),
    /could not read/,
  );
});

test('returns the trimmed commit from rev-parse --short HEAD', async (t) => {
  const base = tmpDir(t);
  const dir = join(base, 'clone');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const { run, calls } = recordRun((cmd, args) =>
    args.includes('rev-parse')
      ? { code: 0, stdout: '  deadbee  \n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  );
  const res = await syncRepo({ dir, url: URL, branch: 'master', run });
  assert.equal(res.commit, 'deadbee');
  assert.deepEqual(calls.at(-1), ['git', '-C', dir, 'rev-parse', '--short', 'HEAD']);
});

test('a failed fetch rejects with the git stderr and runs nothing after it', async (t) => {
  const base = tmpDir(t);
  const dir = join(base, 'clone');
  mkdirSync(join(dir, '.git'), { recursive: true });
  const { run, calls } = recordRun({
    code: 128,
    stdout: '',
    stderr: 'fatal: unable to access origin',
  });
  await assert.rejects(
    () => syncRepo({ dir, url: URL, branch: 'master', run }),
    (err) => {
      assert.match(err.message, /git fetch failed/);
      assert.match(err.message, /unable to access origin/);
      return true;
    },
  );
  assert.deepEqual(calls, [['git', '-C', dir, 'fetch', '--prune', 'origin']]);
});

test('a non-repo directory surfaces the clone error from git', async (t) => {
  const base = tmpDir(t);
  const dir = join(base, 'partial');
  mkdirSync(dir);
  const { run, calls } = recordRun({
    code: 128,
    stdout: '',
    stderr: `fatal: destination path '${dir}' already exists and is not an empty directory.`,
  });
  await assert.rejects(
    () => syncRepo({ dir, url: URL, branch: 'master', run }),
    (err) => {
      assert.match(err.message, /git clone failed/);
      assert.match(err.message, /destination path/);
      return true;
    },
  );
  assert.deepEqual(calls, [['git', 'clone', '--branch', 'master', URL, dir]]);
});

test('rejects an undefined or empty dir without running git', async () => {
  for (const dir of [undefined, '', '   ']) {
    const { run, calls } = recordRun({ code: 0, stdout: 'deadbee\n', stderr: '' });
    await assert.rejects(
      () => syncRepo({ dir, url: URL, branch: 'master', run }),
      /non-empty dir/,
    );
    assert.deepEqual(calls, []);
  }
});
