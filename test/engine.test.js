import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/index.js';
import { initialState } from '../src/state.js';
import { CONFIRM_PROMPT, TIMEOUT_NOTICE, CANCELLED_NOTICE, BUSY_NOTICE } from '../src/reply.js';

// Feishu create_time is a 13-digit millisecond timestamp string.
const NOW = 1793162767785;
const ANALYSIS = '【结论】配置缺失，掉落表没有 reward_1001';

// Real items carry the JSON payload at body.content, but the parser also takes
// the top-level content used by the fixtures here. `sender` may be a plain id
// or a full sender object (id / open_id / name).
function msg(id, t, text, sender = 'ou_ops') {
  return {
    message_id: id,
    create_time: String(t),
    msg_type: 'text',
    sender: typeof sender === 'string' ? { id: sender } : sender,
    content: JSON.stringify({ text }),
  };
}

function awaitingJob(overrides = {}) {
  return {
    status: 'awaiting',
    triggerMessageId: 'om_1',
    question: '奖励没到账',
    context: [],
    promptMessageId: 'om_p',
    expiresAt: NOW + 600_000,
    confirmer: null,
    ...overrides,
  };
}

function harness(overrides = {}) {
  const replies = [];
  const saves = [];
  const logs = { info: [], warn: [], error: [] };
  const calls = { list: [], prompts: [], sync: 0 };
  const state = initialState(0);
  let now = NOW;
  let batch = [];

  const config = {
    chatId: 'oc_x',
    selfOpenId: 'ou_self',
    triggerKeyword: '蔡龙',
    confirmTimeoutSec: 600,
    contextMessages: 2,
    maxReplyChars: 4000,
    // never touched: every fixture analysis fits under maxReplyChars.
    paths: { jobsDir: join(tmpdir(), 'checkproblem-jobs-unused') },
  };

  const lark = {
    listMessages: async (chatId, opts) => {
      calls.list.push({ chatId, opts });
      return batch;
    },
    reply: async (id, text) => {
      replies.push({ id, text });
      return { messageId: `om_r${replies.length}` };
    },
    getSenderName: async () => '运营A',
  };

  const engine = createEngine({
    config,
    lark,
    state,
    clock: () => now,
    log: {
      info: (line) => logs.info.push(line),
      warn: (line) => logs.warn.push(line),
      error: (line) => logs.error.push(line),
    },
    saveState: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    syncRepo: async () => {
      calls.sync += 1;
      return { commit: 'abc1234' };
    },
    runAnalysis: async (prompt) => {
      calls.prompts.push(prompt);
      return { text: ANALYSIS };
    },
    ...overrides,
  });

  return {
    engine,
    state,
    replies,
    saves,
    logs,
    calls,
    config,
    lark,
    setBatch: (messages) => {
      batch = messages;
    },
    setNow: (value) => {
      now = value;
    },
  };
}

test('a trigger spawns the confirmation prompt and an awaiting job', async () => {
  const h = harness();
  h.setBatch([msg('om_1', 100, '  蔡龙 奖励没到账  ')]);

  await h.engine.tick();

  assert.deepEqual(h.replies, [{ id: 'om_1', text: CONFIRM_PROMPT }]);
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.triggerMessageId, 'om_1');
  assert.equal(h.state.job.question, '蔡龙 奖励没到账');
  assert.equal(h.state.job.promptMessageId, 'om_r1');
  assert.deepEqual(h.state.job.context, []);
  assert.equal(h.state.job.expiresAt, NOW + 600 * 1000);
  assert.equal(h.state.job.confirmer, null);
  assert.deepEqual(h.state.lastSeen, { createTimeMs: 100, messageId: 'om_1' });
  assert.deepEqual(h.calls.list, [{ chatId: 'oc_x', opts: { pageSize: 50 } }]);
  assert.equal(h.saves.at(-1).job.triggerMessageId, 'om_1');
});

test('messages from the bot itself never trigger', async () => {
  const h = harness();
  h.setBatch([msg('om_1', 100, '蔡龙 奖励没到账', 'ou_self')]);

  await h.engine.tick();

  assert.equal(h.replies.length, 0);
  assert.equal(h.state.job, null);
  // The chatter is still consumed, so it is not re-read on every poll.
  assert.deepEqual(h.state.lastSeen, { createTimeMs: 100, messageId: 'om_1' });
});

test('a bare @mention triggers through mentions[] even when the body only has a placeholder', async () => {
  const h = harness();
  const mention = msg('om_1', 100, '@_user_1 奖励没到账');
  mention.mentions = [{ id: 'ou_cl', name: '蔡龙' }];
  h.setBatch([mention]);

  await h.engine.tick();

  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].text, CONFIRM_PROMPT);
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.question, '@_user_1 奖励没到账');
});

