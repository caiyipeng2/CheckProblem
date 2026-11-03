// Task 12: the whole requirement flow end to end. The document reader, the model
// parser, the ledger, the coordinator, the submitter and the TAPD adapter are the
// real modules; only the three outside edges are replaced — the lark-cli process
// (replaying the Task 1 sanitised fixture), the model reply, and the TAPD HTTP
// transport. A gate that lives only in a card cannot pass here: every assertion
// reads the ledger or what the transport actually received.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPlanningDocumentReader } from '../src/planning-document.js';
import { createDecomposer } from '../src/decompose.js';
import { openRequirementStore } from '../src/requirement-store.js';
import { createTapdStories } from '../src/tapd-stories.js';
import { createRequirementSubmitter } from '../src/requirement-submit.js';
import { createRequirementRequests } from '../src/requirement-requests.js';
import { requirementTargets } from '../src/requirement-config.js';
import { createWorkSlot } from '../src/work-slot.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/requirement-platform.json', import.meta.url), 'utf8'));

const CHAT = 'oc_e2e';
const BOT = 'ou_bot';
const INITIATOR = 'ou_initiator';
const REVIEWER = 'ou_reviewer';
const OUTSIDER = 'ou_wellformed_but_not_a_reviewer';
const WORKSPACE = '59180547';
const PARENT_ID = '1159180547001004412';
const DOC_URL = 'https://example.feishu.cn/docx/syntheticDocToken';
const TOKEN = 'e2e-token-not-a-real-credential';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let clockTicks = 0;
const clockNow = () => new Date(Date.parse('2026-11-03T00:00:00.000Z') + (clockTicks += 1000));

// --------------------------------------------------------------- outside edges

function ok(payload) {
  return { code: 0, stdout: JSON.stringify({ ok: true, data: payload }) };
}

// The fixture is what the CLI actually answered when Task 1 recorded the real
// platform shapes; replaying it keeps the reader real instead of handing it a
// hand-built snapshot.
function replayCli(calls) {
  return async (cmd, args) => {
    if (cmd !== 'lark-cli') return { code: 1, stdout: '', stderr: 'unexpected command' };
    calls.push([...args]);
    const [group, sub] = args;
    if (group === 'docs' && sub === '+fetch') return { code: 0, stdout: JSON.stringify(FIXTURE.document.fetchEnvelope) };
    if (group === 'drive' && sub === '+list-comments') {
      return ok({ items: [], has_more: false, count: 0 });
    }
    return { code: 1, stdout: '', stderr: 'no reader for this resource' };
  };
}

// The three blocks the fixture's own content declares. The scripted model reply
// is written against them, so the decomposition stays a function of the real
// snapshot rather than of a hand-built one.
const BLOCK_IDS = ['synthetic', 'synthetic-h1', 'synthetic-p'];

function scriptedChat(calls, { firstTitle = '大厅入口与倒计时', firstRule = '活动期间显示大厅入口。' } = {}) {
  const chat = async ({ prompt }) => {
    calls.push(prompt);
    if (prompt.includes('"facts":[{"kind"')) {
      return {
        text: JSON.stringify({
          facts: BLOCK_IDS.map((id) => ({ kind: 'source', text: `[synthetic] ${id} 的规则原文。`, sourceIds: [id] })),
        }),
      };
    }
    if (prompt.includes('"stories":[{"key"')) {
      return {
        text: JSON.stringify({
          stories: [
            {
              key: 'M01',
              title: firstTitle,
              rules: [{ text: firstRule, factIds: ['F1', 'F2'] }],
              acceptance: [{ text: '开启前可见倒计时。', factIds: ['F1'] }],
              dependencies: [],
              sourceIds: ['synthetic', 'synthetic-h1'],
            },
            {
              key: 'M02',
              title: '说明文案',
              rules: [{ text: '正文按文档展示。', factIds: ['F3'] }],
              acceptance: [{ text: '文案与文档一致。', factIds: ['F3'] }],
              dependencies: ['M01'],
              sourceIds: ['synthetic-p'],
            },
          ],
          issues: [],
        }),
      };
    }
    return { text: JSON.stringify({ stories: [], issues: [] }) };
  };
  chat.calls = calls;
  return chat;
}

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

