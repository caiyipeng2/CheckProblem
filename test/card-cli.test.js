import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bin = fileURLToPath(new URL('../bin/checkproblem.js', import.meta.url));

test('live cards refuse --once rather than posting buttons without a listener', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'checkproblem-card-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    chatId: 'oc_test', selfOpenId: 'ou_self',
    projects: [{ id: 'weapon', name: '武器店', url: 'https://example.com/weapon.git' }],
  }));
  const win = process.platform === 'win32';
  writeFileSync(join(root, win ? 'lark-cli.cmd' : 'lark-cli'), win
    ? '@echo off\r\necho {"ok":true,"data":{"items":[]}}\r\n'
    : '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"items":[]}}\'\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` };
  const result = spawnSync(process.execPath, [bin, '--config', config, '--once'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /卡片.*持续运行|cards.*continuous/i);
});
