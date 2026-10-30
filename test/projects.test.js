import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as projects from '../src/projects.js';
const { normalizeProjects, validateBranch, selectProject, listRemoteBranches, syncSelectedProject, matchProject } = projects;
const raw = { id: 'weapon', name: 'Weapon', url: 'https://example.com/team/weapon.git' };
const sha = 'a'.repeat(40);
const ref = (branch) => `${sha}\trefs/heads/${branch}\n`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function fixture(t, branch = 'master') {
  const root = mkdtempSync(join(tmpdir(), 'projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const normalized = normalizeProjects([{ ...raw, branch }], root);
  return { root, repo: normalized[0], config: { root, projects: normalized, defaultProjectId: 'weapon' } };
}

function fakeGit(repo, { heads = ref(repo.branch), origin = repo.url, fail } = {}) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    assert.equal(cmd, 'git');
    if (fail && args.includes(fail)) return { code: 1, stdout: '', stderr: 'offline or rejected' };
    if (args[0] === 'ls-remote') return ok(heads);
    if (args[0] === 'clone') mkdirSync(join(repo.dir, '.git'), { recursive: true });
    if (args.includes('get-url')) return ok(`${origin}\n`);
    if (args.includes('--show-toplevel')) return ok(`${repo.dir}\n`);
    if (args.includes('--absolute-git-dir')) return ok(`${join(repo.dir, '.git')}\n`);
    if (args.includes('--short')) return ok('aaaaaaa\n');
    return ok();
  };
  return { run, calls };
}

test('projects exports the required interfaces', () => {
  for (const name of ['normalizeProjects', 'validateBranch', 'selectProject', 'listRemoteBranches', 'syncSelectedProject']) {
    assert.equal(typeof projects[name], 'function', `${name} is missing`);
  }
});

test('normalizeProjects preserves absence and derives only dedicated clone directories', (t) => {
  assert.equal(normalizeProjects(undefined, tmpdir()), undefined);
  const { root, repo } = fixture(t);
  assert.deepEqual(repo, { ...raw, branch: 'master', mode: 'clone', dir: join(root, 'repo', 'cards', 'weapon') });
  const other = fixture(t);
  assert.notEqual(repo.dir, other.repo.dir);
});

test('normalizeProjects rejects invalid arrays, IDs, names, URLs, branches and caller paths', () => {
  for (const value of [null, [], {}, 'weapon', [null]]) {
    assert.throws(() => normalizeProjects(value, tmpdir()), /project/i);
  }
  for (const id of ['', 'Weapon', '../weapon', 'a/b', '-weapon', 'a'.repeat(41), 'con', 'nul']) {
    assert.throws(() => normalizeProjects([{ ...raw, id }], tmpdir()), /id/i);
  }
  for (const name of ['', '  ', 12, 'n'.repeat(81)]) {
    assert.throws(() => normalizeProjects([{ ...raw, name }], tmpdir()), /name/i);
  }
  for (const url of ['http://example.com/a', 'file:///a', 'https://user:pass@example.com/a',
    'https://example.com/a?q=b', 'https://example.com/a#x', 'https://example.com/a?',
    'https://example.com/a#', 'https://example.com/a&whoami', 'https://example.com/%PATH%',
    'https://example.com/a;whoami', 'https://example.com/$(id)', 'https://example.com/a\nb',
    'https://example.com/a"b', 'https://example.com/a b', 'https://example.com/a\\b']) {
    assert.throws(() => normalizeProjects([{ ...raw, url }], tmpdir()), /url/i, url);
  }
  for (const extra of [{ dir: undefined }, { mode: 'clone' }, { branch: '-x' }, { branch: null }]) {
    assert.throws(() => normalizeProjects([{ ...raw, ...extra }], tmpdir()), /project|branch/i);
  }
  assert.throws(() => normalizeProjects([raw, raw], tmpdir()), /duplicate/i);
  assert.throws(() => normalizeProjects([raw, { ...raw, id: 'WEAPON' }], tmpdir()), /id|duplicate/i);
});

test('validateBranch accepts deployed Unicode and compound branch names but rejects invalid refs', () => {
  for (const branch of ['master', 'feature/ui-v2', 'release/1.2.3', 'fix_under-score', '123',
    'feature/ActivePass+CumulativePay', 'feature/DailyTask&ActRankThrehold', 'feature/月卡优化调整', '素材']) {
    assert.doesNotThrow(() => validateBranch(branch));
  }
  for (const branch of [undefined, null, 1, '', '-x', 'a..b', 'a@{b', '.x', 'a/.x', 'a.lock',
    'a.lock/x', 'a/', '/a', 'a//b', 'a.', 'a b', 'a\nb', 'a\rb', 'a\tb', 'a~b', 'a^b',
    'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a;b', 'a|b', 'a`b', 'a$b',
    'a%b', 'a!b', 'a"b', "a'b", 'a(b)', 'a<b']) {
    assert.throws(() => validateBranch(branch), /branch/i, String(branch));
  }
});

