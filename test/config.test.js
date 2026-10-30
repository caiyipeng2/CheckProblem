import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('loadConfig merges defaults and resolves relative repo dir', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ chatId: 'oc_x', selfOpenId: 'ou_x', repo: { dir: 'repo/x' } }));
  const cfg = loadConfig(file);
  assert.equal(cfg.chatId, 'oc_x');
  assert.equal(cfg.triggerKeyword, '蔡龙');
  assert.equal(cfg.confirmTimeoutSec, 600);
  assert.equal(cfg.pollIntervalSec, 15);
  assert.equal(cfg.repo.branch, 'master');
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.repo.dir, join(dir, 'repo', 'x'));
  assert.equal(cfg.paths.stateFile, join(dir, 'state', 'state.json'));
  assert.equal(cfg.paths.logDir, join(dir, 'logs'));
});

test('loadConfig rejects config without chatId', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ selfOpenId: 'ou_x' }));
  assert.throws(() => loadConfig(file), /chatId/);
});

test('loadConfig defaults to a fast engine with a slower fallback', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ chatId: 'oc_x', selfOpenId: 'ou_x' }));

  const { attempts } = loadConfig(file).analyze;
  assert.equal(Array.isArray(attempts), true);
  assert.ok(attempts.length >= 2);
  assert.ok(attempts[0].timeoutSec < attempts[1].timeoutSec, 'the first engine must give up sooner');
  assert.equal(attempts[0].command, 'codex');
});

test('loadConfig keeps a configured attempt list verbatim', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const attempts = [{ label: 'deepseek', command: 'codex', model: 'deepseek-chat', timeoutSec: 300 }];
  writeFileSync(file, JSON.stringify({ chatId: 'oc_x', selfOpenId: 'ou_x', analyze: { attempts } }));

  assert.deepEqual(loadConfig(file).analyze.attempts, attempts);
});

function projectConfig(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cfg-projects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ chatId: 'oc_x', selfOpenId: 'ou_x', ...extra }));
  return { file, root };
}

const configuredProjects = ['weapon', 'digit', 'gear'].map((id) => ({
  id, name: id, url: `https://example.com/team/${id}.git`,
}));

test('legacy config does not gain projects or a default project', (t) => {
  const { file } = projectConfig(t);
  const config = loadConfig(file);
  assert.equal(Object.hasOwn(config, 'projects'), false);
  assert.equal(Object.hasOwn(config, 'defaultProjectId'), false);
});

test('loadConfig normalizes projects into isolated service clones and defaults to first', (t) => {
  const { file, root } = projectConfig(t, { projects: configuredProjects });
  const config = loadConfig(file);
  assert.deepEqual(config.projects, configuredProjects.map((project) => ({
    ...project, mode: 'clone', branch: 'master', dir: join(root, 'repo', 'cards', project.id),
  })));
  assert.equal(config.defaultProjectId, 'weapon');
});

test('loadConfig accepts a known default project', (t) => {
  const { file } = projectConfig(t, { projects: configuredProjects, defaultProjectId: 'gear' });
  assert.equal(loadConfig(file).defaultProjectId, 'gear');
});

test('loadConfig rejects unknown or malformed default project IDs', (t) => {
  for (const defaultProjectId of ['absent', '', null, 12, 'WEAPON']) {
    const { file } = projectConfig(t, { projects: configuredProjects, defaultProjectId });
    assert.throws(() => loadConfig(file), /defaultProjectId/);
  }
});

test('loadConfig rejects invalid project configuration rather than exposing raw input', (t) => {
  for (const projects of [[], null, {}, [{ ...configuredProjects[0], dir: 'E:/development' }]]) {
    const { file } = projectConfig(t, { projects });
    assert.throws(() => loadConfig(file), /project/i);
  }
});

