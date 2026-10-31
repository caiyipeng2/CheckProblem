// Independent ledger for requirement drafts and submissions. Unlike the
// recent-report window in state.js, this ledger is never pruned; every request
// record is kept so reviews, recovery and the submission audit can refer back
// to it. Filesystem persistence only — the callers own workflow policy.

import {
  closeSync as fsCloseSync,
  fsyncSync as fsFsyncSync,
  mkdirSync as fsMkdirSync,
  openSync as fsOpenSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const LEDGER_CORRUPT = 'LEDGER_CORRUPT';
const LEDGER_UNSUPPORTED = 'LEDGER_UNSUPPORTED';
const STORE_CLOSED = 'STORE_CLOSED';
const TRANSACTION_NOT_SYNC = 'TRANSACTION_NOT_SYNC';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Status enums belong to the workflow layers; the ledger only guarantees the
// shape Task 8 reads directly (request.envelope and submission.items).
function validateRequest(id, request) {
  if (!isPlainObject(request)) throw new Error(LEDGER_CORRUPT);
  if (!nonEmptyString(request.id) || request.id !== id) throw new Error(LEDGER_CORRUPT);
  if (!nonEmptyString(request.chatId)) throw new Error(LEDGER_CORRUPT);
  if (!nonEmptyString(request.status)) throw new Error(LEDGER_CORRUPT);
  if (!Array.isArray(request.submissions)) throw new Error(LEDGER_CORRUPT);
  for (const submission of request.submissions) {
    if (!isPlainObject(submission)) throw new Error(LEDGER_CORRUPT);
    if (!isPlainObject(submission.batch)) throw new Error(LEDGER_CORRUPT);
    if (!nonEmptyString(submission.status)) throw new Error(LEDGER_CORRUPT);
    if (!Array.isArray(submission.items)) throw new Error(LEDGER_CORRUPT);
    for (const item of submission.items) {
      if (!isPlainObject(item)) throw new Error(LEDGER_CORRUPT);
      if (!nonEmptyString(item.key)) throw new Error(LEDGER_CORRUPT);
      if (!nonEmptyString(item.status)) throw new Error(LEDGER_CORRUPT);
    }
  }
}

function validateLedger(ledger) {
  if (!isPlainObject(ledger)) throw new Error(LEDGER_CORRUPT);
  if (typeof ledger.version === 'number' && ledger.version !== 1) {
    throw new Error(LEDGER_UNSUPPORTED);
  }
  // A missing or non-numeric version is malformed, not a newer schema.
  if (ledger.version !== 1) throw new Error(LEDGER_CORRUPT);
  if (!isPlainObject(ledger.requests)) throw new Error(LEDGER_CORRUPT);
  for (const [id, request] of Object.entries(ledger.requests)) {
    validateRequest(id, request);
  }
}

export function openRequirementStore(file, { io = {} } = {}) {
  const fs = {
    mkdirSync: fsMkdirSync,
    readFileSync: fsReadFileSync,
    writeFileSync: fsWriteFileSync,
    openSync: fsOpenSync,
    fsyncSync: fsFsyncSync,
    closeSync: fsCloseSync,
    renameSync: fsRenameSync,
    unlinkSync: fsUnlinkSync,
    ...io,
  };

  let state = loadLedger();
  let closed = false;
  let queue = Promise.resolve();

  function loadLedger() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // Only a missing file may start empty; unreadable files must surface.
      if (error?.code === 'ENOENT') return { version: 1, requests: {} };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(LEDGER_CORRUPT);
    }
    validateLedger(parsed);
    return parsed;
  }

  function writeAtomic(ledger) {
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeFileSync(fd, JSON.stringify(ledger, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // Memory is published only after this rename succeeds; on Windows this is
      // atomic replacement, not a cross-power-loss database guarantee.
      fs.renameSync(tmp, file);
    } catch (error) {
      if (fd !== undefined) {
        // Best effort: a failed close leaves the handle unusable anyway.
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      // Best effort: never accumulate full ledger copies after a failed write.
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw error;
    }
  }

  function get(id) {
    return Object.hasOwn(state.requests, id)
      ? structuredClone(state.requests[id])
      : undefined;
  }

  function list() {
    return Object.values(state.requests).map((request) => structuredClone(request));
  }

  function transaction(fn) {
    if (closed) return Promise.reject(new Error(STORE_CLOSED));

    const run = async () => {
      const next = structuredClone(state);
      const result = fn(next);
      if (result !== null && result !== undefined && typeof result.then === 'function') {
        // Consume the thenable's settlement so a rejecting async fn cannot
        // surface as an unhandled rejection after we refuse its result.
        void Promise.resolve(result).catch(() => {});
        throw new Error(TRANSACTION_NOT_SYNC);
      }
      // Publish exactly what the file holds; non-JSON values would otherwise
      // diverge between memory and the next reopen.
      let normalized;
      try {
        normalized = JSON.parse(JSON.stringify(next));
      } catch {
        throw new Error(LEDGER_CORRUPT);
      }
      validateLedger(normalized);
      writeAtomic(normalized);
      state = normalized;
      return result;
    };

    // Chain synchronously so transactions started without awaiting still queue;
    // the sanitized tail keeps one rejection from poisoning later work.
    const settled = queue.then(run);
    queue = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  async function close() {
    closed = true;
    await queue;
  }

  return { get, list, transaction, close };
}
