// Pure domain rules for planning-document requirement drafts: structure and
// coverage validation, submission eligibility, batch freezing and review
// decisions. No filesystem, network or model calls. Freeze time is injected;
// the only clock read is the review-decision timestamp.

import { createHash, randomUUID } from 'node:crypto';

export const MAX_BATCH_STORIES = 50;
export const MAX_TITLE = 200;
export const MAX_FACT_TEXT = 4000;
export const MAX_RULE_TEXT = 2000;
export const MAX_QUESTION = 500;
export const MAX_REASON = 500;
export const MAX_DECISION_TEXT = 2000;
export const MAX_KEY = 64;

const FACT_KINDS = new Set(['source', 'comment', 'decision', 'suggestion']);
const DISPOSITIONS = new Set(['proposed', 'approved', 'deferred', 'excluded']);
const DECISION_TYPES = new Set([
  'approve',
  'defer',
  'exclude',
  'answer',
  'explain-resource',
  'select-fields',
]);
const RESOURCE_ACTIONS = new Set(['explain', 'exclude']);
const STORY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validText(value, limit) {
  return nonEmptyString(value) && value.length <= limit;
}

function validKey(value) {
  return nonEmptyString(value) && value.length <= MAX_KEY;
}

function fail(code, paths = []) {
  const error = new Error(code);
  error.paths = paths;
  throw error;
}

function validateSnapshot(snapshot) {
  if (
    !isPlainObject(snapshot)
    || !Array.isArray(snapshot.blocks)
    || !Array.isArray(snapshot.resources)
    || !Array.isArray(snapshot.comments)
  ) {
    fail('INVALID_SNAPSHOT', ['snapshot']);
  }
}

function validateFacts(draft, snapshot) {
  if (!Array.isArray(draft.facts)) fail('INVALID_FACT', ['facts']);
  const blockIds = new Set(snapshot.blocks.map((block) => block?.id));
  const commentIds = new Set(snapshot.comments.map((comment) => comment?.id));
  const decisionIds = new Set(
    Array.isArray(draft.decisions) ? draft.decisions.map((decision) => decision?.id) : [],
  );
  const seen = new Set();
  draft.facts.forEach((fact, index) => {
    const path = ['facts', index];
    if (!isPlainObject(fact)) fail('INVALID_FACT', path);
    if (!validKey(fact.id)) fail('INVALID_FACT', [...path, 'id']);
    if (seen.has(fact.id)) fail('DUPLICATE_FACT', [fact.id]);
    seen.add(fact.id);
    if (!validText(fact.text, MAX_FACT_TEXT)) fail('INVALID_FACT', [...path, 'text']);
    if (!FACT_KINDS.has(fact.kind)) fail('INVALID_FACT_KIND', [...path, 'kind']);
    if (
      !Array.isArray(fact.sourceIds)
      || fact.sourceIds.length === 0
      || fact.sourceIds.some((sourceId) => !nonEmptyString(sourceId))
    ) {
      fail('INVALID_FACT', [...path, 'sourceIds']);
    }
    let trustedIds;
    let code;
    if (fact.kind === 'source' || fact.kind === 'suggestion') {
      trustedIds = blockIds;
      code = 'UNKNOWN_FACT_SOURCE';
    } else if (fact.kind === 'comment') {
      trustedIds = commentIds;
      code = 'UNKNOWN_FACT_SOURCE';
    } else {
      // Decisions are written by the server from an actor action; a model
      // cannot manufacture a "decision" by pointing at a block or comment.
      trustedIds = decisionIds;
      code = 'UNTRUSTED_DECISION';
    }
    for (const sourceId of fact.sourceIds) {
      if (!trustedIds.has(sourceId)) fail(code, [...path, 'sourceIds', sourceId]);
    }
  });
}

function validateDecisions(draft, actorIds) {
  if (!Array.isArray(draft.decisions)) fail('INVALID_DECISION', ['decisions']);
  const seen = new Set();
  draft.decisions.forEach((decision, index) => {
    const path = ['decisions', index];
    if (!isPlainObject(decision)) fail('INVALID_DECISION', path);
    if (!validKey(decision.id)) fail('INVALID_DECISION', [...path, 'id']);
    if (seen.has(decision.id)) fail('INVALID_DECISION', [decision.id]);
    seen.add(decision.id);
    if (!actorIds.has(decision.actorId)) fail('UNKNOWN_ACTOR', [...path, 'actorId']);
    if (!validText(decision.text, MAX_DECISION_TEXT)) fail('INVALID_DECISION', [...path, 'text']);
    if (!Array.isArray(decision.sourceIds) || decision.sourceIds.some((id) => typeof id !== 'string')) {
      fail('INVALID_DECISION', [...path, 'sourceIds']);
    }
  });
}

