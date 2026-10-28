import { readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';

const DEFAULTS = {
  triggerKeyword: '蔡龙',
  confirmTimeoutSec: 600,
  pollIntervalSec: 15,
  contextMessages: 5,
  maxReplyChars: 4000,
  analyze: { timeoutSec: 900, command: 'codex' },
  dryRun: false,
};

export function loadConfig(filePath) {
  const abs = resolve(filePath);
  const root = dirname(abs);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  if (!raw.chatId) throw new Error('config: chatId is required');
  if (!raw.selfOpenId) throw new Error('config: selfOpenId is required');

  const repo = { branch: 'master', ...(raw.repo ?? {}) };
  if (repo.dir && !isAbsolute(repo.dir)) repo.dir = join(root, repo.dir);

  return {
    ...DEFAULTS,
    ...raw,
    analyze: { ...DEFAULTS.analyze, ...(raw.analyze ?? {}) },
    repo,
    root,
    paths: {
      stateFile: join(root, 'state', 'state.json'),
      logDir: join(root, 'logs'),
      jobsDir: join(root, 'logs', 'jobs'),
    },
  };
}