test('selectProject resolves trusted project and validates branch without changing config', (t) => {
  const { config, repo } = fixture(t);
  const selected = selectProject(config, 'weapon', 'feature/ui');
  assert.deepEqual(selected, { ...repo, branch: 'feature/ui' });
  assert.equal(repo.branch, 'master');
  assert.deepEqual(selectProject(config, 'weapon'), repo);
  assert.throws(() => selectProject(config, 'unknown', 'master'), /project/i);
  assert.throws(() => selectProject(config, { id: 'weapon', url: 'https://evil.test/a', dir: '/dev' }, 'master'), /project/i);
  assert.throws(() => selectProject(config, 'weapon', 'bad;command'), /branch/i);
});

test('listRemoteBranches uses only ls-remote, has a budget and sorts distinct validated branches', async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return ok(ref('z') + ref('feature/ui') + ref('master') + ref('z')); };
  assert.deepEqual(await listRemoteBranches({ url: raw.url, run }), ['feature/ui', 'master', 'z']);
  assert.deepEqual(calls, [['git', ['ls-remote', '--heads', '--', raw.url], { timeoutMs: 30000 }]]);
  calls.length = 0;
  await listRemoteBranches({ url: raw.url, run, timeoutMs: 1234 });
  assert.equal(calls[0][2].timeoutMs, 1234);
});

test('listRemoteBranches fails closed on empty, malformed, unsafe, truncated or failed listings', async () => {
  for (const result of [ok(''), ok('\n'), ok(ref('unsafe;command')), ok('garbage'),
    ok(`${sha}\trefs/tags/v1\n`), { ...ok(ref('master')), truncated: true },
    { code: 1, stdout: ref('master'), stderr: 'offline' }]) {
    await assert.rejects(listRemoteBranches({ url: raw.url, run: async () => result }));
  }
  await assert.rejects(listRemoteBranches({ url: 'https://example.com/a&b', run: () => assert.fail('unsafe URL reached runner') }));
  await assert.rejects(listRemoteBranches({ url: raw.url, run: async () => { throw new Error('timeout'); } }), /timeout/);
});

test('syncSelectedProject clones only derived service path and fetches the selected ref explicitly', async (t) => {
  const { config } = fixture(t);
  const repo = selectProject(config, 'weapon', 'release/2.0');
  const { run, calls } = fakeGit(repo);
  assert.deepEqual(await syncSelectedProject({ repo, run }), {
    branch: 'release/2.0', commit: 'aaaaaaa', dirty: 0, provenance: 'release/2.0@aaaaaaa',
  });
  assert.equal(calls[0].args[0], 'ls-remote');
  const clone = calls.find(({ args }) => args[0] === 'clone');
  assert.ok(clone.args.includes(repo.dir));
  assert.ok(clone.args.includes(repo.url));
  const fetch = calls.find(({ args }) => args.includes('fetch'));
  assert.ok(fetch.args.includes('+refs/heads/release/2.0:refs/remotes/origin/release/2.0'));
  const reset = calls.find(({ args }) => args.includes('reset'));
  assert.ok(reset.args.includes('refs/remotes/origin/release/2.0'));
  assert.ok(calls.findIndex(({ args }) => args.includes('get-url')) < calls.indexOf(reset));
});

test('existing service clones verify origin and repository boundaries before mutation', async (t) => {
  const { repo } = fixture(t);
  mkdirSync(join(repo.dir, '.git'), { recursive: true });
  const { run, calls } = fakeGit(repo);
  await syncSelectedProject({ repo, run });
  assert.equal(calls.some(({ args }) => args[0] === 'clone'), false);
  for (const flag of ['get-url', '--show-toplevel', '--absolute-git-dir']) {
    assert.ok(calls.findIndex(({ args }) => args.includes(flag)) < calls.findIndex(({ args }) => args.includes('fetch')));
  }
});

test('sync rejects unknown paths, mutated normalized objects, non-repositories and linked git dirs', async (t) => {
  const { repo } = fixture(t);
  await assert.rejects(syncSelectedProject({ repo: { ...repo, dir: dirname(repo.dir) }, run: () => assert.fail('untrusted path reached runner') }), /service|project|dir/i);
  const originalDir = repo.dir;
  repo.dir = dirname(originalDir);
  await assert.rejects(syncSelectedProject({ repo, run: () => assert.fail('mutated path reached runner') }), /service|project|dir/i);
  repo.dir = originalDir;
  mkdirSync(repo.dir, { recursive: true });
  writeFileSync(join(repo.dir, 'work.txt'), 'development work');
  await assert.rejects(syncSelectedProject({ repo, run: fakeGit(repo).run }), /non.empty|repository/i);
  writeFileSync(join(repo.dir, '.git'), 'gitdir: elsewhere');
  await assert.rejects(syncSelectedProject({ repo, run: fakeGit(repo).run }), /git|repository/i);
});

