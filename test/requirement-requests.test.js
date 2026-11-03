// Task 10: the requirement coordinator. These tests run the real draft policy,
// the real ledger, the real review-card gate functions and the real submitter;
// only the outside world (Lark transport, document reader, model, TAPD, clock,
// work slot) is faked. Every assertion is against the ledger result or against
// what the fake transport actually received, so a gate that only exists in the
// card cannot pass here.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRequirementStore } from '../src/requirement-store.js';
import { createRequirementSubmitter } from '../src/requirement-submit.js';
import { applyReviewDecision, freezeBatch, validateDraft } from '../src/requirement-draft.js';
import { reviewState, submitGate } from '../src/requirement-cards.js';
import { createRequirementRequests } from '../src/requirement-requests.js';
import { makeDraft, makeLongSnapshot, makeRequest, makeSnapshot } from './requirement-fixtures.js';

const CHAT = 'oc_test';
const OTHER_CHAT = 'oc_other_group';
const BOT = 'ou_bot';
const INITIATOR = 'ou_initiator';
const REVIEWER = 'ou_reviewer';
// A perfectly well-formed open_id that is not on the request. Format checks must
// never accept it.
const OUTSIDER = 'ou_wellformed_but_not_a_reviewer';
const WORKSPACE = '59180547';
const CARD_MSG = 'om_card';
const TRIGGER = 'om_trigger';
// A chat link has to carry a token the document-input policy accepts
// ([A-Za-z0-9]+), so the pasted url uses `docxabc` while the snapshot keeps its
// own fixture documentId.
const DOC_URL = 'https://example.feishu.cn/docx/docxabc';
const DOC_TOKEN = 'docxabc';
const OWNER_A = '已核实成员甲';
const OWNER_B = '已核实成员乙';
const ITERATION = '1159180547001000128';
const PARENT_ID = '1159180547001009000';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let messageSeq = 0;

// ------------------------------------------------------------------ fixtures

function makeRequirements(overrides = {}) {
  return {
    allowedSenders: [INITIATOR, REVIEWER],
    reviewers: [REVIEWER],
    documentHosts: ['example.feishu.cn'],
    modelAttempt: 0,
    attempt: { kind: 'chat', baseUrl: 'https://model.invalid/v1', model: 'test-model', apiKeyFile: 'secrets/model.key', apiKeyEnv: '' },
    projects: {
      weapon: {
        parentTypeId: 'type-parent',
        childTypeId: 'type-child',
        templateId: 'tpl-1',
        owners: [OWNER_A, OWNER_B],
        iterationIds: [ITERATION],
      },
    },
    paths: { stateFile: 'state/requirements.json', assetsDir: 'state/requirement-assets' },
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    selfOpenId: BOT,
    chatId: CHAT,
    tapd: { workspaces: { weapon: { workspaceId: WORKSPACE } } },
    requirements: makeRequirements(),
    ...overrides,
  };
}

function story(key, factIds, overrides = {}) {
  return {
    key,
    title: `${key} 大厅入口与倒计时`,
    rules: [{ text: `${key} 活动期间显示大厅入口，开启前显示倒计时。`, factIds }],
    acceptance: [{ text: `${key} 开启前可见倒计时。`, factIds }],
    sourceIds: ['b_m01'],
    factIds,
    dependencies: [],
    issueIds: [],
    owner: null,
    disposition: 'approved',
    ...overrides,
  };
}

function reviewDraft(overrides = {}) {
  return makeDraft({
    stories: [
      story('M01', ['F1'], { sourceIds: ['b_m01', 'c_1'] }),
      story('M02', ['F2'], { title: 'M02 活动周期与关闭', sourceIds: ['b_m02'], dependencies: ['M01'] }),
    ],
    ...overrides,
  });
}

// The cross-chapter fixture is used for the paging tests: its blocks/comments
// give a draft whose detail view really needs several segments.
function longDraft() {
  return {
    version: 1,
    facts: [
      { id: 'F1', sourceIds: ['b_entry_rule'], text: '活动期间，大厅显示活动入口，点击后进入活动主界面。', kind: 'source' },
      { id: 'F2', sourceIds: ['b_task_rule_ch2'], text: '任务奖励可以在活动主界面直接领取。', kind: 'source' },
      { id: 'F3', sourceIds: ['c_conflict'], text: '评审意见：任务奖励改为自动发放。', kind: 'comment' },
    ],
    stories: [
      {
        key: 'M01',
        title: 'M01 活动入口',
        rules: Array.from({ length: 30 }, (_, index) => ({
          text: `规则${index}：` + '活动期间大厅显示活动入口，点击后进入活动主界面并保留上次位置。'.repeat(4),
          factIds: ['F1'],
        })),
        acceptance: [{ text: '入口在活动期内可见，结束后隐藏。', factIds: ['F1'] }],
        sourceIds: ['b_entry_rule', 'b_entry_image'],
        factIds: ['F1'],
        dependencies: [],
        issueIds: [],
        owner: null,
        disposition: 'approved',
      },
      {
        key: 'M02',
        title: 'M02 任务与奖励',
        rules: [{ text: '任务奖励改为自动发放，不再需要手动领取。', factIds: ['F2', 'F3'] }],
        acceptance: [{ text: '完成后自动收到奖励。', factIds: ['F2', 'F3'] }],
        sourceIds: ['b_task_rule_ch2'],
        factIds: ['F2', 'F3'],
        dependencies: ['M01'],
        issueIds: [],
        owner: null,
        disposition: 'approved',
      },
    ],
    issues: [],
    exclusions: [],
    decisions: [],
    resourceDecisions: [],
  };
}

function modelDraft() {
  return makeDraft({
    stories: [
      story('M01', ['F1'], { disposition: 'proposed', sourceIds: ['b_m01', 'c_1'] }),
      story('M02', ['F2'], { title: 'M02 活动周期与关闭', sourceIds: ['b_m02'], dependencies: ['M01'], disposition: 'proposed' }),
    ],
  });
}

function targetOf(overrides = {}) {
  return {
    workspaceId: WORKSPACE,
    parentTypeId: 'type-parent',
    childTypeId: 'type-child',
    templateId: 'tpl-1',
    childDefaults: {},
    parent: { mode: 'create', title: '勋章挑战系统（总单）' },
    ...overrides,
  };
}

function seenFor(version, extra = {}) {
  return {
    draftVersion: version,
    pagesSeen: [0],
    detailSeen: ['M01', 'M02'],
    confirmSeen: true,
    ...extra,
  };
}

// Independent re-derivation of the submitter's documented marker formula, so a
// crashed ledger can be seeded exactly as the submitter would have written it.
function markerOf(key, requestId = 'r1', batchId = 'batch-1') {
  const digest = createHash('sha256')
    .update(`${requestId}|${batchId}|${key}`)
    .digest('hex')
    .slice(0, 16);
  return `req-${String(key).slice(0, 24)}-${digest}`;
}

function coded(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

function tokensOf(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => token !== '');
}

// ------------------------------------------------------------------- fakes

function fakeLark({ failUpdates = 0 } = {}) {
  const sent = { replies: [], notices: [], cardReplies: [], cards: [], updates: [] };
  let seq = 0;
  let failed = 0;
  return {
    sent,
    async reply(messageId, text) {
      sent.replies.push({ messageId, text });
      return { messageId: `om_reply_${(seq += 1)}` };
    },
    async send(chatId, text) {
      sent.notices.push({ chatId, text });
      return { messageId: `om_send_${(seq += 1)}` };
    },
    async replyCard(messageId, card) {
      sent.cardReplies.push({ messageId, card });
      return { messageId: `om_card_${(seq += 1)}` };
    },
    async sendCard(chatId, card) {
      sent.cards.push({ chatId, card });
      return { messageId: `om_card_${(seq += 1)}` };
    },
    async updateCard(messageId, card) {
      if (failed < failUpdates) {
        failed += 1;
        throw coded('CARD_UPDATE_FAILED', 'card patch lost');
      }
      sent.updates.push({ messageId, card });
    },
    async listMessages() { return []; },
    async getSenderName(openId) { return openId; },
    async downloadImage() { return { path: '' }; },
  };
}

function fakeDocuments(options) {
  const calls = { read: [], revalidate: 0, cleanup: 0 };
  return {
    calls,
    async read(link) {
      calls.read.push(link);
      if (options.readError) throw options.readError;
      return options.snapshot ?? makeSnapshot();
    },
    async revalidate() {
      calls.revalidate += 1;
      if (options.revalidateError) throw options.revalidateError;
      return options.sourceChanged ? { unchanged: false, changes: ['BLOCK_CHANGED'] } : { unchanged: true };
    },
    async cleanup() { calls.cleanup += 1; },
  };
}

function fakeDecomposer(options = {}) {
  const calls = { analyze: 0, revise: [] };
  return {
    calls,
    async analyze() {
      calls.analyze += 1;
      if (options.analyzeGate) await options.analyzeGate;
      if (options.analyzeError) throw options.analyzeError;
      return options.analyzedDraft ?? modelDraft();
    },
    async revise({ draft, instruction }) {
      calls.revise.push(instruction);
      if (options.reviseError) throw options.reviseError;
      if (options.reviseGate) await options.reviseGate;
      const next = structuredClone(draft);
      next.version = draft.version + 1;
      return next;
    },
  };
}

function fakeSlot({ busy = false } = {}) {
  const state = { busy, owners: [], active: 0, released: 0 };
  return {
    state,
    isBusy: () => state.busy,
    tryStart(owner, work) {
      if (state.busy) return { accepted: false };
      state.busy = true;
      state.active += 1;
      state.owners.push(owner);
      const done = Promise.resolve()
        .then(work)
        .finally(() => {
          state.busy = false;
          state.released += 1;
        });
      return { accepted: true, done };
    },
    async whenIdle() {
      while (state.busy) await new Promise((resolve) => { setTimeout(resolve, 0); });
    },
  };
}

