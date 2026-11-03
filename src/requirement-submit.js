// Requirement submission: drives one frozen batch into TAPD stories.
//
// TAPD has no idempotency key, so this module's job is ordering and bookkeeping:
// every item is written to the ledger as `sending` before the POST exists, and a
// result that cannot be proven (timeout, malformed answer, lost write) is parked
// as `unknown` instead of retried. Only the read-only reconcile may turn an
// unknown item into a created one, and only from a read-back that matches
// exactly. Nothing here invents payload: fields come from the frozen batch plus
// the configured target, and every description is built by src/tapd-stories.js.

import { createHash } from 'node:crypto';

import { buildChildFields, buildParentFields } from './tapd-stories.js';

// The batch always carries the parent as an item, so the cap is one higher than
// the story limit the card advertises (50 stories plus their parent).
const DEFAULT_MAX_ITEMS = 51;
const MARKER_KEY_LENGTH = 24;
const MARKER_HASH_LENGTH = 16;
const PARENT_KEY = 'parent';
const ITEM_STATUSES = new Set(['pending', 'sending', 'created', 'unknown', 'rejected', 'blocked']);

function coded(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

function fail(code) {
  throw coded(code, `requirement-submit: ${code}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

// Markers are derived, never stored as input: the same frozen batch always
// produces the same marker, which is what lets a restarted process reconcile an
// item it lost mid-flight. They locate stories; they are not an idempotency key.
function markerFor(requestId, batchId, key) {
  const digest = createHash('sha256')
    .update(`${requestId}|${batchId}|${key}`)
    .digest('hex')
    .slice(0, MARKER_HASH_LENGTH);
  return `req-${String(key).slice(0, MARKER_KEY_LENGTH)}-${digest}`;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function descriptionTokens(text) {
  return decodeEntities(String(text ?? '').replace(/<[^>]*>/g, ' '))
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => token !== '');
}

function byKey(left, right) {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// Children in dependency order (keys break ties), so a child is only ever
// created after the story it depends on.
function planOrder(stories) {
  const batchKeys = new Set(stories.map((story) => story.key));
  const remaining = [...stories].sort(byKey);
  const ordered = [];
  const placed = new Set();
  while (remaining.length > 0) {
    const index = remaining.findIndex((story) => story.dependencies
      .every((dependency) => !batchKeys.has(dependency) || placed.has(dependency)));
    if (index < 0) fail('DEPENDENCY_CYCLE');
    const [story] = remaining.splice(index, 1);
    placed.add(story.key);
    ordered.push(story);
  }
  return ordered;
}

function planItems(frozen) {
  return [
    { key: PARENT_KEY, marker: markerFor(frozen.requestId, frozen.id, PARENT_KEY) },
    ...planOrder(Array.isArray(frozen.stories) ? frozen.stories : []).map((story) => ({
      key: story.key,
      marker: markerFor(frozen.requestId, frozen.id, story.key),
    })),
  ];
}

function childView(story) {
  const fields = isPlainObject(story.fields) ? story.fields : {};
  return {
    key: story.key,
    title: fields.title,
    rules: Array.isArray(fields.rules) ? fields.rules : [],
    acceptance: Array.isArray(fields.acceptance) ? fields.acceptance : [],
    factIds: Array.isArray(fields.factIds) ? fields.factIds : [],
    sourceIds: Array.isArray(fields.sourceIds) ? fields.sourceIds : [],
    issueIds: Array.isArray(fields.issueIds) ? fields.issueIds : [],
    owner: fields.owner ?? null,
    iterationId: fields.iterationId ?? null,
    dependencies: Array.isArray(story.dependencies) ? story.dependencies : [],
  };
}

function isAllowedActor(request, actorId) {
  if (!nonEmptyString(actorId)) return false;
  if (request.initiatorId === actorId) return true;
  return Array.isArray(request.reviewerIds) && request.reviewerIds.includes(actorId);
}

export function createRequirementSubmitter({
  store,
  tapd,
  documents,
  targets,
  clock = null,
  limits = {},
} = {}) {
  if (!isPlainObject(store) || typeof store.get !== 'function' || typeof store.transaction !== 'function') {
    fail('INVALID_CONFIG');
  }
  if (!isPlainObject(tapd) || typeof tapd.createStory !== 'function' || typeof tapd.findParents !== 'function') {
    fail('INVALID_CONFIG');
  }
  if (!isPlainObject(documents) || typeof documents.revalidate !== 'function') fail('INVALID_CONFIG');
  if (!isPlainObject(targets)) fail('INVALID_CONFIG');

  const maxItems = Number.isInteger(limits?.maxItems) && limits.maxItems > 0
    ? limits.maxItems
    : DEFAULT_MAX_ITEMS;
  const stamp = () => (clock && typeof clock.now === 'function' ? clock.now() : new Date()).toISOString();
  const queues = new Map();

  // One batch at a time: a double click must observe the first run's ledger
  // writes instead of issuing a second POST for the same item.
  function serialize(id, task) {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(id, next.then(
      () => undefined,
      () => undefined,
    ));
    return next;
  }

  function submissionOf(state, requestId, batchId) {
    const request = state.requests?.[requestId];
    if (!isPlainObject(request)) return null;
    return (Array.isArray(request.submissions) ? request.submissions : [])
      .find((entry) => entry?.batch?.id === batchId) ?? null;
  }

  function locate(requestId, batchId) {
    if (!nonEmptyString(requestId) || !nonEmptyString(batchId)) fail('UNKNOWN_REQUEST');
    const request = store.get(requestId);
    if (!isPlainObject(request)) fail('UNKNOWN_REQUEST');
    const submission = (Array.isArray(request.submissions) ? request.submissions : [])
      .find((entry) => entry?.batch?.id === batchId);
    if (!isPlainObject(submission) || !isPlainObject(submission.batch)) fail('UNKNOWN_BATCH');

    const frozen = submission.batch;
    if (!nonEmptyString(frozen.id) || !nonEmptyString(frozen.requestId)
      || !nonEmptyString(frozen.workspaceId) || !nonEmptyString(frozen.documentId)) {
      fail('SUBMISSION_MISMATCH');
    }
    if (frozen.requestId !== requestId) fail('SUBMISSION_MISMATCH');
    const target = targets[request.projectId];
    if (!isPlainObject(target) || !nonEmptyString(target.workspaceId)) fail('INVALID_TARGET');
    if (frozen.workspaceId !== target.workspaceId) fail('SUBMISSION_MISMATCH');
    if (!nonEmptyString(request.snapshot?.documentId)
      || frozen.documentId !== request.snapshot.documentId) {
      fail('SUBMISSION_MISMATCH');
    }
    if (frozen.draftVersion !== request.draft?.version) fail('SUBMISSION_MISMATCH');
    if (frozen.parent?.mode !== 'create' && frozen.parent?.mode !== 'bind') fail('SUBMISSION_MISMATCH');
    if (frozen.parent.mode === 'bind' && !nonEmptyString(frozen.parent.storyId)) fail('SUBMISSION_MISMATCH');
    if (frozen.parent.mode === 'create' && !nonEmptyString(frozen.parent.fields?.title)) {
      fail('SUBMISSION_MISMATCH');
    }

    const items = planItems(frozen);
    if (items.length > maxItems) fail('BATCH_TOO_LARGE');

    const stored = Array.isArray(submission.items) ? submission.items : [];
    // A materialized list is complete: items are never added or dropped after
    // the first submit, so any other length means the ledger was rewritten.
    if (stored.length > 0 && stored.length !== items.length) fail('SUBMISSION_MISMATCH');
    const ordered = items.map((expected, index) => {
      const entry = { key: expected.key, marker: expected.marker, status: 'pending', storyId: null };
      const persisted = stored[index];
      if (!persisted) return entry;
      if (!isPlainObject(persisted) || persisted.key !== expected.key || persisted.marker !== expected.marker) {
        fail('SUBMISSION_MISMATCH');
      }
      if (!ITEM_STATUSES.has(persisted.status)) fail('SUBMISSION_MISMATCH');
      entry.status = persisted.status;
      if (nonEmptyString(persisted.storyId)) entry.storyId = persisted.storyId;
      return entry;
    });

    const view = new Map(ordered.map((item) => [item.key, item]));
    return {
      requestId,
      batchId,
      request,
      submission,
      frozen,
      target,
      workspaceId: frozen.workspaceId,
      ordered,
      view,
      materialized: stored.length > 0,
      status: nonEmptyString(submission.status) ? submission.status : 'pending',
      parentStoryId: nonEmptyString(submission.parentStoryId) ? submission.parentStoryId : null,
      notes: [],
      paused: false,
    };
  }

  function wire(ctx) {
    ctx.read = (id) => tapd.getStory({ workspaceId: ctx.workspaceId, id });
    ctx.findParents = (name) => tapd.findParents({
      workspaceId: ctx.workspaceId,
      name,
      documentId: ctx.frozen.documentId,
    });
    ctx.findByMarker = (marker) => tapd.findByMarker({
      workspaceId: ctx.workspaceId,
      parentId: ctx.parentStoryId,
      marker,
    });
    ctx.createStory = (workspaceId, fields) => tapd.createStory({ workspaceId, fields });
    return ctx;
  }

  async function write(ctx, mutate) {
    try {
      await store.transaction((state) => {
        const submission = submissionOf(state, ctx.requestId, ctx.batchId);
        if (!submission) throw coded('SUBMISSION_MISMATCH');
        mutate(submission);
        submission.updatedAt = stamp();
      });
      return true;
    } catch {
      // A failed ledger write means the next process would see a different
      // history than this one, so no remote call may follow it.
      ctx.paused = true;
      ctx.notes.push('LEDGER_WRITE_FAILED');
      return false;
    }
  }

  async function patchItem(ctx, key, patch) {
    const item = ctx.view.get(key);
    if (!item) return false;
    Object.assign(item, patch);
    if (key === PARENT_KEY && nonEmptyString(patch.storyId)) ctx.parentStoryId = patch.storyId;
    return write(ctx, (submission) => {
      const stored = (Array.isArray(submission.items) ? submission.items : [])
        .find((entry) => entry?.key === key);
      if (!stored) throw coded('SUBMISSION_MISMATCH');
      Object.assign(stored, patch, { at: stamp() });
      if (key === PARENT_KEY && nonEmptyString(patch.storyId)) submission.parentStoryId = patch.storyId;
    });
  }

  function summary(ctx) {
    return {
      status: ctx.status,
      parentStoryId: ctx.parentStoryId,
      items: ctx.ordered.map((item) => ({
        key: item.key,
        status: item.status,
        storyId: item.storyId,
        marker: item.marker,
      })),
      notes: [...new Set(ctx.notes)],
    };
  }

  async function settle(ctx, status) {
    ctx.status = status;
    const notes = [...new Set(ctx.notes)];
    await write(ctx, (submission) => {
      submission.status = status;
      if (notes.length > 0) {
        submission.notes = [
          ...(Array.isArray(submission.notes) ? submission.notes : []),
          ...notes.map((code) => ({ code, at: stamp() })),
        ];
      }
    });
    return summary(ctx);
  }

  // A crashed process leaves `sending` behind, which means "we never learned the
  // answer": downgrade before any remote call so nothing is re-posted blindly.
  async function normalizeSending(ctx) {
    for (const item of ctx.ordered) {
      if (item.status !== 'sending') continue;
      const saved = await patchItem(ctx, item.key, { status: 'unknown' });
      if (!saved) return false;
      ctx.notes.push('SENDING_RECOVERED');
    }
    return true;
  }

  // The coordinator freezes and appends the batch; this module owns the item
  // list. Items are written once, in the planned order, and never grow after.
  async function materialize(ctx) {
    if (ctx.materialized) return true;
    return write(ctx, (submission) => {
      submission.items = ctx.ordered.map((item) => ({
        key: item.key,
        marker: item.marker,
        status: item.status,
        storyId: item.storyId,
        at: stamp(),
      }));
      submission.status = 'running';
      if (!nonEmptyString(submission.startedAt)) submission.startedAt = stamp();
    });
  }

  async function checkSource(ctx) {
    let result = null;
    let error = null;
    try {
      result = await documents.revalidate(ctx.request.snapshot);
    } catch (caught) {
      error = caught;
    }
    if (error || !isPlainObject(result)) {
      ctx.notes.push('SOURCE_RECHECK_FAILED');
      ctx.paused = true;
      return false;
    }
    if (result.unchanged !== true) {
      ctx.notes.push('SOURCE_CHANGED');
      ctx.paused = true;
      return false;
    }
    return true;
  }

  function parentTargetFor(ctx) {
    return {
      ...ctx.target,
      parent: {
        ...(isPlainObject(ctx.target.parent) ? ctx.target.parent : {}),
        title: ctx.frozen.parent.fields.title,
      },
    };
  }

  function parentFieldsOf(ctx) {
    try {
      return buildParentFields({ request: ctx.request, target: parentTargetFor(ctx), marker: ctx.view.get(PARENT_KEY).marker });
    } catch (error) {
      fail(error?.code === 'INVALID_MARKER' ? 'SUBMISSION_MISMATCH' : 'INVALID_TARGET');
    }
    return null;
  }

  // An explicitly confirmed bind is the only way a document-identity mismatch
  // can pass; the confirmation must name this batch's bind target and come from
  // someone who may review the request.
  function bindOverrideMatches(ctx, storyId) {
    const override = ctx.request.parentBindOverride;
    if (!isPlainObject(override) || override.storyId !== storyId) return false;
    if (!nonEmptyString(override.at)) return false;
    return isAllowedActor(ctx.request, override.actorId);
  }

  async function bindParent(ctx) {
    const storyId = ctx.frozen.parent.storyId;
    let story = null;
    try {
      story = await ctx.read(storyId);
    } catch (error) {
      ctx.notes.push(error?.code === 'NOT_FOUND' ? 'PARENT_NOT_FOUND' : 'READ_FAILED');
      ctx.paused = true;
      return null;
    }
    const sameDocument = descriptionTokens(story?.description).includes(ctx.frozen.documentId);
    if (story?.workspaceId !== ctx.workspaceId || story?.parentId !== '0'
      || (!sameDocument && !bindOverrideMatches(ctx, storyId))) {
      ctx.notes.push('PARENT_MISMATCH');
      ctx.paused = true;
      return null;
    }
    const saved = await patchItem(ctx, PARENT_KEY, { status: 'created', storyId });
    if (!saved) return null;
    ctx.notes.push('PARENT_BOUND');
    return storyId;
  }

  // Resolves the parent without ever posting when `allowCreate` is false. A
  // parent that merely cannot be found is never rebuilt either: posting a second
  // parent is the duplicate-tree failure this task exists to avoid, so creation
  // happens only for a parent that is still provably `pending`.
  async function resolveParent(ctx, { allowCreate }) {
    const parent = ctx.view.get(PARENT_KEY);
    if (parent.status === 'created' && nonEmptyString(parent.storyId)) return parent.storyId;

    if (ctx.frozen.parent.mode === 'bind') return bindParent(ctx);

    const fields = parentFieldsOf(ctx);
    let found = null;
    try {
      found = await ctx.findParents(fields.name);
    } catch {
      ctx.notes.push('READ_FAILED');
      ctx.paused = true;
      return null;
    }
    const items = Array.isArray(found?.items) ? found.items : [];
    if (items.length > 1) {
      ctx.notes.push('PARENT_AMBIGUOUS');
      ctx.paused = true;
      return null;
    }
    if (found?.complete !== true) {
      ctx.notes.push('READ_INCOMPLETE');
      ctx.paused = true;
      return null;
    }
    if (items.length === 1) {
      const storyId = items[0].id;
      if (!nonEmptyString(storyId)) {
        ctx.notes.push('READ_INCOMPLETE');
        ctx.paused = true;
        return null;
      }
      const saved = await patchItem(ctx, PARENT_KEY, { status: 'created', storyId });
      if (!saved) return null;
      ctx.notes.push(allowCreate ? 'PARENT_REUSED' : 'REMOTE_MATCH');
      return storyId;
    }
    if (!allowCreate) {
      ctx.notes.push('NOT_FOUND');
      ctx.paused = true;
      return null;
    }
    if (parent.status !== 'pending') {
      ctx.notes.push('PARENT_UNRESOLVED');
      ctx.paused = true;
      return null;
    }
    return createItem(ctx, PARENT_KEY, fields);
  }

  // Write-before-call, then classify: only REJECTED and UNSENT are proven
  // outcomes; anything else becomes unknown and stops the batch.
  async function createItem(ctx, key, fields) {
    if (!(await patchItem(ctx, key, { status: 'sending' }))) return null;

    let result = null;
    let error = null;
    try {
      result = await ctx.createStory(ctx.workspaceId, fields);
    } catch (caught) {
      error = caught;
    }

    if (error) {
      const status = error.code === 'REJECTED' ? 'rejected'
        : error.code === 'UNSENT' ? 'pending' : 'unknown';
      if (!(await patchItem(ctx, key, { status }))) return null;
      ctx.notes.push(status === 'rejected' ? 'CREATE_REJECTED'
        : status === 'pending' ? 'UNSENT' : 'UNKNOWN_RESULT');
      ctx.paused = true;
      return null;
    }

    const storyId = nonEmptyString(result?.id) ? String(result.id) : '';
    if (storyId === '') {
      await patchItem(ctx, key, { status: 'unknown' });
      ctx.notes.push('UNKNOWN_RESULT');
      ctx.paused = true;
      return null;
    }
    // The remote story exists whether or not the ledger accepted the id, so a
    // failed writeback parks the batch for reconcile instead of re-posting.
    if (!(await patchItem(ctx, key, { status: 'created', storyId }))) return null;
    return storyId;
  }

  // Dependency ids come only from stories this ledger can prove were created —
  // this batch first, then earlier batches of the same request.
  function createdIds(ctx) {
    const ids = new Map();
    for (const submission of Array.isArray(ctx.request.submissions) ? ctx.request.submissions : []) {
      if (!isPlainObject(submission) || submission.id === ctx.batchId) continue;
      for (const item of Array.isArray(submission.items) ? submission.items : []) {
        if (item?.status === 'created' && nonEmptyString(item.storyId) && nonEmptyString(item.key)) {
          ids.set(item.key, item.storyId);
        }
      }
    }
    for (const item of ctx.ordered) {
      if (item.status === 'created' && nonEmptyString(item.storyId)) ids.set(item.key, item.storyId);
    }
    return ids;
  }

  async function blockChild(ctx, key) {
    if (!(await patchItem(ctx, key, { status: 'blocked' }))) return;
    ctx.notes.push('DEPENDENCY_BLOCKED');
    ctx.paused = true;
  }

  async function createChildren(ctx, parentId) {
    const ids = createdIds(ctx);
    for (const story of planOrder(Array.isArray(ctx.frozen.stories) ? ctx.frozen.stories : [])) {
      const item = ctx.view.get(story.key);
      if (item.status === 'created') {
        ids.set(story.key, item.storyId);
        continue;
      }
      if (item.status !== 'pending' && item.status !== 'blocked') continue;

      const dependencies = Array.isArray(story.dependencies) ? story.dependencies : [];
      const dependencyIds = Object.fromEntries(
        dependencies.map((dependency) => [dependency, ids.get(dependency) ?? '']),
      );
      let fields;
      try {
        fields = buildChildFields({
          story: childView(story),
          request: ctx.request,
          target: ctx.target,
          parentId,
          dependencyIds,
          marker: item.marker,
        });
      } catch (error) {
        // Task 7 refuses a dependency without a TAPD id: that child is not ready
        // yet, and building the payload was never attempted.
        if (error?.code === 'INVALID_DEPENDENCY') {
          await blockChild(ctx, story.key);
          return false;
        }
        fail('INVALID_TARGET');
      }

      const storyId = await createItem(ctx, story.key, fields);
      // A null here means either an unproven remote outcome or a created story
      // whose id the ledger rejected; reconcile backfills the latter, so no
      // further post may follow.
      if (storyId === null) return false;
      ids.set(story.key, storyId);
    }
    return true;
  }

  function outcome(ctx) {
    if (ctx.paused) return 'paused';
    return ctx.ordered.every((item) => item.status === 'created') ? 'completed' : 'needs_review';
  }

  async function runSubmit(requestId, batchId) {
    const ctx = wire(locate(requestId, batchId));
    if (!(await normalizeSending(ctx))) return settle(ctx, 'paused');
    if (!(await materialize(ctx))) return settle(ctx, 'paused');
    if (!(await checkSource(ctx))) return settle(ctx, 'paused');

    const parentId = await resolveParent(ctx, { allowCreate: true });
    if (!nonEmptyString(parentId)) return settle(ctx, outcome(ctx));
    if (!(await createChildren(ctx, parentId))) return settle(ctx, outcome(ctx));
    return settle(ctx, outcome(ctx));
  }

  // Read-only against TAPD: an unknown or unwritten id becomes created only from
  // an exact match, and an absent story is left alone rather than rebuilt.
  async function runReconcile(requestId, batchId) {
    const ctx = wire(locate(requestId, batchId));
    if (!(await normalizeSending(ctx))) return settle(ctx, 'paused');

    const parentId = nonEmptyString(ctx.parentStoryId)
      ? ctx.parentStoryId
      : await resolveParent(ctx, { allowCreate: false });
    if (!nonEmptyString(parentId)) {
      ctx.notes.push('PARENT_UNRESOLVED');
      return settle(ctx, outcome(ctx));
    }

    for (const item of ctx.ordered) {
      if (item.key === PARENT_KEY || item.status !== 'unknown') continue;
      let found = null;
      try {
        found = await ctx.findByMarker(item.marker);
      } catch {
        ctx.notes.push('READ_FAILED');
        continue;
      }
      const items = Array.isArray(found?.items) ? found.items : [];
      if (items.length > 1) {
        ctx.notes.push('AMBIGUOUS_MATCH');
        continue;
      }
      if (found?.complete !== true) {
        ctx.notes.push('READ_INCOMPLETE');
        continue;
      }
      if (items.length === 0) {
        ctx.notes.push('NOT_FOUND');
        continue;
      }
      const storyId = items[0].id;
      let story = null;
      try {
        story = await ctx.read(storyId);
      } catch {
        ctx.notes.push('READ_FAILED');
        continue;
      }
      if (story?.workspaceId !== ctx.workspaceId || story?.parentId !== parentId
        || !descriptionTokens(story?.description).includes(item.marker)) {
        ctx.notes.push('AMBIGUOUS_MATCH');
        continue;
      }
      if (!(await patchItem(ctx, item.key, { status: 'created', storyId }))) {
        return settle(ctx, 'paused');
      }
      ctx.notes.push('REMOTE_MATCH');
    }
    return settle(ctx, outcome(ctx));
  }

  // Only proven-safe work continues: pending (UNSENT) and blocked items. Unknown
  // needs reconcile first, and a rejected story needs a new batch.
  async function runResume(requestId, batchId, actorId) {
    const request = store.get(requestId);
    if (!isPlainObject(request)) fail('UNKNOWN_REQUEST');
    if (!isAllowedActor(request, actorId)) fail('NOT_REVIEWER');

    const ctx = wire(locate(requestId, batchId));
    if (!(await normalizeSending(ctx))) return settle(ctx, 'paused');
    if (ctx.ordered.some((item) => item.status === 'unknown')) {
      ctx.notes.push('UNKNOWN_PENDING');
      ctx.paused = true;
      return settle(ctx, 'paused');
    }

    if (!(await checkSource(ctx))) return settle(ctx, 'paused');
    const parentId = await resolveParent(ctx, { allowCreate: true });
    if (!nonEmptyString(parentId)) return settle(ctx, outcome(ctx));
    if (!(await createChildren(ctx, parentId))) return settle(ctx, outcome(ctx));
    return settle(ctx, outcome(ctx));
  }

  return {
    async submit({ requestId, batchId } = {}) {
      return serialize(`${requestId}|${batchId}`, () => runSubmit(requestId, batchId));
    },
    async reconcile({ requestId, batchId } = {}) {
      return serialize(`${requestId}|${batchId}`, () => runReconcile(requestId, batchId));
    },
    async resume({ requestId, batchId, actorId } = {}) {
      return serialize(`${requestId}|${batchId}`, () => runResume(requestId, batchId, actorId));
    },
  };
}