function validateRuleItems(items, factIds, basePath, field) {
  items.forEach((item, index) => {
    const path = [...basePath, field, index];
    if (!isPlainObject(item)) fail('INVALID_STORY', path);
    if (!validText(item.text, MAX_RULE_TEXT)) fail('INVALID_STORY', [...path, 'text']);
    if (!Array.isArray(item.factIds) || item.factIds.length === 0) {
      fail('INVALID_STORY', [...path, 'factIds']);
    }
    for (const factId of item.factIds) {
      if (!nonEmptyString(factId) || !factIds.has(factId)) {
        fail('UNKNOWN_FACT', [...path, 'factIds', String(factId)]);
      }
    }
  });
}

function findDependencyCycle(stories) {
  const byKey = new Map(stories.map((story) => [story.key, story]));
  const visiting = new Set();
  const done = new Set();
  const stack = [];
  const visit = (key) => {
    if (visiting.has(key)) return [...stack.slice(stack.indexOf(key)), key];
    if (done.has(key) || !byKey.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const dependency of byKey.get(key).dependencies) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    done.add(key);
    return null;
  };
  for (const story of stories) {
    const cycle = visit(story.key);
    if (cycle) return cycle;
  }
  return null;
}

function validateStories(draft, factIds) {
  if (!Array.isArray(draft.stories)) fail('INVALID_STORY', ['stories']);
  const issueIds = new Set(
    Array.isArray(draft.issues) ? draft.issues.map((issue) => issue?.id) : [],
  );
  const allKeys = new Set(draft.stories.map((story) => story?.key));
  const seen = new Set();
  draft.stories.forEach((story, index) => {
    const path = ['stories', index];
    if (!isPlainObject(story)) fail('INVALID_STORY', path);
    if (!nonEmptyString(story.key) || !STORY_KEY.test(story.key)) {
      fail('INVALID_STORY', [...path, 'key']);
    }
    if (seen.has(story.key)) fail('DUPLICATE_STORY_KEY', [story.key]);
    seen.add(story.key);
    if (!validText(story.title, MAX_TITLE)) fail('INVALID_STORY', [...path, 'title']);
    if (!DISPOSITIONS.has(story.disposition)) {
      fail('INVALID_DISPOSITION', [...path, 'disposition']);
    }
    if (!Array.isArray(story.factIds) || story.factIds.length === 0) {
      fail('INVALID_STORY', [...path, 'factIds']);
    }
    for (const factId of story.factIds) {
      if (!nonEmptyString(factId) || !factIds.has(factId)) {
        fail('UNKNOWN_FACT', [...path, 'factIds', String(factId)]);
      }
    }
    if (
      !Array.isArray(story.sourceIds)
      || story.sourceIds.some((sourceId) => typeof sourceId !== 'string')
    ) {
      fail('INVALID_STORY', [...path, 'sourceIds']);
    }
    if (!Array.isArray(story.issueIds)) fail('INVALID_STORY', [...path, 'issueIds']);
    for (const issueId of story.issueIds) {
      if (!nonEmptyString(issueId) || !issueIds.has(issueId)) {
        fail('UNKNOWN_ISSUE', [...path, 'issueIds', String(issueId)]);
      }
    }
    if (story.owner !== null && !validKey(story.owner)) {
      fail('INVALID_STORY', [...path, 'owner']);
    }
    if (!Array.isArray(story.rules) || story.rules.length === 0) {
      fail('MISSING_RULE', [...path, 'rules']);
    }
    validateRuleItems(story.rules, factIds, path, 'rules');
    if (!Array.isArray(story.acceptance) || story.acceptance.length === 0) {
      fail('MISSING_ACCEPTANCE', [...path, 'acceptance']);
    }
    validateRuleItems(story.acceptance, factIds, path, 'acceptance');
    if (!Array.isArray(story.dependencies)) {
      fail('INVALID_STORY', [...path, 'dependencies']);
    }
    for (const dependency of story.dependencies) {
      if (dependency === story.key) {
        fail('SELF_DEPENDENCY', [...path, 'dependencies', dependency]);
      }
      if (!nonEmptyString(dependency) || !allKeys.has(dependency)) {
        fail('UNKNOWN_DEPENDENCY', [...path, 'dependencies', String(dependency)]);
      }
    }
  });
  const cycle = findDependencyCycle(draft.stories);
  if (cycle) fail('DEPENDENCY_CYCLE', cycle);
}

