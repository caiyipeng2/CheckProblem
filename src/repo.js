// Repo sync: keeps one dedicated clone on the latest origin/<branch>.
// `dir` is the only path this module touches; it never resolves, substitutes,
// or falls back to another clone. All git work goes through the injected `run`
// as an argument array, so no shell is involved.

import { existsSync } from 'node:fs';

function assertOk(res, what) {
  if (res.code !== 0) {
    throw new Error(`git ${what} failed: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res;
}

export async function syncRepo({ dir, url, branch, run, log = null }) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('syncRepo requires a non-empty dir');
  }

  const isRepo = existsSync(`${dir}/.git`);

  if (!isRepo) {
    // A plain directory here (e.g. an interrupted clone) takes this branch too;
    // git's "destination path already exists" is surfaced by assertOk.
    log?.info?.(`cloning ${url} -> ${dir}`);
    assertOk(await run('git', ['clone', '--branch', branch, url, dir]), 'clone');
  } else {
    log?.info?.(`syncing ${dir} to origin/${branch}`);
    assertOk(await run('git', ['-C', dir, 'fetch', '--prune', 'origin']), 'fetch');
    assertOk(await run('git', ['-C', dir, 'reset', '--hard', `origin/${branch}`]), 'reset');
    // -fd only: ignored build artifacts are irrelevant to analysis and costly to re-download.
    assertOk(await run('git', ['-C', dir, 'clean', '-fd']), 'clean');
  }

  const rev = assertOk(await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']), 'rev-parse');
  return { commit: rev.stdout.trim() };
}
