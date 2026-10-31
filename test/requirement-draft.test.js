import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATCH_STORIES,
  MAX_DECISION_TEXT,
  MAX_FACT_TEXT,
  MAX_KEY,
  MAX_QUESTION,
  MAX_REASON,
  MAX_RULE_TEXT,
  MAX_TITLE,
  applyReviewDecision,
  freezeBatch,
  submissionEligibility,
  validateDraft,
} from '../src/requirement-draft.js';
import { makeSnapshot, makeDraft, makeRequest } from './requirement-fixtures.js';

const ACTORS = ['ou_reviewer'];

function validate(draft, snapshot = makeSnapshot()) {
  return validateDraft({ draft, snapshot, actorIds: ACTORS });
}

function makeStory(key, factIds, overrides = {}) {
  return {
    key,
    title: `${key} 标题`,
    rules: [{ text: `${key} 规则`, factIds }],
    acceptance: [{ text: `${key} 验收`, factIds }],
    sourceIds: [],
    factIds,
    dependencies: [],
    issueIds: [],
    owner: null,
    disposition: 'approved',
    ...overrides,
  };
}

test('rejects an uncovered source requirement', () => {
  const draft = makeDraft();
  draft.stories[0].factIds = ['F1'];
  assert.throws(
    () => validateDraft({ draft, snapshot: makeSnapshot(), actorIds: ['ou_test'] }),
    { message: 'UNCOVERED_FACT' },
  );
});

test('reports every uncovered fact id in paths', () => {
  const draft = makeDraft();
  draft.facts.push({ id: 'F3', sourceIds: ['b_m01'], text: '额外事实', kind: 'source' });
  try {
    validate(draft);
    assert.fail('expected UNCOVERED_FACT');
  } catch (error) {
    assert.equal(error.message, 'UNCOVERED_FACT');
    assert.deepEqual(error.paths, ['F3']);
  }
});

test('an explicit exclusion accounts for a fact', () => {
  const draft = makeDraft();
  draft.stories[0].factIds = ['F1'];
  draft.exclusions = [{ factIds: ['F2'], reason: '示例数值，本期不承诺', approvedBy: 'ou_reviewer' }];
  assert.equal(validate(draft), draft);
});

test('a deferred story still accounts for its facts', () => {
  const draft = makeDraft();
  draft.stories[0].disposition = 'deferred';
  assert.equal(validate(draft), draft);
});

test('an excluded story without an exclusion entry does not account for facts', () => {
  const draft = makeDraft();
  draft.stories[0].disposition = 'excluded';
  assert.throws(() => validate(draft), { message: 'UNCOVERED_FACT' });
});

test('rejects self dependencies', () => {
  const draft = makeDraft();
  draft.stories[0].dependencies = ['M01'];
  assert.throws(() => validate(draft), { message: 'SELF_DEPENDENCY' });
});

test('rejects dependencies on unknown stories', () => {
  const draft = makeDraft();
  draft.stories[0].dependencies = ['M99'];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_DEPENDENCY' });
});

test('detects a dependency cycle across two stories', () => {
  const draft = makeDraft();
  draft.stories = [
    makeStory('M01', ['F1'], { dependencies: ['M02'] }),
    makeStory('M02', ['F2'], { dependencies: ['M01'] }),
  ];
  assert.throws(() => validate(draft), { message: 'DEPENDENCY_CYCLE' });
});

test('accepts a valid dependency chain', () => {
  const draft = makeDraft();
  draft.stories = [
    makeStory('M01', ['F1']),
    makeStory('M02', ['F2'], { dependencies: ['M01'] }),
  ];
  assert.equal(validate(draft), draft);
});

test('rule items must reference existing facts', () => {
  const draft = makeDraft();
  draft.stories[0].rules = [{ text: '规则', factIds: ['F9'] }];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_FACT' });
});

test('acceptance items must reference existing facts', () => {
  const draft = makeDraft();
  draft.stories[0].acceptance = [{ text: '验收', factIds: ['F9'] }];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_FACT' });
});

test('a source fact must point at snapshot blocks', () => {
  const draft = makeDraft();
  draft.facts[0].sourceIds = ['b_missing'];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_FACT_SOURCE' });
});

test('a comment fact must point at snapshot comments, not blocks', () => {
  const draft = makeDraft();
  draft.facts[0] = { id: 'F1', sourceIds: ['b_m01'], text: '评论补充', kind: 'comment' };
  assert.throws(() => validate(draft), { message: 'UNKNOWN_FACT_SOURCE' });
});