// A TAPD that answers the adapter's documented GET/POST shapes and records every
// write, so the assertions see exactly what would have reached the tracker.
function fakeTapdTransport(remote, options = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/stories') return jsonResponse({ status: 0, info: 'unsupported' });

    if ((init.method ?? 'GET') === 'GET') {
      const workspaceId = parsed.searchParams.get('workspace_id');
      const id = parsed.searchParams.get('id');
      const page = Number(parsed.searchParams.get('page') ?? '1');
      let items = remote.stories.filter((story) => story.workspace_id === workspaceId);
      if (id) items = items.filter((story) => story.id === id);
      if (parsed.searchParams.get('parent_id')) {
        items = items.filter((story) => story.parent_id === parsed.searchParams.get('parent_id'));
      }
      remote.reads.push({ id, workspaceId, page });
      // Pagination is real: the adapter only believes a scan is complete when a
      // page comes back empty.
      return jsonResponse({ status: 1, data: page === 1 ? items.map((story) => ({ Story: story })) : [] });
    }

    if (options.failCreate) return { ok: true, status: 500, text: async () => 'gateway error' };

    const fields = Object.fromEntries(new URLSearchParams(init.body));
    const id = String(1159180547001009000n + BigInt(remote.stories.length));
    const story = {
      id,
      workspace_id: fields.workspace_id,
      name: fields.name,
      parent_id: fields.parent_id ?? '0',
      workitem_type_id: fields.workitem_type_id ?? '',
      templated_id: fields.templated_id ?? '',
      iteration_id: fields.iteration_id ?? '',
      owner: fields.owner ?? '',
      description: fields.description ?? '',
    };
    remote.stories.push(story);
    remote.created.push(story);
    return jsonResponse({ status: 1, data: { Story: { id } } });
  };
}

// -------------------------------------------------------------------- harness

