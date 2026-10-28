import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

const freshDir = () => mkdtempSync(join(tmpdir(), 'checkproblem-log-'));

test('createLogger writes one file per UTC day and echoes to the console', () => {
  const dir = freshDir();
  const lines = [];
  const logger = createLogger({ dir, now: Date.UTC(2026, 9, 28), echo: false });
  logger.info('hello');
  logger.warn('careful');

  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^app-\d{4}-\d{2}-\d{2}\.log$/);
});

test('createLogger prunes log files older than 14 days and keeps newer ones', () => {
  const dir = freshDir();
  const now = Date.UTC(2026, 9, 28);
  writeFileSync(join(dir, 'app-2026-10-13.log'), 'old\n'); // 15 days back
  writeFileSync(join(dir, 'app-2026-10-14.log'), 'edge\n'); // exactly 14 days back
  writeFileSync(join(dir, 'app-2026-10-27.log'), 'recent\n');
  writeFileSync(join(dir, 'notes.txt'), 'untouched\n');

  createLogger({ dir, now, echo: false });

  assert.equal(existsSync(join(dir, 'app-2026-10-13.log')), false);
  assert.equal(existsSync(join(dir, 'app-2026-10-14.log')), true);
  assert.equal(existsSync(join(dir, 'app-2026-10-27.log')), true);
  assert.equal(existsSync(join(dir, 'notes.txt')), true);
});

test('createLogger creates a missing directory instead of failing', () => {
  const dir = join(freshDir(), 'nested', 'logs');
  const logger = createLogger({ dir, now: Date.UTC(2026, 9, 28), echo: false });
  logger.error('boom');
  assert.equal(readdirSync(dir).length, 1);
});