test('a decision fact must point at server-written decisions', () => {
  const draft = makeDraft();
  draft.facts.push({ id: 'F3', sourceIds: ['D9'], text: '决定', kind: 'decision' });
  draft.stories[0].factIds.push('F3');
  assert.throws(() => validate(draft), { message: 'UNTRUSTED_DECISION' });
});

test('a decision fact backed by a decision record is trusted', () => {
  const draft = makeDraft();
  draft.decisions = [{ id: 'D1', actorId: 'ou_reviewer', text: '确认范围', sourceIds: [] }];
  draft.facts.push({ id: 'F3', sourceIds: ['D1'], text: '决定', kind: 'decision' });
  draft.stories[0].factIds.push('F3');
  assert.equal(validate(draft), draft);
});

test('rejects decisions written by actors outside the request', () => {
  const draft = makeDraft();
  draft.decisions = [{ id: 'D1', actorId: 'ou_stranger', text: '确认范围', sourceIds: [] }];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_ACTOR' });
});

test('rejects an invalid disposition', () => {
  const draft = makeDraft();
  draft.stories[0].disposition = 'done';
  assert.throws(() => validate(draft), { message: 'INVALID_DISPOSITION' });
});

test('requires at least one rule', () => {
  const draft = makeDraft();
  draft.stories[0].rules = [];
  assert.throws(() => validate(draft), { message: 'MISSING_RULE' });
});

test('requires at least one acceptance condition', () => {
  const draft = makeDraft();
  draft.stories[0].acceptance = [];
  assert.throws(() => validate(draft), { message: 'MISSING_ACCEPTANCE' });
});

test('rejects an unknown issue reference from a story', () => {
  const draft = makeDraft();
  draft.stories[0].issueIds = ['I9'];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_ISSUE' });
});

test('rejects duplicate fact and story identifiers', () => {
  const duplicatedFact = makeDraft();
  duplicatedFact.facts.push({ ...duplicatedFact.facts[0] });
  assert.throws(() => validate(duplicatedFact), { message: 'DUPLICATE_FACT' });

  const duplicatedStory = makeDraft();
  duplicatedStory.stories.push(makeStory('M01', ['F2']));
  assert.throws(() => validate(duplicatedStory), { message: 'DUPLICATE_STORY_KEY' });
});

test('rejects a draft without a positive integer version or usable snapshot', () => {
  assert.throws(() => validate({ ...makeDraft(), version: 0 }), { message: 'INVALID_VERSION' });
  assert.throws(() => validate({ ...makeDraft(), version: '1' }), { message: 'INVALID_VERSION' });
  assert.throws(
    () => validate(makeDraft(), { ...makeSnapshot(), blocks: 'nope' }),
    { message: 'INVALID_SNAPSHOT' },
  );
});

test('rejects facts whose text or identifiers exceed the shared limits', () => {
  const longText = 'x'.repeat(MAX_FACT_TEXT + 1);
  const draft = makeDraft();
  draft.facts[0].text = longText;
  assert.throws(() => validate(draft), { message: 'INVALID_FACT' });

  const longId = 'F'.repeat(MAX_KEY + 1);
  const second = makeDraft();
  second.facts[0].id = longId;
  assert.throws(() => validate(second), { message: 'INVALID_FACT' });

  const longTitle = 'x'.repeat(MAX_TITLE + 1);
  const third = makeDraft();
  third.stories[0].title = longTitle;
  assert.throws(() => validate(third), { message: 'INVALID_STORY' });

  const longRule = 'x'.repeat(MAX_RULE_TEXT + 1);
  const fourth = makeDraft();
  fourth.stories[0].rules[0].text = longRule;
  assert.throws(() => validate(fourth), { message: 'INVALID_STORY' });
});

test('rejects issues and exclusions outside their shared limits and actors', () => {
  const longQuestion = makeDraft();
  longQuestion.issues = [{
    id: 'I1',
    question: 'x'.repeat(MAX_QUESTION + 1),
    storyKeys: ['M01'],
    blocking: false,
    resolvedBy: null,
  }];
  assert.throws(() => validate(longQuestion), { message: 'INVALID_ISSUE' });

  const unknownIssueStory = makeDraft();
  unknownIssueStory.issues = [{
    id: 'I1',
    question: '奖励如何发放？',
    storyKeys: ['M99'],
    blocking: false,
    resolvedBy: null,
  }];
  assert.throws(() => validate(unknownIssueStory), { message: 'UNKNOWN_STORY' });

  const badExclusion = makeDraft();
  badExclusion.exclusions = [{
    factIds: ['F2'],
    reason: 'x'.repeat(MAX_REASON + 1),
    approvedBy: 'ou_reviewer',
  }];
  assert.throws(() => validate(badExclusion), { message: 'INVALID_EXCLUSION' });

  const unknownApprover = makeDraft();
  unknownApprover.exclusions = [{ factIds: ['F2'], reason: '排除', approvedBy: 'ou_stranger' }];
  assert.throws(() => validate(unknownApprover), { message: 'UNKNOWN_ACTOR' });
});

