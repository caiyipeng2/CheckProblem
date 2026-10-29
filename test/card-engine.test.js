import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/index.js';
import { initialState } from '../src/state.js';

const message = (id, text, t = 10, sender = 'ou_member') => ({
  message_id: id, create_time: String(t), msg_type: 'text', sender: { id: sender },
  body: { content: JSON.stringify({ text }) },
});
const imageMessage = (id, fileKey, t = 10, sender = 'ou_member') => ({
  message_id: id, create_time: String(t), msg_type: 'image', sender: { id: sender },
  body: { content: JSON.stringify({ image_key: fileKey }) },
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const projects = [
  { id: 'weapon', name: '武器店', branch: 'master', dir: 'owned/weapon', url: 'https://example.com/weapon.git' },
  { id: 'gear', name: '齿轮', branch: 'develop', dir: 'owned/gear', url: 'https://example.com/gear.git' },
];

function harness(overrides = {}) {
  let now = 1000;
  let batch = [message('om_question', '蔡龙 查询奖励逻辑')];
  const state = initialState(0);
  const replies = [], cards = [], updates = [], calls = [], saves = [], warnings = [], downloads = [];
  const config = {
    chatId: 'oc_test', selfOpenId: 'ou_self', triggerKeyword: '蔡龙',
    confirmTimeoutSec: 600, contextMessages: 2, maxReplyChars: 4000,
    projects, defaultProjectId: 'weapon',
    paths: { jobsDir: 'unused', imagesDir: join(tmpdir(), 'checkproblem-images-unused') },
    ...(overrides.tapdConfig ? { tapd: overrides.tapdConfig } : {}),
  };
  const lark = {
    listMessages: async () => batch,
    reply: async (id, text) => { replies.push({ id, text }); return { messageId: 'om_text' }; },
    replyCard: async (id, card) => { cards.push({ id, card }); return { messageId: 'om_card' }; },
    updateCard: async (id, card) => { updates.push({ id, card }); },
    getSenderName: async () => '确认人',
    downloadImage: async ({ messageId, fileKey, outputPath }) => {
      downloads.push({ messageId, fileKey, outputPath });
      const path = `${outputPath}.png`;
      writeFileSync(path, PNG);
      return { path };
    },
    ...overrides.lark,
  };
  const engine = createEngine({
    config, state, lark, clock: () => now,
    log: { info() {}, warn: (s) => warnings.push(s), error: (s) => warnings.push(s) },
    saveState: (s) => saves.push(structuredClone(s)),
    listBranches: async (p) => p.id === 'weapon' ? ['master', 'feature/rewards'] : ['develop', 'release/v2'],
    syncRepo: async (repo) => { calls.push(['sync', repo]); return { provenance: `${repo.branch}@abc1234` }; },
    retrieve: async (question, repo) => { calls.push(['search', repo]); return { digest: 'evidence' }; },
    runAnalysis: async (prompt, repo) => { calls.push(['analysis', repo]); return { text: '查询结果' }; },
    tapd: overrides.tapdClient ?? null,
    ...overrides.engine,
  });
  function event(action, option, extra = {}) {
    const job = state.job;
    return {
      type: 'card.action.trigger', event_id: `evt-${action}-${job?.revision}-${option ?? ''}`,
      chat_id: 'oc_test', message_id: 'om_card', operator_id: 'ou_member',
      action_tag: ['project', 'branch'].includes(action) ? 'select_static' : 'button',
      action_value: JSON.stringify({ action, requestId: job?.requestId, revision: job?.revision }),
      option, ...extra,
    };
  }
  return { engine, state, config, replies, cards, updates, calls, saves, warnings, downloads, event,
    setBatch: (value) => { batch = value; }, setNow: (value) => { now = value; } };
}

function elements(card) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.tag) found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(card);
  return found;
}

for (const mention of [false, true]) {
  test(`card mode accepts the signed-in user's ${mention ? '@mention' : 'keyword'} question`, async () => {
    const h = harness();
    const question = message('om_self', mention ? '@_user_1 奖励未到账' : '蔡龙 奖励未到账', 20, 'ou_self');
    question.sender.sender_type = 'user';
    if (mention) question.mentions = [{ id: 'ou_bot', name: '蔡龙', key: '@_user_1' }];
    h.setBatch([question]);
    await h.engine.tick();
    assert.equal(h.cards.length, 1);
    assert.equal(h.state.job.triggerMessageId, 'om_self');
  });
}