test('the screenshot cache stays inside the lark-cli write allowlist', async () => {
  const { defaultImagesDir } = await import('../src/config.js');
  assert.equal(
    defaultImagesDir({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' }, 'C:/Users/x'),
    join('C:/Users/x/AppData/Local/Temp/checkproblem-images'),
  );
  assert.equal(defaultImagesDir({}, 'C:/Users/x'), join('C:/Users/x/files/checkproblem-images'));
});

test('loadConfig always provides a screenshot directory', (t) => {
  const { file } = projectConfig(t);
  assert.match(loadConfig(file).paths.imagesDir, /checkproblem-images$/);
});

const tapdBase = () => ({
  chatId: 'oc_x', selfOpenId: 'ou_x',
  projects: [{ id: 'weapon', name: '武器店', url: 'https://example.com/w.git' }],
  tapd: {
    tokenFile: 'C:/secrets/tapd.token',
    fields: { versionReport: '每周迭代版本', currentOwner: '小鱼;', priority: 'medium' },
    workspaces: {
      weapon: { workspaceId: '59180547' },
      gear: { workspaceId: '12345678', fields: { currentOwner: '阿鱼;' } },
    },
  },
});

function writeTapd(t, value) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-tapd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

// tapdBase's workspaces cover both projects, so every case that reaches the
// workspace loop needs the gear project to exist.
const tapdBothProjects = () => {
  const value = tapdBase();
  value.projects.push({ id: 'gear', name: '齿轮', url: 'https://example.com/g.git' });
  return value;
};

test('tapd config resolves per-project entries with merged fields', (t) => {
  const cfg = loadConfig(writeTapd(t, { ...tapdBase(), projects: [...tapdBase().projects,
    { id: 'gear', name: '齿轮', url: 'https://example.com/g.git' }] }));
  assert.equal(cfg.tapd.baseUrl, 'https://api.tapd.cn');
  assert.equal(cfg.tapd.workspaces.weapon.workspaceId, '59180547');
  assert.equal(cfg.tapd.workspaces.weapon.tokenFile, 'C:/secrets/tapd.token');
  assert.deepEqual(cfg.tapd.workspaces.weapon.fields, {
    version_report: '每周迭代版本', current_owner: '小鱼;', priority: 'medium',
  });
  assert.equal(cfg.tapd.workspaces.gear.fields.current_owner, '阿鱼;', 'per-project field wins');
  assert.equal(cfg.tapd.workspaces.gear.version_report, undefined);
});

test('a per-project token file overrides the default', (t) => {
  const value = tapdBothProjects();
  value.tapd.workspaces.weapon.tokenFile = 'C:/secrets/gear.token';
  assert.equal(loadConfig(writeTapd(t, value)).tapd.workspaces.weapon.tokenFile, 'C:/secrets/gear.token');
});

// A non-string override used to be String()'d, so null loaded as the literal path
// "null" and startup passed; the failure only surfaced at ticket time. The top-level
// tokenFile is type-checked, so the override must be too.
test('a per-project token file must be a non-empty string', (t) => {
  for (const bad of [null, 123, { path: 'C:/secrets/gear.token' }, '']) {
    const value = tapdBothProjects();
    value.tapd.workspaces.weapon.tokenFile = bad;
    let message = '';
    try {
      loadConfig(writeTapd(t, value));
    } catch (err) {
      message = err.message;
    }
    assert.match(message, /^config: tapd\.workspaces\.weapon\.tokenFile /, String(bad));
    assert.equal(message.includes('C:/secrets'), false, 'a token path is never echoed');
  }
});

test('no tapd section means the feature is off', (t) => {
  const value = tapdBase();
  delete value.tapd;
  assert.equal(loadConfig(writeTapd(t, value)).tapd, undefined);
});

for (const [label, mutate, pattern] of [
  ['tokenFile missing', (v) => { delete v.tapd.tokenFile; }, /tokenFile/],
  ['http base url', (v) => { v.tapd.baseUrl = 'http://api.tapd.cn'; }, /https/],
  ['workspace id not digits', (v) => { v.tapd.workspaces.weapon.workspaceId = 'abc'; }, /workspaceId/],
  ['unknown project', (v) => { v.tapd.workspaces.nope = { workspaceId: '12345678' }; }, /no matching project/],
  ['unknown field name', (v) => { v.tapd.fields.reporter = 'x'; }, /reporter/],
  ['over long field value', (v) => { v.tapd.fields.te = '机'.repeat(101); }, /too long/],
  ['tapd without projects', (v) => { delete v.projects; }, /requires projects/],
]) {
  test(`tapd config rejects ${label}`, (t) => {
    const value = tapdBothProjects();
    mutate(value);
    assert.throws(() => loadConfig(writeTapd(t, value)), pattern);
  });
}

// src/tapd.js buildBugPayload spreads this fields map LAST, so a key named
// title/description/workspace_id would overwrite the analysis the service just built
// (an empty ticket) or retarget it at another team's tracker. Nothing next to that
// spread would remind a future reader, so the config layer proves it rejects them.
for (const key of ['title', 'description', 'workspace_id']) {
  test(`tapd config cannot inject the payload key ${key}`, (t) => {
    for (const [where, fields] of [
      ['tapd.fields', (v) => v.tapd.fields],
      ['per-project fields', (v) => (v.tapd.workspaces.weapon.fields ??= {})],
    ]) {
      const value = tapdBothProjects();
      fields(value)[key] = 'injected by config';
      assert.throws(() => loadConfig(writeTapd(t, value)), new RegExp(`unknown field ${key}$`), where);
    }
  });
}

// JSON configs reach the whitelist as own properties, and every other key of a plain
// object literal is inherited from Object.prototype — so an `in` check would accept
// constructor/toString/__proto__ and map them to something that is not a TAPD field.
test('tapd config rejects keys inherited from Object.prototype', (t) => {
  for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const value = tapdBothProjects();
    Object.defineProperty(value.tapd.fields, key, { value: 'injected', enumerable: true, writable: true, configurable: true });
    let message = '';
    try {
      loadConfig(writeTapd(t, value));
    } catch (err) {
      message = err.message;
    }
    assert.match(message, new RegExp(`unknown field ${key}$`), key);
  }
});

test('the seven template parameters are the only accepted field names', (t) => {
  const value = tapdBothProjects();
  value.tapd.fields = {
    versionReport: '每周迭代版本', te: '小鱼', currentOwner: '阿鱼;',
    cc: 'a;b', severity: 'normal', priority: 'high', frequency: '100%',
  };
  assert.deepEqual(loadConfig(writeTapd(t, value)).tapd.workspaces.weapon.fields, {
    version_report: '每周迭代版本', te: '小鱼', current_owner: '阿鱼;',
    cc: 'a;b', severity: 'normal', priority: 'high', frequency: '100%',
  });
});

test('os is no longer a ticket field: TAPD calls it 操作系统 and has no 使用机型 field', (t) => {
  const value = tapdBothProjects();
  value.tapd.fields.os = '线上安卓';
  let message = '';
  try {
    loadConfig(writeTapd(t, value));
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /tapd\.fields has unknown field os$/, 'the old key fails loudly instead of filing nothing');
});

test('device is inherited from tapd and may be overridden per workspace', (t) => {
  const value = tapdBothProjects();
  value.tapd.device = '线上安卓';
  value.tapd.workspaces.gear = { ...value.tapd.workspaces.gear, device: '线上iOS' };
  const config = loadConfig(writeTapd(t, value));
  assert.equal(config.tapd.workspaces.weapon.device, '线上安卓');
  assert.equal(config.tapd.workspaces.gear.device, '线上iOS');
  assert.equal(config.tapd.workspaces.weapon.fields.os, undefined, 'device never becomes a ticket parameter');
});

test('a workspace without any device loads as absent', (t) => {
  const config = loadConfig(writeTapd(t, tapdBothProjects()));
  assert.equal(config.tapd.workspaces.weapon.device, undefined);
});

test('a non-string device is refused instead of stringified', (t) => {
  for (const bad of [null, 42, { x: 1 }]) {
    const value = tapdBothProjects();
    value.tapd.device = bad;
    let message = '';
    try {
      loadConfig(writeTapd(t, value));
    } catch (err) {
      message = err.message;
    }
    assert.match(message, /tapd\.device must be a string/, JSON.stringify(bad));
  }
});

test('a rejected tapd field names its key without echoing the value', (t) => {
  const value = tapdBothProjects();
  const long = '机'.repeat(101);
  value.tapd.fields.te = long;
  let message = '';
  try {
    loadConfig(writeTapd(t, value));
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /tapd\.fields\.te/);
  assert.equal(message.includes('机'.repeat(5)), false);
});