test('a confirm runs the analysis and replies to the trigger with the footer', async () => {
  const h = harness();
  const lookup = [];
  h.lark.getSenderName = async (openId) => {
    lookup.push(openId);
    return '运营A';
  };
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '确认', 'ou_ops')]);

  await h.engine.tick();

  assert.equal(h.state.job, null);
  assert.deepEqual(lookup, ['ou_ops']);
  assert.equal(h.calls.sync, 1);
  assert.equal(h.calls.prompts.length, 1);

  const result = h.replies.at(-1);
  assert.equal(result.id, 'om_1');
  assert.match(result.text, /【结论】配置缺失/);
  assert.match(result.text, /^【结论】配置缺失/);
  assert.match(result.text, /—— 蔡龙自动分析 · master@abc1234 · 由 运营A 确认$/);

  // `running` is persisted before the long-running work, so a crash on the next
  // start is recognisable.
  assert.ok(h.saves.some((s) => s.job?.status === 'running'));
  assert.equal(h.saves.at(-1).job, null);
  assert.deepEqual(h.state.lastSeen, { createTimeMs: NOW + 100, messageId: 'om_2' });
});

test('a clipped reply keeps the footer and the archive holds the full text', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'checkproblem-jobs-'));
  const h = harness();
  h.config.maxReplyChars = 50;
  h.config.paths = { jobsDir };
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '确认', 'ou_ops')]);

  await h.engine.tick();

  const footer = '—— 蔡龙自动分析 · master@abc1234 · 由 运营A 确认';
  const reply = h.replies.at(-1);
  assert.equal(reply.id, 'om_1');
  assert.equal(reply.text, `【结论】配置缺失，掉落\n\n${footer}`);
  assert.ok(reply.text.endsWith(footer), 'the clipped reply keeps the footer');
  assert.ok(reply.text.length <= 50, 'the clipped reply respects maxReplyChars');

  const archived = readFileSync(join(jobsDir, 'om_1.md'), 'utf8');
  assert.equal(archived, `${ANALYSIS}\n\n${footer}`);
});

test('a cancel replies with the notice and clears the job', async () => {
  const h = harness();
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '取消', 'ou_ops')]);

  await h.engine.tick();

  assert.equal(h.state.job, null);
  assert.deepEqual(h.replies, [{ id: 'om_1', text: CANCELLED_NOTICE }]);
  assert.equal(h.calls.sync, 0);
  assert.equal(h.calls.prompts.length, 0);
  assert.deepEqual(h.state.lastSeen, { createTimeMs: NOW + 100, messageId: 'om_2' });
});

test('an expired job times out before any messages are read', async () => {
  const h = harness();
  h.state.job = awaitingJob({ expiresAt: NOW - 1 });
  let readsWhenNoticed = -1;
  h.lark.reply = async (id, text) => {
    if (text === TIMEOUT_NOTICE) readsWhenNoticed = h.calls.list.length;
    h.replies.push({ id, text });
    return { messageId: 'om_t' };
  };
  h.setBatch([]);

  await h.engine.tick();

  assert.equal(readsWhenNoticed, 0, 'timeout notice must not wait for the poll');
  assert.deepEqual(h.replies, [{ id: 'om_1', text: TIMEOUT_NOTICE }]);
  assert.equal(h.state.job, null);
  assert.equal(h.saves.at(-1).job, null);
});

test('a failed timeout notice does not wedge the loop and a new trigger still works', async () => {
  const h = harness();
  h.state.job = awaitingJob({ expiresAt: NOW - 1 });
  let failing = true;
  h.lark.reply = async (id, text) => {
    if (failing) throw new Error('reply api down');
    h.replies.push({ id, text });
    return { messageId: 'om_r1' };
  };
  h.setBatch([]);

  await h.engine.tick();

  assert.equal(h.state.job, null, 'the job is cleared even when the notice fails');
  assert.equal(h.calls.list.length, 1, 'the tick still reaches the poll');
  assert.ok(h.logs.error.some((line) => /cannot deliver notice/.test(line)));

  failing = false;
  h.setNow(NOW + 100);
  h.setBatch([msg('om_9', NOW + 100, '蔡龙 再查一次')]);
  await h.engine.tick();

  assert.equal(h.calls.list.length, 2, 'the next tick polls normally');
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.triggerMessageId, 'om_9');
  assert.deepEqual(h.replies, [{ id: 'om_9', text: CONFIRM_PROMPT }]);
});