test('card mode ignores application replies containing the trigger even after restart', async () => {
  const h = harness();
  const reply = message('om_bot', '查询完成 —— 蔡龙自动分析', 20, 'cli_bot');
  Object.assign(reply.sender, { sender_type: 'app', id_type: 'app_id' });
  h.setBatch([reply]);
  await h.engine.tick();
  assert.equal(h.cards.length, 0);
  assert.equal(h.state.job, null);
  assert.equal(h.state.lastSeen.messageId, 'om_bot');
});

test('awaiting cards notify the signed-in user but never reply to application messages', async () => {
  const h = harness();
  await h.engine.tick();
  const bot = message('om_bot', '蔡龙自动分析', 20, 'cli_bot');
  bot.sender.sender_type = 'app';
  const question = message('om_self', '蔡龙 再查一个问题', 30, 'ou_self');
  question.sender.sender_type = 'user';
  h.setBatch([bot, question]);
  await h.engine.tick();
  assert.deepEqual(h.replies.map(({ id }) => id), ['om_self']);
  assert.equal(h.cards.length, 1);
});

for (const text of ['uid：16115645 奖励未到账', '玩家反馈奖励未到账', '麻烦有时间看看奖励记录']) {
  test(`feedback question opens one card and waits for a button: ${text}`, async () => {
    const h = harness();
    h.setBatch([message('om_feedback', text, 20, 'ou_self')]);
    await h.engine.tick();
    await h.engine.tick();
    assert.equal(h.cards.length, 1);
    assert.equal(h.state.job.question, text);
    assert.equal(h.state.job.status, 'awaiting');
    assert.equal(h.calls.length, 0);
    h.setBatch([message('om_confirm', '确认', 30)]);
    await h.engine.tick();
    assert.equal(h.calls.length, 0);
    h.engine.enqueueCardAction(h.event('start'));
    await h.engine.tick();
    assert.deepEqual(h.calls.map(([action]) => action), ['sync', 'search', 'analysis']);
  });
}

test('feedback terms in bot replies never open cards or receive busy notices', async () => {
  const h = harness();
  const bot = message('om_bot_feedback', 'uid：16115645 玩家反馈，麻烦有时间看看', 20, 'cli_bot');
  bot.sender.sender_type = 'app';
  h.setBatch([bot]);
  await h.engine.tick();
  assert.equal(h.cards.length, 0);
  h.setBatch([message('om_question', '蔡龙 查询奖励逻辑', 30)]);
  await h.engine.tick();
  h.setBatch([{ ...bot, message_id: 'om_bot_later', create_time: '40' }]);
  await h.engine.tick();
  assert.equal(h.cards.length, 1);
  assert.equal(h.replies.length, 0);
});

test('a second feedback question gets a busy notice without replacing the awaiting card', async () => {
  const h = harness();
  await h.engine.tick();
  h.setBatch([message('om_feedback', '玩家反馈奖励未到账', 20, 'ou_self')]);
  await h.engine.tick();
  assert.deepEqual(h.replies.map(({ id }) => id), ['om_feedback']);
  assert.equal(h.cards.length, 1);
  assert.equal(h.state.job.triggerMessageId, 'om_question');
  assert.equal(h.calls.length, 0);
});

test('card trigger offers project and remote branches without a text confirmation', async () => {
  const h = harness();
  await h.engine.tick();
  assert.equal(h.cards.length, 1);
  assert.equal(h.replies.length, 0);
  assert.equal(h.state.job.projectId, 'weapon');
  assert.equal(h.state.job.branch, 'master');
  assert.equal(h.state.job.promptMessageId, 'om_card');
  const selects = elements(h.cards[0].card).filter((e) => e.tag === 'select_static');
  assert.deepEqual(selects[0].options.map((o) => o.value), ['weapon', 'gear']);
  assert.deepEqual(selects[1].options.map((o) => o.value), ['master', 'feature/rewards']);
  assert.equal(h.cards[0].card.schema, '2.0');
});