async function endToEndHarness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'req-e2e-'));
  dirs.push(dir);

  const remote = {
    stories: [{
      id: PARENT_ID,
      workspace_id: WORKSPACE,
      name: '勋章挑战功能需求',
      parent_id: '0',
      description: overrides.parentDescription ?? '<p>来源文档：https://example.feishu.cn/docx/syntheticDocToken</p>',
    }],
    created: [],
    reads: [],
  };
  const cliCalls = [];
  const chatCalls = [];
  const cards = [];
  const updates = [];
  const notices = [];

  const config = {
    selfOpenId: BOT,
    chatId: CHAT,
    tapd: { workspaces: { weapon: { workspaceId: WORKSPACE } } },
    requirements: {
      allowedSenders: [INITIATOR, REVIEWER],
      reviewers: [REVIEWER],
      documentHosts: ['example.feishu.cn'],
      modelAttempt: 0,
      attempt: { kind: 'chat', baseUrl: 'https://model.invalid/v1', model: 'e2e', apiKeyFile: 'secrets/model.key', apiKeyEnv: '' },
      projects: {
        weapon: {
          parentTypeId: '1159180547001000025',
          childTypeId: '1159180547001000027',
          templateId: '1159180547001000039',
          parentStoryId: PARENT_ID,
          owners: ['已核实成员甲'],
          iterationIds: ['1159180547001000128'],
        },
      },
      paths: { stateFile: join(dir, 'state', 'requirements.json'), assetsDir: join(dir, 'state', 'requirement-assets') },
    },
  };
  Object.assign(config.requirements, overrides.requirements ?? {});

  const store = openRequirementStore(config.requirements.paths.stateFile);
  const documents = createPlanningDocumentReader({
    run: replayCli(cliCalls),
    hosts: config.requirements.documentHosts,
    assetsDir: config.requirements.paths.assetsDir,
  });
  const decomposer = createDecomposer({ chat: scriptedChat(chatCalls, { firstTitle: overrides.storyTitle, firstRule: overrides.firstRule }) });
  const tapd = createTapdStories({
    tokenFile: 'C:/secrets/tapd.token',
    request: fakeTapdTransport(remote, overrides.transport ?? {}),
    readFile: () => TOKEN,
  });
  const submitter = createRequirementSubmitter({
    store,
    tapd,
    documents,
    targets: requirementTargets(config),
    clock: { now: clockNow },
  });
  const slot = createWorkSlot({ log: { info() {}, warn() {}, error() {} } });
  const lark = {
    async replyCard(messageId, card) {
      cards.push({ messageId, card });
      return { messageId: `om_card_${cards.length}` };
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card });
    },
    async reply(messageId, text) {
      notices.push({ messageId, text });
    },
    async send(chatId, text) {
      notices.push({ chatId, text });
      return { messageId: 'om_notice' };
    },
  };

  const flow = createRequirementRequests({
    config,
    store,
    lark,
    documents,
    decomposer,
    submitter,
    slot,
    clock: clockNow,
    log: { info() {}, warn() {}, error() {} },
  });

  let messageSeq = 0;
  const nextMessageId = () => (messageSeq += 1, `om_msg_${messageSeq}`);

  const harness = {
    config,
    store,
    flow,
    remote,
    cliCalls,
    chatCalls,
    cards,
    updates,
    notices,
    request: () => store.list()[0],

    // A new process: same ledger file, same transport, fresh modules.
    restart() {
      const store = openRequirementStore(config.requirements.paths.stateFile);
      const submitter = createRequirementSubmitter({
        store,
        tapd: createTapdStories({
          tokenFile: 'C:/secrets/tapd.token',
          request: fakeTapdTransport(remote, overrides.transport ?? {}),
          readFile: () => TOKEN,
        }),
        documents: createPlanningDocumentReader({
          run: replayCli([]),
          hosts: config.requirements.documentHosts,
          assetsDir: config.requirements.paths.assetsDir,
        }),
        targets: requirementTargets(config),
        clock: { now: clockNow },
      });
      return { store, submitter };
    },

    async sendPlanningDocument({ actor = INITIATOR, text = `拆分需求 ${DOC_URL}` } = {}) {
      const accepted = await flow.handleMessage({
        message_id: nextMessageId(),
        chat_id: CHAT,
        sender: { id: actor, sender_type: 'user' },
        msg_type: 'text',
        body: { content: JSON.stringify({ text }) },
        mentions: [{ id: { open_id: BOT } }],
      });
      await flow.whenIdle();
      return accepted;
    },

    action(name, extra = {}) {
      const request = store.list()[0];
      return {
        type: 'card.action.trigger',
        event_id: `ev_${name}_${(messageSeq += 1)}`,
        chat_id: CHAT,
        message_id: 'om_card_1',
        operator_id: extra.actor ?? REVIEWER,
        action_tag: 'button',
        action_value: JSON.stringify({
          workflow: 'requirements',
          requestId: request.id,
          draftVersion: request.draft.version,
          action: name,
          key: extra.key ?? '',
          page: 0,
        }),
      };
    },

    async press(name, extra = {}) {
      const accepted = flow.enqueue(harness.action(name, extra));
      await flow.whenIdle();
      return accepted;
    },

    // The reviewer names the existing parent in the chat after pressing the card's
    // parent button; the ledger keeps that id and the submitter re-reads it.
    async bindParent(storyId, { actor = REVIEWER } = {}) {
      await harness.press('bind_parent', { actor });
      await flow.handleMessage({
        message_id: nextMessageId(),
        chat_id: CHAT,
        sender: { id: actor, sender_type: 'user' },
        msg_type: 'text',
        body: { content: JSON.stringify({ text: storyId }) },
      });
      await flow.whenIdle();
    },

    // The reviewer's path through the card: read every detail, read the confirm
    // page, decide each story, re-read the new confirm page, submit. The version
    // is re-read for every press, so a stale callback is never sent by accident.
    async review({ selectedKeys = ['M01'], parentId } = {}) {
      if (parentId) await harness.bindParent(parentId);
      const request = store.list()[0];
      const keys = request.draft.stories.map((story) => story.key);
      for (const key of keys) await harness.press('detail', { key });
      await harness.press('confirm');
      for (const key of keys) {
        await harness.press(selectedKeys.includes(key) ? 'approve' : 'defer', { key });
      }
      // Every decision bumps the draft version, which voids what this reviewer had
      // read; the card forces a fresh read before the submit can go through.
      for (const key of keys) await harness.press('detail', { key });
      await harness.press('confirm');
      await harness.press('submit');
    },
  };

  return harness;
}