test('an analysis failure replies with the reason and clears the job', async () => {
  const h = harness({
    runAnalysis: async () => {
      throw new Error('codex exec failed (exit 1): boom');
    },
  });
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '确认', 'ou_ops')]);

  await h.engine.tick();

  assert.equal(h.state.job, null);
  assert.equal(h.calls.sync, 1);
  const last = h.replies.at(-1);
  assert.equal(last.id, 'om_1');
  assert.match(last.text, /^分析失败：codex exec failed \(exit 1\): boom$/);
  assert.ok(h.logs.error.some((line) => /analysis failed/.test(line)));
  assert.deepEqual(h.state.lastSeen, { createTimeMs: NOW + 100, messageId: 'om_2' });
});

test('chatter while awaiting is ignored but a later confirm in the same batch runs', async () => {
  const h = harness();
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([
    msg('om_2', NOW + 100, '这个我也遇到了'),
    msg('om_3', NOW + 200, '蔡龙 快点看'),
    msg('om_4', NOW + 300, '确认', 'ou_ops'),
  ]);

  await h.engine.tick();

  assert.equal(h.replies.length, 2, 'the dropped question gets one notice, the confirm gets the result');
  assert.deepEqual(h.replies[0], { id: 'om_3', text: BUSY_NOTICE }, 'plain chatter draws nothing');
  assert.equal(h.replies[1].id, 'om_1');
  assert.match(h.replies[1].text, /master@abc1234/);
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(h.state.job, null);
});

test('a second trigger while awaiting gets the busy notice and does not replace the job', async () => {
  const h = harness();
  h.state.job = awaitingJob({ promptMessageId: 'om_p1' });
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([
    msg('om_2', NOW + 100, '蔡龙 另一个问题'),
    msg('om_3', NOW + 200, '随便聊聊'),
  ]);

  await h.engine.tick();

  assert.equal(h.replies.length, 1, 'one notice for the dropped question, nothing for chatter');
  assert.equal(h.replies[0].id, 'om_2');
  assert.equal(h.replies[0].text, BUSY_NOTICE);
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.triggerMessageId, 'om_1');
  assert.equal(h.state.job.promptMessageId, 'om_p1');
  assert.deepEqual(h.state.lastSeen, { createTimeMs: NOW + 200, messageId: 'om_3' });
});

test('context lines from preceding messages reach the prompt', async () => {
  const h = harness();
  h.state.lastSeen = { createTimeMs: 0, messageId: '' };
  const batch = [
    msg('om_0', 100, '今天的活动出问题了', 'ou_early'),
    msg('om_1', 110, '玩家反馈奖励没到账', { id: 'ou_1', name: '小明' }),
    msg('om_2', 120, '已经收到三例', 'ou_2'),
    msg('om_3', 130, '蔡龙 帮看一下', 'ou_3'),
  ];
  h.setBatch(batch);

  await h.engine.tick();
  assert.deepEqual(h.state.job.context, ['小明: 玩家反馈奖励没到账', 'ou_2: 已经收到三例']);

  h.setNow(NOW + 1000);
  h.setBatch([...batch, msg('om_4', NOW + 1000, '确认', 'ou_ops')]);
  await h.engine.tick();

  assert.equal(h.calls.prompts.length, 1);
  const prompt = h.calls.prompts[0];
  assert.match(prompt, /- 小明: 玩家反馈奖励没到账/);
  assert.match(prompt, /- ou_2: 已经收到三例/);
  assert.doesNotMatch(prompt, /今天的活动出问题了/, 'context is capped at contextMessages');
  assert.match(prompt, /蔡龙 帮看一下/);
});

test('an interrupted running job is reported and cleared on the first tick only', async () => {
  const h = harness();
  h.state.job = {
    status: 'running',
    triggerMessageId: 'om_1',
    question: '奖励没到账',
    context: [],
    promptMessageId: 'om_p',
    expiresAt: NOW,
    confirmer: null,
  };
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '蔡龙 再查一次')]);

  await h.engine.tick();

  assert.deepEqual(h.replies[0], { id: 'om_1', text: '上次分析中断，请重新发起' });
  // The tick continues after recovery: the fresh trigger is picked up at once.
  assert.deepEqual(h.replies[1], { id: 'om_2', text: CONFIRM_PROMPT });
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.triggerMessageId, 'om_2');

  // Re-seed a `running` job: after the first tick state.job is `awaiting`, so
  // without this the assertion below would pass even if the firstTick guard
  // were deleted.
  h.state.job = { ...awaitingJob(), status: 'running', triggerMessageId: 'om_9' };
  await h.engine.tick();
  assert.equal(h.replies.length, 2, 'recovery must not repeat on later ticks');
});

