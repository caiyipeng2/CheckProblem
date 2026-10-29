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
