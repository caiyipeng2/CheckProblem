import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRequirementStore } from '../src/requirement-store.js';
import { freezeBatch } from '../src/requirement-draft.js';
import { createRequirementSubmitter } from '../src/requirement-submit.js';
import { makeDraft, makeRequest, makeSnapshot } from './requirement-fixtures.js';

const WORKSPACE = '59180547';
const PARENT_TITLE = '勋章挑战系统（总单）';
const SECRET = 'tapd-secret-never-leak';
const DOC_TEXT = '大厅显示勋章挑战入口';
const ASSET_PATH = 'C:/Users/EDY/.checkproblem/tapd.token';

const targets = {
  weapon: {
    workspaceId: WORKSPACE,
    parentTypeId: '1159180547001000025',
    childTypeId: '1159180547001000027',
    templateId: '1159180547001000039',
    childDefaults: { owner: '周俊|刘学', iterationId: '1159180547001000128' },
  },
};

function coded(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

// Independent re-derivation of the documented marker formula
// req-<key[0..24]>-<sha256(requestId|batchId|key).hex[0..16]>.
function markerOf(key, requestId = 'r1', batchId = 'b1') {
  const digest = createHash('sha256')
    .update(`${requestId}|${batchId}|${key}`)
    .digest('hex')
    .slice(0, 16);
  return `req-${String(key).slice(0, 24)}-${digest}`;
}

function tokensOf(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => token !== '');
}

function submissionStories() {
  const draft = makeDraft();
  draft.stories = [
    {
      key: 'M01',
      title: '大厅入口与倒计时',
      rules: [{ text: '活动期间显示大厅入口，开启前显示倒计时。', factIds: ['F1'] }],
      acceptance: [{ text: '开启前可见倒计时，开启后可进入活动。', factIds: ['F1'] }],
      sourceIds: ['b_m01', 'c_1'],
      factIds: ['F1'],
      dependencies: [],
      issueIds: [],
      owner: null,
      disposition: 'approved',
    },
    {
      key: 'M02',
      title: '奖励发放',
      rules: [{ text: '全部任务完成后发放头像框 30 天。', factIds: ['F2'] }],
      acceptance: [{ text: '完成后自动收到头像框。', factIds: ['F2'] }],
      sourceIds: ['b_m02'],
      factIds: ['F2'],
      dependencies: ['M01'],
      issueIds: [],
      owner: null,
      disposition: 'approved',
    },
  ];
  return draft;
}

function submissionRequest(overrides = {}) {
  return makeRequest({
    id: 'r1',
    status: 'reviewed',
    snapshot: makeSnapshot(),
    draft: submissionStories(),
    ...overrides,
  });
}

function normalizedStory({ id, workspaceId, fields }) {
  return {
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
  };
}

