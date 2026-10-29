import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { normalizeProjects } from './projects.js';

export { normalizeProjects } from './projects.js';

// lark-cli only writes files beneath its allowlist (cwd, the account temp
// directory, ~/files). Node's os.tmpdir() follows TMP, which is relocated on
// this machine and refused by the CLI, so prefer the Windows per-user temp.
export function defaultImagesDir(env = process.env, home = homedir()) {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Temp') : join(home, 'files');
  return join(base, 'checkproblem-images');
}

const DEFAULTS = {
  triggerKeyword: '蔡龙',
  confirmTimeoutSec: 600,
  pollIntervalSec: 15,
  contextMessages: 5,
  maxReplyChars: 4000,
  // Tried in order; a slow engine only costs its own budget before the next one
  // starts. Every attempt still runs codex-shaped and read-only.
  analyze: {
    attempts: [
      { label: 'codex-fast', command: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', timeoutSec: 240 },
      { label: 'codex-deep', command: 'codex', timeoutSec: 600 },
    ],
  },
  dryRun: false,
};

export function loadConfig(filePath) {
  const abs = resolve(filePath);
  const root = dirname(abs);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  if (!raw.chatId) throw new Error('config: chatId is required');
  if (!raw.selfOpenId) throw new Error('config: selfOpenId is required');

  const repo = { mode: 'clone', branch: 'master', ...(raw.repo ?? {}) };
  if (repo.dir && !isAbsolute(repo.dir)) repo.dir = join(root, repo.dir);

  const projects = normalizeProjects(raw.projects, root);
  const projectConfig = {};
  if (projects !== undefined) {
    const defaultProjectId = raw.defaultProjectId === undefined ? projects[0].id : raw.defaultProjectId;
    if (!projects.some((project) => project.id === defaultProjectId)) {
      throw new Error('config: defaultProjectId must match a configured project id');
    }
    Object.assign(projectConfig, { projects, defaultProjectId });
  }

  return {
    ...DEFAULTS,
    ...raw,
    ...projectConfig,
    analyze: {
      ...DEFAULTS.analyze,
      ...(raw.analyze ?? {}),
      attempts:
        Array.isArray(raw.analyze?.attempts) && raw.analyze.attempts.length > 0
          ? raw.analyze.attempts
          : DEFAULTS.analyze.attempts,
    },
    repo,
    root,
    paths: {
      stateFile: join(root, 'state', 'state.json'),
      logDir: join(root, 'logs'),
      jobsDir: join(root, 'logs', 'jobs'),
      imagesDir: defaultImagesDir(),
    },
  };
}
