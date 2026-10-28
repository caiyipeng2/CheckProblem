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