function createFakeTapd(remote) {
  const keyOf = (fields) => (fields.parent_id ? remote.titleToKey.get(fields.name) : 'parent');
  const parents = () => remote.stories.filter((story) => story.parentId === '0');
  const complete = (items, flag) => ({ items, complete: flag !== false });
  // TAPD ids are 19 digits, which a Number cannot hold exactly, so the fake
  // counts them as BigInt to keep every story's id distinct.
  const land = (workspaceId, fields) => {
    const id = String(1159180547001000000n + BigInt(remote.stories.length));
    remote.stories.push(normalizedStory({ id, workspaceId, fields }));
    return id;
  };

  return {
    async createStory({ workspaceId, fields }) {
      const key = keyOf(fields);
      if (!key) throw coded('INVALID_ARGUMENT', 'fake tapd: unknown story name');
      remote.createdKeys.push(key);
      remote.calls.push({ workspaceId, fields, key });
      const mode = remote.behavior[key] ?? 'ok';
      if (mode === 'unknown') {
        // A lost response may still have created the story: unknownLands models
        // exactly the case reconcile exists to resolve.
        if (remote.unknownLands[key]) land(workspaceId, fields);
        throw coded('UNKNOWN', 'tapd-stories: 建单结果未知（超时）');
      }
      if (mode === 'leaky') {
        if (remote.unknownLands[key]) land(workspaceId, fields);
        throw coded('UNKNOWN', `raw response ${SECRET} ${DOC_TEXT} ${ASSET_PATH}`);
      }
      if (mode === 'rejected') throw coded('REJECTED', 'tapd-stories: 建单被拒绝（HTTP 200）');
      if (mode === 'unsent') throw coded('UNSENT', 'tapd-stories: 令牌文件不可读或为空');
      const id = land(workspaceId, fields);
      return { id };
    },
    async findParents({ workspaceId, name, documentId }) {
      remote.reads.push('findParents');
      if (remote.behavior.findParents === 'READ_FAILED') {
        throw coded('READ_FAILED', 'tapd-stories: 读取需求列表失败');
      }
      const items = parents().filter((story) => story.workspaceId === String(workspaceId)
        && story.name === String(name)
        && tokensOf(story.description).includes(String(documentId)));
      return complete(items, remote.complete.findParents);
    },
    async findByMarker({ workspaceId, parentId, marker }) {
      remote.reads.push('findByMarker');
      if (remote.behavior.findByMarker === 'READ_FAILED') {
        throw coded('READ_FAILED', 'tapd-stories: 读取需求列表失败');
      }
      const items = remote.stories.filter((story) => story.workspaceId === String(workspaceId)
        && story.parentId === String(parentId)
        && tokensOf(story.description).includes(marker));
      return complete(items, remote.complete.findByMarker);
    },
    async listChildren({ workspaceId, parentId }) {
      remote.reads.push('listChildren');
      const items = remote.stories.filter((story) => story.workspaceId === String(workspaceId)
        && story.parentId === String(parentId));
      return complete(items, remote.complete.listChildren);
    },
    async getStory({ workspaceId, id }) {
      remote.reads.push('getStory');
      if (remote.behavior.getStory === 'READ_FAILED') {
        throw coded('READ_FAILED', 'tapd-stories: 读取需求失败');
      }
      if (remote.behavior.getStory === 'NOT_FOUND') {
        throw coded('NOT_FOUND', 'tapd-stories: 未找到需求');
      }
      const found = remote.stories.find(
        (story) => story.workspaceId === String(workspaceId) && story.id === String(id),
      );
      if (!found) throw coded('NOT_FOUND', 'tapd-stories: 未找到需求');
      return found;
    },
  };
}