// ---------------------------------------------------------------------- tests

test('a reviewed document creates only approved children under the bound parent', async () => {
  const h = await endToEndHarness();
  assert.equal(await h.sendPlanningDocument(), true, 'the planning message belongs to this flow');
  assert.equal(h.cliCalls.filter((args) => args[0] === 'docs' && args[1] === '+fetch').length, 1, 'the analysis reads the document once');

  const request = h.request();
  assert.ok(request, 'the ledger holds the request');
  assert.deepEqual(request.draft.stories.map((story) => story.key).sort(), ['M01', 'M02']);
  assert.equal(h.remote.created.length, 0, 'analysis alone never writes to TAPD');

  await h.review({ selectedKeys: ["M01"], parentId: PARENT_ID });

  const after = h.request();
  const deferred = after.draft.stories.find((story) => story.key === 'M02');
  assert.equal(deferred.disposition, 'deferred', 'the untouched story stays out of the batch');
  // Deferred is not excluded: the ledger keeps the story on the request, so the
  // batch that did land is reported as partial rather than complete.
  assert.equal(after.status, 'partially_completed');
  assert.deepEqual(
    h.remote.created.map((story) => [story.name, story.parent_id]),
    [['大厅入口与倒计时', PARENT_ID]],
    'exactly one child, bound to the existing parent',
  );
  assert.equal(h.remote.created.some((story) => story.parent_id === '0'), false, 'no parent is ever created');
  assert.equal(h.remote.created.at(-1).workspace_id, WORKSPACE);
  assert.equal(h.remote.created.at(-1).workitem_type_id, '1159180547001000027');
  assert.equal(h.remote.created.at(-1).templated_id, '1159180547001000039');
});

test('a failed creation is recorded as unknown and is never retried behind the reviewer', async () => {
  const h = await endToEndHarness({ transport: { failCreate: true } });
  await h.sendPlanningDocument();
  await h.review({ selectedKeys: ["M01"], parentId: PARENT_ID });

  const request = h.request();
  assert.equal(request.status, 'needs_review');
  const item = request.submissions[0].items.find((entry) => entry.key === 'M01');
  assert.equal(item.status, 'unknown', 'a 5xx proves nothing about whether the write landed');
  assert.equal(h.remote.created.length, 0);

  // A second submit pressed after the unknown must not write again.
  await h.press('submit');
  assert.equal(h.remote.created.length, 0);
  assert.equal(h.request().submissions.length, 1, 'no second batch is frozen for the same draft');
});

test('another person cannot approve or submit, and nothing reaches TAPD', async () => {
  const h = await endToEndHarness();
  await h.sendPlanningDocument();
  await h.press('approve', { key: 'M01', actor: OUTSIDER });
  await h.press('submit', { actor: OUTSIDER });

  assert.equal(h.request().draft.version, 1, 'the outsider changed nothing');
  assert.equal(h.request().submissions.length, 0);
  assert.equal(h.remote.created.length, 0);
});