test('project change replaces branches and a selected branch reaches sync, search and analysis', async () => {
  const h = harness();
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  await h.engine.tick();
  assert.equal(h.state.job.projectId, 'gear');
  assert.equal(h.state.job.branch, 'develop');
  assert.deepEqual(h.state.job.branches, ['develop', 'release/v2']);
  h.engine.enqueueCardAction(h.event('branch', 'release/v2'));
  await h.engine.tick();
  const start = h.event('start');
  h.engine.enqueueCardAction(start);
  h.engine.enqueueCardAction(start);
  await h.engine.tick();
  assert.deepEqual(h.calls.map(([action]) => action), ['sync', 'search', 'analysis']);
  for (const [, repo] of h.calls) {
    assert.equal(repo.dir, 'owned/gear');
    assert.equal(repo.branch, 'release/v2');
  }
  assert.equal(h.state.job, null);
  assert.match(h.replies.at(-1).text, /齿轮.*release\/v2@abc1234/);
  assert.ok(h.saves.some((s) => s.job?.status === 'running' && s.job.branch === 'release/v2'));
  assert.match(JSON.stringify(h.updates.at(-1).card), /查询完成/);
});

test('card analysis prompt and reply use the selected project and synchronized provenance', async () => {
  let analysisPrompt;
  const h = harness({ engine: {
    syncRepo: async () => ({ branch: 'release/v2', commit: 'fedcba9876', dirty: 0, provenance: 'release/v2@fedcba9876' }),
    retrieve: async () => ({ digest: '' }),
    runAnalysis: async (prompt) => { analysisPrompt = prompt; return { text: '查询结果' }; },
  } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('branch', 'release/v2'));
  await h.engine.tick();
  h.state.job.provenance = 'master@0000000';
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.match(analysisPrompt, /齿轮 · release\/v2@fedcba9876/);
  assert.doesNotMatch(analysisPrompt, /master@0000000|develop@/);
  assert.match(h.replies.at(-1).text, /齿轮 · release\/v2@fedcba9876/);
});

test('text confirmations cannot bypass card selection', async () => {
  const h = harness();
  await h.engine.tick();
  h.setBatch([message('om_confirm', '确认', 20)]);
  await h.engine.tick();
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.calls.length, 0);
});

test('foreign, stale, malformed and unknown actions never start a query', async () => {
  const h = harness();
  await h.engine.tick();
  for (const extra of [
    { chat_id: 'oc_other' }, { message_id: 'om_other' }, { operator_id: '' },
    { action_value: '{' }, { action_value: JSON.stringify({ action: 'start', requestId: 'other', revision: 0 }) },
    { action_tag: 'input' }, { type: 'other' },
  ]) h.engine.enqueueCardAction(h.event('start', undefined, extra));
  h.engine.enqueueCardAction(h.event('project', 'unknown'));
  h.engine.enqueueCardAction(h.event('branch', '--upload-pack=evil'));
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job.projectId, 'weapon');
  const stale = h.event('start');
  h.engine.enqueueCardAction(h.event('branch', 'feature/rewards'));
  h.engine.enqueueCardAction(stale);
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job.status, 'awaiting');
});

test('cancel closes the card and invalidates later clicks', async () => {
  const h = harness();
  await h.engine.tick();
  const start = h.event('start');
  h.engine.enqueueCardAction(h.event('cancel'));
  h.engine.enqueueCardAction(start);
  await h.engine.tick();
  assert.equal(h.state.job, null);
  assert.equal(h.calls.length, 0);
  assert.match(JSON.stringify(h.updates.at(-1).card), /已取消/);
});

test('expiry rejects a queued start and disables the card', async () => {
  const h = harness();
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  h.setNow(h.state.job.expiresAt + 1);
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job, null);
  assert.match(JSON.stringify(h.updates.at(-1).card), /已超时/);
});

test('failed branch loading leaves no stale branch available and permits cancellation', async () => {
  const h = harness({ engine: { listBranches: async () => { throw new Error('network offline'); } } });
  await h.engine.tick();
  assert.equal(h.cards.length, 1);
  assert.equal(h.state.job.branch, '');
  assert.deepEqual(h.state.job.branches, []);
  assert.ok(elements(h.cards[0].card).find((e) => e.tag === 'button' && e.text.content === '开始查询').disabled);
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  h.engine.enqueueCardAction(h.event('cancel'));
  await h.engine.tick();
  assert.equal(h.state.job, null);
});

test('running and terminal cards cannot be edited or started again', async () => {
  let release;
  const paused = new Promise((r) => { release = r; });
  const h = harness({ engine: { runAnalysis: async () => { await paused; return { text: 'done' }; } } });
  await h.engine.tick();
  const start = h.event('start');
  h.engine.enqueueCardAction(start);
  const tick = h.engine.tick();
  while (h.state.job?.status !== 'running') await new Promise((r) => setImmediate(r));
  h.engine.enqueueCardAction(start);
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  await h.engine.tick();
  release();
  await tick;
  await h.engine.tick();
  assert.equal(h.calls.filter(([op]) => op === 'sync').length, 1);
  assert.equal(h.state.job, null);
});

