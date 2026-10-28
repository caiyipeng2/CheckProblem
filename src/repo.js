// Repo access for the analysed project.
//
// Two modes, and the difference matters:
// - `clone`: a dedicated clone owned by this service. It is moved by
//   fetch/reset --hard/clean -fd, so it must never point at a working copy.
// - `copy`: somebody's working copy. It is only fetched and read: no reset, no
//   clean, no checkout, no branch change. The reported provenance carries the
//   branch and the uncommitted-file count so a reader knows what was analysed.
//
// `dir` is the only path this module touches. All git work goes through the
// injected `run` as an argument array, so no shell is involved.

import { existsSync } from 'node:fs';

// clone and fetch move a multi-gigabyte Unity repo and can legitimately take
// many minutes; everything else is local and relies on the runner's default.
const NETWORK_TIMEOUT_MS = 1_800_000;

function assertOk(res, what) {
  if (res.code !== 0) {
    throw new Error(`git ${what} failed: ${(res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  return res;
}

async function describeWorkingCopy({ dir, run, log }) {
  // A failed fetch is not fatal: the analysis reads the files that are on disk,
  // and an offline laptop still deserves an answer.
  try {
    const fetched = await run('git', ['-C', dir, 'fetch', '--prune', 'origin'], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    if (fetched.code !== 0) {
      log?.warn?.(`fetch failed, analysing the working copy as it is: ${(fetched.stderr || '').slice(-200)}`);
    }
  } catch (err) {
    log?.warn?.(`fetch failed, analysing the working copy as it is: ${err?.message ?? err}`);
  }

  const branch = assertOk(await run('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']), 'branch')
    .stdout.trim();
  const commit = assertOk(await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']), 'rev-parse')
    .stdout.trim();
  const status = assertOk(await run('git', ['-C', dir, 'status', '--porcelain']), 'status');
  const dirty = String(status.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '').length;

  const provenance = `${branch}@${commit}${dirty > 0 ? `+${dirty}` : ''}`;
  log?.info?.(`analysing ${dir} at ${provenance}`);
  return { branch, commit, dirty, provenance };
}

export async function syncRepo({ dir, url, branch, mode = 'clone', run, log = null }) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error('syncRepo requires a non-empty dir');
  }

  const isRepo = existsSync(`${dir}/.git`);

  if (mode === 'copy') {
    if (!isRepo) throw new Error(`not a git repository: ${dir}`);
    return describeWorkingCopy({ dir, run, log });
  }

  if (!isRepo) {
    // A plain directory here (e.g. an interrupted clone) takes this branch too;
    // git's "destination path already exists" is surfaced by assertOk.
    log?.info?.(`cloning ${url} -> ${dir}`);
    assertOk(
      await run('git', ['clone', '--branch', branch, url, dir], { timeoutMs: NETWORK_TIMEOUT_MS }),
      'clone',
    );
  }

  log?.info?.(`syncing ${dir} to origin/${branch}`);
  assertOk(
    await run('git', ['-C', dir, 'fetch', '--prune', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS }),
    'fetch',
  );
  assertOk(await run('git', ['-C', dir, 'reset', '--hard', `origin/${branch}`]), 'reset');
  // -fd only: ignored build artifacts are irrelevant to analysis and costly to re-download.
  assertOk(await run('git', ['-C', dir, 'clean', '-fd']), 'clean');

  const rev = assertOk(await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']), 'rev-parse');
  const commit = rev.stdout.trim();
  return { branch, commit, dirty: 0, provenance: `${branch}@${commit}` };
}