test('rejects decision text beyond the shared limit', () => {
  const draft = makeDraft();
  draft.decisions = [{
    id: 'D1',
    actorId: 'ou_reviewer',
    text: 'x'.repeat(MAX_DECISION_TEXT + 1),
    sourceIds: [],
  }];
  assert.throws(() => validate(draft), { message: 'INVALID_DECISION' });
});

function approvedDraft() {
  const draft = makeDraft();
  draft.stories[0].disposition = 'approved';
  return draft;
}

function twoStoryDraft() {
  const draft = makeDraft();
  draft.stories = [
    makeStory('M01', ['F1'], { sourceIds: ['b_m01', 'r_img', 'c_1'] }),
    makeStory('M02', ['F2'], { sourceIds: ['b_m02', 'r_video'], dependencies: ['M01'] }),
  ];
  return draft;
}

function eligibility(draft, selectedKeys, createdKeys = []) {
  return submissionEligibility({ draft, snapshot: makeSnapshot(), selectedKeys, createdKeys });
}

test('submission requires every selected story to be approved', () => {
  assert.deepEqual(eligibility(makeDraft(), ['M01']), {
    allowed: false,
    blockers: [{ code: 'NOT_APPROVED', key: 'M01' }],
  });
  assert.deepEqual(eligibility(approvedDraft(), ['M01']), { allowed: true, blockers: [] });
});

test('empty and non-array selections are blocked without further checks', () => {
  assert.deepEqual(eligibility(approvedDraft(), []), {
    allowed: false,
    blockers: [{ code: 'EMPTY_SELECTION' }],
  });
  assert.deepEqual(eligibility(approvedDraft(), undefined), {
    allowed: false,
    blockers: [{ code: 'EMPTY_SELECTION' }],
  });
});

test('duplicate and unknown selections are all reported', () => {
  assert.deepEqual(eligibility(approvedDraft(), ['M01', 'M01']), {
    allowed: false,
    blockers: [{ code: 'DUPLICATE_SELECTION', key: 'M01' }],
  });
  assert.deepEqual(eligibility(approvedDraft(), ['M99']), {
    allowed: false,
    blockers: [{ code: 'UNKNOWN_STORY', key: 'M99' }],
  });
});

test('more than the batch limit stories are rejected using the exported limit', () => {
  const keys = Array.from({ length: MAX_BATCH_STORIES + 1 }, (_, index) => `K${index}`);
  const result = eligibility(approvedDraft(), keys);
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers.find((blocker) => blocker.code === 'BATCH_LIMIT'), {
    code: 'BATCH_LIMIT',
  });
});

test('an unresolved blocking issue blocks only its stories', () => {
  const draft = approvedDraft();
  draft.issues = [{
    id: 'I1',
    question: '排名是实时还是结算时判定？',
    storyKeys: ['M01'],
    blocking: true,
    resolvedBy: null,
  }];
  assert.deepEqual(eligibility(draft, ['M01']), {
    allowed: false,
    blockers: [{ code: 'OPEN_BLOCKING_ISSUE', key: 'M01' }],
  });

  draft.issues[0].resolvedBy = { actorId: 'ou_reviewer', text: '结算时判定', at: '2026-10-30T00:00:00.000Z' };
  assert.deepEqual(eligibility(draft, ['M01']), { allowed: true, blockers: [] });
});

test('a pending resource blocks only stories that reference it directly', () => {
  const draft = twoStoryDraft();
  assert.deepEqual(eligibility(draft, ['M01']), { allowed: true, blockers: [] });
  assert.deepEqual(eligibility(draft, ['M01', 'M02']), {
    allowed: false,
    blockers: [{ code: 'UNREAD_RESOURCE', key: 'M02' }],
  });

  draft.resourceDecisions = [{
    resourceId: 'r_video',
    action: 'explain',
    text: '视频内容为活动周期说明',
    actorId: 'ou_reviewer',
    at: '2026-10-30T00:00:00.000Z',
  }];
  assert.deepEqual(eligibility(draft, ['M01', 'M02']), { allowed: true, blockers: [] });
});

test('dependencies must be selected or already created', () => {
  const draft = makeDraft();
  draft.stories = [
    makeStory('M01', ['F1']),
    makeStory('M02', ['F2'], { dependencies: ['M01'] }),
  ];
  assert.deepEqual(eligibility(draft, ['M02']), {
    allowed: false,
    blockers: [{ code: 'UNSATISFIED_DEPENDENCY', key: 'M02', dependency: 'M01' }],
  });
  assert.deepEqual(eligibility(draft, ['M01', 'M02']), { allowed: true, blockers: [] });
  assert.deepEqual(eligibility(draft, ['M02'], ['M01']), { allowed: true, blockers: [] });
});