test('failed repository sync never runs analysis and marks card failed', async () => {
  const h = harness({ engine: { syncRepo: async () => { throw new Error('branch removed'); } } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job, null);
  assert.match(JSON.stringify(h.updates.at(-1).card), /查询失败/);
  assert.match(h.replies.at(-1).text, /branch removed/);
});

test('failed running-card update prevents starting a hidden query', async () => {
  const h = harness({ lark: { updateCard: async () => { throw new Error('patch unavailable'); } } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job, null);
  assert.match(h.replies.at(-1).text, /patch unavailable/);
});

test('a failed selection update is retried before processing another action', async () => {
  let fail = true;
  const h = harness({ lark: { updateCard: async () => { if (fail) throw new Error('offline'); } } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  await assert.rejects(h.engine.tick(), /offline/);
  assert.equal(h.state.job.cardNeedsUpdate, true);
  fail = false;
  await h.engine.tick();
  assert.ok(!h.state.job.cardNeedsUpdate);
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.calls.filter(([op]) => op === 'sync').length, 1);
});

test('restart closes a persisted running card without repeating the job', async () => {
  const h = harness();
  Object.assign(h.state, { job: {
    card: true, requestId: 'old', revision: 0, status: 'running', projectId: 'weapon',
    branch: 'master', branches: ['master'], question: 'old', triggerMessageId: 'om_old', promptMessageId: 'om_card',
  } });
  h.setBatch([]);
  await h.engine.tick();
  assert.equal(h.state.job, null);
  assert.equal(h.calls.length, 0);
  assert.match(JSON.stringify(h.updates.at(-1).card), /查询中断/);
});

test('paging branches preserves selection until a visible branch is chosen', async () => {
  const branches = Array.from({ length: 400 }, (_, i) => `feature/${i}-${'x'.repeat(100)}`);
  const h = harness({ engine: { listBranches: async () => branches } });
  await h.engine.tick();
  const select = elements(h.cards[0].card).find((n) => n.name === 'branch');
  const next = select.options.find((o) => o.text.content.startsWith('下一页'));
  assert.ok(next);
  h.engine.enqueueCardAction(h.event('branch', next.value));
  await h.engine.tick();
  assert.equal(h.state.job.branch, branches[0]);
  assert.equal(h.state.job.revision, 1);
  const updated = elements(h.updates.at(-1).card).find((n) => n.name === 'branch');
  const target = updated.options.find((o) => branches.includes(o.value) && o.value !== branches[0]).value;
  h.engine.enqueueCardAction(h.event('branch', target));
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.calls[0][1].branch, target);
});

test('cancel from the last visible revision works even while all patches fail', async () => {
  const h = harness({ lark: { updateCard: async () => { throw new Error('offline'); } } });
  await h.engine.tick();
  const cancel = h.event('cancel');
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  await assert.rejects(h.engine.tick(), /offline/);
  h.engine.enqueueCardAction(cancel);
  await h.engine.tick();
  assert.equal(h.state.job, null);
  assert.equal(h.calls.length, 0);
});

test('terminal patch failures survive restart without reviving or repeating analysis', async () => {
  const h = harness({ lark: { updateCard: async () => { throw new Error('offline'); } } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('cancel'));
  await h.engine.tick();
  const persisted = JSON.parse(JSON.stringify(h.saves.at(-1)));
  const restored = harness();
  Object.assign(restored.state, persisted);
  restored.setBatch([]);
  await restored.engine.tick();
  assert.equal(restored.state.job, null);
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.updates.length, 1);
  assert.match(JSON.stringify(restored.updates[0].card), /已取消/);
  await restored.engine.tick();
  assert.equal(restored.updates.length, 1);
});

test('cancel arriving during branch refresh is not lost after the revision advances', async () => {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ engine: { listBranches: async (project) => {
    if (project.id === 'gear') { enter(); await blocked; return ['develop']; }
    return ['master'];
  } } });
  await h.engine.tick();
  const cancel = h.event('cancel');
  h.engine.enqueueCardAction(h.event('project', 'gear'));
  const pendingTick = h.engine.tick();
  await entered;
  assert.equal(h.engine.enqueueCardAction(cancel), true);
  release();
  await pendingTick;
  assert.equal(h.state.job, null);
  assert.equal(h.calls.length, 0);
  assert.match(JSON.stringify(h.updates.at(-1).card), /已取消/);
});