test('sync rejects junctions at project and parent directories without any git commands', async (t) => {
  for (const target of ['project', 'parent', 'git']) {
    const { root, repo } = fixture(t);
    const outside = join(root, 'development');
    mkdirSync(outside);
    const link = target === 'project' ? repo.dir : target === 'parent' ? dirname(repo.dir) : join(repo.dir, '.git');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(syncSelectedProject({ repo, run: () => assert.fail('linked directory reached runner') }), /link|reparse|service/i);
  }
});

test('sync fails instead of falling back to local refs on remote disappearance or command failures', async (t) => {
  for (const scenario of [{ heads: ref('different') }, { fail: 'ls-remote' }, { fail: 'clone' },
    { fail: 'fetch' }, { fail: 'reset' }, { fail: 'clean' }, { fail: 'rev-parse' }]) {
    const { repo } = fixture(t);
    const { run, calls } = fakeGit(repo, scenario);
    await assert.rejects(syncSelectedProject({ repo, run }));
    if (scenario.heads || ['ls-remote', 'clone', 'fetch'].includes(scenario.fail)) {
      assert.equal(calls.some(({ args }) => args.includes('reset')), false);
    }
  }
});

test('sync rejects origin mismatch, failed verification and repositories rooted elsewhere before fetch/reset', async (t) => {
  for (const scenario of ['origin', '--show-toplevel', '--absolute-git-dir', 'get-url']) {
    const { repo } = fixture(t);
    mkdirSync(join(repo.dir, '.git'), { recursive: true });
    const fake = fakeGit(repo, scenario === 'origin' ? { origin: 'https://evil.test/repo' } : {});
    const run = async (...args) => {
      const result = await fake.run(...args);
      if (scenario !== 'origin' && args[1].includes(scenario)) return ok('/somewhere/else');
      return result;
    };
    await assert.rejects(syncSelectedProject({ repo, run }), /origin|repository|service|git/i);
    assert.equal(fake.calls.some(({ args }) => args.includes('fetch') || args.includes('reset')), false);
  }
});

test('sync accepts canonical Git paths for the same service directory (including Windows short paths)', async (t) => {
  const { repo } = fixture(t);
  mkdirSync(join(repo.dir, '.git'), { recursive: true });
  const fake = fakeGit(repo);
  const run = async (...args) => {
    const result = await fake.run(...args);
    if (args[1].includes('--show-toplevel')) return ok(realpathSync(repo.dir));
    if (args[1].includes('--absolute-git-dir')) return ok(realpathSync(join(repo.dir, '.git')));
    return result;
  };
  assert.equal((await syncSelectedProject({ repo, run })).dirty, 0);
});

test('sync must not reset a parent repository when its own .git disappears during verification', async (t) => {
  const { repo } = fixture(t);
  mkdirSync(join(repo.dir, '.git'), { recursive: true });
  const fake = fakeGit(repo);
  let origins = 0;
  const run = async (...args) => {
    const result = await fake.run(...args);
    if (args[1].includes('get-url') && ++origins === 2) rmSync(join(repo.dir, '.git'), { recursive: true });
    return result;
  };
  await assert.rejects(syncSelectedProject({ repo, run }), /repository|service/i);
  assert.equal(fake.calls.some(({ args }) => args.includes('reset')), false);
});

const named = [
  { id: 'weapon', name: '武器店（Idle_Outpost）' },
  { id: 'gear', name: '齿轮 (Idle_Gear_Defence)' },
  { id: 'digit', name: '数字门' },
];

test('a question that names a project selects it by its short name', () => {
  assert.equal(matchProject(named, '蔡龙 玩家反馈：齿轮升到 5 级后攻击力没刷新'), 'gear');
  assert.equal(matchProject(named, '武器店点自动上阵没反应'), 'weapon');
});

test('the repository half of a project name matches too, whatever the case', () => {
  assert.equal(matchProject(named, 'idle_gear_defence 里金币结算不对'), 'gear');
  assert.equal(matchProject(named, 'IDLE_OUTPOST 每日奖励未到账'), 'weapon');
});

test('a question naming no project matches none so the configured default still applies', () => {
  assert.equal(matchProject(named, '玩家反馈：登录以后奖励没到账，uid: 16115645'), undefined);
  assert.equal(matchProject([], '齿轮'), undefined);
});

test('when several projects are named the one mentioned first wins', () => {
  assert.equal(matchProject(named, '齿轮和武器店都领不到每日奖励'), 'gear');
  assert.equal(matchProject(named, '数字门先查，再看齿轮'), 'digit');
});