function validateIssues(draft, actorIds) {
  if (!Array.isArray(draft.issues)) fail('INVALID_ISSUE', ['issues']);
  const storyKeys = new Set(
    Array.isArray(draft.stories) ? draft.stories.map((story) => story?.key) : [],
  );
  const seen = new Set();
  draft.issues.forEach((issue, index) => {
    const path = ['issues', index];
    if (!isPlainObject(issue)) fail('INVALID_ISSUE', path);
    if (!validKey(issue.id)) fail('INVALID_ISSUE', [...path, 'id']);
    if (seen.has(issue.id)) fail('INVALID_ISSUE', [issue.id]);
    seen.add(issue.id);
    if (!validText(issue.question, MAX_QUESTION)) {
      fail('INVALID_ISSUE', [...path, 'question']);
    }
    if (!Array.isArray(issue.storyKeys) || issue.storyKeys.length === 0) {
      fail('INVALID_ISSUE', [...path, 'storyKeys']);
    }
    for (const key of issue.storyKeys) {
      if (!nonEmptyString(key) || !storyKeys.has(key)) {
        fail('UNKNOWN_STORY', [...path, 'storyKeys', String(key)]);
      }
    }
    if (typeof issue.blocking !== 'boolean') fail('INVALID_ISSUE', [...path, 'blocking']);
    if (issue.resolvedBy !== null) {
      if (!isPlainObject(issue.resolvedBy)) {
        fail('INVALID_ISSUE', [...path, 'resolvedBy']);
      }
      if (!actorIds.has(issue.resolvedBy.actorId)) {
        fail('UNKNOWN_ACTOR', [...path, 'resolvedBy', 'actorId']);
      }
      if (!validText(issue.resolvedBy.text, MAX_DECISION_TEXT)) {
        fail('INVALID_ISSUE', [...path, 'resolvedBy', 'text']);
      }
      if (typeof issue.resolvedBy.at !== 'string') {
        fail('INVALID_ISSUE', [...path, 'resolvedBy', 'at']);
      }
    }
  });
}

function validateExclusions(draft, factIds, actorIds) {
  if (!Array.isArray(draft.exclusions)) fail('INVALID_EXCLUSION', ['exclusions']);
  draft.exclusions.forEach((exclusion, index) => {
    const path = ['exclusions', index];
    if (!isPlainObject(exclusion)) fail('INVALID_EXCLUSION', path);
    if (!Array.isArray(exclusion.factIds) || exclusion.factIds.length === 0) {
      fail('INVALID_EXCLUSION', [...path, 'factIds']);
    }
    for (const factId of exclusion.factIds) {
      if (!nonEmptyString(factId) || !factIds.has(factId)) {
        fail('UNKNOWN_FACT', [...path, 'factIds', String(factId)]);
      }
    }
    if (!validText(exclusion.reason, MAX_REASON)) {
      fail('INVALID_EXCLUSION', [...path, 'reason']);
    }
    if (!actorIds.has(exclusion.approvedBy)) {
      fail('UNKNOWN_ACTOR', [...path, 'approvedBy']);
    }
  });
}

function validateCoverage(draft) {
  const accounted = new Set();
  for (const story of draft.stories) {
    // Deferred stories still own their facts: a blocking question may delay a
    // story but must not make its source requirement silently disappear.
    if (story.disposition === 'excluded') continue;
    for (const factId of story.factIds) accounted.add(factId);
  }
  for (const exclusion of draft.exclusions) {
    for (const factId of exclusion.factIds) accounted.add(factId);
  }
  const missing = draft.facts
    .filter((fact) => !accounted.has(fact.id))
    .map((fact) => fact.id);
  if (missing.length > 0) fail('UNCOVERED_FACT', missing);
}