for (const status of ['awaiting', 'running']) {
  test(`${status} recovery durably queues the terminal patch in the same save that clears the job`, async () => {
    const h = harness({ lark: { updateCard: async () => { throw new Error('offline'); } } });
    h.setBatch([]);
    h.state.job = {
      card: true, requestId: 'old', revision: 0, status, projectId: 'weapon', expiresAt: 1,
      branch: 'master', branches: ['master'], question: 'old', triggerMessageId: 'om_old', promptMessageId: 'om_card',
    };
    await h.engine.tick();
    assert.ok(h.saves.length > 0);
    for (const saved of h.saves) {
      if (saved.job === null) assert.equal(saved.cardUpdates?.[0]?.messageId, 'om_card');
    }
  });
}

test('new request cannot accept events from a previous card request', async () => {
  const h = harness();
  await h.engine.tick();
  const stale = h.event('start');
  h.engine.enqueueCardAction(h.event('cancel'));
  await h.engine.tick();
  h.setBatch([message('om_new', '蔡龙 新问题', 30)]);
  await h.engine.tick();
  h.engine.enqueueCardAction(stale);
  await h.engine.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.job.triggerMessageId, 'om_new');
});

test('screenshots around the trigger reach the card, the analysis and are cleaned up', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let seen;
  let existed = false;
  const h = harness({
    engine: {
      runAnalysis: async (prompt, repo, options) => {
        seen = { prompt, options };
        existed = options.images.length === 1 && existsSync(options.images[0].path);
        return { text: '查询结果' };
      },
    },
  });
  h.config.paths.imagesDir = join(root, 'images');

  h.setBatch([
    imageMessage('om_img', 'img_v3_one', 50),
    message('om_question', 'uid：16115645 奖励没到账', 60),
  ]);
  await h.engine.tick();

  assert.deepEqual(h.state.job.images, [{ messageId: 'om_img', fileKey: 'img_v3_one' }]);
  assert.match(JSON.stringify(h.cards[0].card), /截图 1 张/);

  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();

  assert.deepEqual(h.downloads.map(({ messageId, fileKey }) => [messageId, fileKey]), [
    ['om_img', 'img_v3_one'],
  ]);
  assert.equal(seen.options.images.length, 1);
  assert.equal(seen.options.images[0].mime, 'image/png');
  assert.equal(existed, true, 'the screenshot file exists while the analysis runs');
  assert.match(seen.prompt, /【群内截图】/);
  assert.match(seen.prompt, /1 张/);
  assert.equal(existsSync(join(root, 'images', 'om_question')), false);
  assert.equal(h.state.job, null);
});

test('a screenshot posted while awaiting is attached once and refreshes the card', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let seen;
  const h = harness({
    engine: {
      runAnalysis: async (prompt, repo, options) => {
        seen = options;
        return { text: '查询结果' };
      },
    },
  });
  h.config.paths.imagesDir = join(root, 'images');

  h.setBatch([message('om_question', '玩家反馈奖励未到账', 10)]);
  await h.engine.tick();
  assert.equal(h.cards.length, 1);

  const batch = [
    message('om_question', '玩家反馈奖励未到账', 10),
    imageMessage('om_img_a', 'img_v3_same', 20),
    imageMessage('om_img_b', 'img_v3_same', 21),
  ];
  h.setBatch(batch);
  await h.engine.tick();

  assert.equal(h.cards.length, 1, 'the original card must not be replaced');
  assert.equal(h.replies.length, 0, 'attaching a screenshot needs no notice');
  assert.deepEqual(h.state.job.images, [{ messageId: 'om_img_a', fileKey: 'img_v3_same' }]);

  await h.engine.tick();
  assert.match(JSON.stringify(h.updates.at(-1).card), /截图 1 张/);

  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.deepEqual(seen.images.map((image) => image.mime), ['image/png']);
});

