// Persistent poll state: the message cursor plus the single in-flight job.
// Pure filesystem persistence only — the engine owns any crash-recovery policy
// (e.g. deciding what a `running` job means after a restart); this module
// restores exactly what was saved.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { timeOf } from './trigger.js';

export function initialState(nowMs) {
  return {
    version: 1,
    startedAt: nowMs,
    // Seeding the cursor at `nowMs` makes the first run ignore pre-existing
    // group history; only messages created after startup are seen.
    lastSeen: { createTimeMs: nowMs, messageId: '' },
    job: null,
  };
}

export function loadState(file, nowMs) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !parsed.lastSeen) return initialState(nowMs);
    return parsed;
  } catch {
    return initialState(nowMs);
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
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
