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
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const LEDGER_CORRUPT = 'LEDGER_CORRUPT';
const LEDGER_UNSUPPORTED = 'LEDGER_UNSUPPORTED';
const STORE_CLOSED = 'STORE_CLOSED';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Deliberately shallow: request and story internals are validated by the draft
// layer. Here only the container must be trustworthy before it reaches memory.
function validateLedger(ledger) {
  if (!isPlainObject(ledger)) throw new Error(LEDGER_CORRUPT);
  if (typeof ledger.version === 'number' && ledger.version !== 1) {
    throw new Error(LEDGER_UNSUPPORTED);
  }
  // A missing or non-numeric version is malformed, not a newer schema.
  if (ledger.version !== 1) throw new Error(LEDGER_CORRUPT);
  if (!isPlainObject(ledger.requests)) throw new Error(LEDGER_CORRUPT);
  for (const [id, request] of Object.entries(ledger.requests)) {
    if (id.length === 0 || !isPlainObject(request)) throw new Error(LEDGER_CORRUPT);
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
    ...io,
  };

  let state = loadLedger();
  let closed = false;
  let queue = Promise.resolve();
  let tempSeq = 0;

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
    tempSeq += 1;
    const tmp = `${file}.${process.pid}.${tempSeq}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(ledger, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Memory is published only after this rename succeeds; on Windows this is
    // atomic replacement, not a cross-power-loss database guarantee.
    fs.renameSync(tmp, file);
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
      validateLedger(next);
      writeAtomic(next);
      state = next;
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