test('screenshots from the service itself never attach to a job', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = harness();
  h.config.paths.imagesDir = join(root, 'images');

  h.setBatch([message('om_question', '蔡龙 查询奖励逻辑', 10)]);
  await h.engine.tick();

  const botImage = imageMessage('om_bot_img', 'img_v3_bot', 20, 'cli_bot');
  botImage.sender.sender_type = 'app';
  h.setBatch([message('om_question', '蔡龙 查询奖励逻辑', 10), botImage]);
  await h.engine.tick();

  assert.deepEqual(h.state.job.images, []);
  assert.equal(h.replies.length, 0);
});

test('at most four screenshots are attached and a failed download never blocks the analysis', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cp-images-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let seen;
  let calls = 0;
  const h = harness({
    lark: {
      downloadImage: async ({ outputPath }) => {
        calls += 1;
        if (calls === 1) throw new Error('network offline');
        const path = `${outputPath}.png`;
        writeFileSync(path, PNG);
        return { path };
      },
    },
    engine: {
      runAnalysis: async (prompt, repo, options) => {
        seen = options;
        return { text: '查询结果' };
      },
    },
  });
  h.config.paths.imagesDir = join(root, 'images');

  h.setBatch([message('om_question', 'uid：16115645 奖励没到账', 50)]);
  await h.engine.tick();

  const images = Array.from({ length: 5 }, (_, i) => imageMessage(`om_img_${i}`, `img_v3_${i}`, 100 + i));
  h.setBatch([message('om_question', 'uid：16115645 奖励没到账', 50), ...images]);
  await h.engine.tick();

  assert.equal(h.state.job.images.length, 4);
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();

  assert.equal(calls, 4, 'only the capped refs are requested');
  assert.equal(seen.images.length, 3, 'the failed download is skipped, the rest still reach the model');
  assert.match(h.replies.at(-1).text, /查询结果/);
  assert.equal(h.state.job, null);
});

const TAPD_CONFIG = {
  baseUrl: 'https://api.tapd.cn',
  tokenFile: 'C:/secrets/tapd.token',
  workspaces: { weapon: { workspaceId: '59180547', tokenFile: 'C:/secrets/tapd.token', fields: { current_owner: '小鱼;' } } },
};
const FULL_ANALYSIS = [
  '【结论】配置缺失：奖励表没有该档位',
  '【复现】1. 打开铁匠铺 2. 点击锻造',
  '【定位】Assets/a.cs:12',
  '【依据】表里没有。',
  '【建议】补一行配置。',
].join('\n');

function submittedHarness(overrides = {}) {
  // `engine` is merged instead of replaced so a test that only swaps the TAPD
  // client still gets the five-section analysis text the ticket is built from.
  const { engine: engineOverrides, ...rest } = overrides;
  return harness({
    tapdConfig: TAPD_CONFIG,
    ...rest,
    engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }), ...engineOverrides },
  });
}

async function completeOneJob(h) {
  await h.engine.tick();                                // 群消息触发 -> 建卡片
  h.engine.enqueueCardAction(h.event('start'));         // 点「开始查询」
  await h.engine.tick();                                // 跑分析 -> 查询完成 + 回填卡片
  return h.state.reports[0];
}

test('a completed report is remembered with its analysis text', async () => {
  const h = submittedHarness();
  const report = await completeOneJob(h);
  assert.equal(report.status, 'completed');
  assert.equal(report.analysis, FULL_ANALYSIS);
  assert.equal(report.projectId, 'weapon');
  assert.equal(report.tapd, undefined);
});

test('the submit button creates one ticket and stamps the card', async () => {
  const created = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { created.push(payload); return { bugId: '1159180547001002353', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1159180547001002353' }; } },
  });
  const report = await completeOneJob(h);
  const press = {
    type: 'card.action.trigger', event_id: 'evt-tapd-1', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), true);
  await h.engine.tick();
  assert.equal(created.length, 1);
  assert.equal(created[0].workspace_id, '59180547');
  assert.equal(created[0].current_owner, '小鱼;');
  assert.equal(h.state.reports[0].tapd.status, 'done');
  assert.match(h.state.reports[0].tapd.url, /tapd_fe\/59180547\/bug\/detail\/1159180547001002353$/);
  // The card was PATCHed with the link, not the button.
  assert.ok(JSON.stringify(h.updates.at(-1)).includes('已提单：[TAPD 1159180547001002353]'));
  assert.ok(!JSON.stringify(h.updates.at(-1)).includes('"action":"tapd"'), 'no second bite at the same card');
});

