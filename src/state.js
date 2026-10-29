// Persistent poll state: the message cursor plus the single in-flight job.
// Pure filesystem persistence only — the engine owns any crash-recovery policy
// (e.g. deciding what a `running` job means after a restart); this module
// restores exactly what was saved.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { timeOf } from './trigger.js';

export function initialState(nowMs = Date.now()) {
  return {
    version: 1,
    startedAt: nowMs,
    // Seeding the cursor at `nowMs` makes the first run ignore pre-existing
    // group history; only messages created after startup are seen.
    lastSeen: { createTimeMs: nowMs, messageId: '' },
    job: null,
    // Finished reports the TAPD button can still address. Kept small on purpose:
    // the card that renders them lives in Feishu, not here.
    reports: [],
  };
}

// A cursor is usable only when markSeen can compare it: a finite timestamp and
// a string id. Number(...) would coerce null/''/false/[] to 0, which would make
// the whole chat history look unseen, so accept only an actual finite number or
// a fully numeric string.
function normalizeCursor(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.messageId !== 'string') return null;
  const value = raw.createTimeMs;
  const usable =
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && /^\d+$/.test(value));
  if (!usable) return null;
  return { createTimeMs: Number(value), messageId: raw.messageId };
}

export function loadState(file, nowMs = Date.now()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== 1) return initialState(nowMs);
    const cursor = normalizeCursor(parsed.lastSeen);
    if (cursor === null) return initialState(nowMs);
    return {
      ...parsed,
      startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : nowMs,
      lastSeen: cursor,
      // Only the shape is trusted; a hand-edited or half-written file must not
      // feed the ticket button a report that cannot be addressed.
      reports: Array.isArray(parsed.reports) ? parsed.reports.slice(-20) : [],
      job:
        parsed.job !== null && typeof parsed.job === 'object' ? parsed.job : null,
    };
  } catch {
    // An unreadable file must not crash-loop the service; saveState's atomic rename below removes the truncation cause.
    return initialState(nowMs);
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

// Monotonic: out-of-order pages must never rewind the cursor. Only strictly
// newer messages advance it, breaking timestamp ties by message id.
export function markSeen(state, msg) {
  const createTimeMs = timeOf(msg);
  const messageId = String(msg.message_id);
  const lastSeen = state?.lastSeen;
  if (!lastSeen) {
    state.lastSeen = { createTimeMs, messageId };
    return;
  }
  const isNewer =
    createTimeMs > lastSeen.createTimeMs ||
    (createTimeMs === lastSeen.createTimeMs && messageId > String(lastSeen.messageId));
  if (isNewer) state.lastSeen = { createTimeMs, messageId };
}
