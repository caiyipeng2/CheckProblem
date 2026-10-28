import test from 'node:test';
import assert from 'node:assert/strict';
import { createLark, LarkError } from '../src/lark.js';

// Envelopes captured from real `lark-cli api ... --as user --json` calls.
const envelope = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: 'user', data }), stderr: '' });
const failure = (error, code = 3) => ({ code, stdout: JSON.stringify({ ok: false, error }), stderr: '' });

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const jsonFlag = (args, name) => JSON.parse(flag(args, name));

function capture(respond) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return respond({ cmd, args, index: calls.length - 1 });
  };
  return { calls, run };
}

const message = (id, createTime, text) => ({
  message_id: id,
  msg_type: 'text',
  create_time: createTime,
  deleted: false,
  updated: false,
  chat_id: 'oc_x',
  chat_type: 'group',
  parent_id: '',
  root_id: '',
  body: { content: JSON.stringify({ text }) },
  sender: { id: 'ou_human', id_type: 'open_id', sender_type: 'user', tenant_key: 't' },
});

const ITEMS = [message('om_1', '1793162767000', '先'), message('om_2', '1793162767785', '后')];

test('listMessages calls the raw api endpoint with chat params and returns data.items unchanged', async () => {
  const { calls, run } = capture(() =>
    envelope({ items: ITEMS, has_more: false, page_token: '' }),
  );
  const lark = createLark({ run });

  const msgs = await lark.listMessages('oc_x');

  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'GET', '/open-apis/im/v1/messages']);
  assert.ok(args.includes('--params'));
  assert.ok(args.includes('--json'));
  assert.equal(flag(args, '--as'), 'user');

  const params = jsonFlag(args, '--params');
  assert.equal(params.container_id, 'oc_x');
  assert.equal(params.container_id_type, 'chat');
  assert.equal(params.sort_type, 'ByCreateTimeAsc');
  assert.equal(params.page_size, 20);

  // Server order is preserved verbatim: no client-side re-sort or mapping.
  assert.deepEqual(msgs, ITEMS);
});

test('listMessages passes pageSize through and tolerates a missing items field', async () => {
  const { calls, run } = capture(() => envelope({ has_more: false, page_token: '' }));
  const lark = createLark({ run });

  const msgs = await lark.listMessages('oc_x', { pageSize: 7 });

  assert.deepEqual(msgs, []);
  assert.equal(jsonFlag(calls[0].args, '--params').page_size, 7);
});

test('listMessages still runs real reads when dryRun is enabled', async () => {
  let called = 0;
  const run = async () => {
    called += 1;
    return envelope({ items: ITEMS, has_more: false, page_token: '' });
  };
  const lark = createLark({ run, dryRun: true });

  assert.deepEqual(await lark.listMessages('oc_x'), ITEMS);
  assert.equal(called, 1);
});

test('reply posts a text body JSON string and returns the new message id', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_reply' }));
  const lark = createLark({ run });

  const res = await lark.reply('om_1', 'hello');

  assert.deepEqual(res, { messageId: 'om_reply' });
  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'POST', '/open-apis/im/v1/messages/om_1/reply']);
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));

  const body = jsonFlag(args, '--data');
  assert.equal(body.msg_type, 'text');
  assert.equal(typeof body.content, 'string');
  assert.equal(body.content, '{"text":"hello"}');
});

test('reply is suppressed under dryRun, logs the text, and never calls run', async () => {
  const seen = [];
  const log = { info: (m) => seen.push(m), warn: () => {} };
  const { calls, run } = capture(() => envelope({ message_id: 'om_reply' }));
  const lark = createLark({ run, dryRun: true, log });

  const res = await lark.reply('om_1', 'hello');

  assert.deepEqual(res, { messageId: 'dry-run' });
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /hello/);
});

test('send uses receive_id_type chat_id and carries the chat in the body', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_sent' }));
  const lark = createLark({ run });

  const res = await lark.send('oc_x', '通知');

  assert.deepEqual(res, { messageId: 'om_sent' });
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'POST', '/open-apis/im/v1/messages']);
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));
  assert.deepEqual(jsonFlag(args, '--params'), { receive_id_type: 'chat_id' });

  const body = jsonFlag(args, '--data');
  assert.equal(body.receive_id, 'oc_x');
  assert.equal(body.msg_type, 'text');
  assert.equal(body.content, '{"text":"通知"}');
});

test('send is suppressed under dryRun and never calls run', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_sent' }));
  const lark = createLark({ run, dryRun: true });

  assert.deepEqual(await lark.send('oc_x', '通知'), { messageId: 'dry-run' });
  assert.equal(calls.length, 0);
});

test('a failure envelope raises LarkError with code and missing scopes', async () => {
  const run = async () =>
    failure({ type: 'auth', subtype: 'scope', code: 99991672, message: 'denied', missing_scopes: ['im:x'] });
  const lark = createLark({ run });

  await assert.rejects(
    () => lark.listMessages('oc_x'),
    (err) => {
      assert.ok(err instanceof LarkError);
      assert.equal(err.code, 99991672);
      assert.deepEqual(err.missingScopes, ['im:x']);
      return true;
    },
  );
});

test('unparseable stdout raises LarkError mentioning unparseable', async () => {
  const run = async () => ({ code: 0, stdout: 'not json', stderr: 'boom' });
  const lark = createLark({ run });

  await assert.rejects(() => lark.reply('om_1', 'x'), /unparseable/);
});

test('empty stdout on a failed exit raises LarkError carrying stderr', async () => {
  const run = async () => ({ code: 3, stdout: '', stderr: 'spawn lark-cli ENOENT' });
  const lark = createLark({ run });

  await assert.rejects(
    () => lark.listMessages('oc_x'),
    (err) => {
      assert.ok(err instanceof LarkError);
      assert.match(err.message, /spawn lark-cli ENOENT/);
      return true;
    },
  );
});

test('getSenderName resolves data.user.name via contact +get-user', async () => {
  const { calls, run } = capture(() => envelope({ user: { name: '南柯' } }));
  const lark = createLark({ run });

  assert.equal(await lark.getSenderName('ou_human'), '南柯');
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 2), ['contact', '+get-user']);
  assert.equal(flag(args, '--user-id'), 'ou_human');
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));
});

test('getSenderName returns an empty string instead of throwing', async () => {
  const warnings = [];
  const log = { info: () => {}, warn: (m) => warnings.push(m) };

  const spawnFailure = createLark({
    run: async () => {
      throw new Error('spawn lark-cli ENOENT');
    },
    log,
  });
  assert.equal(await spawnFailure.getSenderName('ou_human'), '');

  const denied = createLark({
    run: async () => failure({ code: 99991672, message: 'denied', missing_scopes: ['im:x'] }),
    log,
  });
  assert.equal(await denied.getSenderName('ou_human'), '');

  const nameless = createLark({ run: async () => envelope({ user: {} }), log });
  assert.equal(await nameless.getSenderName('ou_human'), '');

  assert.equal(warnings.length, 3);
});