test('the card says the ticket state is unknown while the request is still in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = submittedHarness({
    tapdClient: { createBug: async () => { await gate; return { bugId: '1', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1' }; } },
  });
  const report = await completeOneJob(h);
  h.engine.enqueueCardAction({
    type: 'card.action.trigger', event_id: 'evt-in-flight', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  });
  const tick = h.engine.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.reports[0].tapd.status, 'submitting');
  assert.match(JSON.stringify(h.updates.at(-1)), /提交中/);
  release();
  await tick;
  assert.equal(h.state.reports[0].tapd.status, 'done');
});

test('pressing submit twice in a row still creates one ticket', async () => {
  const created = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { created.push(payload); return { bugId: '1', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1' }; } },
  });
  const report = await completeOneJob(h);
  const press = (revision) => ({
    type: 'card.action.trigger', event_id: `evt-${revision}`, chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision }),
  });
  h.engine.enqueueCardAction(press(report.revision));
  h.engine.enqueueCardAction(press(report.revision));
  await h.engine.tick();
  assert.equal(created.length, 1);
});

test('an event for an unknown or already submitted report is refused', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  const report = await completeOneJob(h);
  const base = { type: 'card.action.trigger', event_id: 'evt-x', chat_id: 'oc_test', message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button' };
  assert.equal(h.engine.enqueueCardAction({ ...base, action_value: JSON.stringify({ action: 'tapd', requestId: 'nope', revision: report.revision }) }), false);
  assert.equal(h.engine.enqueueCardAction({ ...base, message_id: 'om_other', action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }) }), false);
  assert.equal(h.engine.enqueueCardAction({ ...base, action_tag: 'input', action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }) }), false);
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd, undefined);
});

test('a failed submit invites a retry on a fresh card revision', async () => {
  const attempts = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { attempts.push(payload); throw new Error('tapd: 建单失败（HTTP 502 bad）'); } },
  });
  const report = await completeOneJob(h);
  // `report` is the live stored report, so its revision advances in place when
  // the press is booked; remember the number the card rendered.
  const renderedRevision = report.revision;
  const press = (revision) => ({
    type: 'card.action.trigger', event_id: `evt-${revision}`, chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision }),
  });
  h.engine.enqueueCardAction(press(report.revision));
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd.status, 'failed');
  assert.match(h.state.reports[0].tapd.error, /HTTP 502/);
  const retryRevision = h.state.reports[0].revision;
  assert.ok(retryRevision > renderedRevision, 'the failed press consumed its revision');
  h.engine.enqueueCardAction(press(retryRevision));
  await h.engine.tick();
  assert.equal(attempts.length, 2);
});

test('a submit left in flight after a restart is never auto-retried', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  const report = await completeOneJob(h);
  report.tapd = { status: 'submitting' };
  const press = {
    type: 'card.action.trigger', event_id: 'evt-stale', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), true);
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd.status, 'submitting', 'the operator has to look, not the service');
});

test('without a workspace mapping the finished card carries no submit action', async () => {
  const h = harness({ engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }) } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.state.reports.length, 1, 'the report is still remembered');
  assert.ok(!JSON.stringify(h.updates.at(-1)).includes('"action":"tapd"'));
});

test('only the newest twenty completed reports are kept', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  h.state.reports = Array.from({ length: 20 }, (_, i) => ({ requestId: `old${i}`, status: 'completed' }));
  await completeOneJob(h);
  assert.equal(h.state.reports.length, 20);
  assert.equal(h.state.reports.at(-1).question, '蔡龙 查询奖励逻辑');
  assert.ok(!h.state.reports.some((item) => item.requestId === 'old0'));
});

test('the running job keeps the raw analysis so the ticket can reuse it', async () => {
  const seen = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { seen.push(payload); return { bugId: '9', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/9' }; } },
  });
  const report = await completeOneJob(h);
  assert.equal(report.analysis.includes('【复现】'), true);
  assert.equal(h.replies.at(-1).text.includes('【复现】'), true, 'the group still sees the same answer');

  h.engine.enqueueCardAction({
    type: 'card.action.trigger', event_id: 'evt-tapd-9', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  });
  await h.engine.tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0].description, /【操作步骤】\n1\. 打开铁匠铺 2\. 点击锻造\n/);
});

test('no TAPD client means no submit path at all', async () => {
  const h = harness({ tapdConfig: TAPD_CONFIG, engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }) } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  const report = h.state.reports[0];
  const press = {
    type: 'card.action.trigger', event_id: 'evt-off', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), false);
});
