import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/index.js';
import { initialState } from '../src/state.js';
import { CONFIRM_PROMPT } from '../src/reply.js';

// End-to-end through the real engine: only the I/O edges (Feishu, git, codex,
// state file) are stubbed. buildPrompt, clipForReply and markSeen run for real,
// so the assertions cover the wording and the cursor the group actually see.

const TRIGGER = '蔡龙 玩家奖励没到账怎么办';
const ANALYSIS = '【结论】配置缺失\n【定位】Assets/A.cs:12';

const msg = (id, t, text, sender = 'ou_ops') => ({
  message_id: id,
  create_time: String(t),
  msg_type: 'text',
  sender: typeof sender === 'string' ? { id: sender, name: sender } : sender,
  content: JSON.stringify({ text }),
});

function setup() {
  const state = initialState(0);
  const sent = [];
  const prompts = [];
  const saves = [];
  let now = 1000;
  let batch = [];

  const lark = {
    listMessages: async () => batch,
    reply: async (id, text) => {
      sent.push({ id, text });
      return { messageId: `om_s${sent.length}` };
    },
    send: async () => ({ messageId: 'om_x' }),
    getSenderName: async (openId) => (openId === 'ou_nanke' ? '南柯' : ''),
  };

  const engine = createEngine({
    config: {
      chatId: 'oc_x',
      selfOpenId: 'ou_self',
      triggerKeyword: '蔡龙',
      confirmTimeoutSec: 600,
      contextMessages: 2,
      maxReplyChars: 4000,
    },
    lark,
    state,
    clock: () => now,
    log: { info() {}, warn() {}, error() {} },
    // The real module writes state/; the e2e run must stay off disk.
    saveState: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    syncRepo: async () => ({ commit: 'abc1234', provenance: 'master@abc1234' }),
    runAnalysis: async (prompt) => {
      prompts.push(prompt);
      return { text: ANALYSIS };
    },
  });

  return {
    engine,
    state,
    sent,
    prompts,
    saves,
    setNow: (value) => {
      now = value;
    },
    setBatch: (messages) => {
      batch = messages;
    },
  };
}

test('trigger -> prompt -> confirm -> analysis reply (dry run)', async () => {
  const h = setup();
  const trigger = msg('om_1', 100, TRIGGER);
  h.setBatch([msg('om_0', 50, '玩家反馈奖励没到账', { id: 'ou_early', name: '小明' }), trigger]);

  await h.engine.tick();

  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { id: 'om_1', text: CONFIRM_PROMPT });
  assert.equal(h.state.job.status, 'awaiting');
  assert.equal(h.state.job.question, TRIGGER);
  assert.deepEqual(h.state.lastSeen, { createTimeMs: 100, messageId: 'om_1' });

  h.setNow(2000);
  h.setBatch([trigger, msg('om_2', 1500, '确认', 'ou_nanke')]);
  await h.engine.tick();

  // buildPrompt ran for real: the group question and its context are fenced
  // into the prompt handed to codex.
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /【群内上下文】/);
  assert.match(h.prompts[0], /- 小明: 玩家反馈奖励没到账/);
  assert.match(h.prompts[0], /【运营提出的问题】/);
  assert.match(h.prompts[0], /蔡龙 玩家奖励没到账怎么办/);

  // clipForReply ran for real: the body is followed by the provenance footer.
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].id, 'om_1');
  assert.match(h.sent[1].text, /^【结论】配置缺失/);
  assert.match(h.sent[1].text, /master@abc1234/);
  assert.match(h.sent[1].text, /由 南柯 确认$/);

  assert.equal(h.state.job, null);
  assert.equal(h.state.lastSeen.messageId, 'om_2');
});

test('second trigger while awaiting gets a busy notice instead of a second prompt', async () => {
  const h = setup();
  h.setBatch([msg('om_1', 100, '蔡龙 问题一')]);
  await h.engine.tick();

  assert.equal(h.sent.length, 1);

  h.setBatch([msg('om_1', 100, '蔡龙 问题一'), msg('om_2', 150, '蔡龙 问题二')]);
  await h.engine.tick();

  assert.equal(h.sent.length, 2, 'the dropped question is told why');
  assert.equal(h.sent[1].id, 'om_2');
  assert.match(h.sent[1].text, /已有查询待确认/);
  assert.equal(h.prompts.length, 0, 'no analysis starts before a confirm');
  assert.equal(h.state.job.triggerMessageId, 'om_1');
  assert.equal(h.state.lastSeen.messageId, 'om_2');
});