test('already-created stories are reported as such', () => {
  assert.deepEqual(eligibility(approvedDraft(), ['M01'], ['M01']), {
    allowed: false,
    blockers: [{ code: 'ALREADY_CREATED', key: 'M01' }],
  });
});

test('suggestion facts need a server-written decision before submission', () => {
  const draft = approvedDraft();
  draft.facts.push({
    id: 'F3',
    sourceIds: ['b_m01'],
    text: '建议增加排行榜展示',
    kind: 'suggestion',
  });
  draft.stories[0].factIds.push('F3');
  assert.deepEqual(eligibility(draft, ['M01']), {
    allowed: false,
    blockers: [{ code: 'UNAPPROVED_SUGGESTION', key: 'M01' }],
  });

  draft.decisions = [{
    id: 'D1',
    actorId: 'ou_reviewer',
    text: '确认采纳排行榜建议',
    sourceIds: ['F3'],
  }];
  assert.deepEqual(eligibility(draft, ['M01']), { allowed: true, blockers: [] });
});

function freezeTarget(overrides = {}) {
  return {
    workspaceId: 'ws_weapon',
    parent: { mode: 'create', title: '勋章挑战系统' },
    childDefaults: { owner: 'ou_owner', iterationId: 'iter_1' },
    ...overrides,
  };
}

function freeze(request, selectedKeys = ['M01'], target = freezeTarget()) {
  return freezeBatch({
    request,
    selectedKeys,
    target,
    actorId: 'ou_reviewer',
    now: '2026-10-30T00:00:00.000Z',
    batchId: 'batch_1',
  });
}

test('freezes the selected stories with trusted target fields', () => {
  const draft = approvedDraft();
  const frozen = freeze(makeRequest({ draft }));
  assert.equal(frozen.id, 'batch_1');
  assert.equal(frozen.requestId, 'req_1');
  assert.equal(frozen.draftVersion, 1);
  assert.equal(frozen.workspaceId, 'ws_weapon');
  assert.equal(frozen.documentId, 'docx_abc');
  assert.equal(frozen.sourceFingerprint, 'sha256:doc-1');
  assert.equal(frozen.actorId, 'ou_reviewer');
  assert.equal(frozen.approvedAt, '2026-10-30T00:00:00.000Z');
  assert.deepEqual(frozen.parent, { mode: 'create', fields: { title: '勋章挑战系统' } });
  assert.deepEqual(frozen.stories, [{
    key: 'M01',
    fields: {
      title: '系统开放与大厅入口',
      rules: draft.stories[0].rules,
      acceptance: draft.stories[0].acceptance,
      factIds: ['F1', 'F2'],
      sourceIds: ['b_m01', 'b_m02', 'r_img', 'c_1'],
      issueIds: [],
      owner: 'ou_owner',
      iterationId: 'iter_1',
    },
    dependencies: [],
  }]);
  assert.match(frozen.payloadHash, /^[0-9a-f]{64}$/);
});

test('freezes a bind parent and defaults absent child fields to null', () => {
  const request = makeRequest({ draft: approvedDraft(), parentStoryId: '1001' });
  const frozen = freeze(request, ['M01'], {
    workspaceId: 'ws_weapon',
    parent: { mode: 'bind', storyId: '1001' },
  });
  assert.deepEqual(frozen.parent, { mode: 'bind', storyId: '1001' });
  assert.equal(frozen.stories[0].fields.owner, null);
  assert.equal(frozen.stories[0].fields.iterationId, null);
});

test('payload hashes ignore batch id and approval time but track content', () => {
  const request = makeRequest({ draft: approvedDraft() });
  const first = freeze(request);
  const second = freezeBatch({
    request,
    selectedKeys: ['M01'],
    target: freezeTarget(),
    actorId: 'ou_reviewer',
    now: '2026-11-01T12:00:00.000Z',
    batchId: 'batch_2',
  });
  assert.equal(first.payloadHash, second.payloadHash);

  const otherWorkspace = freeze(request, ['M01'], freezeTarget({ workspaceId: 'ws_gear' }));
  assert.notEqual(otherWorkspace.payloadHash, first.payloadHash);

  const otherVersion = freeze(makeRequest({
    draft: { ...approvedDraft(), version: 2 },
  }));
  assert.notEqual(otherVersion.payloadHash, first.payloadHash);
});