test('a failed interrupted notice still clears the running job and keeps polling', async () => {
  const h = harness();
  h.state.job = { ...awaitingJob(), status: 'running', triggerMessageId: 'om_1' };
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.lark.reply = async () => {
    throw new Error('message recalled');
  };
  h.setBatch([]);

  await h.engine.tick();

  assert.equal(h.state.job, null);
  assert.equal(h.calls.list.length, 1);
  assert.ok(h.logs.error.some((line) => /cannot deliver notice/.test(line)));
  assert.equal(h.replies.length, 0);
});

test('a tick already in flight makes the next tick return immediately', async () => {
  const h = harness();
  let release = () => {};
  let listCalls = 0;
  h.lark.listMessages = () => {
    listCalls += 1;
    if (listCalls === 1) {
      return new Promise((resolve) => {
        release = () => resolve([]);
      });
    }
    return Promise.resolve([]);
  };

  const first = h.engine.tick();
  const second = h.engine.tick();

  try {
    await second;
    assert.equal(listCalls, 1, 'the overlapping tick must not poll');
  } finally {
    release();
  }
  await first;

  // The guard clears, so the next poll works normally (second call: the
  // overlapping tick never reached listMessages).
  await h.engine.tick();
  assert.equal(listCalls, 2);
});

test('a stalled poll warns once per overlap and the flag clears when it finishes', async () => {
  const h = harness();
  let release = () => {};
  h.lark.listMessages = () =>
    new Promise((resolve) => {
      release = () => resolve([]);
    });
  const stalled = () => h.logs.warn.filter((line) => /poll still running after/.test(line));

  const first = h.engine.tick();
  h.setNow(NOW + 15_000);
  await h.engine.tick();
  h.setNow(NOW + 30_000);
  await h.engine.tick();

  assert.equal(stalled().length, 1, 'one line per overlap, not one per skipped tick');
  assert.match(stalled()[0], /15000ms/, 'the line reports how long the tick has been stuck');

  release();
  await first;

  // A later stall is a new overlap and must be reported again.
  let releaseAgain = () => {};
  h.lark.listMessages = () =>
    new Promise((resolve) => {
      releaseAgain = () => resolve([]);
    });
  const next = h.engine.tick();
  h.setNow(NOW + 45_000);
  await h.engine.tick();
  assert.equal(stalled().length, 2, 'the already-warned flag is cleared when the tick finishes');
  releaseAgain();
  await next;
});

test('a skipped tick stays silent while an analysis is legitimately running', async () => {
  const h = harness();
  // Consume the crash-recovery pass so the seeded `running` job survives.
  await h.engine.tick();
  h.state.job = { ...awaitingJob(), status: 'running' };

  let release = () => {};
  h.lark.listMessages = () =>
    new Promise((resolve) => {
      release = () => resolve([]);
    });

  const first = h.engine.tick();
  h.setNow(NOW + 15_000);
  await h.engine.tick();
  await h.engine.tick();

  assert.equal(h.logs.warn.filter((line) => /poll still running after/.test(line)).length, 0);
  release();
  await first;
});

test('the footer falls back to the open_id when the lookup returns no name', async () => {
  const h = harness();
  const looked = [];
  h.lark.getSenderName = async (openId) => {
    looked.push(openId);
    return '';
  };
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '确认', 'ou_ops')]);

  await h.engine.tick();

  assert.deepEqual(looked, ['ou_ops']);
  assert.match(h.replies.at(-1).text, /由 ou_ops 确认$/);
});

test('a throwing name lookup never blocks the analysis', async () => {
  const h = harness();
  h.lark.getSenderName = async () => {
    throw new Error('contact api down');
  };
  h.state.job = awaitingJob();
  h.state.lastSeen = { createTimeMs: NOW, messageId: 'om_1' };
  h.setBatch([msg('om_2', NOW + 100, '确认', 'ou_ops')]);

  await h.engine.tick();

  assert.equal(h.state.job, null);
  assert.equal(h.calls.prompts.length, 1);
  assert.match(h.replies.at(-1).text, /由 ou_ops 确认$/);
  assert.ok(h.logs.warn.some((line) => /confirmer lookup failed/.test(line)));
});

test('unrelated chatter only advances the cursor', async () => {
  const h = harness();
  h.setBatch([msg('om_1', 100, '早上好'), msg('om_2', 200, '收到')]);

  await h.engine.tick();

  assert.equal(h.replies.length, 0);
  assert.equal(h.state.job, null);
  assert.deepEqual(h.state.lastSeen, { createTimeMs: 200, messageId: 'om_2' });
});
