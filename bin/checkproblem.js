#!/usr/bin/env node
// Process entry: wiring only. All policy lives in the modules below; in
// particular the engine owns crash recovery for a `running` job on its first
// tick, so nothing here inspects or rewrites the loaded state.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createLark, LarkError } from '../src/lark.js';
import { loadState, saveState } from '../src/state.js';
import { syncRepo } from '../src/repo.js';
import { runAnalysis } from '../src/analyze.js';
import { createEngine } from '../src/index.js';
import { run } from '../src/runner.js';
import { collectEvidence } from '../src/search.js';
import { askChat, resolveApiKey } from '../src/chat.js';
import { clearImages } from '../src/images.js';
import { acquireLock, releaseLock } from '../src/lock.js';
import { listRemoteBranches, selectProject, syncSelectedProject } from '../src/projects.js';
import { startCardEvents } from '../src/card-events.js';
import { createTapdClient } from '../src/tapd.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const once = args.includes('--once');
const dryRunFlag = args.includes('--dry-run');

const configIdx = args.indexOf('--config');
if (configIdx >= 0 && !args[configIdx + 1]) {
  console.error('--config requires a path');
  process.exit(1);
}
const configPath = configIdx >= 0 ? resolve(args[configIdx + 1]) : join(here, '..', 'config.json');

const config = loadConfig(configPath);
if (dryRunFlag) config.dryRun = true;
if (config.projects && once && !config.dryRun) {
  console.error('卡片模式需要持续运行，不能使用 --once');
  process.exit(1);
}

const log = createLogger({ dir: config.paths.logDir });

// Two pollers would double-reply and fight over the cursor, so a second copy
// exits before it touches anything.
const lockFile = join(config.root, 'state', 'checkproblem.lock');
mkdirSync(dirname(lockFile), { recursive: true });
const lock = acquireLock(lockFile);
if (!lock.ok) {
  log.error(`another instance is already running (pid ${lock.pid}) — stop it first`);
  process.exit(1);
}
process.on('exit', () => releaseLock(lockFile));

// A crash mid-analysis leaves downloaded screenshots behind; holding the lock
// proves no other instance can still be reading them.
clearImages(config.paths.imagesDir);

const state = loadState(config.paths.stateFile, Date.now());

const lark = createLark({ run, dryRun: config.dryRun, log, botReplies: Boolean(config.projects) });
// TAPD is opt-in: a config without a `tapd` section leaves the client null and
// the finished card exactly as it was before this feature.
const tapd = config.tapd && Object.keys(config.tapd.workspaces).length
  ? createTapdClient({ tokenFile: config.tapd.tokenFile, baseUrl: config.tapd.baseUrl, log })
  : null;
if (tapd) {
  log.info(`tapd enabled for ${Object.keys(config.tapd.workspaces).join(', ')}`);
  // Config validation checks the token path's shape only: the file may be
  // mounted at deploy time, so a missing one must not fail startup. But a
  // typo would otherwise surface as a working-looking button that fails on
  // every press, so probe each project once through the client's own reader
  // and name the project and path. The token itself is never logged.
  for (const [projectId, entry] of Object.entries(config.tapd.workspaces)) {
    if (!resolveApiKey({ apiKeyEnv: '', apiKeyFile: entry.tokenFile })) {
      log.warn(`tapd: token file for ${projectId} is unreadable or empty: ${entry.tokenFile} — that project cannot file tickets`);
    }
  }
}
const selectedRepo = (selection) => config.projects
  ? selectProject(config, selection?.id, selection?.branch)
  : config.repo;

const engine = createEngine({
  config,
  lark,
  state,
  clock: () => Date.now(),
  log,
  saveState: (s) => saveState(config.paths.stateFile, s),
  listBranches: (project) => listRemoteBranches({ url: project.url, run }),
  syncRepo: (selection) => config.projects
    ? syncSelectedProject({ repo: selectedRepo(selection), run, log })
    : syncRepo({ ...config.repo, run, log }),
  retrieve: (question, selection) => collectEvidence({ question, repoDir: selectedRepo(selection).dir, run, log }),
  runAnalysis: (prompt, selection, options) =>
    runAnalysis({
      prompt,
      repoDir: selectedRepo(selection).dir,
      attempts: config.analyze.attempts,
      run,
      log,
      images: options?.images,
      chat: ({ prompt, attempt, images }) =>
        askChat({
          prompt,
          images,
          baseUrl: attempt.baseUrl,
          model: attempt.model,
          apiKey: resolveApiKey({ apiKeyEnv: attempt.apiKeyEnv, apiKeyFile: attempt.apiKeyFile }),
          timeoutMs: attempt.timeoutSec * 1000,
        }),
    }),
  tapd,
});

const ALARM_AFTER_FAILURES = 5;

async function main() {
  log.info(`starting (once=${once}, dryRun=${config.dryRun}, cards=${Boolean(config.projects)}, chat=${config.chatId})`);
  let failures = 0;
  let stopping = false;
  let eventWake = false;
  let wake;
  let listener;
  const stop = () => { stopping = true; wake?.(); listener?.stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    if (config.projects && !config.dryRun) {
      listener = startCardEvents({
        log,
        onEvent: (event) => {
          if (!stopping && engine.enqueueCardAction(event)) {
            eventWake = true;
            wake?.();
          }
        },
      });
      listener.done.catch((err) => {
        log.error(`card listener failed: ${err.message}`);
        process.exitCode = 1;
        stop();
      });
      await listener.ready;
    }

    while (!stopping) {
      eventWake = false;
      try {
        await engine.tick();
        failures = 0;
      } catch (err) {
        if (err instanceof LarkError && err.missingScopes?.length > 0) {
          log.error(`missing scopes: ${err.missingScopes.join(', ')} — check application permissions and the calling identity`);
          process.exitCode = 1;
          return;
        }
        failures += 1;
        log.error(`tick failed (${failures} in a row): ${err?.message ?? err}`);
        if (failures === ALARM_AFTER_FAILURES) {
          log.error(`${failures} consecutive failures — check credentials and network before restarting`);
        }
      }
      if (once || stopping) return;
      if (eventWake) continue;
      await new Promise((resolve) => {
        const timer = setTimeout(done, config.pollIntervalSec * 1000);
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    listener?.stop();
    if (listener) await listener.done.catch(() => {});
  }
}

main().catch((err) => {
  log.error(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