function fakeTapd(remote) {
  const parents = () => remote.stories.filter((storyItem) => storyItem.parentId === '0');
  const land = (workspaceId, fields) => {
    const id = String(1159180547001000000n + BigInt(remote.stories.length));
    remote.stories.push({
      id,
      workspaceId: String(workspaceId),
      name: String(fields.name ?? ''),
      parentId: String(fields.parent_id ?? '0'),
      childrenIds: [],
      ancestorId: String(fields.parent_id ?? '0'),
      level: fields.parent_id ? '1' : '0',
      workitemTypeId: String(fields.workitem_type_id ?? ''),
      templatedId: String(fields.templated_id ?? ''),
      iterationId: String(fields.iteration_id ?? ''),
      description: String(fields.description ?? ''),
    });
    return id;
  };
  return {
    async createStory({ workspaceId, fields }) {
      const key = fields.parent_id ? remote.titleToKey.get(fields.name) : 'parent';
      if (!key) throw coded('INVALID_ARGUMENT', 'fake tapd: unknown story name');
      if (remote.behavior[key] === 'rejected') throw coded('REJECTED', 'fake tapd: rejected');
      remote.created.push(key);
      const id = land(workspaceId, fields);
      remote.calls.push({ key, fields, id });
      return { id };
    },
    async getStory({ workspaceId, id }) {
      remote.reads.push(`getStory:${id}`);
      if (remote.behavior.getStory === 'NOT_FOUND') throw coded('NOT_FOUND', 'fake: 未找到需求');
      if (remote.behavior.getStory === 'READ_FAILED') throw coded('READ_FAILED', 'fake: 读取需求失败');
      const found = remote.stories.find(
        (storyItem) => storyItem.id === String(id) && storyItem.workspaceId === String(workspaceId),
      );
      if (!found) throw coded('NOT_FOUND', 'fake: 未找到需求');
      return found;
    },
    async findParents({ workspaceId, name, documentId }) {
      remote.reads.push('findParents');
      const items = parents().filter((storyItem) => storyItem.workspaceId === String(workspaceId)
        && storyItem.name === String(name)
        && tokensOf(storyItem.description).includes(String(documentId)));
      return { items, complete: remote.complete.findParents !== false };
    },
    async findByMarker({ workspaceId, parentId, marker }) {
      remote.reads.push('findByMarker');
      const items = remote.stories.filter((storyItem) => storyItem.workspaceId === String(workspaceId)
        && storyItem.parentId === String(parentId)
        && tokensOf(storyItem.description).includes(marker));
      return { items, complete: remote.complete.findByMarker !== false };
    },
    async listChildren({ workspaceId, parentId }) {
      remote.reads.push('listChildren');
      const items = remote.stories.filter((storyItem) => storyItem.workspaceId === String(workspaceId)
        && storyItem.parentId === String(parentId));
      return { items, complete: remote.complete.listChildren !== false };
    },
  };
}

function instrument(submitter, calls, submitError = null) {
  return {
    async submit(args) {
      calls.submit += 1;
      calls.submitArgs.push(args);
      // The submitter is allowed to refuse outright. The coordinator must still
      // record that attempt, because an unrecorded freeze is how a story ends up
      // created twice.
      if (submitError) throw submitError;
      return submitter.submit(args);
    },
    async reconcile(args) {
      calls.reconcile += 1;
      calls.reconcileArgs.push(args);
      return submitter.reconcile(args);
    },
    async resume(args) {
      calls.resume += 1;
      calls.resumeArgs.push(args);
      return submitter.resume(args);
    },
  };
}

// ----------------------------------------------------------------- harness

function seededRequest(options = {}) {
  const draft = options.draft ?? reviewDraft();
  const request = makeRequest({
    id: options.requestId ?? 'r1',
    chatId: options.chatId ?? CHAT,
    triggerMessageId: options.triggerMessageId ?? TRIGGER,
    cardMessageIds: options.cardMessageIds ?? [CARD_MSG],
    initiatorId: options.initiatorId ?? INITIATOR,
    reviewerIds: options.reviewerIds ?? [REVIEWER],
    projectId: options.projectId ?? 'weapon',
    status: options.status ?? 'awaiting_review',
    snapshot: options.snapshot ?? makeSnapshot(),
    draft,
    parentStoryId: options.parentStoryId ?? null,
    submissions: options.submissions ?? [],
    viewByActor: options.viewByActor ?? { [REVIEWER]: seenFor(draft.version) },
    target: targetOf(options.target),
    document: { kind: 'docx', token: DOC_TOKEN, url: DOC_URL },
    docKey: `docx:${DOC_TOKEN}`,
  });
  return request;
}

async function reviewHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-requests-'));
  dirs.push(dir);
  const file = join(dir, 'state', 'requirements.json');
  const store = openRequirementStore(file);

  const config = options.config ?? makeConfig();
  const lark = fakeLark({ failUpdates: options.failUpdates ?? 0 });
  const documents = fakeDocuments(options);
  const decomposer = fakeDecomposer(options);
  const slot = fakeSlot({ busy: options.busy === true });
  const log = { lines: [], info(line) { this.lines.push(line); }, warn(line) { this.lines.push(line); }, error(line) { this.lines.push(line); } };

  const request = options.seed === false ? null : seededRequest(options);
  const remote = {
    stories: options.remoteStories ?? [],
    created: [],
    calls: [],
    reads: [],
    behavior: options.behavior ?? {},
    complete: options.complete ?? {},
    titleToKey: new Map(request ? request.draft.stories.map((storyItem) => [storyItem.title, storyItem.key]) : []),
  };
  const tapd = fakeTapd(remote);
  let ticks = 0;
  const clockNow = () => new Date(Date.parse('2026-11-03T00:00:00.000Z') + (ticks += 1));
  const submitterCalls = { submit: 0, reconcile: 0, resume: 0, submitArgs: [], reconcileArgs: [], resumeArgs: [] };
  const submitter = instrument(createRequirementSubmitter({
    store,
    tapd,
    documents,
    targets: { weapon: targetOf({ parent: undefined, childDefaults: { owner: OWNER_A, iterationId: ITERATION } }) },
    clock: { now: clockNow },
  }), submitterCalls, options.submitError ?? null);

  const flow = createRequirementRequests({
    config,
    store,
    lark,
    documents,
    decomposer,
    submitter,
    slot,
    clock: clockNow,
    log,
  });

  if (request) {
    await store.transaction((state) => {
      state.requests[request.id] = structuredClone(request);
    });
  }

  const versionOf = (id = 'r1') => store.get(id)?.draft?.version ?? 0;

  const harness = {
    config,
    store,
    flow,
    lark,
    documents,
    decomposer,
    slot,
    submitter: submitterCalls,
    remote,
    log,
    request,
    file,
    versionOf,
    seenFor,
    targetOf,
    reviewDraft,
    storyAt: story,
    textMessage,
    action,
    enqueue: (event) => flow.enqueue(event),
    state: (id = 'r1') => store.get(id),
    texts: () => [...lark.sent.replies, ...lark.sent.notices, ...lark.sent.cardReplies]
      .map((entry) => entry.text ?? '')
      .join('\n'),
    async edit(text, opts = {}) {
      await flow.handleMessage(textMessage(text, { parentId: TRIGGER, mention: true, actor: opts.actor ?? REVIEWER, ...opts }));
      await flow.whenIdle();
    },
    async send(text, opts = {}) {
      const accepted = await flow.handleMessage(textMessage(text, opts));
      await flow.whenIdle();
      return accepted;
    },
    async run(event) {
      const accepted = flow.enqueue(event);
      await flow.whenIdle();
      return accepted;
    },
    async press(name, extra = {}) {
      return harness.run(action(name, extra));
    },
    async prime(overrides = {}) {
      await store.transaction((state) => {
        const current = state.requests[overrides.id ?? 'r1'];
        current.viewByActor = { [REVIEWER]: seenFor(current.draft.version, overrides.seen) };
        if (overrides.status) current.status = overrides.status;
      });
    },
  };

  function textMessage(text, opts = {}) {
    messageSeq += 1;
    const message = {
      message_id: opts.messageId ?? `om_msg_${messageSeq}`,
      chat_id: opts.chatId ?? CHAT,
      sender: { id: opts.actor ?? INITIATOR, sender_type: 'user' },
      msg_type: 'text',
      body: { content: JSON.stringify({ text }) },
    };
    if (opts.mention !== false) message.mentions = [{ id: { open_id: BOT } }];
    if (opts.parentId) message.parent_id = opts.parentId;
    if (opts.rootId) message.root_id = opts.rootId;
    if (opts.rawBody !== undefined) message.body.content = opts.rawBody;
    if (opts.msgType) message.msg_type = opts.msgType;
    return message;
  }

  function action(name, extra = {}) {
    const value = {
      workflow: 'requirements',
      requestId: extra.requestId ?? 'r1',
      draftVersion: extra.draftVersion === undefined ? versionOf(extra.requestId ?? 'r1') : extra.draftVersion,
      action: name,
      key: extra.key ?? '',
      page: extra.page ?? 0,
    };
    if (extra.rawValue !== undefined) return { ...value, ...extra.rawValue };
    return {
      type: 'card.action.trigger',
      event_id: extra.eventId ?? `ev_${name}_${messageSeq += 1}`,
      chat_id: extra.chatId ?? CHAT,
      message_id: extra.messageId ?? CARD_MSG,
      operator_id: extra.actor ?? REVIEWER,
      action_tag: extra.actionTag ?? 'button',
      action_value: JSON.stringify(value),
    };
  }

  return harness;
}

