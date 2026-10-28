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
