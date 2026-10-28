#!/usr/bin/env node
// Process entry: wiring only. All policy lives in the modules below; in
// particular the engine owns crash recovery for a `running` job on its first
// tick, so nothing here inspects or rewrites the loaded state.

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

const log = createLogger({ dir: config.paths.logDir });
const state = loadState(config.paths.stateFile, Date.now());

const lark = createLark({ run, dryRun: config.dryRun, log });

const engine = createEngine({
  config,
  lark,
  state,
  clock: () => Date.now(),
  log,
  saveState: (s) => saveState(config.paths.stateFile, s),
  syncRepo: () => syncRepo({ ...config.repo, run, log }),
  runAnalysis: (prompt) =>
    runAnalysis({
      prompt,
      repoDir: config.repo.dir,
      timeoutSec: config.analyze.timeoutSec,
      command: config.analyze.command,
      run,
    }),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spec §11: five consecutive failures is the alarm threshold. An expired token
// is the common cause and it does not clear itself, so say so loudly — but keep
// polling, because a network blip looks identical from here.
const ALARM_AFTER_FAILURES = 5;

async function main() {
  log.info(`starting (once=${once}, dryRun=${config.dryRun}, chat=${config.chatId})`);
  let failures = 0;

  for (;;) {
    try {
      await engine.tick();
      failures = 0;
    } catch (err) {
      // A revoked scope cannot recover by retrying; everything else is one bad
      // tick and the loop must survive it.
      if (err instanceof LarkError && err.missingScopes?.length > 0) {
        log.error(
          `missing scopes: ${err.missingScopes.join(', ')} — run lark-cli auth login --scope "<scope>"`,
        );
        process.exitCode = 1;
        return;
      }
      failures += 1;
      log.error(`tick failed (${failures} in a row): ${err?.message ?? err}`);
      if (failures === ALARM_AFTER_FAILURES) {
        log.error(
          `${failures} consecutive failures — if the cause is credentials, run lark-cli auth login and restart`,
        );
      }
    }

    if (once) return;
    await sleep(config.pollIntervalSec * 1000);
  }
}

main().catch((err) => {
  log.error(`fatal: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