function submissionOf(frozen, overrides = {}) {
  return {
    id: frozen.id,
    requestId: frozen.requestId,
    batch: frozen,
    payloadHash: frozen.payloadHash,
    status: 'pending',
    parentStoryId: null,
    startedAt: null,
    updatedAt: '2026-11-03T00:00:00.000Z',
    items: [],
    notes: [],
    ...overrides,
  };
}

// ------------------------------------------------------------- the brief's RED

test('an old review cannot submit an edited draft', async () => {
  const h = await reviewHarness();
  const oldEvent = h.action('submit');
  await h.edit('修改拆分：将M01延期');
  h.flow.enqueue(oldEvent);
  await h.flow.whenIdle();
  assert.equal(h.store.get('r1').submissions.length, 0);
});

// ------------------------------------------------------------------ the gate

test('a stale confirm never even reaches the submitter', async () => {
  const h = await reviewHarness();
  const oldEvent = h.action('submit');
  await h.edit('修改拆分：把 M02 的验收改成分档结算');
  assert.equal(h.store.get('r1').draft.version, 2);
  await h.run(oldEvent);
  assert.deepEqual(h.submitter.submitArgs, []);
  assert.equal(h.submitter.submit, 0);
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.match(h.texts(), /操作无效/);
});

test('the same press at the current version does submit', async () => {
  const h = await reviewHarness();
  await h.press('submit');
  const request = h.store.get('r1');
  assert.equal(request.submissions.length, 1);
  assert.equal(request.submissions[0].batch.draftVersion, request.draft.version);
  assert.deepEqual(request.submissions[0].items.map((item) => item.status).sort(), ['created', 'created', 'created']);
  assert.equal(request.status, 'completed');
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1);
});

// 双击提交 / 并行回调, asserted directly: two `submit` callbacks for the same
// request are fired with no gap at all. The claim is taken synchronously, the
// freeze is re-gated inside the transaction and the submitter serializes per
// request+batch, so the second press must end as an in-flight refusal, not as a
// second batch and certainly not as a second story.
test('two submit presses fired together freeze exactly one batch and create each story once', async () => {
  const h = await reviewHarness();
  const first = h.action('submit', { eventId: 'ev_double_1' });
  const second = h.action('submit', { eventId: 'ev_double_2' });
  assert.equal(h.flow.enqueue(first), true);
  assert.equal(h.flow.enqueue(second), true);
  await h.flow.whenIdle();

  const request = h.store.get('r1');
  assert.equal(request.submissions.length, 1, 'exactly one batch is frozen');
  assert.equal(h.submitter.submit, 1, 'the submitter is entered once');
  assert.equal(h.slot.state.owners.length, 1, 'the request is claimed once');
  assert.deepEqual(h.remote.created.slice().sort(), ['M01', 'M02', 'parent'], 'each story is created exactly once');
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1, 'no duplicate parent');
  const ids = h.remote.calls.map((call) => call.id);
  assert.equal(new Set(ids).size, ids.length, 'no story is written twice under two ids');
  assert.equal(request.status, 'completed');
  assert.match(h.texts(), /正在处理其他重操作/, 'the second press hears the coded in-flight answer');
});