test('freezing deep-copies the draft', () => {
  const request = makeRequest({ draft: approvedDraft() });
  const frozen = freeze(request);
  request.draft.stories[0].title = '改动后的标题';
  request.draft.stories[0].rules[0].text = '改动后的规则';
  assert.equal(frozen.stories[0].fields.title, '系统开放与大厅入口');
  assert.equal(frozen.stories[0].fields.rules[0].text, approvedDraft().stories[0].rules[0].text);
  assert.notEqual(freeze(request).payloadHash, frozen.payloadHash);
});

test('freezing is blocked with the eligibility blockers', () => {
  const request = makeRequest();
  try {
    freeze(request);
    assert.fail('expected SUBMISSION_BLOCKED');
  } catch (error) {
    assert.equal(error.message, 'SUBMISSION_BLOCKED');
    assert.deepEqual(error.blockers, [
      { code: 'NOT_APPROVED', key: 'M01' },
    ]);
  }
});

test('created submission items count as already created', () => {
  const request = makeRequest({
    draft: approvedDraft(),
    submissions: [{
      batch: {},
      status: 'partial',
      items: [{ key: 'M01', status: 'created' }],
    }],
  });
  assert.throws(() => freeze(request), { message: 'SUBMISSION_BLOCKED' });

  request.submissions[0].items[0].status = 'rejected';
  assert.equal(freeze(request).stories.length, 1);
});

test('an existing parent story must be bound, not recreated', () => {
  const request = makeRequest({ draft: approvedDraft(), parentStoryId: '2002' });
  assert.throws(() => freeze(request), { message: 'PARENT_MISMATCH' });
  assert.throws(
    () => freeze(request, ['M01'], {
      workspaceId: 'ws_weapon',
      parent: { mode: 'bind', storyId: '1001' },
    }),
    { message: 'PARENT_MISMATCH' },
  );
});

test('only the initiator or a reviewer may freeze', () => {
  const request = makeRequest({ draft: approvedDraft() });
  assert.throws(
    () => freezeBatch({
      request,
      selectedKeys: ['M01'],
      target: freezeTarget(),
      actorId: 'ou_stranger',
      now: '2026-10-30T00:00:00.000Z',
      batchId: 'batch_1',
    }),
    { message: 'NOT_REVIEWER' },
  );
  const byInitiator = freezeBatch({
    request,
    selectedKeys: ['M01'],
    target: freezeTarget(),
    actorId: 'ou_initiator',
    now: '2026-10-30T00:00:00.000Z',
    batchId: 'batch_1',
  });
  assert.equal(byInitiator.actorId, 'ou_initiator');
});

test('rejects unusable batch inputs and targets', () => {
  const request = makeRequest({ draft: approvedDraft() });
  assert.throws(
    () => freezeBatch({
      request, selectedKeys: ['M01'], target: freezeTarget(),
      actorId: 'ou_reviewer', now: '2026-10-30T00:00:00.000Z', batchId: '',
    }),
    { message: 'INVALID_BATCH_INPUT' },
  );
  assert.throws(
    () => freezeBatch({
      request, selectedKeys: ['M01'], target: freezeTarget(),
      actorId: 'ou_reviewer', now: 'not-a-date', batchId: 'batch_1',
    }),
    { message: 'INVALID_BATCH_INPUT' },
  );
  assert.throws(
    () => freeze(request, ['M01'], freezeTarget({ workspaceId: '' })),
    { message: 'INVALID_TARGET' },
  );
  assert.throws(
    () => freeze(request, ['M01'], { workspaceId: 'ws_weapon', parent: { mode: 'bind' } }),
    { message: 'INVALID_TARGET' },
  );
  assert.throws(
    () => freeze(request, ['M01'], freezeTarget({ childDefaults: 'nope' })),
    { message: 'INVALID_TARGET' },
  );
});

function review(request, decision, actorId = 'ou_reviewer') {
  return applyReviewDecision({ request, actorId, decision });
}