async function submissionHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-submit-'));
  const file = join(dir, 'state', 'requirements.json');
  const store = openRequirementStore(file);
  const request = options.request ?? submissionRequest();

  const parentTarget = options.parent ?? { mode: 'create', title: PARENT_TITLE };
  const frozen = freezeBatch({
    request,
    selectedKeys: options.selectedKeys ?? ['M01', 'M02'],
    target: options.freezeTarget ?? { ...targets.weapon, parent: parentTarget },
    actorId: options.actorId ?? 'ou_reviewer',
    now: '2026-10-31T00:00:00.000Z',
    batchId: options.batchId ?? 'b1',
  });
  if (options.tamper) options.tamper(frozen);

  const foreignUrl = 'https://example.feishu.cn/docx/doxcn_a_different_document';
  const seeded = options.seedParent || options.seedForeignParent
    ? [{
      id: '1159180547001009000',
      workspaceId: WORKSPACE,
      name: PARENT_TITLE,
      parentId: '0',
      childrenIds: [],
      ancestorId: '0',
      level: '0',
      workitemTypeId: targets.weapon.parentTypeId,
      templatedId: targets.weapon.templateId,
      iterationId: '',
      description: options.seedForeignParent
        ? `【需求文档】<a href="${foreignUrl}">${foreignUrl}</a>`
          + '（文档 ID：doxcn_a_different_document）<br />【追踪标识】preexisting-parent'
        : `【需求文档】<a href="${makeSnapshot().url}">${makeSnapshot().url}</a>`
          + `（文档 ID：${makeSnapshot().documentId}）<br />【追踪标识】preexisting-parent`,
    }]
    : [];

  const remote = {
    stories: seeded,
    calls: [],
    createdKeys: [],
    reads: [],
    behavior: options.behavior ?? {},
    complete: options.complete ?? {},
    unknownLands: options.unknownLands ?? {},
    titleToKey: new Map(frozen.stories.map((story) => [story.fields.title, story.key])),
  };
  const tapd = options.tapd ?? createFakeTapd(remote);
  const documents = {
    revalidate: async () => {
      documents.calls += 1;
      if (documents.thrower) throw documents.thrower;
      return documents.result;
    },
    result: options.revalidate ?? { unchanged: true, changes: [] },
    calls: 0,
    thrower: options.revalidateError ?? null,
    cleanup: () => {},
  };

  const presetParent = (options.items ?? []).find((item) => item.key === 'parent');
  const submission = {
    id: frozen.id,
    requestId: frozen.requestId,
    batch: frozen,
    payloadHash: frozen.payloadHash,
    status: options.status ?? 'pending',
    parentStoryId: frozen.parent.mode === 'bind'
      ? frozen.parent.storyId
      : presetParent?.status === 'created' ? presetParent.storyId : null,
    startedAt: null,
    updatedAt: null,
    items: options.items ?? [],
    notes: [],
  };
  await store.transaction((state) => {
    state.requests[request.id] = { ...structuredClone(request), submissions: [submission] };
  });

  // A store facade that fails chosen transactions models a disk write failure:
  // requirement-store keeps its previous state whenever writeAtomic throws.
  let txCount = 0;
  const failures = new Set(options.transactionFailures ?? []);
  const storeFacade = {
    get: (id) => store.get(id),
    list: () => store.list(),
    transaction: (fn) => {
      txCount += 1;
      if (failures.has(txCount)) return Promise.reject(new Error('disk full'));
      return store.transaction(fn);
    },
    close: () => store.close(),
  };

  let clockAt = Date.parse('2026-10-31T00:00:00.000Z');
  const submitter = createRequirementSubmitter({
    store: storeFacade,
    tapd,
    documents,
    targets: options.targets ?? targets,
    clock: { now: () => new Date(clockAt += 1) },
    limits: options.limits,
  });

  return {
    dir,
    file,
    store,
    remote,
    tapd,
    documents,
    submitter,
    frozen,
    request,
    batch: () => store.get('r1').submissions[0],
    ledgerJson: () => readFileSync(file, 'utf8'),
    async reopen(extra = {}) {
      const reopened = openRequirementStore(file);
      const next = createRequirementSubmitter({
        store: reopened,
        tapd: options.tapd ?? tapd,
        documents,
        targets: options.targets ?? targets,
        clock: { now: () => new Date(clockAt += 1) },
        limits: options.limits,
        ...extra,
      });
      return { store: reopened, submitter: next };
    },
    async close() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The plan's mandated RED case: an unknown child result must never be replayed.
test('unknown child result never causes an automatic repeat', async (t) => {
  const h = await submissionHarness({ behavior: { M02: 'unknown' } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const batch = h.store.get('r1').submissions[0];
  assert.equal(batch.items.find((i) => i.key === 'parent').status, 'created');
  assert.equal(batch.items.find((i) => i.key === 'M02').status, 'unknown');
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
});

test('first submit materializes frozen items in topological order', async (t) => {
  const h = await submissionHarness();
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const batch = h.batch();
  assert.deepEqual(batch.items.map((item) => item.key), ['parent', 'M01', 'M02']);
  assert.deepEqual(batch.items.map((item) => item.status), ['created', 'created', 'created']);
  for (const item of batch.items) {
    assert.match(item.marker, /^req-[A-Za-z0-9_-]{1,59}$/);
    assert.equal(item.marker.startsWith(`req-${item.key.slice(0, 24)}-`), true, item.key);
  }
  assert.equal(batch.status, 'completed');
  assert.equal(batch.parentStoryId, h.remote.stories[0].id);
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
  assert.equal(h.batch().items.find((i) => i.key === 'M02').storyId.length > 0, true);
});

test('a restart keeps the same markers and never replays created stories', async (t) => {
  const h = await submissionHarness();
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const first = h.batch().items.map((item) => item.marker);
  const createdBefore = [...h.remote.createdKeys];
  assert.equal(createdBefore.length, 3);

  const reopened = await h.reopen();
  t.after(() => reopened.store.close());
  await reopened.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(reopened.store.get('r1').submissions[0].items.map((item) => item.marker), first);
  assert.deepEqual(h.remote.createdKeys, createdBefore);
});

test('markers follow the documented hash formula', async (t) => {
  const h = await submissionHarness();
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  for (const key of ['parent', 'M01', 'M02']) {
    const item = h.batch().items.find((entry) => entry.key === key);
    assert.equal(item.marker, markerOf(key));
    assert.match(item.marker, /^[A-Za-z0-9_-]{1,64}$/);
  }
});

test('a batch that does not match its frozen identity is refused before any remote call', async (t) => {
  const cases = [
    {
      name: 'unknown request',
      submit: { requestId: 'r_missing', batchId: 'b1' },
      code: 'UNKNOWN_REQUEST',
    },
    {
      name: 'unknown batch',
      submit: { requestId: 'r1', batchId: 'b_missing' },
      code: 'UNKNOWN_BATCH',
    },
    {
      name: 'missing target',
      request: submissionRequest({ projectId: 'gear' }),
      code: 'INVALID_TARGET',
    },
    {
      name: 'other workspace',
      freezeTarget: { ...targets.weapon, workspaceId: '99999999', parent: { mode: 'create', title: PARENT_TITLE } },
      code: 'SUBMISSION_MISMATCH',
    },
    {
      name: 'other document',
      tamper: (frozen) => { frozen.documentId = 'doxcn_other'; },
      code: 'SUBMISSION_MISMATCH',
    },
    {
      name: 'other draft version',
      tamper: (frozen) => { frozen.draftVersion = 99; },
      code: 'SUBMISSION_MISMATCH',
    },
    {
      name: 'tampered marker',
      items: [
        { key: 'parent', marker: 'req-parent-0000000000000000', status: 'pending', storyId: null },
        { key: 'M01', marker: markerOf('M01'), status: 'pending', storyId: null },
        { key: 'M02', marker: markerOf('M02'), status: 'pending', storyId: null },
      ],
      code: 'SUBMISSION_MISMATCH',
    },
    {
      name: 'dropped item',
      items: [{ key: 'parent', marker: markerOf('parent'), status: 'pending', storyId: null }],
      code: 'SUBMISSION_MISMATCH',
    },
    {
      name: 'batch over the limit',
      limits: { maxItems: 2 },
      code: 'BATCH_TOO_LARGE',
    },
  ];

  for (const testCase of cases) {
    const h = await submissionHarness(testCase);
    t.after(() => h.close());
    await assert.rejects(
      () => h.submitter.submit({
        requestId: testCase.submit?.requestId ?? 'r1',
        batchId: testCase.submit?.batchId ?? 'b1',
      }),
      { code: testCase.code },
      testCase.name,
    );
    assert.deepEqual(h.remote.createdKeys, [], testCase.name);
    assert.deepEqual(h.remote.reads, [], testCase.name);
    assert.equal(h.documents.calls, 0, testCase.name);
  }
});

test('a changed source stops the batch without any create', async (t) => {
  const h = await submissionHarness({
    revalidate: { unchanged: false, changes: [{ kind: 'resource', fingerprint: 'sha256:changed' }] },
  });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(h.batch().status, 'paused');
  assert.equal(h.batch().notes.some((note) => note.code === 'SOURCE_CHANGED'), true);
});

test('a failed source recheck stops the batch without any create', async (t) => {
  const h = await submissionHarness({ revalidateError: coded('SOURCE_RECHECK_FAILED', 'reader failed') });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(h.batch().notes.some((note) => note.code === 'SOURCE_RECHECK_FAILED'), true);
});

test('an ambiguous existing parent stops the batch instead of picking one', async (t) => {
  const h = await submissionHarness({ seedParent: true });
  t.after(() => h.close());
  h.remote.stories.push({
    ...h.remote.stories[0],
    id: '1159180547001009001',
    description: `${h.remote.stories[0].description} duplicate`,
  });
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(h.batch().notes.some((note) => note.code === 'PARENT_AMBIGUOUS'), true);
});

test('an incomplete parent read cannot prove absence, so nothing is created', async (t) => {
  const h = await submissionHarness({ complete: { findParents: false } });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(h.batch().notes.some((note) => note.code === 'READ_INCOMPLETE'), true);
});

test('a failed parent read stops the batch instead of creating a second parent', async (t) => {
  const h = await submissionHarness({ behavior: { findParents: 'READ_FAILED' } });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(h.batch().notes.some((note) => note.code === 'READ_FAILED'), true);
});

test('binding to an existing parent reuses it after the document identity is proved', async (t) => {
  const h = await submissionHarness({
    parent: { mode: 'bind', storyId: '1159180547001009000' },
    seedParent: true,
  });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['M01', 'M02']);
  const batch = h.batch();
  assert.equal(batch.parentStoryId, '1159180547001009000');
  assert.equal(batch.items.find((item) => item.key === 'parent').status, 'created');
  assert.equal(batch.notes.some((note) => note.code === 'PARENT_BOUND'), true);
});

test('binding to a parent of another document needs an explicit reviewer confirmation', async (t) => {
  const bindTarget = { mode: 'bind', storyId: '1159180547001009000' };

  const plain = await submissionHarness({ parent: bindTarget, seedForeignParent: true });
  t.after(() => plain.close());
  const blocked = await plain.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(blocked.status, 'paused');
  assert.deepEqual(plain.remote.createdKeys, []);
  assert.equal(plain.batch().notes.some((note) => note.code === 'PARENT_MISMATCH'), true);

  const confirmed = await submissionHarness({
    parent: bindTarget,
    seedForeignParent: true,
    request: submissionRequest({
      parentBindOverride: {
        actorId: 'ou_reviewer',
        storyId: '1159180547001009000',
        at: '2026-10-31T00:00:00.000Z',
      },
    }),
  });
  t.after(() => confirmed.close());
  await confirmed.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(confirmed.batch().parentStoryId, '1159180547001009000');
  assert.deepEqual(confirmed.remote.createdKeys, ['M01', 'M02']);
  assert.equal(confirmed.batch().items.find((item) => item.key === 'M01').status, 'created');
});

test('binding to a parent that cannot be read stops the batch', async (t) => {
  const missing = await submissionHarness({
    parent: { mode: 'bind', storyId: '1159180547001009000' },
    seedParent: true,
    behavior: { getStory: 'NOT_FOUND' },
  });
  t.after(() => missing.close());
  const result = await missing.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.status, 'paused');
  assert.deepEqual(missing.remote.createdKeys, []);
  assert.equal(missing.batch().notes.some((note) => note.code === 'PARENT_NOT_FOUND'), true);

  const unreadable = await submissionHarness({
    parent: { mode: 'bind', storyId: '1159180547001009000' },
    seedParent: true,
    behavior: { getStory: 'READ_FAILED' },
  });
  t.after(() => unreadable.close());
  await unreadable.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(unreadable.remote.createdKeys, []);
  assert.equal(unreadable.batch().notes.some((note) => note.code === 'READ_FAILED'), true);
});

test('a parent that is not created leaves every child unposted', async (t) => {
  for (const mode of ['rejected', 'unsent', 'unknown']) {
    const h = await submissionHarness({ behavior: { parent: mode } });
    t.after(() => h.close());
    const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
    assert.deepEqual(h.remote.createdKeys, ['parent'], mode);
    assert.equal(result.items.find((item) => item.key === 'M01').status, 'pending', mode);
    assert.equal(result.items.find((item) => item.key === 'M02').status, 'pending', mode);
    const expected = { rejected: 'rejected', unsent: 'pending', unknown: 'unknown' }[mode];
    assert.equal(h.batch().items.find((item) => item.key === 'parent').status, expected, mode);
    assert.equal(h.batch().status, 'paused', mode);
  }
});

test('a rejected child is never retried by submit or resume', async (t) => {
  const h = await submissionHarness({ behavior: { M01: 'rejected' } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01']);
  assert.equal(h.batch().items.find((item) => item.key === 'M01').status, 'rejected');
  // The run stops at the first unproven result, so M02 was never attempted:
  // it stays pending until something tries it, and then it is blocked.
  assert.equal(h.batch().items.find((item) => item.key === 'M02').status, 'pending');

  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const resumed = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01']);
  assert.equal(resumed.items.find((item) => item.key === 'M01').status, 'rejected');
  assert.equal(resumed.items.find((item) => item.key === 'M02').status, 'blocked');
  assert.equal(resumed.status, 'paused');
});

test('an unsent child is resumed exactly once', async (t) => {
  const h = await submissionHarness({ behavior: { M01: 'unsent' } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01']);
  assert.equal(h.batch().items.find((item) => item.key === 'M01').status, 'pending');

  delete h.remote.behavior.M01;
  const resumed = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_initiator' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M01', 'M02']);
  assert.equal(resumed.status, 'completed');
  assert.equal(h.batch().status, 'completed');
});

test('an interrupted run downgrades sending items to unknown before touching the remote', async (t) => {
  const h = await submissionHarness({
    status: 'running',
    items: [
      { key: 'parent', marker: markerOf('parent'), status: 'created', storyId: '1159180547001000000' },
      { key: 'M01', marker: markerOf('M01'), status: 'sending', storyId: null },
      { key: 'M02', marker: markerOf('M02'), status: 'pending', storyId: null },
    ],
  });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(h.batch().items.find((item) => item.key === 'M01').status, 'unknown');
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(result.items.find((item) => item.key === 'M02').status, 'blocked');
  assert.equal(h.batch().notes.some((note) => note.code === 'SENDING_RECOVERED'), true);
});

test('a double click creates each story once', async (t) => {
  const h = await submissionHarness();
  t.after(() => h.close());
  const [first, second] = await Promise.all([
    h.submitter.submit({ requestId: 'r1', batchId: 'b1' }),
    h.submitter.submit({ requestId: 'r1', batchId: 'b1' }),
  ]);
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
});

test('a failed sending write stops the batch before the post', async (t) => {
  const h = await submissionHarness({ transactionFailures: [2] });
  t.after(() => h.close());
  const result = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, []);
  assert.equal(result.status, 'paused');
  assert.equal(h.batch().items.find((item) => item.key === 'parent').status, 'pending');
  assert.equal(h.batch().notes.some((note) => note.code === 'LEDGER_WRITE_FAILED'), true);
});

test('a failed created writeback is backfilled by reconcile without a second post', async (t) => {
  const h = await submissionHarness({ transactionFailures: [3] });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['parent']);
  assert.equal(h.batch().status, 'paused');
  // The post landed but the id never reached the ledger: the item stays
  // `sending`, which is the signal reconcile reads back.
  assert.equal(h.batch().items.find((item) => item.key === 'parent').status, 'sending');

  const reconciled = await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['parent']);
  assert.equal(h.batch().items.find((item) => item.key === 'parent').status, 'created');
  assert.equal(h.batch().parentStoryId, h.remote.stories[0].id);
  assert.equal(reconciled.status, 'needs_review');

  const resumed = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
  assert.equal(resumed.status, 'completed');
});