test('the same document sent twice does not start a second analysis or a second card', async () => {
  const h = await endToEndHarness();
  await h.sendPlanningDocument();
  const firstReads = h.cliCalls.filter((args) => args[0] === 'docs' && args[1] === '+fetch').length;

  await h.sendPlanningDocument();

  assert.equal(
    h.cliCalls.filter((args) => args[0] === 'docs' && args[1] === '+fetch').length,
    firstReads,
    'the document is not read again for a duplicate message',
  );
  assert.equal(h.store.list().length, 1, 'one request, not two');
  assert.equal(h.remote.created.length, 0);
});

test('a completed batch is not written again after a restart', async () => {
  const h = await endToEndHarness();
  await h.sendPlanningDocument();
  await h.review({ selectedKeys: ['M01'], parentId: PARENT_ID });
  assert.equal(h.remote.created.length, 1);

  const reopened = h.restart();
  assert.equal(reopened.store.list().length, 1, 'the ledger survived the restart');
  const recovered = reopened.store.list()[0];
  const result = await reopened.submitter.resume({
    requestId: recovered.id,
    batchId: recovered.submissions[0].batch.id,
    actorId: REVIEWER,
  });
  assert.equal(result?.status, 'completed', 'the resumed submitter finds nothing left to write');
  assert.equal(h.remote.created.length, 1, 'a landed story is never written twice');
});

test('a restart finishes the pending items of a paused batch exactly once', async () => {
  // The parent does not cite this document yet, so the first submit pauses with
  // the child still pending — the state a crash between freeze and write leaves.
  const h = await endToEndHarness({ parentDescription: '<p>勋章挑战功能需求（未写来源）</p>' });
  await h.sendPlanningDocument();
  await h.review({ selectedKeys: ['M01'] });

  const paused = h.request();
  assert.equal(paused.blockedReason, 'PARENT_MISMATCH');
  assert.equal(h.remote.created.length, 0);
  const pending = paused.submissions[0].items.filter((item) => item.status === 'pending');
  assert.ok(pending.some((item) => item.key === 'M01'), 'the child is still pending, not lost');

  // The operator fixes the parent in TAPD; the next process may finish the batch.
  h.remote.stories[0].description = '<p>来源文档：https://example.feishu.cn/docx/syntheticDocToken</p>';
  const reopened = h.restart();
  const result = await reopened.submitter.resume({
    requestId: paused.id,
    batchId: paused.submissions[0].batch.id,
    actorId: REVIEWER,
  });

  assert.equal(result?.status, 'completed');
  assert.deepEqual(h.remote.created.map((story) => story.name), ['大厅入口与倒计时'], 'the pending child is written once');
  assert.equal(h.remote.created.filter((story) => story.parent_id === '0').length, 0, 'the bound parent is reused');
});

test('model output is escaped, never injected into the ticket markup', async () => {
  const h = await endToEndHarness({ firstRule: '活动期间显示大厅入口 <script>alert(1)</script>' });
  await h.sendPlanningDocument();
  await h.review({ selectedKeys: ["M01"], parentId: PARENT_ID });

  const created = h.remote.created.at(-1);
  assert.ok(created.description.includes('<br />'), 'the description keeps its real line breaks');
  assert.ok(created.description.includes('&lt;script&gt;'), 'the tag is escaped, not dropped');
  assert.equal(/<script/i.test(created.description), false, 'no raw script tag reaches TAPD');
});

test('an existing parent whose body never mentions the document pauses the batch', async () => {
  // No reviewer override here: the parent comes from the config, so the submitter
  // must re-read it and refuse to write under a parent that does not cite this
  // document.
  const h = await endToEndHarness({ parentDescription: '<p>勋章挑战功能需求（未写来源）</p>' });
  await h.sendPlanningDocument();
  await h.review({ selectedKeys: ['M01'] });

  const request = h.request();
  assert.equal(request.blockedReason, 'PARENT_MISMATCH');
  assert.equal(h.remote.created.length, 0, 'nothing is written under a mismatched parent');
});
