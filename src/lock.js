// Single-instance guard. Two pollers sharing one state file would double-reply
// and overwrite each other's cursor, and nothing else in the service prevents a
// second copy from being started by hand while the scheduled task runs.
//
// The lock is a pid file: created with O_EXCL, taken over when the recorded pid
// is gone (a crash leaves the file behind), and removed on a clean exit.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}

export function acquireLock(file, { pid = process.pid, alive = isRunning } = {}) {
  const claim = () => {
    writeFileSync(file, String(pid), { flag: 'wx' });
    return { ok: true, release: () => releaseLock(file, pid) };
  };

  try {
    return claim();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  let holder = NaN;
  try {
    holder = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  } catch {
    // Unreadable lock is treated as stale below.
  }
  if (alive(holder)) return { ok: false, pid: holder };

  try {
    unlinkSync(file);
  } catch {
    // Someone else removed it first; the retry below reports the truth.
  }
  return claim();
}

export function releaseLock(file, pid = process.pid) {
  try {
    if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file);
  } catch {
    // Already gone, or never ours.
  }
}