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
import { createWorkSlot } from '../src/work-slot.js';
import { openRequirementStore } from '../src/requirement-store.js';
import { createCliResourceReaders, createPlanningDocumentReader } from '../src/planning-document.js';
import { createDecomposer } from '../src/decompose.js';
import { createTapdStories } from '../src/tapd-stories.js';
import { createRequirementSubmitter } from '../src/requirement-submit.js';
import { requirementTargets } from '../src/requirement-config.js';
import { createRequirementRequests } from '../src/requirement-requests.js';

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
// 需求拆分 is opt-in: a config without a `requirements` section leaves the
// coordinator unassembled and every message follows the old path. `--dry-run`
// must not write to TAPD or submit a batch, so the flow stays off there too —
// 拆分需求 is then skipped by the engine's own planning-command guard.
let requirements = null;
// One heavy-work slot for the whole process: 故障排查 and 需求拆分 share it. It is
// created only with the requirement flow; without one the engine creates its own,
// exactly as before this feature.
let workSlot = null;
if (config.requirements && !config.dryRun) {
  const settings = config.requirements;
  const store = openRequirementStore(settings.paths.stateFile);
  workSlot = createWorkSlot({ log });
  const documents = createPlanningDocumentReader({
    run,
    resourceReaders: createCliResourceReaders({ run }),
    hosts: settings.documentHosts,
    assetsDir: settings.paths.assetsDir,
  });
  // The configured attempt is fixed at startup. Its key comes from the file
  // named in the config only: apiKeyEnv is pinned to '', so a process
  // environment variable can never stand in, and the key is never logged or
  // passed anywhere except into the in-memory header of askChat.
  const attempt = settings.attempt;
  const decomposer = createDecomposer({
    chat: ({ prompt, images }) => askChat({
      prompt,
      images,
      baseUrl: attempt.baseUrl,
      model: attempt.model,
      apiKey: resolveApiKey({ apiKeyEnv: '', apiKeyFile: attempt.apiKeyFile }),
      timeoutMs: Number.isFinite(attempt.timeoutSec) ? attempt.timeoutSec * 1000 : undefined,
    }),
  });
  const tapdStories = createTapdStories({
    tokenFile: config.tapd.tokenFile,
    // A mapped workspace may use its own TAPD app/token (weapon and gear do);
    // the story adapter picks the file by workspace on every call.
    tokenFiles: Object.fromEntries(
      Object.values(config.tapd.workspaces ?? {})
        .map((workspace) => [workspace.workspaceId, workspace.tokenFile]),
    ),
    baseUrl: config.tapd.baseUrl,
  });
  // The submitter compares a frozen batch's workspace with this map, while the
  // coordinator derives the target from the same two sections (requirements
  // projects + TAPD workspaces). They must stay one source, or every real
  // submission would be refused as SUBMISSION_MISMATCH while tests stay green.
  // The map also has to carry the types and the template: the submitter builds
  // the TAPD payload straight from it.
  const submitter = createRequirementSubmitter({
    store,
    tapd: tapdStories,
    documents,
    targets: requirementTargets(config),
    clock: { now: () => Date.now() },
  });
  requirements = createRequirementRequests({
    config,
    store,
    lark,
    documents,
    decomposer,
    submitter,
    slot: workSlot,
    clock: () => Date.now(),
    log,
  });
  log.info(`requirements enabled for ${Object.keys(settings.projects).join(', ')}`);
} else if (config.requirements) {
  log.info('requirements disabled by --dry-run: no TAPD writes and no submissions');
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
  slot: workSlot,
  requirements,
});

const ALARM_AFTER_FAILURES = 5;
// A graceful stop waits for work that already started, but a stuck transport
// must not hold the process (and the instance lock) forever. Anything unfinished
// at this deadline is settled from its persisted status on the next start, just
// like after a SIGKILL: a bug job reopens as interrupted and a TAPD item parked
// as `sending` goes through the read-only reconcile.
const SHUTDOWN_WAIT_MS = 30_000;

// Returns 'idle', 'deadline' or 'failed' and never rejects, so the lock can
// always be released afterwards.
async function settleWithin(ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    return await Promise.race([
      engine.whenIdle().then(() => 'idle', () => 'failed'),
      deadline.then(() => 'deadline'),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// One-shot mode keeps its old completion guarantee: an analysis started from
// the single tick is awaited before the process reports its exit.
async function settleOnce() {
  try {
    await engine.whenIdle();
    return 'idle';
  } catch {
    return 'failed';
  }
}

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
    // Recovery is one idempotent pass and must finish before any card event can
    // start work for a `reading`/`analyzing` request left by the last process.
    // The engine repeats the call on its first tick; the guard inside the
    // coordinator makes that second call a no-op.
    if (requirements) {
      try {
        await requirements.flush();
      } catch (err) {
        log.error(`requirement recovery failed: ${err?.message ?? err}`);
      }
    }

    if (!stopping && config.projects && !config.dryRun) {
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
    // New events are already refused: the listener is stopping and `stopping`
    // gates every callback. Let operations that did start finish and persist
    // their outcome; an unfinished one is recovered on the next start.
    let outcome = 'idle';
    if (stopping) outcome = await settleWithin(SHUTDOWN_WAIT_MS);
    else if (once) outcome = await settleOnce();
    if (outcome === 'deadline') {
      log.warn(`shutdown: work still running after ${SHUTDOWN_WAIT_MS}ms; the next start will recover it`);
    } else if (outcome === 'failed') {
      log.warn('shutdown: engine work did not settle cleanly');
    }
    // Last: only now may another instance take over.
    releaseLock(lockFile);
  }
}

main().catch((err) => {
  log.error(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