test('reconcile claims an unknown story only from an exact marker match', async (t) => {
  const h = await submissionHarness({ behavior: { M01: 'unknown' }, unknownLands: { M01: true } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.equal(h.batch().items.find((item) => item.key === 'M01').status, 'unknown');

  const result = await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  const child = h.batch().items.find((item) => item.key === 'M01');
  // Reconcile is read-only: it claims the story it can prove and never posts the
  // child that was never attempted.
  assert.equal(child.status, 'created');
  assert.equal(child.storyId, h.remote.stories[1].id);
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01']);
  assert.equal(h.batch().items.find((item) => item.key === 'M02').status, 'pending');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.parentStoryId, h.batch().parentStoryId);

  const resumed = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
  assert.equal(resumed.status, 'completed');
});

test('reconcile keeps an unknown story unknown on ambiguous, partial or empty reads', async (t) => {
  const ambiguous = await submissionHarness({ behavior: { M01: 'unknown' }, unknownLands: { M01: true } });
  t.after(() => ambiguous.close());
  await ambiguous.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const created = ambiguous.remote.stories.find((story) => story.name === ambiguous.frozen.stories[0].fields.title);
  ambiguous.remote.stories.push({ ...created, id: '999999999999999999' });
  await ambiguous.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  assert.equal(ambiguous.batch().items.find((item) => item.key === 'M01').status, 'unknown');
  assert.equal(ambiguous.batch().notes.some((note) => note.code === 'AMBIGUOUS_MATCH'), true);

  const partial = await submissionHarness({
    behavior: { M01: 'unknown' },
    unknownLands: { M01: true },
    complete: { findByMarker: false },
  });
  t.after(() => partial.close());
  await partial.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await partial.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  assert.equal(partial.batch().items.find((item) => item.key === 'M01').status, 'unknown');
  assert.equal(partial.batch().notes.some((note) => note.code === 'READ_INCOMPLETE'), true);

  const absent = await submissionHarness({ behavior: { M01: 'unknown' } });
  t.after(() => absent.close());
  await absent.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await absent.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  assert.equal(absent.batch().items.find((item) => item.key === 'M01').status, 'unknown');
  assert.deepEqual(absent.remote.createdKeys, ['parent', 'M01']);
  assert.equal(absent.batch().notes.some((note) => note.code === 'NOT_FOUND'), true);
});

test('reconcile refuses children while the parent is still unresolved', async (t) => {
  const h = await submissionHarness({ behavior: { parent: 'unknown' } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const result = await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  assert.equal(result.parentStoryId, null);
  // The parent POST's outcome was lost, so there is no id to match children
  // against. The child was never attempted and reconcile must not attempt it.
  assert.equal(result.items.find((item) => item.key === 'parent').status, 'unknown');
  assert.equal(result.items.find((item) => item.key === 'M01').status, 'pending');
  assert.equal(h.batch().notes.some((note) => note.code === 'PARENT_UNRESOLVED'), true);
  assert.deepEqual(h.remote.createdKeys, ['parent']);
});

test('reconcile never posts a story for a batch that was never submitted', async (t) => {
  const h = await submissionHarness();
  t.after(() => h.close());
  const result = await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  // Reconcile is read-only and never materializes or creates: a story that was
  // never attempted stays un-attempted until submit runs.
  assert.deepEqual(h.remote.createdKeys, []);
  assert.deepEqual(h.remote.reads, ['findParents']);
  assert.equal(result.status, 'paused');
  assert.equal(result.parentStoryId, null);
  assert.equal(h.batch().items.length, 0);
  assert.equal(h.batch().notes.some((note) => note.code === 'NOT_FOUND'), true);
});

test('resume needs a reviewer and refuses to replay unknown items', async (t) => {
  const h = await submissionHarness({ behavior: { M01: 'unknown' }, unknownLands: { M01: true } });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });

  await assert.rejects(
    () => h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_stranger' }),
    { code: 'NOT_REVIEWER' },
  );
  const blocked = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.equal(blocked.status, 'paused');
  assert.equal(h.batch().notes.some((note) => note.code === 'UNKNOWN_PENDING'), true);
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01']);

  await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  const resumed = await h.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_initiator' });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
});

test('resume completes a fully created batch and reports a partial one', async (t) => {
  const done = await submissionHarness();
  t.after(() => done.close());
  await done.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const completed = await done.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(done.remote.createdKeys, ['parent', 'M01', 'M02']);

  const partial = await submissionHarness({
    status: 'needs_review',
    items: [
      { key: 'parent', marker: markerOf('parent'), status: 'created', storyId: '1159180547001000000' },
      { key: 'M01', marker: markerOf('M01'), status: 'created', storyId: '1159180547001000001' },
      { key: 'M02', marker: markerOf('M02'), status: 'rejected', storyId: null },
    ],
  });
  t.after(() => partial.close());
  const result = await partial.submitter.resume({ requestId: 'r1', batchId: 'b1', actorId: 'ou_reviewer' });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(partial.remote.createdKeys, []);
});

test('an unproven parent is never posted twice', async (t) => {
  const landed = await submissionHarness({ behavior: { parent: 'unknown' }, unknownLands: { parent: true } });
  t.after(() => landed.close());
  await landed.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await landed.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  // The read-back proves the parent, so the second run attaches to it instead of
  // posting a second root.
  assert.deepEqual(landed.remote.createdKeys, ['parent', 'M01', 'M02']);
  assert.equal(landed.batch().items.find((item) => item.key === 'parent').status, 'created');
  assert.equal(landed.batch().notes.some((note) => note.code === 'PARENT_REUSED'), true);

  const missing = await submissionHarness({ behavior: { parent: 'unknown' } });
  t.after(() => missing.close());
  await missing.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const second = await missing.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(missing.remote.createdKeys, ['parent']);
  assert.equal(second.status, 'paused');
  assert.equal(missing.batch().notes.some((note) => note.code === 'PARENT_UNRESOLVED'), true);
});

test('nothing but fixed codes carries the failure text out of the module', async (t) => {
  const h = await submissionHarness({ behavior: { M01: 'leaky' } });
  t.after(() => h.close());
  const summary = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const second = await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await h.submitter.reconcile({ requestId: 'r1', batchId: 'b1' });
  const ledger = h.ledgerJson();
  const rendered = JSON.stringify([summary, second, h.batch().notes, ledger]);

  for (const secret of [SECRET, ASSET_PATH]) {
    assert.equal(rendered.includes(secret), false, secret);
  }
  assert.equal(JSON.stringify(summary).includes(DOC_TEXT), false);
  for (const note of h.batch().notes) {
    assert.match(note.code, /^[A-Z][A-Z_]{2,49}$/);
    assert.deepEqual(Object.keys(note).sort(), ['at', 'code']);
  }
  assert.deepEqual(Object.keys(summary).sort(), ['items', 'notes', 'parentStoryId', 'status']);
  for (const item of summary.items) {
    assert.deepEqual(Object.keys(item).sort(), ['key', 'marker', 'status', 'storyId']);
  }
});

test('a parent that already exists for the same document is reused, not rebuilt', async (t) => {
  const h = await submissionHarness({ seedParent: true });
  t.after(() => h.close());
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  assert.deepEqual(h.remote.createdKeys, ['M01', 'M02']);
  const batch = h.batch();
  assert.equal(batch.items.find((i) => i.key === 'parent').status, 'created');
  assert.equal(batch.parentStoryId, '1159180547001009000');
  assert.equal(batch.notes.some((note) => note.code === 'PARENT_REUSED'), true);
});