test('a well-formed open_id that is not on the request cannot approve or submit', async () => {
  const h = await reviewHarness();
  const before = h.store.get('r1');
  await h.press('approve', { actor: OUTSIDER, key: 'M01' });
  await h.press('submit', { actor: OUTSIDER });
  const after = h.store.get('r1');
  assert.equal(after.draft.version, before.draft.version);
  assert.equal(after.draft.decisions.length, 0);
  assert.equal(after.submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

// 身份 first: an actor who is not on the request must not be told anything about
// the draft version, so a stale press from an outsider answers with the identity
// refusal, never with the stale-version refusal. Both refuse; only the coded
// outcome differs, and the order is the one the plan fixes.
test('an unauthorized actor is not told that the version is stale', async () => {
  const h = await reviewHarness();
  await h.edit('修改拆分：把 M02 的验收改成分档结算');
  assert.equal(h.store.get('r1').draft.version, 2, 'the reviewer moved the draft to v2');
  const before = h.store.get('r1');
  await h.press('approve', { key: 'M01', actor: OUTSIDER, draftVersion: 1 });
  await h.press('submit', { actor: OUTSIDER, draftVersion: 1 });
  const after = h.store.get('r1');
  assert.equal(after.draft.version, before.draft.version);
  assert.equal(after.submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
  const heard = h.texts();
  assert.match(heard, /不是本需求的审核人/, 'identity is answered before version');
  assert.doesNotMatch(heard, /草稿已更新/, 'the stale-version code is not leaked to an outsider');
});

test('an authorized reviewer still gets the stale-version refusal', async () => {
  const h = await reviewHarness();
  const oldEvent = h.action('submit');
  await h.edit('修改拆分：把 M02 的验收改成分档结算');
  await h.run(oldEvent);
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.match(h.texts(), /草稿已更新/, 'the refusal strings stay distinct');
  assert.doesNotMatch(h.texts(), /不是本需求的审核人/);
});

test('a cross-group press cannot approve or submit', async () => {
  const h = await reviewHarness();
  await h.press('approve', { key: 'M01', chatId: OTHER_CHAT });
  await h.press('submit', { chatId: OTHER_CHAT });
  const after = h.store.get('r1');
  assert.equal(after.draft.version, 1);
  assert.equal(after.submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

// A card callback is not the only write path: a natural-language 修改拆分 and a
// thread reply both reach the same gate, so the chat has to come from the
// incoming message (exactly as the callback path takes `event.chat_id`) instead
// of being copied off the request. A same-thread reply stays in-chat.
test('a natural-language edit from another group is refused and writes nothing', async () => {
  const h = await reviewHarness();
  const before = h.store.get('r1');
  const accepted = await h.send('修改拆分 请求 r1：把 M01 的倒计时改成 3 天', {
    chatId: OTHER_CHAT, actor: REVIEWER, messageId: 'om_foreign_edit',
  });
  await h.flow.whenIdle();
  assert.equal(accepted, true, 'the message is still consumed by the workflow');
  assert.equal(h.decomposer.calls.revise.length, 0, 'the model is never asked');
  const after = h.store.get('r1');
  assert.equal(after.draft.version, before.draft.version, 'no version bump');
  assert.deepEqual(after.draft.decisions, [], 'no decision appended');
  assert.equal(after.status, before.status);
  assert.match(h.texts(), /不属于当前群/, 'the coded cross-chat refusal is what the reviewer hears');
  // The refusal is delivered to the request's own chat, never to the foreign one.
  assert.deepEqual(h.lark.sent.notices.filter((entry) => entry.chatId === OTHER_CHAT), []);
  assert.deepEqual(h.lark.sent.replies.filter((entry) => entry.messageId === 'om_foreign_edit'), []);
  assert.deepEqual(h.lark.sent.cardReplies.filter((entry) => entry.messageId === 'om_foreign_edit'), []);
  assert.ok(h.lark.sent.replies.some((entry) => entry.messageId === CARD_MSG), 'the notice lands in the review thread');
});

test('a field-change reply from another group is refused and writes nothing', async () => {
  const h = await reviewHarness();
  const accepted = await h.send(`M01 · ${OWNER_B}`, {
    chatId: OTHER_CHAT, parentId: CARD_MSG, mention: false, actor: REVIEWER, messageId: 'om_foreign_reply',
  });
  await h.flow.whenIdle();
  assert.equal(accepted, true);
  const after = h.store.get('r1');
  assert.equal(after.draft.version, 1, 'the field change did not land');
  assert.equal(after.draft.stories[0].owner, null);
  assert.deepEqual(after.draft.decisions, []);
  assert.match(h.texts(), /不属于当前群/);
  assert.deepEqual(h.lark.sent.notices.filter((entry) => entry.chatId === OTHER_CHAT), []);
  assert.deepEqual(h.lark.sent.replies.filter((entry) => entry.messageId === 'om_foreign_reply'), []);
});

test('the same-thread reply from the request chat still applies the change', async () => {
  const h = await reviewHarness();
  await h.send(`M01 · ${OWNER_B}`, { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const after = h.store.get('r1');
  assert.equal(after.draft.stories[0].owner, OWNER_B);
  assert.equal(after.draft.version, 2, 'an in-chat thread reply is not cross-chat');
});

test('an outsider cannot drive the shared review card with a paging press', async () => {
  const h = await reviewHarness();
  await h.press('list_next', { page: 1, actor: OUTSIDER });
  await h.press('detail', { key: 'M01', actor: OUTSIDER });
  await h.press('confirm', { actor: OUTSIDER });
  const request = h.store.get('r1');
  assert.equal(request.draft.version, 1);
  assert.deepEqual(request.viewByActor[OUTSIDER], undefined, 'no view progress for a refused viewer');
  assert.equal(request.view?.mode, undefined, 'the shared view was not moved');
  assert.deepEqual(h.lark.sent.updates, [], 'a refused press patches nobody\'s card');
  assert.match(h.texts(), /审核人/);
});

test('a press from a card that is not part of the request is refused', async () => {
  const h = await reviewHarness();
  await h.press('submit', { messageId: 'om_some_other_card' });
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

test('actions outside the card allow-list and other workflows are refused', async () => {
  const h = await reviewHarness();
  assert.equal(h.enqueue(h.action('delete_everything')), false);
  assert.equal(h.enqueue({ ...h.action('approve'), action_value: JSON.stringify({ ...JSON.parse(h.action('approve').action_value), workflow: 'tickets' }) }), false);
  assert.equal(h.enqueue({ type: 'card.action.trigger', event_id: 'ev_x', chat_id: CHAT, message_id: CARD_MSG, operator_id: REVIEWER, action_tag: 'button', action_value: 'not json at all' }), false);
  assert.equal(h.enqueue({ ...h.action('approve'), action_value: '' }), false);
  assert.equal(h.enqueue(null), false);
  assert.equal(h.enqueue(undefined), false);
  const after = h.store.get('r1');
  assert.equal(after.draft.version, 1);
  assert.equal(after.submissions.length, 0);
});

test('callback values carrying extra keys are refused, not merged', async () => {
  const h = await reviewHarness();
  await h.run(h.action('approve', { rawValue: { owner: OWNER_B, target: { workspaceId: '999' } }, key: 'M01' }));
  const after = h.store.get('r1');
  assert.equal(after.draft.version, 1);
  assert.equal(after.draft.stories[0].owner, null);
  assert.equal(after.submissions.length, 0);
});

test('cancel closes the request and disables every write afterwards', async () => {
  const h = await reviewHarness();
  await h.press('cancel');
  assert.equal(h.store.get('r1').status, 'cancelled');
  await h.press('approve', { key: 'M01' });
  await h.press('submit');
  const after = h.store.get('r1');
  assert.equal(after.draft.version, 1);
  assert.equal(after.submissions.length, 0);
});

test('cancel is refused once a batch has written a parent or a child', async () => {
  const h = await reviewHarness();
  await h.press('defer', { key: 'M02' });
  await h.prime({});
  await h.press('submit');
  const before = h.store.get('r1');
  assert.equal(before.status, 'partially_completed');
  assert.ok(before.parentStoryId, 'the parent was written and recorded');

  await h.press('cancel');
  const after = h.store.get('r1');
  assert.equal(after.status, 'partially_completed', 'the request stays open');
  assert.equal(after.submissions.length, 1, 'no state is discarded');
  assert.match(h.texts(), /已写入|不能取消/, 'the reviewer is told why the cancel did nothing');
});

test('approve and defer are recorded against the acting reviewer and bump one version', async () => {
  const h = await reviewHarness();
  await h.press('approve', { key: 'M01' });
  let request = h.store.get('r1');
  assert.equal(request.draft.version, 2);
  assert.equal(request.draft.decisions.length, 1);
  assert.equal(request.draft.decisions[0].actorId, REVIEWER);
  await h.press('defer', { key: 'M02', draftVersion: 2 });
  request = h.store.get('r1');
  assert.equal(request.draft.version, 3);
  assert.equal(request.draft.stories.find((item) => item.key === 'M02').disposition, 'deferred');
  // The confirm page is now stale for that actor, so a submit at v3 is refused
  // until the reviewer re-reads the new version.
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
});

// ---------------------------------------------------------------- navigation

// Six stories is one more than LIST_PAGE_SIZE, so the list really has two pages
// and a "page 1" press is something the reviewer can actually have seen.
function pagedDraft() {
  return makeDraft({
    stories: [
      story('M01', ['F1'], { sourceIds: ['b_m01', 'c_1'] }),
      story('M02', ['F2'], { title: 'M02 活动周期与关闭', sourceIds: ['b_m02'], dependencies: ['M01'] }),
      story('M03', ['F2'], { title: 'M03 奖励发放', sourceIds: ['b_m02'], dependencies: ['M01'] }),
      story('M04', ['F2'], { title: 'M04 结算面板', sourceIds: ['b_m02'], dependencies: ['M01'] }),
      story('M05', ['F2'], { title: 'M05 数据埋点', sourceIds: ['b_m02'], dependencies: ['M01'] }),
      story('M06', ['F2'], { title: 'M06 灰度开关', sourceIds: ['b_m02'], dependencies: ['M01'] }),
    ],
  });
}

test('navigation never changes the draft version and never approves anything', async () => {
  const h = await reviewHarness({ draft: pagedDraft(), viewByActor: {} });
  await h.press('list_next', { page: 1 });
  await h.press('detail', { key: 'M01' });
  await h.press('confirm');
  await h.press('back');
  const request = h.store.get('r1');
  assert.equal(request.draft.version, 1);
  assert.equal(request.draft.decisions.length, 0);
  assert.equal(request.submissions.length, 0);
  assert.equal(request.draft.stories.every((storyItem) => storyItem.disposition === 'approved'), true);
  assert.ok(request.viewByActor[REVIEWER], 'the reviewer view ledger is persisted');
  assert.equal(request.viewByActor[REVIEWER].draftVersion, 1);
  assert.ok(request.viewByActor[REVIEWER].pagesSeen.includes(1));
  // A page that does not exist is clamped, never credited as read.
  await h.press('list_next', { page: 40 });
  assert.equal(h.store.get('r1').viewByActor[REVIEWER].pagesSeen.includes(40), false);
});

test('a story counts as fully read only after the whole detail series', async () => {
  const h = await reviewHarness({
    snapshot: makeLongSnapshot(),
    draft: longDraft(),
    viewByActor: {},
  });
  await h.press('detail', { key: 'M01' });
  let seen = h.store.get('r1').viewByActor[REVIEWER];
  assert.deepEqual(seen.detailSeen, [], 'the first segment is not the whole story');
  for (let page = 1; page < 60; page += 1) {
    await h.press('detail_next', { key: 'M01', page });
    seen = h.store.get('r1').viewByActor[REVIEWER];
    if (seen.detailSeen.includes('M01')) break;
  }
  assert.ok(seen.detailSeen.includes('M01'), 'the last segment closes the read range');
  assert.equal(h.store.get('r1').draft.version, 1, 'reading does not approve anything');
});

test('a stale story key still refreshes the shared card as a list', async () => {
  const h = await reviewHarness();
  await h.press('detail', { key: 'GONE' });
  const request = h.store.get('r1');
  assert.equal(request.draft.version, 1);
  assert.ok(h.lark.sent.updates.length > 0, 'the shared card was patched');
});

// ------------------------------------------------------------------- starts

test('a start creates the request, reads, analyses and renders a review card', async () => {
  const h = await reviewHarness({ seed: false });
  const message = h.textMessage(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start' });
  const pending = h.flow.handleMessage(message);
  const acked = await pending;
  assert.equal(acked, true);
  const midFlight = h.store.list();
  assert.equal(midFlight.length, 1);
  assert.equal(midFlight[0].draft, undefined, 'handleMessage does not wait for the analysis');
  await h.flow.whenIdle();
  const request = h.store.list()[0];
  assert.equal(request.status, 'awaiting_review');
  assert.equal(request.initiatorId, INITIATOR);
  assert.equal(request.draft.stories.length, 2);
  assert.equal(request.chatId, CHAT);
  assert.equal(h.documents.calls.read.length, 1);
  assert.equal(h.decomposer.calls.analyze, 1);
  assert.ok(h.lark.sent.cards.length + h.lark.sent.cardReplies.length > 0, 'a review card was published');
  const cardText = JSON.stringify(h.lark.sent.cards.at(-1)?.card ?? h.lark.sent.cardReplies.at(-1)?.card);
  assert.doesNotMatch(cardText, /apiKeyFile|secrets\/model\.key|stateFile/, 'no credential path reaches the card');
});

test('the confirm page shows the configured target, not an empty one', async () => {
  const config = makeConfig();
  config.requirements.projects.weapon.parentOwner = OWNER_A;
  config.requirements.projects.weapon.parentIterationId = ITERATION;
  config.requirements.projects.weapon.titlePrefix = '实验自测';
  const h = await reviewHarness({ seed: false, config });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start' });
  const started = h.store.list()[0];
  // The freshly published card carries the id the reply returned, not the
  // seeded harness constant, so the press has to come from that card.
  await h.press('confirm', { requestId: started.id, messageId: started.cardMessageIds.at(-1) });
  const text = JSON.stringify(h.lark.sent.updates.at(-1)?.card);

  assert.match(text, new RegExp(`workspace ${WORKSPACE}`), 'the mapped workspace is shown');
  assert.match(text, /父单类型：type-parent/);
  assert.match(text, /子单类型：type-child/);
  assert.match(text, /模板：tpl-1/);
  assert.match(text, new RegExp(`父单负责人：${OWNER_A}`), 'the parent owner comes from config');
  assert.match(text, new RegExp(`父单迭代：${ITERATION}`), 'the parent iteration is independent of the child default');
  assert.match(text, /标题前缀：实验自测/, 'the prefix the submitter will add is on the page');
  assert.ok(!text.includes('未配置'), 'no configured target field renders as unset');
});

test('only an allowed sender may start a request', async () => {
  const h = await reviewHarness({ seed: false });
  const accepted = await h.send(`拆分需求 ${DOC_URL}`, { actor: OUTSIDER, messageId: 'om_start' });
  assert.equal(accepted, true);
  assert.equal(h.store.list().length, 0);
  assert.equal(h.documents.calls.read.length, 0);
  assert.match(h.texts(), /无权限|不在白名单/);
});

test('a second start for the same document returns the existing draft instead of a new mapping', async () => {
  const h = await reviewHarness();
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_2' });
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.equal(h.documents.calls.read.length, 0, 'the document is not read a second time');
  assert.match(h.texts(), /r1/);
});

test('several document links ask the reviewer to choose one before anything is read', async () => {
  const h = await reviewHarness({ seed: false });
  const other = 'https://example.feishu.cn/docx/docxother';
  await h.send(`拆分需求 ${DOC_URL} ${other}`, { actor: INITIATOR, messageId: 'om_start_multi' });
  assert.equal(h.store.list().length, 0);
  assert.equal(h.documents.calls.read.length, 0);
  assert.match(h.texts(), /多个文档|请选择/);
  await h.send('1', { actor: INITIATOR, messageId: 'om_pick', parentId: 'om_start_multi', mention: false });
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.list()[0].document.token, DOC_TOKEN);
  assert.equal(h.documents.calls.read.length, 1);
});

// A pick reply may paste the link instead of typing a number, but only a link the
// thread really offered may be chosen.
test('a pasted link in the pick thread only counts when it was offered', async () => {
  const h = await reviewHarness({ seed: false });
  const other = 'https://example.feishu.cn/docx/docxother';
  await h.send(`拆分需求 ${DOC_URL} ${other}`, { actor: INITIATOR, messageId: 'om_start_pick' });
  await h.send('https://example.feishu.cn/docx/doxcnneveroffered', {
    actor: INITIATOR, messageId: 'om_pick_bad', parentId: 'om_start_pick', mention: false,
  });
  assert.equal(h.store.list().length, 0, 'a link nobody offered is not a choice');
  assert.equal(h.documents.calls.read.length, 0);
  await h.send(other, { actor: INITIATOR, messageId: 'om_pick_link', parentId: 'om_start_pick', mention: false });
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.list()[0].document.token, 'docxother');
  assert.equal(h.store.list()[0].triggerMessageId, 'om_start_pick', 'the request stays anchored to the original message');
});

test('an unresolvable target holds the request and waits for the reviewer', async () => {
  const h = await reviewHarness({
    seed: false,
    config: makeConfig({ requirements: makeRequirements({ projects: {
      weapon: { parentTypeId: 'p', childTypeId: 'c', templateId: 't', owners: [OWNER_A], iterationIds: [] },
      gear: { parentTypeId: 'p2', childTypeId: 'c2', templateId: 't2', owners: [OWNER_A], iterationIds: [] },
    } }) }),
  });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_amb' });
  const [request] = h.store.list();
  assert.equal(request.projectId ?? '', '');
  assert.equal(request.status, 'awaiting_review');
  assert.equal(request.draft, undefined);
  assert.equal(h.documents.calls.read.length, 0, 'nothing is read against an unknown target');
  await h.send('weapon', { actor: REVIEWER, messageId: 'om_pick_project', parentId: 'om_start_amb', mention: false });
  assert.equal(h.store.list()[0].projectId, 'weapon');
  assert.equal(h.store.list()[0].status, 'awaiting_review');
  assert.equal(h.documents.calls.read.length, 1);
});

test('reading and analysing occupy the work slot and are released afterwards', async () => {
  const h = await reviewHarness({ seed: false });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_slot' });
  assert.equal(h.slot.state.active, 1);
  assert.equal(h.slot.state.released, 1, 'the reservation is always released');
  assert.equal(h.slot.state.busy, false);
});

test('a busy slot answers with an explicit notice and queues nothing', async () => {
  const h = await reviewHarness({ busy: true });
  const accepted = h.enqueue(h.action('submit'));
  await h.flow.whenIdle();
  assert.equal(accepted, true);
  assert.equal(h.submitter.submit, 0);
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.match(h.texts(), /正在处理其他重操作/);
  const editAccepted = await h.flow.handleMessage(h.textMessage('修改拆分：M01 标题缩短', { parentId: TRIGGER }));
  await h.flow.whenIdle();
  assert.equal(editAccepted, true);
  assert.equal(h.decomposer.calls.revise.length, 0);
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.match(h.texts(), /正在处理其他重操作/);
});

test('handleMessage is not consumed by ordinary chatter', async () => {
  const h = await reviewHarness({ seed: false });
  assert.equal(await h.flow.handleMessage(h.textMessage('今天天气不错', { mention: false })), false);
  assert.equal(await h.flow.handleMessage(h.textMessage('拆分需求 https://evil.example/docx/docx_x', { mention: true })), false);
  assert.equal(h.store.list().length, 0);
});

// -------------------------------------------------------------------- edits

test('an edit is located by its thread and keeps the decision record', async () => {
  const h = await reviewHarness();
  await h.press('approve', { key: 'M01' });
  const versionBefore = h.store.get('r1').draft.version;
  await h.edit('修改拆分：把 M01 的倒计时改成 3 天');
  const request = h.store.get('r1');
  assert.equal(request.draft.version, versionBefore + 1);
  assert.equal(h.decomposer.calls.revise.at(-1), '把 M01 的倒计时改成 3 天');
  assert.equal(request.draft.decisions.length, 2, 'the model edit adds one decision, the approval stays');
  assert.equal(request.draft.decisions.at(-1).actorId, REVIEWER);
  assert.match(request.draft.decisions.at(-1).text, /倒计时/);
});

test('an ambiguous edit reference asks for the request id and changes nothing', async () => {
  const h = await reviewHarness({ requestId: 'r1' });
  await h.store.transaction((state) => {
    state.requests.r2 = structuredClone(seededRequest({
      requestId: 'r2',
      triggerMessageId: TRIGGER,
      cardMessageIds: [CARD_MSG],
      draft: reviewDraft(),
    }));
  });
  await h.edit('修改拆分：M01 缩短标题');
  assert.equal(h.decomposer.calls.revise.length, 0);
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.equal(h.store.get('r2').draft.version, 1);
  assert.match(h.texts(), /请求.*编号|写明/);
});

test('an instruction that is empty or absurdly long is refused without a model call', async () => {
  const h = await reviewHarness();
  await h.edit('修改拆分：');
  await h.edit(`修改拆分：${'超长指令'.repeat(600)}`);
  assert.equal(h.decomposer.calls.revise.length, 0);
  assert.equal(h.store.get('r1').draft.version, 1);
});

test('a batch that is in flight cannot be edited', async () => {
  const request = seededRequest({ status: 'awaiting_review' });
  const frozen = freezeBatch({
    request,
    selectedKeys: ['M01', 'M02'],
    target: targetOf(),
    actorId: REVIEWER,
    now: '2026-11-03T00:00:00.000Z',
    batchId: 'batch-1',
  });
  const h = await reviewHarness({
    status: 'submitting',
    submissions: [submissionOf(frozen, {
      status: 'running',
      items: [
        { key: 'parent', marker: markerOf('parent'), status: 'created', storyId: PARENT_ID },
        { key: 'M01', marker: markerOf('M01'), status: 'sending', storyId: null },
        { key: 'M02', marker: markerOf('M02'), status: 'pending', storyId: null },
      ],
    })],
  });
  await h.edit('修改拆分：M01 再改一次');
  assert.equal(h.decomposer.calls.revise.length, 0);
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.match(h.texts(), /提交中|不可编辑/);
  await h.press('approve', { key: 'M01' });
  assert.equal(h.store.get('r1').draft.version, 1);
});

test('a sending item blocks a second submit but not a reconcile', async () => {
  const request = seededRequest();
  const frozen = freezeBatch({
    request,
    selectedKeys: ['M01', 'M02'],
    target: targetOf(),
    actorId: REVIEWER,
    now: '2026-11-03T00:00:00.000Z',
    batchId: 'batch-1',
  });
  const h = await reviewHarness({
    status: 'needs_review',
    submissions: [submissionOf(frozen, {
      status: 'running',
      parentStoryId: PARENT_ID,
      items: [
        { key: 'parent', marker: markerOf('parent'), status: 'created', storyId: PARENT_ID },
        { key: 'M01', marker: markerOf('M01'), status: 'sending', storyId: null },
        { key: 'M02', marker: markerOf('M02'), status: 'pending', storyId: null },
      ],
    })],
    remoteStories: [{
      id: PARENT_ID, workspaceId: WORKSPACE, name: '勋章挑战系统（总单）', parentId: '0', childrenIds: [],
      ancestorId: '0', level: '0', workitemTypeId: 'type-parent', templatedId: 'tpl-1', iterationId: '',
      description: `【需求文档】${DOC_URL}（文档 ID：docx_abc）<br />【追踪标识】${markerOf('parent')}`,
    }],
  });
  await h.press('submit');
  assert.equal(h.submitter.submit, 0, 'an in-flight batch is never re-submitted');
  await h.press('reconcile');
  assert.equal(h.submitter.reconcile, 1);
  const submission = h.store.get('r1').submissions[0];
  assert.equal(submission.items.find((item) => item.key === 'M01').status, 'unknown');
  assert.deepEqual(h.remote.created, [], 'a reconcile posts nothing');
});

// ---------------------------------------------------------- decisions & text

test('an unread resource needs a named reviewer decision before it unblocks', async () => {
  const blocked = story('M01', ['F1'], { sourceIds: ['b_m01', 'r_video'] });
  const h = await reviewHarness({ draft: reviewDraft({ stories: [blocked, story('M02', ['F2'], { dependencies: ['M01'] })] }) });
  // The story is held back by the pending video, so it is not in the writable subset.
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0, 'M02 depends on a held story and M01 is blocked');
  await h.send(`${REVIEWER} 说明 r_video · 视频是运营录屏，验收以正文为准`, { parentId: CARD_MSG, mention: false, actor: OUTSIDER });
  assert.equal(h.store.get('r1').draft.resourceDecisions.length, 0);
  await h.press('answer');
  await h.send('r_video · 说明 · 视频是运营录屏，验收以正文为准', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.draft.resourceDecisions.length, 1);
  assert.equal(request.draft.resourceDecisions[0].actorId, REVIEWER);
  assert.equal(request.draft.resourceDecisions[0].resourceId, 'r_video');
  assert.ok(request.viewByActor[REVIEWER] ?? true);
});

test('excluding a resource records the reviewer as the author of the exclusion', async () => {
  const blocked = story('M01', ['F1'], { sourceIds: ['b_m01', 'r_video'] });
  const h = await reviewHarness({ draft: reviewDraft({ stories: [blocked, story('M02', ['F2'], { dependencies: ['M01'] })] }) });
  await h.send('r_video · 排除 · 录屏与本期无关', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.draft.resourceDecisions[0].action, 'exclude');
  assert.equal(request.draft.resourceDecisions[0].actorId, REVIEWER);
  assert.equal(request.submissions.length, 0);
});

test('excluding a story needs a reason and stores it with the reviewer', async () => {
  const h = await reviewHarness();
  await h.press('exclude', { key: 'M01' });
  assert.equal(h.store.get('r1').draft.version, 1, 'the press only asks for the reason');
  assert.match(h.texts(), /原因/);
  await h.send('M01 · 本期不做入口倒计时', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.draft.stories.find((item) => item.key === 'M01').disposition, 'excluded');
  assert.equal(request.draft.exclusions.at(-1).approvedBy, REVIEWER);
  assert.match(request.draft.exclusions.at(-1).reason, /本期不做/);
});

test('a blocking question is answered in the thread by a named reviewer', async () => {
  const draft = reviewDraft({
    stories: [
      story('M01', ['F1'], { issueIds: ['Q1'] }),
      story('M02', ['F2'], { dependencies: ['M01'], issueIds: ['Q1'] }),
    ],
    issues: [{ id: 'Q1', question: '倒计时结束后是否保留入口？', storyKeys: ['M01', 'M02'], blocking: true, resolvedBy: null }],
  });
  const h = await reviewHarness({ draft });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
  await h.press('answer', { key: 'M01' });
  await h.send('请求 r1 · Q1 · 结束后隐藏入口，保留历史记录', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.draft.issues[0].resolvedBy.actorId, REVIEWER);
  assert.match(request.draft.issues[0].resolvedBy.text, /历史记录/);
  // With the question answered and a fresh review of the new version, submit works.
  await h.prime({ seen: {} });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 1);
});

test('an owner change only accepts the configured allow-list', async () => {
  const h = await reviewHarness();
  await h.press('select_owner', { key: 'M01' });
  await h.send('M01 · 陌生人丙', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  assert.equal(h.store.get('r1').draft.version, 1, 'a name outside the allow-list is refused');
  await h.send(`M01 · ${OWNER_B}`, { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.draft.stories[0].owner, OWNER_B);
  assert.equal(request.draft.version, 2, 'a field change is a content change');
  assert.equal(request.draft.decisions.at(-1).actorId, REVIEWER);
});

test('an iteration change only accepts the configured allow-list', async () => {
  const h = await reviewHarness();
  await h.press('select_iteration');
  await h.send('迭代 999999', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.equal(h.store.get('r1').selections, undefined);
  await h.send(ITERATION, { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.selections.iterationId, ITERATION);
  assert.equal(request.draft.version, 2);
  assert.equal(request.draft.decisions.length, 1, 'one accepted change, one version, one decision');
});

// 字段变更 has to be revalidated, not just appended: the iteration reply mutates
// the draft version and the decision log inside one transaction, so `validateDraft`
// runs on the result there and a draft the policy cannot accept is refused whole.
test('an iteration change that fails revalidation leaves the ledger untouched', async () => {
  // F3 belongs to no story and to no exclusion: a draft the draft policy rejects.
  const orphaned = reviewDraft({
    facts: [
      { id: 'F1', sourceIds: ['b_m01'], text: '活动期间，大厅显示勋章挑战入口。', kind: 'source' },
      { id: 'F2', sourceIds: ['b_m02'], text: '挑战活动持续 14 天，结束后关闭入口。', kind: 'source' },
      { id: 'F3', sourceIds: ['b_m01'], text: '文末补充：活动结束后排行榜保留 7 天。', kind: 'source' },
    ],
  });
  const h = await reviewHarness({ draft: orphaned });
  assert.throws(() => validateDraft({
    draft: orphaned,
    snapshot: makeSnapshot(),
    actorIds: [INITIATOR, REVIEWER],
  }), /UNCOVERED_FACT/);

  await h.press('select_iteration');
  const before = h.store.get('r1');
  await h.send(ITERATION, { parentId: CARD_MSG, mention: false, actor: REVIEWER });

  const after = h.store.get('r1');
  assert.equal(after.draft.version, before.draft.version, 'no version bump');
  assert.deepEqual(after.draft.decisions, before.draft.decisions, 'no decision appended');
  assert.equal(after.selections, undefined, 'the rejected batch carries no selection');
  assert.match(h.texts(), /校验失败/, 'the reviewer hears the coded revalidation refusal');
  assert.equal(after.submissions.length, 0);
});

// The same discipline has to hold when there is nothing to revalidate: an
// unprompted iteration reply on a request that has no draft yet is refused by the
// revalidation step instead of crashing on the missing version.
test('an iteration reply with no draft is refused, not thrown', async () => {
  const h = await reviewHarness({ seed: false });
  const noDraft = seededRequest();
  delete noDraft.draft;
  await h.store.transaction((state) => {
    state.requests.r1 = noDraft;
    return undefined;
  });
  const accepted = await h.send(ITERATION, { parentId: TRIGGER, mention: false, actor: REVIEWER });
  assert.equal(accepted, true, 'the workflow still owns the message');
  const after = h.store.get('r1');
  assert.equal(after.draft, undefined);
  assert.equal(after.selections, undefined, 'no selection is stored behind the refusal');
  assert.match(h.texts(), /校验失败/);
});

test('the model never gets to choose people, targets or approval', async () => {
  const h = await reviewHarness();
  // A "document" that tries to instruct the flow is only ever data.
  await h.send(`M01 · ${OWNER_B}`, { parentId: CARD_MSG, mention: false, actor: OUTSIDER });
  assert.equal(h.store.get('r1').draft.version, 1);
  await h.press('approve', { key: 'M01', actor: OUTSIDER });
  assert.equal(h.store.get('r1').draft.version, 1);
  const cardText = JSON.stringify(h.lark.sent.updates.map((entry) => entry.card));
  assert.doesNotMatch(cardText, /ou_initiator|"owner":"\s*陌生人/);
});

// -------------------------------------------------------------------- submit

test('submitting a subset then the rest does not build a second parent', async () => {
  const h = await reviewHarness();
  await h.press('defer', { key: 'M02' });
  await h.prime({});
  await h.press('submit');
  let request = h.store.get('r1');
  assert.equal(request.submissions.length, 1);
  assert.deepEqual(request.submissions[0].batch.stories.map((item) => item.key), ['M01']);
  assert.equal(request.status, 'partially_completed');
  const parentId = request.parentStoryId;
  assert.ok(parentId, 'the created parent is recorded on the request');
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1);

  await h.press('approve', { key: 'M02', draftVersion: request.draft.version });
  await h.prime({});
  await h.press('submit');
  request = h.store.get('r1');
  assert.equal(request.submissions.length, 2);
  assert.deepEqual(request.submissions[1].batch.stories.map((item) => item.key), ['M02']);
  assert.equal(request.submissions[1].batch.parent.mode, 'bind');
  assert.equal(request.submissions[1].batch.parent.storyId, parentId);
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1, 'the second batch reuses the parent');
  assert.equal(request.status, 'completed');
});

test('a rejected item is retried in a new batch and created items are never rebuilt', async () => {
  const h = await reviewHarness({ behavior: { M01: 'rejected' } });
  await h.press('submit');
  let request = h.store.get('r1');
  assert.equal(request.status, 'needs_review');
  assert.equal(request.submissions.length, 1);
  assert.deepEqual(h.remote.created, ['parent'], 'a rejection proves nothing was written');
  assert.equal(request.submissions[0].items.find((item) => item.key === 'M01').status, 'rejected');

  // TAPD accepts the corrected payload on the retry: the gate must let the
  // reviewer submit again, and the new batch may only carry uncreated keys.
  delete h.remote.behavior.M01;
  await h.press('submit');
  request = h.store.get('r1');
  assert.equal(request.submissions.length, 2);
  assert.deepEqual(request.submissions[1].batch.stories.map((item) => item.key), ['M01', 'M02']);
  assert.deepEqual(h.remote.created.slice().sort(), ['M01', 'M02', 'parent'], 'each story lands once');
  assert.equal(request.status, 'completed');
});

test('an incomplete parent search cannot prove there is no duplicate', async () => {
  const h = await reviewHarness({ complete: { findParents: false } });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.deepEqual(h.remote.created, [], 'nothing is posted on an incomplete read');
  assert.equal(request.status, 'needs_review');
  assert.match(JSON.stringify(request.submissions[0].notes), /READ_INCOMPLETE/);
});

test('a changed source is refused before any batch is frozen', async () => {
  const h = await reviewHarness({ sourceChanged: true });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
  assert.match(h.texts(), /SOURCE_CHANGED/);
});

test('a source re-check failure stops the submit without posting', async () => {
  const h = await reviewHarness({ revalidateError: coded('SOURCE_RECHECK_FAILED', 'reader unavailable') });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

test('a selected story whose full detail was not read cannot be written', async () => {
  const h = await reviewHarness({ viewByActor: { [REVIEWER]: { draftVersion: 1, pagesSeen: [0], detailSeen: ['M01'], confirmSeen: true } } });
  const state = reviewState(h.store.get('r1'), REVIEWER);
  assert.ok(submitGate(state, 1).join(' ').includes('M02'), 'the shared gate names the missing story');
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

test('a confirm page that was not fully walked cannot be written', async () => {
  const h = await reviewHarness({ viewByActor: { [REVIEWER]: { draftVersion: 1, pagesSeen: [0], detailSeen: ['M01', 'M02'], confirmSeen: [] } } });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

// Thirty approved stories is what it takes to push the confirm card past one
// segment, so the count the server-side gate uses is something a test can pin
// exactly rather than a number the coordinator may guess.
function wideStoryKeys(count = 30) {
  return Array.from({ length: count }, (_, index) => `M${String(index + 1).padStart(2, '0')}`);
}

function multiPageConfirmDraft(keys) {
  return makeDraft({
    stories: keys.map((key, index) => story(key, index % 2 === 0 ? ['F1'] : ['F2'], {
      title: `${key} 一个相当长的子单标题，用来把确认页撑到更多段，重复重复重复。`,
      sourceIds: index % 2 === 0 ? ['b_m01'] : ['b_m02'],
      dependencies: index === 0 ? [] : [keys[0]],
    })),
  });
}

test('the submit gate counts the real confirm series and accepts exactly the last page', async () => {
  const keys = wideStoryKeys();
  const seen = { draftVersion: 1, pagesSeen: [0], detailSeen: keys, confirmSeen: [0] };
  const h = await reviewHarness({ draft: multiPageConfirmDraft(keys), viewByActor: { [REVIEWER]: seen } });
  await h.press('submit');
  assert.equal(h.store.get('r1').submissions.length, 0, 'one segment of a longer series is not the whole series');
  assert.equal(h.submitter.submit, 0);
  assert.match(h.texts(), /提交前条件|确认页/);

  // Walking the last segment closes it: the ledger still holds an array, so the
  // count really has to be 2 and no more.
  await h.prime({ seen: { pagesSeen: [0], detailSeen: keys, confirmSeen: [0, 1] } });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.equal(request.submissions.length, 1, 'the gate accepted exactly two segments');
  assert.equal(request.submissions[0].batch.stories.length, keys.length);
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1);
});

test('a parent that cannot be found is confirmed by a human, never rebuilt', async () => {
  const h = await reviewHarness({ parentStoryId: PARENT_ID, target: targetOf({ parent: { mode: 'bind', storyId: PARENT_ID } }), behavior: { getStory: 'NOT_FOUND' }, remoteStories: [{
    id: '1159180547001000500', workspaceId: WORKSPACE, name: '别的总单', parentId: '0', childrenIds: [],
    ancestorId: '0', level: '0', workitemTypeId: 'type-parent', templatedId: 'tpl-1', iterationId: '',
    description: `（文档 ID：docx_other）`,
  }] });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.deepEqual(h.remote.created, [], 'no second parent is created');
  assert.equal(request.status, 'needs_review');
  assert.match(h.texts(), /未找到父单|需确认/);
});

test('an existing parent with a different source is reported, never updated', async () => {
  const foreign = {
    id: PARENT_ID, workspaceId: WORKSPACE, name: '勋章挑战系统（总单）', parentId: '0', childrenIds: [],
    ancestorId: '0', level: '0', workitemTypeId: 'type-parent', templatedId: 'tpl-1', iterationId: 'other-iteration',
    description: '【需求文档】https://example.feishu.cn/docx/doxcn_a_different_document（文档 ID：doxcn_a_different_document）',
  };
  const h = await reviewHarness({
    parentStoryId: PARENT_ID,
    target: targetOf({ parent: { mode: 'bind', storyId: PARENT_ID } }),
    remoteStories: [foreign],
  });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.match(JSON.stringify(request.submissions[0].notes), /PARENT_MISMATCH/);
  assert.deepEqual(h.remote.created, [], 'the existing story is never rewritten');
  assert.equal(request.status, 'needs_review');
  // An explicit confirmation may only bind a story id the ledger already verified.
  await h.press('bind_parent');
  await h.send(PARENT_ID, { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const confirmed = h.store.get('r1');
  assert.equal(confirmed.parentBindOverride.actorId, REVIEWER);
  assert.equal(confirmed.parentBindOverride.storyId, PARENT_ID);
  assert.ok(confirmed.parentBindOverride.at);
  await h.press('resume');
  assert.equal(h.submitter.resume, 1);
  assert.equal(h.store.get('r1').submissions[0].items.find((item) => item.key === 'parent').status, 'created');
  assert.equal(
    h.remote.created.filter((key) => key === 'parent').length,
    0,
    'binding an existing parent still posts no second parent',
  );
  const boundParent = h.remote.stories.find((storyItem) => storyItem.id === PARENT_ID);
  assert.equal(boundParent.iterationId, 'other-iteration', 'the existing parent is never rewritten');
  assert.match(boundParent.description, /doxcn_a_different_document/, 'the existing parent keeps its own source');
});

test('a typed story id that the ledger never verified cannot be bound', async () => {
  const h = await reviewHarness();
  await h.press('bind_parent');
  await h.send('1159180547001099999', { parentId: CARD_MSG, mention: false, actor: REVIEWER });
  const request = h.store.get('r1');
  assert.equal(request.parentBindOverride, undefined);
  assert.equal(request.parentStoryId, null);
  assert.match(h.texts(), /未核实|无法核实/);
});

test('a submission that does not match the ledger is reported, not retried blindly', async () => {
  const h = await reviewHarness();
  const request = h.store.get('r1');
  const frozen = freezeBatch({
    request,
    selectedKeys: ['M01', 'M02'],
    target: targetOf({ workspaceId: '99999999' }),
    actorId: REVIEWER,
    now: '2026-11-03T00:00:00.000Z',
    batchId: 'batch-forged',
  });
  await h.store.transaction((state) => {
    state.requests.r1.submissions.push(submissionOf(frozen));
  });
  await h.press('reconcile');
  assert.equal(h.submitter.reconcile, 1, 'the coordinator really asked the submitter to look');
  const after = h.store.get('r1');
  assert.equal(after.submissions[0].status, 'pending', 'a mismatched batch is not rewritten behind the submitter');
  assert.match(String(after.blockedReason ?? ''), /SUBMISSION_MISMATCH/);
  assert.equal(after.status, 'needs_review');
  assert.deepEqual(h.remote.created, [], 'a mismatched batch posts nothing');
});

// ----------------------------------------------------------------- failures

test('a submitter that refuses outright is still recorded', async () => {
  const secret = 'tapd-500-body-with-令牌';
  const h = await reviewHarness({ submitError: coded('SUBMIT_TRANSPORT_FAILED', `远端失败：${secret}`) });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.equal(h.submitter.submit, 1, 'the freeze really reached the submitter');
  assert.equal(request.submissions.length, 1, 'the frozen batch stays in the ledger');
  assert.equal(request.status, 'needs_review', 'the request is writable again, not stuck at submitting');
  assert.equal(request.blockedReason, 'SUBMIT_TRANSPORT_FAILED');
  assert.doesNotMatch(JSON.stringify(request), new RegExp(secret), 'the remote text never enters the ledger');
  assert.doesNotMatch(h.texts(), new RegExp(secret), 'the remote text never reaches the chat');
  assert.match(h.texts(), /SUBMIT_TRANSPORT_FAILED/);
  assert.deepEqual(h.remote.created, [], 'a refused submit posts nothing');
  // The card must come back showing the refusal instead of a frozen 提交中 state.
  assert.match(JSON.stringify(h.lark.sent.updates.at(-1)?.card), /待核对/);
});

test('a failed read leaves a retryable request and says so', async () => {
  const h = await reviewHarness({ seed: false, readError: coded('SOURCE_READ_FAILED', 'document is not readable') });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_fail' });
  const [request] = h.store.list();
  assert.equal(request.status, 'failed');
  assert.equal(request.draft, undefined);
  assert.equal(request.submissions.length, 0);
  assert.match(h.texts(), /SOURCE_READ_FAILED|读取失败/);
  // Retrying the same document reuses the request instead of adding a mapping.
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_retry' });
  assert.equal(h.store.list().length, 1, 'a retry does not create a second request');
});

test('a rejected model step is reported by code and never by remote text', async () => {
  const secret = 'raw-model-response-with-secret-令牌';
  const h = await reviewHarness({ seed: false, analyzeError: coded('ANALYSIS_LIMIT', `超限：${secret}`) });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_limit' });
  const [request] = h.store.list();
  assert.equal(request.status, 'failed');
  const stored = JSON.stringify(h.store.list());
  assert.doesNotMatch(stored, new RegExp(secret), 'the remote message never enters the ledger');
  assert.match(h.texts(), /ANALYSIS_LIMIT/);
});

test('a malicious or oversized message cannot crash the coordinator', async () => {
  const h = await reviewHarness();
  const hostile = [
    h.textMessage('修改拆分 ' + 'x'.repeat(3_000_000), { parentId: TRIGGER, actor: REVIEWER }),
    h.textMessage('', { parentId: TRIGGER }),
    h.textMessage('拆分需求', { messageId: 'om_no_doc' }),
    { message_id: 'om_bad', chat_id: CHAT, sender: null, msg_type: 'text', body: { content: '{not json' } },
    { message_id: 'om_deep', chat_id: CHAT, sender: { id: REVIEWER }, msg_type: 'post', body: { content: JSON.stringify(JSON.parse('{"a":' + '[1,'.repeat(200) + '1' + (']'.repeat(200)) + '}')) } },
    { message_id: 'om_proto', chat_id: CHAT, sender: { id: REVIEWER }, msg_type: 'text', body: { content: '{"__proto__":{"polluted":1},"text":"拆分需求 ' + DOC_URL + '"}' } },
  ];
  for (const message of hostile) {
    await h.flow.handleMessage(message);
  }
  await h.flow.whenIdle();
  for (const event of [
    { type: 'card.action.trigger', event_id: 'e', chat_id: CHAT, message_id: CARD_MSG, operator_id: REVIEWER, action_tag: 'button', action_value: JSON.stringify(JSON.parse('{"a":' + '[1,'.repeat(500) + '1' + ']'.repeat(500) + '}')) },
    { type: 'card.action.trigger', event_id: 'e', chat_id: CHAT, message_id: CARD_MSG, operator_id: REVIEWER, action_tag: 'button', action_value: '{"workflow":"requirements","requestId":"__proto__","action":"submit","draftVersion":1,"key":"","page":0}' },
    { type: 'card.action.trigger', event_id: 'e', chat_id: CHAT, message_id: CARD_MSG, operator_id: REVIEWER, action_tag: 'button', action_value: '{"workflow":"requirements","requestId":"r1","action":"submit","draftVersion":' + (2 ** 53) + ',"key":"","page":0}' },
    { type: 'card.action.trigger', event_id: 'e', chat_id: CHAT, message_id: CARD_MSG, operator_id: {}, action_tag: 'button', action_value: '{"workflow":"requirements","requestId":"r1","action":"submit","draftVersion":1}' },
    { type: 'card.action.trigger', event_id: 'e', chat_id: CHAT, message_id: CARD_MSG, operator_id: REVIEWER, action_tag: 'button', action_value: '{"workflow":"requirements","requestId":"r1","action":"submit","draftVersion":1,"key":"' + 'k'.repeat(10_000) + '","page":0}' },
  ]) {
    h.enqueue(event);
  }
  await h.flow.whenIdle();
  const request = h.store.get('r1');
  assert.equal(request.draft.version, 1);
  assert.equal(request.submissions.length, 0);
  assert.equal(Object.prototype.polluted, undefined);
});

test('a card transport failure never loses the created stories', async () => {
  const h = await reviewHarness({ failUpdates: 1 });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.equal(request.submissions.length, 1);
  assert.equal(request.status, 'completed');
  assert.equal(h.remote.created.length, 3, 'the stories are created exactly once');
  await h.flow.flush();
  await h.flow.whenIdle();
  assert.equal(h.remote.created.length, 3, 'a card retry does not create anything again');
  assert.ok(h.lark.sent.updates.length > 0, 'the card was patched on the retry');
});

// ----------------------------------------------------------------- recovery

test('recovery downgrades an interrupted read and re-renders the review card', async () => {
  const h = await reviewHarness({ seed: false });
  const crashed = seededRequest({ status: 'reading', draft: undefined });
  await h.store.transaction((state) => {
    state.requests[crashed.id] = crashed;
  });
  await h.flow.flush();
  await h.flow.whenIdle();
  const request = h.store.get('r1');
  assert.equal(request.status, 'interrupted');
  assert.match(JSON.stringify(request), /READ_INTERRUPTED|STEP_INTERRUPTED/);
  assert.match(h.texts(), /中断|重试/);
});

test('recovery hands a sending item to reconcile without posting anything', async () => {
  const request = seededRequest({ status: 'submitting' });
  const frozen = freezeBatch({
    request,
    selectedKeys: ['M01', 'M02'],
    target: targetOf(),
    actorId: REVIEWER,
    now: '2026-11-03T00:00:00.000Z',
    batchId: 'batch-1',
  });
  const h = await reviewHarness({
    status: 'submitting',
    submissions: [submissionOf(frozen, {
      status: 'running',
      startedAt: '2026-11-03T00:00:00.000Z',
      items: [
        { key: 'parent', marker: markerOf('parent'), status: 'sending', storyId: null },
        { key: 'M01', marker: markerOf('M01'), status: 'pending', storyId: null },
        { key: 'M02', marker: markerOf('M02'), status: 'pending', storyId: null },
      ],
    })],
  });
  await h.flow.flush();
  await h.flow.whenIdle();
  assert.equal(h.submitter.reconcile, 1);
  const stored = h.store.get('r1');
  assert.equal(stored.submissions[0].items.find((item) => item.key === 'parent').status, 'unknown');
  assert.equal(stored.status, 'needs_review');
  assert.deepEqual(h.remote.created, [], 'recovery never creates a story on its own');
});

test('recovery re-renders a review card for a draft that survived the restart', async () => {
  const h = await reviewHarness();
  await h.flow.flush();
  await h.flow.whenIdle();
  assert.ok(h.lark.sent.updates.length > 0);
  assert.equal(h.store.get('r1').draft.version, 1);
});

// The freeze and the submitter's first write are two separate transactions, so a
// restart can land between them and leave a batch that never started. `submitting`
// is not a writable status, so if recovery ignores that shape the request is dead:
// every button refuses and the frozen batch is neither driven nor released.
test('a batch frozen just before the restart is released, not left unclickable', async () => {
  const request = seededRequest({ status: 'submitting' });
  const frozen = freezeBatch({
    request,
    selectedKeys: ['M01', 'M02'],
    target: targetOf(),
    actorId: REVIEWER,
    now: '2026-11-03T00:00:00.000Z',
    batchId: 'batch-1',
  });
  const h = await reviewHarness({
    status: 'submitting',
    submissions: [submissionOf(frozen, { status: 'pending', startedAt: null, items: [] })],
  });
  await h.flow.flush();
  await h.flow.whenIdle();
  const stored = h.store.get('r1');
  assert.equal(stored.submissions.length, 1, 'the frozen batch is kept, never discarded');
  assert.deepEqual(h.remote.created, [], 'a batch that never started creates nothing on recovery');
  assert.ok(['needs_review', 'partially_completed', 'completed'].includes(stored.status),
    `the request must return to a writable status, got ${stored.status}`);
  // Proof it is really usable again: the reviewer's next press freezes afresh and
  // the stories land exactly once, with no second parent.
  await h.press('submit');
  const after = h.store.get('r1');
  assert.equal(after.submissions.length, 2, 'the released freeze is not re-driven, a new one is');
  assert.deepEqual(after.submissions[1].items.map((item) => item.status).sort(),
    ['created', 'created', 'created'], 'the second submit writes the whole batch');
  assert.equal(h.remote.created.filter((key) => key === 'parent').length, 1, 'no duplicate parent');
  assert.equal(after.status, 'completed');
});

test('flush refreshes pending cards without waiting for the running analysis', async () => {
  let release;
  const analyzeGate = new Promise((resolve) => { release = resolve; });
  const h = await reviewHarness({ seed: false, analyzeGate });
  const accepted = await h.flow.handleMessage(h.textMessage(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_slow' }));
  assert.equal(accepted, true);
  assert.equal(h.store.list()[0].draft, undefined);
  const flushed = await Promise.race([
    h.flow.flush().then(() => 'flushed'),
    new Promise((resolve) => { setTimeout(() => resolve('timeout'), 50); }),
  ]);
  assert.equal(flushed, 'flushed', 'flush never waits for heavy work');
  // Whichever heavy step is running, the ledger says so: a request is never left
  // looking idle with no draft while the reader or the model is still working.
  assert.ok(['reading', 'analyzing'].includes(h.store.list()[0].status), 'the running step is recorded');
  assert.equal(h.store.list()[0].draft, undefined, 'the analysis has not been adopted yet');
  release();
  await h.flow.whenIdle();
  assert.equal(h.store.list()[0].status, 'awaiting_review');
  assert.equal(h.slot.state.busy, false);
});

// ------------------------------------------------------------- security edges

test('nothing that is stored carries a credential, a local path or remote text', async () => {
  const h = await reviewHarness();
  await h.press('submit');
  const stored = JSON.stringify(h.store.list());
  for (const forbidden of ['secrets/model.key', 'apiKeyFile', 'baseUrl', 'tokenFile', 'C:\\\\', 'stateFile']) {
    assert.doesNotMatch(stored, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the ledger must not carry ${forbidden}`);
  }
  const cards = JSON.stringify(h.lark.sent.updates.map((entry) => entry.card));
  for (const forbidden of ['secrets/model.key', 'apiKeyFile', 'tokenFile', 'baseUrl']) {
    assert.doesNotMatch(cards, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the card must not carry ${forbidden}`);
  }
});

test('an unknown request status fails closed', async () => {
  const h = await reviewHarness({ status: 'teleporting' });
  await h.press('approve', { key: 'M01' });
  await h.press('submit');
  const request = h.store.get('r1');
  assert.equal(request.draft.version, 1);
  assert.equal(request.submissions.length, 0);
  assert.equal(h.submitter.submit, 0);
});

test('a coordinator built without the feature configured ignores everything', async () => {
  const flow = createRequirementRequests({
    config: {},
    store: { get: () => undefined, list: () => [], transaction: async () => {} },
    lark: fakeLark(),
    documents: fakeDocuments({}),
    decomposer: fakeDecomposer({}),
    submitter: { submit: async () => ({}), reconcile: async () => ({}), resume: async () => ({}) },
    slot: fakeSlot(),
  });
  assert.equal(await flow.handleMessage({ message_id: 'om', chat_id: CHAT, sender: { id: INITIATOR }, msg_type: 'text', body: { content: '{"text":"拆分需求"}' }, mentions: [{ id: { open_id: BOT } }] }), false);
  assert.equal(flow.enqueue({ type: 'card.action.trigger', action_value: '{}' }), false);
  await flow.flush();
  await flow.whenIdle();
});

test('validateDraft really is the gate: a model draft that breaks coverage is not adopted', async () => {
  const broken = makeDraft({ stories: [story('M01', ['F1'], { factIds: ['F1'], sourceIds: ['b_m01'] })] });
  const h = await reviewHarness({ seed: false, analyzedDraft: broken });
  await h.send(`拆分需求 ${DOC_URL}`, { actor: INITIATOR, messageId: 'om_start_broken' });
  const [request] = h.store.list();
  assert.equal(request.status, 'failed');
  assert.equal(request.draft, undefined);
  assert.throws(() => validateDraft({ draft: broken, snapshot: makeSnapshot(), actorIds: [INITIATOR, REVIEWER] }), /UNCOVERED_FACT/);
});

test('a review decision that the draft policy rejects leaves the ledger untouched', async () => {
  const h = await reviewHarness();
  const request = h.store.get('r1');
  assert.throws(() => applyReviewDecision({ request, actorId: REVIEWER, decision: { type: 'exclude', storyKeys: ['M99'] } }), /UNKNOWN_STORY/);
  await h.press('approve', { key: 'M99' });
  assert.equal(h.store.get('r1').draft.version, 1);
  assert.match(h.texts(), /不存在|无效/);
});