function assertIsoTimestamp(value) {
  assert.equal(typeof value, 'string');
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

test('approving stories updates disposition and records the decision', () => {
  const request = makeRequest();
  const before = structuredClone(request);
  const updated = review(request, {
    type: 'approve',
    storyKeys: ['M01'],
    text: '确认可提交',
  });
  assert.equal(updated.draft.version, 2);
  assert.equal(updated.draft.stories[0].disposition, 'approved');
  assert.equal(updated.draft.decisions.length, 1);
  assert.equal(updated.draft.decisions[0].actorId, 'ou_reviewer');
  assert.equal(updated.draft.decisions[0].text, '确认可提交');
  assert.deepEqual(updated.draft.decisions[0].sourceIds, []);
  assert.equal(validate(updated.draft), updated.draft);
  assert.deepEqual(request, before);
  assert.notEqual(updated, request);
  assert.notEqual(updated.draft, request.draft);
});

test('deferring stories records the decision and keeps coverage valid', () => {
  const request = makeRequest();
  const updated = review(request, { type: 'defer', storyKeys: ['M01'] });
  assert.equal(updated.draft.stories[0].disposition, 'deferred');
  assert.equal(updated.draft.version, 2);
  assert.equal(updated.draft.decisions.length, 1);
  assert.equal(validate(updated.draft), updated.draft);
});

test('excluding stories writes matching exclusions', () => {
  const request = makeRequest();
  const updated = review(request, {
    type: 'exclude',
    storyKeys: ['M01'],
    reason: '本期不做入口倒计时',
  });
  assert.equal(updated.draft.stories[0].disposition, 'excluded');
  assert.deepEqual(updated.draft.exclusions, [{
    factIds: ['F1', 'F2'],
    reason: '本期不做入口倒计时',
    approvedBy: 'ou_reviewer',
  }]);
  assert.equal(updated.draft.version, 2);
  assert.equal(validate(updated.draft), updated.draft);
});

test('excluding does not duplicate facts already excluded', () => {
  const draft = makeDraft();
  draft.exclusions = [{ factIds: ['F1'], reason: '先前排除', approvedBy: 'ou_reviewer' }];
  const request = makeRequest({ draft });
  const updated = review(request, { type: 'exclude', storyKeys: ['M01'], reason: '继续排除' });
  assert.deepEqual(updated.draft.exclusions, [
    { factIds: ['F1'], reason: '先前排除', approvedBy: 'ou_reviewer' },
    { factIds: ['F2'], reason: '继续排除', approvedBy: 'ou_reviewer' },
  ]);
});

test('answering an issue resolves it and unblocks submission', () => {
  const draft = approvedDraft();
  draft.issues = [{
    id: 'I1',
    question: '排名是实时还是结算时判定？',
    storyKeys: ['M01'],
    blocking: true,
    resolvedBy: null,
  }];
  const request = makeRequest({ draft });
  assert.equal(eligibility(request.draft, ['M01']).blockers[0].code, 'OPEN_BLOCKING_ISSUE');

  const updated = review(request, {
    type: 'answer',
    issueId: 'I1',
    text: '结算时判定',
  });
  assert.deepEqual(updated.draft.issues[0].resolvedBy, {
    actorId: 'ou_reviewer',
    text: '结算时判定',
    at: updated.draft.issues[0].resolvedBy.at,
  });
  assertIsoTimestamp(updated.draft.issues[0].resolvedBy.at);
  assert.equal(updated.draft.decisions.length, 1);
  assert.deepEqual(updated.draft.decisions[0].sourceIds, ['I1']);
  assert.equal(updated.draft.version, 2);
  assert.deepEqual(eligibility(updated.draft, ['M01']), { allowed: true, blockers: [] });
  assert.equal(validate(updated.draft), updated.draft);
});

test('explaining a resource records the decision and unblocks its stories', () => {
  const draft = twoStoryDraft();
  const request = makeRequest({ draft });
  const updated = review(request, {
    type: 'explain-resource',
    resourceId: 'r_video',
    action: 'explain',
    text: '视频说明活动周期，未包含额外规则',
  });
  assert.deepEqual(updated.draft.resourceDecisions, [{
    resourceId: 'r_video',
    action: 'explain',
    text: '视频说明活动周期，未包含额外规则',
    actorId: 'ou_reviewer',
    at: updated.draft.resourceDecisions[0].at,
  }]);
  assertIsoTimestamp(updated.draft.resourceDecisions[0].at);
  assert.equal(updated.draft.decisions.length, 0);
  assert.equal(updated.draft.version, 2);
  assert.deepEqual(eligibility(updated.draft, ['M01', 'M02']), { allowed: true, blockers: [] });
});

test('selecting fields updates the owner', () => {
  const request = makeRequest();
  const updated = review(request, {
    type: 'select-fields',
    storyKey: 'M01',
    owner: 'ou_dev',
  });
  assert.equal(updated.draft.stories[0].owner, 'ou_dev');
  assert.equal(updated.draft.version, 2);
  assert.equal(updated.draft.decisions.length, 1);
  assert.equal(validate(updated.draft), updated.draft);
});

test('approving a suggestion-backed story clears the suggestion blocker', () => {
  const draft = makeDraft();
  draft.facts.push({
    id: 'F3',
    sourceIds: ['b_m01'],
    text: '建议增加排行榜展示',
    kind: 'suggestion',
  });
  draft.stories[0].factIds.push('F3');
  const request = makeRequest({ draft });
  assert.deepEqual(eligibility(draft, ['M01']).blockers, [
    { code: 'NOT_APPROVED', key: 'M01' },
    { code: 'UNAPPROVED_SUGGESTION', key: 'M01' },
  ]);

  const updated = review(request, { type: 'approve', storyKeys: ['M01'] });
  assert.deepEqual(updated.draft.decisions[0].sourceIds, ['F3']);
  assert.deepEqual(eligibility(updated.draft, ['M01']), { allowed: true, blockers: [] });
  assert.equal(validate(updated.draft), updated.draft);
});

test('each successful decision increments the version and leaves its input intact', () => {
  const request = makeRequest();
  const approved = review(request, { type: 'approve', storyKeys: ['M01'] });
  const selected = review(approved, { type: 'select-fields', storyKey: 'M01', owner: 'ou_dev' });
  assert.equal(request.draft.version, 1);
  assert.equal(approved.draft.version, 2);
  assert.equal(selected.draft.version, 3);
  assert.equal(approved.draft.stories[0].owner, null);
  assert.equal(selected.draft.stories[0].owner, 'ou_dev');
});

test('review actions reject unknown types, stories, issues and resources', () => {
  const request = makeRequest({ draft: approvedDraft() });
  assert.throws(() => review(request, { type: 'rewrite' }), { message: 'UNKNOWN_DECISION' });
  assert.throws(() => review(request, { type: 'approve', storyKeys: [] }), { message: 'UNKNOWN_STORY' });
  assert.throws(
    () => review(request, { type: 'approve', storyKeys: ['M99'] }),
    { message: 'UNKNOWN_STORY' },
  );
  assert.throws(
    () => review(request, { type: 'answer', issueId: 'I9', text: '答复' }),
    { message: 'UNKNOWN_ISSUE' },
  );
  assert.throws(
    () => review(request, { type: 'explain-resource', resourceId: 'r_missing', action: 'explain', text: '说明' }),
    { message: 'UNKNOWN_RESOURCE' },
  );
});

test('review actions reject invalid content and actors', () => {
  const request = makeRequest({ draft: approvedDraft() });
  assert.throws(
    () => review(request, { type: 'exclude', storyKeys: ['M01'], reason: '' }),
    { message: 'INVALID_DECISION' },
  );
  assert.throws(
    () => review(request, { type: 'answer', issueId: 'I1', text: 'x'.repeat(MAX_DECISION_TEXT + 1) }),
    { message: 'UNKNOWN_ISSUE' },
  );
  request.draft.issues = [{
    id: 'I1',
    question: '问题',
    storyKeys: ['M01'],
    blocking: false,
    resolvedBy: null,
  }];
  assert.throws(
    () => review(request, { type: 'answer', issueId: 'I1', text: 'x'.repeat(MAX_DECISION_TEXT + 1) }),
    { message: 'INVALID_DECISION' },
  );
  assert.throws(
    () => review(request, { type: 'select-fields', storyKey: 'M01', owner: '' }),
    { message: 'INVALID_DECISION' },
  );
  assert.throws(
    () => review(request, { type: 'approve', storyKeys: ['M01'] }, 'ou_stranger'),
    { message: 'NOT_REVIEWER' },
  );
});

test('forged decision facts cannot borrow a suggestion or block id', () => {
  const forgedDecision = makeDraft();
  forgedDecision.facts.push({
    id: 'F3',
    sourceIds: ['F1'],
    text: '伪造决定',
    kind: 'decision',
  });
  forgedDecision.stories[0].factIds.push('F3');
  assert.throws(() => validate(forgedDecision), { message: 'UNTRUSTED_DECISION' });

  const forgedSource = makeDraft();
  forgedSource.decisions = [{ id: 'D1', actorId: 'ou_reviewer', text: '决定', sourceIds: [] }];
  forgedSource.facts[0].sourceIds = ['D1'];
  assert.throws(() => validate(forgedSource), { message: 'UNKNOWN_FACT_SOURCE' });
});

test('freezing after a review uses the updated draft version', () => {
  const request = makeRequest();
  const approved = review(request, { type: 'approve', storyKeys: ['M01'] });
  const first = freeze(makeRequest({ draft: approvedDraft() }));
  const frozen = freeze(approved);
  assert.equal(frozen.draftVersion, 2);
  assert.equal(frozen.draftVersion, approved.draft.version);
  assert.notEqual(frozen.payloadHash, first.payloadHash);
});

test('rejects an invalid fact kind', () => {
  const draft = makeDraft();
  draft.facts[0].kind = 'rumor';
  assert.throws(() => validate(draft), { message: 'INVALID_FACT_KIND' });
});

test('rejects malformed source lists and non-boolean blocking flags', () => {
  const emptySources = makeDraft();
  emptySources.facts[0].sourceIds = [];
  assert.throws(() => validate(emptySources), { message: 'INVALID_FACT' });

  const badStorySources = makeDraft();
  badStorySources.stories[0].sourceIds = [42];
  assert.throws(() => validate(badStorySources), { message: 'INVALID_STORY' });

  const badDecisionSources = makeDraft();
  badDecisionSources.decisions = [{
    id: 'D1',
    actorId: 'ou_reviewer',
    text: '决定',
    sourceIds: 'D2',
  }];
  assert.throws(() => validate(badDecisionSources), { message: 'INVALID_DECISION' });

  const badBlocking = makeDraft();
  badBlocking.issues = [{
    id: 'I1',
    question: '问题',
    storyKeys: ['M01'],
    blocking: 'yes',
    resolvedBy: null,
  }];
  assert.throws(() => validate(badBlocking), { message: 'INVALID_ISSUE' });
});

test('rejects invalid story keys and owners', () => {
  const invalidKey = makeDraft();
  invalidKey.stories[0].key = '1M01';
  assert.throws(() => validate(invalidKey), { message: 'INVALID_STORY' });

  const invalidOwner = makeDraft();
  invalidOwner.stories[0].owner = 'x'.repeat(MAX_KEY + 1);
  assert.throws(() => validate(invalidOwner), { message: 'INVALID_STORY' });
});

test('rejects an issue resolved by an unknown actor', () => {
  const draft = makeDraft();
  draft.issues = [{
    id: 'I1',
    question: '问题',
    storyKeys: ['M01'],
    blocking: false,
    resolvedBy: {
      actorId: 'ou_stranger',
      text: '答复',
      at: '2026-10-30T00:00:00.000Z',
    },
  }];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_ACTOR' });
});

test('rejects an exclusion for an unknown fact', () => {
  const draft = makeDraft();
  draft.exclusions = [{ factIds: ['F9'], reason: '排除', approvedBy: 'ou_reviewer' }];
  assert.throws(() => validate(draft), { message: 'UNKNOWN_FACT' });
});

test('rejects duplicate decision and issue identifiers', () => {
  const duplicateDecision = makeDraft();
  const decision = { id: 'D1', actorId: 'ou_reviewer', text: '决定', sourceIds: [] };
  duplicateDecision.decisions = [decision, { ...decision }];
  assert.throws(() => validate(duplicateDecision), { message: 'INVALID_DECISION' });

  const duplicateIssue = makeDraft();
  const issue = {
    id: 'I1',
    question: '问题',
    storyKeys: ['M01'],
    blocking: false,
    resolvedBy: null,
  };
  duplicateIssue.issues = [issue, { ...issue }];
  assert.throws(() => validate(duplicateIssue), { message: 'INVALID_ISSUE' });
});

test('freezes selected stories in key order regardless of selection order', () => {
  const draft = makeDraft();
  draft.stories = [makeStory('M02', ['F2']), makeStory('M01', ['F1'])];
  const request = makeRequest({ draft });
  const reversed = freeze(request, ['M02', 'M01']);
  assert.deepEqual(reversed.stories.map((story) => story.key), ['M01', 'M02']);
  const ordered = freeze(request, ['M01', 'M02']);
  assert.equal(ordered.payloadHash, reversed.payloadHash);
});

test('a create parent falls back to the snapshot title', () => {
  const frozen = freeze(makeRequest({ draft: approvedDraft() }), ['M01'], {
    workspaceId: 'ws_weapon',
    parent: { mode: 'create' },
  });
  assert.equal(frozen.parent.fields.title, '勋章挑战系统');
});

test('a story owner wins over the batch child default', () => {
  const draft = approvedDraft();
  draft.stories[0].owner = 'ou_story_owner';
  const frozen = freeze(makeRequest({ draft }));
  assert.equal(frozen.stories[0].fields.owner, 'ou_story_owner');
});

test('selecting a null owner clears it', () => {
  const draft = makeDraft();
  draft.stories[0].owner = 'ou_old';
  const updated = review(makeRequest({ draft }), {
    type: 'select-fields',
    storyKey: 'M01',
    owner: null,
  });
  assert.equal(updated.draft.stories[0].owner, null);
});

test('rejects an invalid resource action', () => {
  const request = makeRequest({ draft: approvedDraft() });
  assert.throws(
    () => review(request, {
      type: 'explain-resource',
      resourceId: 'r_video',
      action: 'skip',
      text: '说明',
    }),
    { message: 'INVALID_DECISION' },
  );
});