export function validateDraft({ draft, snapshot, actorIds } = {}) {
  if (!isPlainObject(draft) || !Number.isInteger(draft.version) || draft.version <= 0) {
    fail('INVALID_VERSION', ['version']);
  }
  validateSnapshot(snapshot);
  const actors = new Set(Array.isArray(actorIds) ? actorIds : []);
  validateFacts(draft, snapshot);
  validateDecisions(draft, actors);
  const factIds = new Set(draft.facts.map((fact) => fact.id));
  validateStories(draft, factIds);
  validateIssues(draft, actors);
  validateExclusions(draft, factIds, actors);
  validateCoverage(draft);
  return draft;
}

function toKeySet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

export function submissionEligibility({ draft, snapshot, selectedKeys, createdKeys } = {}) {
  if (!Array.isArray(selectedKeys) || selectedKeys.length === 0) {
    return { allowed: false, blockers: [{ code: 'EMPTY_SELECTION' }] };
  }

  const blockers = [];
  const seen = new Set();
  for (const key of selectedKeys) {
    if (seen.has(key)) blockers.push({ code: 'DUPLICATE_SELECTION', key });
    seen.add(key);
  }
  if (selectedKeys.length > MAX_BATCH_STORIES) blockers.push({ code: 'BATCH_LIMIT' });

  const stories = Array.isArray(draft?.stories) ? draft.stories : [];
  const byKey = new Map(stories.map((story) => [story.key, story]));
  const selectedSet = new Set(selectedKeys);
  const createdSet = toKeySet(createdKeys);
  const pendingResources = new Set(
    (Array.isArray(snapshot?.resources) ? snapshot.resources : [])
      .filter((resource) => resource?.status === 'pending')
      .map((resource) => resource.id),
  );
  const decidedResources = new Set(
    (Array.isArray(draft?.resourceDecisions) ? draft.resourceDecisions : [])
      .filter((decision) => decision?.action === 'explain' || decision?.action === 'exclude')
      .map((decision) => decision.resourceId),
  );
  const approvedSuggestionIds = new Set(
    (Array.isArray(draft?.decisions) ? draft.decisions : [])
      .flatMap((decision) => (Array.isArray(decision?.sourceIds) ? decision.sourceIds : [])),
  );
  const suggestionFactIds = new Set(
    (Array.isArray(draft?.facts) ? draft.facts : [])
      .filter((fact) => fact?.kind === 'suggestion')
      .map((fact) => fact.id),
  );
  const issues = Array.isArray(draft?.issues) ? draft.issues : [];

  for (const key of selectedKeys) {
    const story = byKey.get(key);
    if (!story) {
      blockers.push({ code: 'UNKNOWN_STORY', key });
      continue;
    }
    if (createdSet.has(key)) blockers.push({ code: 'ALREADY_CREATED', key });
    if (story.disposition !== 'approved') blockers.push({ code: 'NOT_APPROVED', key });
    const openIssue = issues.some(
      (issue) => issue?.blocking === true
        && issue.resolvedBy == null
        && Array.isArray(issue.storyKeys)
        && issue.storyKeys.includes(key),
    );
    if (openIssue) blockers.push({ code: 'OPEN_BLOCKING_ISSUE', key });
    const sourceIds = Array.isArray(story.sourceIds) ? story.sourceIds : [];
    // Only direct references block: a pending video must not stall unrelated
    // stories through a shared block mapping.
    const unreadResource = sourceIds.some(
      (sourceId) => pendingResources.has(sourceId) && !decidedResources.has(sourceId),
    );
    if (unreadResource) blockers.push({ code: 'UNREAD_RESOURCE', key });
    for (const dependency of Array.isArray(story.dependencies) ? story.dependencies : []) {
      if (!selectedSet.has(dependency) && !createdSet.has(dependency)) {
        blockers.push({ code: 'UNSATISFIED_DEPENDENCY', key, dependency });
      }
    }
    const unapprovedSuggestion = (Array.isArray(story.factIds) ? story.factIds : [])
      .some((factId) => suggestionFactIds.has(factId) && !approvedSuggestionIds.has(factId));
    if (unapprovedSuggestion) blockers.push({ code: 'UNAPPROVED_SUGGESTION', key });
  }

  return { allowed: blockers.length === 0, blockers };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isAllowedActor(request, actorId) {
  if (!isPlainObject(request) || !nonEmptyString(actorId)) return false;
  if (request.initiatorId === actorId) return true;
  return Array.isArray(request.reviewerIds) && request.reviewerIds.includes(actorId);
}

export function freezeBatch({ request, selectedKeys, target, actorId, now, batchId } = {}) {
  if (!isAllowedActor(request, actorId)) fail('NOT_REVIEWER');
  if (!nonEmptyString(batchId)) fail('INVALID_BATCH_INPUT', ['batchId']);
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (
    (typeof now !== 'string' && typeof now !== 'number' && !(now instanceof Date))
    || Number.isNaN(date.getTime())
  ) {
    fail('INVALID_BATCH_INPUT', ['now']);
  }

  if (!isPlainObject(target) || !nonEmptyString(target.workspaceId)) {
    fail('INVALID_TARGET', ['workspaceId']);
  }
  if (!isPlainObject(target.parent)) fail('INVALID_TARGET', ['parent']);
  if (target.parent.mode !== 'create' && target.parent.mode !== 'bind') {
    fail('INVALID_TARGET', ['parent', 'mode']);
  }
  if (target.parent.mode === 'bind' && !nonEmptyString(target.parent.storyId)) {
    fail('INVALID_TARGET', ['parent', 'storyId']);
  }
  const childDefaults = target.childDefaults ?? {};
  if (!isPlainObject(childDefaults)) fail('INVALID_TARGET', ['childDefaults']);

  let parent;
  if (target.parent.mode === 'bind') {
    parent = { mode: 'bind', storyId: target.parent.storyId };
  } else {
    const title = nonEmptyString(target.parent.title)
      ? target.parent.title
      : request.snapshot?.title;
    if (!nonEmptyString(title)) fail('INVALID_TARGET', ['parent', 'title']);
    // Only trusted target/snapshot values become the parent title; the model
    // draft never supplies target fields.
    parent = { mode: 'create', fields: { title } };
  }

  if (
    nonEmptyString(request.parentStoryId)
    && (parent.mode !== 'bind' || parent.storyId !== request.parentStoryId)
  ) {
    fail('PARENT_MISMATCH', ['parentStoryId']);
  }

  const createdKeys = new Set();
  for (const submission of Array.isArray(request.submissions) ? request.submissions : []) {
    for (const item of Array.isArray(submission?.items) ? submission.items : []) {
      if (item?.status === 'created' && nonEmptyString(item.key)) createdKeys.add(item.key);
    }
  }

  const { allowed, blockers } = submissionEligibility({
    draft: request.draft,
    snapshot: request.snapshot,
    selectedKeys,
    createdKeys,
  });
  if (!allowed) {
    const error = new Error('SUBMISSION_BLOCKED');
    error.paths = [];
    error.blockers = blockers;
    throw error;
  }

  const selectedSet = toKeySet(selectedKeys);
  const stories = [...request.draft.stories]
    .filter((story) => selectedSet.has(story.key))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((story) => ({
      key: story.key,
      fields: {
        title: story.title,
        rules: story.rules,
        acceptance: story.acceptance,
        factIds: story.factIds,
        sourceIds: story.sourceIds,
        issueIds: story.issueIds,
        owner: story.owner ?? childDefaults.owner ?? null,
        iterationId: childDefaults.iterationId ?? null,
      },
      dependencies: [...story.dependencies],
    }));

  const frozen = structuredClone({
    id: batchId,
    requestId: request.id,
    draftVersion: request.draft.version,
    workspaceId: target.workspaceId,
    documentId: request.snapshot.documentId,
    sourceFingerprint: request.snapshot.fingerprint,
    parent,
    stories,
    actorId,
    approvedAt: date.toISOString(),
  });
  frozen.payloadHash = createHash('sha256')
    .update(canonicalJson({
      draftVersion: frozen.draftVersion,
      workspaceId: frozen.workspaceId,
      documentId: frozen.documentId,
      sourceFingerprint: frozen.sourceFingerprint,
      parent: frozen.parent,
      stories: frozen.stories,
    }))
    .digest('hex');
  return frozen;
}

function pickStories(draft, storyKeys) {
  if (!Array.isArray(storyKeys) || storyKeys.length === 0) {
    fail('UNKNOWN_STORY', ['storyKeys']);
  }
  const stories = Array.isArray(draft.stories) ? draft.stories : [];
  return storyKeys.map((key) => {
    const story = stories.find((candidate) => candidate?.key === key);
    if (!story) fail('UNKNOWN_STORY', [String(key)]);
    return story;
  });
}

function optionalDecisionText(decision, fallback) {
  if (decision.text === undefined) return fallback.slice(0, MAX_DECISION_TEXT);
  if (!validText(decision.text, MAX_DECISION_TEXT)) fail('INVALID_DECISION', ['text']);
  return decision.text;
}

function suggestionFactIds(draft, stories) {
  const suggestions = new Set(
    (Array.isArray(draft.facts) ? draft.facts : [])
      .filter((fact) => fact?.kind === 'suggestion')
      .map((fact) => fact.id),
  );
  const ids = [];
  for (const story of stories) {
    for (const factId of Array.isArray(story.factIds) ? story.factIds : []) {
      if (suggestions.has(factId) && !ids.includes(factId)) ids.push(factId);
    }
  }
  return ids;
}

function appendDecision(draft, { actorId, text, sourceIds }) {
  draft.decisions.push({ id: randomUUID(), actorId, text, sourceIds });
}

export function applyReviewDecision({ request, actorId, decision } = {}) {
  if (!isAllowedActor(request, actorId)) fail('NOT_REVIEWER');
  if (!isPlainObject(decision) || !DECISION_TYPES.has(decision.type)) {
    fail('UNKNOWN_DECISION', ['type']);
  }

  const updated = structuredClone(request);
  const draft = updated.draft;
  const at = new Date().toISOString();

  switch (decision.type) {
    case 'approve':
    case 'defer':
    case 'exclude': {
      const stories = pickStories(draft, decision.storyKeys);
      if (decision.type === 'exclude' && !validText(decision.reason, MAX_REASON)) {
        fail('INVALID_DECISION', ['reason']);
      }
      const text = optionalDecisionText(decision, `${decision.type}: ${decision.storyKeys.join(', ')}`);
      const disposition = decision.type === 'approve'
        ? 'approved'
        : decision.type === 'defer'
          ? 'deferred'
          : 'excluded';
      for (const story of stories) story.disposition = disposition;
      if (decision.type === 'exclude') {
        const already = new Set(draft.exclusions.flatMap((exclusion) => exclusion.factIds));
        const added = [];
        for (const story of stories) {
          for (const factId of story.factIds) {
            if (!already.has(factId) && !added.includes(factId)) added.push(factId);
          }
        }
        if (added.length > 0) {
          draft.exclusions.push({ factIds: added, reason: decision.reason, approvedBy: actorId });
        }
      }
      appendDecision(draft, { actorId, text, sourceIds: suggestionFactIds(draft, stories) });
      break;
    }
    case 'answer': {
      const issue = (Array.isArray(draft.issues) ? draft.issues : [])
        .find((candidate) => candidate?.id === decision.issueId);
      if (!issue) fail('UNKNOWN_ISSUE', [String(decision.issueId)]);
      if (!validText(decision.text, MAX_DECISION_TEXT)) fail('INVALID_DECISION', ['text']);
      issue.resolvedBy = { actorId, text: decision.text, at };
      appendDecision(draft, { actorId, text: decision.text, sourceIds: [issue.id] });
      break;
    }
    case 'explain-resource': {
      const resources = Array.isArray(updated.snapshot?.resources) ? updated.snapshot.resources : [];
      if (!resources.some((resource) => resource?.id === decision.resourceId)) {
        fail('UNKNOWN_RESOURCE', [String(decision.resourceId)]);
      }
      if (!RESOURCE_ACTIONS.has(decision.action)) fail('INVALID_DECISION', ['action']);
      if (!validText(decision.text, MAX_DECISION_TEXT)) fail('INVALID_DECISION', ['text']);
      draft.resourceDecisions.push({
        resourceId: decision.resourceId,
        action: decision.action,
        text: decision.text,
        actorId,
        at,
      });
      break;
    }
    case 'select-fields': {
      const [story] = pickStories(draft, [decision.storyKey]);
      if (decision.owner !== null && !validKey(decision.owner)) {
        fail('INVALID_DECISION', ['owner']);
      }
      story.owner = decision.owner;
      appendDecision(draft, {
        actorId,
        text: optionalDecisionText(decision, `select-fields: ${story.key}`),
        sourceIds: [],
      });
      break;
    }
    default:
      // DECISION_TYPES already narrowed the switch; kept for exhaustiveness.
      fail('UNKNOWN_DECISION', ['type']);
  }

  draft.version += 1;
  return updated;
}
