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
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return respond({ cmd, args, opts, index: calls.length - 1 });
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

test('listMessages calls the raw api endpoint with chat params and returns items oldest-first', async () => {
  // The API page is newest-first; the adapter must flip it back to ascending.
  const { calls, run } = capture(() =>
    envelope({ items: [...ITEMS].reverse(), has_more: false, page_token: '' }),
  );
  const lark = createLark({ run });

  const msgs = await lark.listMessages('oc_x');

  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'GET', '/open-apis/im/v1/messages']);
  assert.ok(args.includes('--params'));
  assert.ok(args.includes('--json'));
  assert.equal(flag(args, '--as'), 'user');
  assert.deepEqual(opts, {});

  const params = jsonFlag(args, '--params');
  assert.equal(params.container_id, 'oc_x');
  assert.equal(params.container_id_type, 'chat');
  assert.equal(params.sort_type, 'ByCreateTimeDesc');
  assert.equal(params.page_size, 20);

  assert.deepEqual(msgs, ITEMS);
});

test('listMessages requests the newest-first sort type', async () => {
  const { calls, run } = capture(() => envelope({ items: [] }));
  const lark = createLark({ run });

  await lark.listMessages('oc_x');

  assert.equal(jsonFlag(calls[0].args, '--params').sort_type, 'ByCreateTimeDesc');
});

test('listMessages reverses a newest-first page into ascending create_time order', async () => {
  const newestFirst = [
    message('om_3', '1793162768000', '三'),
    message('om_2', '1793162767785', '二'),
    message('om_1', '1793162767000', '一'),
  ];
  const { run } = capture(() => envelope({ items: newestFirst, has_more: false, page_token: '' }));
  const lark = createLark({ run });

  const msgs = await lark.listMessages('oc_x');

  assert.deepEqual(msgs.map((m) => m.message_id), ['om_1', 'om_2', 'om_3']);
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
    return envelope({ items: [...ITEMS].reverse(), has_more: false, page_token: '' });
  };
  const lark = createLark({ run, dryRun: true });

  assert.deepEqual(await lark.listMessages('oc_x'), ITEMS);
  assert.equal(called, 1);
});

test('reply posts a text body JSON string on stdin and returns the new message id', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_reply' }));
  const lark = createLark({ run });

  const res = await lark.reply('om_1', 'hello');

  assert.deepEqual(res, { messageId: 'om_reply' });
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'POST', '/open-apis/im/v1/messages/om_1/reply']);
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));

  const expected = { content: '{"text":"hello"}', msg_type: 'text' };
  // The body must not leak into argv, where the Windows shell would see it.
  assert.equal(args.includes(JSON.stringify(expected)), false);
  assert.equal(args.some((arg) => String(arg).includes('hello')), false);
  assert.equal(flag(args, '--data'), '-');

  assert.equal(typeof opts.stdin, 'string');
  const body = JSON.parse(opts.stdin);
  assert.deepEqual(body, expected);
  assert.equal(typeof body.content, 'string');
});

test('botReplies sends service text as the bot while message reads remain user-scoped', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_bot_reply', items: [] }));
  const lark = createLark({ run, botReplies: true });
  assert.deepEqual(await lark.reply('om_question', '蔡龙自动分析'), { messageId: 'om_bot_reply' });
  await lark.listMessages('oc_x');
  assert.equal(flag(calls[0].args, '--as'), 'bot');
  assert.equal(flag(calls[1].args, '--as'), 'user');
  assert.deepEqual(JSON.parse(calls[0].opts.stdin), { content: '{"text":"蔡龙自动分析"}', msg_type: 'text' });
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

test('send uses receive_id_type chat_id and carries the chat in the stdin body', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_sent' }));
  const lark = createLark({ run });

  const res = await lark.send('oc_x', '通知');

  assert.deepEqual(res, { messageId: 'om_sent' });
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 3), ['api', 'POST', '/open-apis/im/v1/messages']);
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));
  assert.deepEqual(jsonFlag(args, '--params'), { receive_id_type: 'chat_id' });

  const expected = { receive_id: 'oc_x', msg_type: 'text', content: '{"text":"通知"}' };
  assert.equal(args.includes(JSON.stringify(expected)), false);
  assert.equal(args.some((arg) => String(arg).includes('通知')), false);
  assert.equal(flag(args, '--data'), '-');

  assert.equal(typeof opts.stdin, 'string');
  const body = JSON.parse(opts.stdin);
  assert.deepEqual(body, expected);
  assert.equal(typeof body.content, 'string');
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
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 2), ['contact', '+get-user']);
  assert.equal(flag(args, '--user-id'), 'ou_human');
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));
  assert.deepEqual(opts, {});
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

test('reply rejects an unsafe message id before calling run', async () => {
  const { calls, run } = capture(() => envelope({ message_id: 'om_reply' }));
  const lark = createLark({ run });

  await assert.rejects(() => lark.reply('om_1; rm -rf /', 'x'), LarkError);
  assert.equal(calls.length, 0);
});

test('listMessages rejects an unsafe chat id', async () => {
  const { calls, run } = capture(() => envelope({ items: ITEMS }));
  const lark = createLark({ run });

  await assert.rejects(() => lark.listMessages('oc_x y'), LarkError);
  assert.equal(calls.length, 0);
});

test('getSenderName returns an empty string for an unsafe open id', async () => {
  const warnings = [];
  const { calls, run } = capture(() => envelope({ user: { name: '南柯' } }));
  const lark = createLark({ run, log: { info: () => {}, warn: (m) => warnings.push(m) } });

  assert.equal(await lark.getSenderName('bad id'), '');
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
});

const CARD = { elements: [{ tag: 'markdown', content: '确认 & %SECRET% "按钮"' }] };

for (const [method, id, verb, path, extra] of [
  ['replyCard', 'om_1', 'POST', '/open-apis/im/v1/messages/om_1/reply', { msg_type: 'interactive' }],
  ['updateCard', 'om_1', 'PATCH', '/open-apis/im/v1/messages/om_1', {}],
  ['sendCard', 'oc_x', 'POST', '/open-apis/im/v1/messages', { receive_id: 'oc_x', msg_type: 'interactive' }],
]) {
  test(`${method} writes interactive content through stdin with bot identity only`, async () => {
    const { calls, run } = capture(() => envelope({ message_id: 'om_card' }));
    const result = await createLark({ run })[method](id, CARD);
    if (method !== 'updateCard') assert.deepEqual(result, { messageId: 'om_card' });
    assert.equal(calls.length, 1);
    const { cmd, args, opts } = calls[0];
    assert.equal(cmd, 'lark-cli');
    assert.deepEqual(args.slice(0, 3), ['api', verb, path]);
    assert.deepEqual(args.slice(-3), ['--as', 'bot', '--json']);
    assert.equal(args.includes('user'), false);
    assert.equal(flag(args, '--data'), '-');
    assert.deepEqual(JSON.parse(opts.stdin), { ...extra, content: JSON.stringify(CARD) });
    assert.equal(args.some((arg) => arg.includes('SECRET') || arg.includes('确认')), false);
    if (method === 'sendCard') {
      assert.deepEqual(jsonFlag(args, '--params'), { receive_id_type: 'chat_id' });
    }
  });

  test(`${method} honors dryRun without logging card contents`, async () => {
    const logs = [];
    const { calls, run } = capture(() => envelope({}));
    const result = await createLark({ run, dryRun: true, log: { info: (m) => logs.push(m) } })[method](id, CARD);
    if (method !== 'updateCard') assert.deepEqual(result, { messageId: 'dry-run' });
    assert.equal(calls.length, 0);
    assert.equal(logs.some((m) => m.includes('SECRET')), false);
  });

  test(`${method} validates ids and UTF-8 serialized size even in dryRun`, async () => {
    for (const dryRun of [false, true]) {
      const { calls, run } = capture(() => envelope({}));
      const lark = createLark({ run, dryRun });
      for (const bad of ['', 'om_x&whoami', '../om_x', null]) {
        await assert.rejects(() => lark[method](bad, CARD), LarkError);
      }
      await assert.rejects(() => lark[method](id, { text: '中'.repeat(10240) }), /30\s*Ki?B|30\s*KB/i);
      const circular = {}; circular.self = circular;
      await assert.rejects(() => lark[method](id, circular), LarkError);
      await assert.rejects(() => lark[method](id, undefined), LarkError);
      assert.equal(calls.length, 0);
    }
  });

  test(`${method} accepts exactly 30 KiB of serialized content`, async () => {
    const { calls, run } = capture(() => envelope({}));
    // {"text":""} is 11 bytes; Chinese characters are three bytes each.
    await createLark({ run })[method](id, { text: '中'.repeat(10236) + 'x' });
    assert.equal(Buffer.byteLength(JSON.parse(calls[0].opts.stdin).content), 30720);
  });

  test(`${method} surfaces CLI failures`, async () => {
    const lark = createLark({ run: async () => failure({ message: 'denied', code: 403 }) });
    await assert.rejects(() => lark[method](id, CARD), (err) => err instanceof LarkError && err.code === 403);
  });
}

test('downloadImage saves a message image through the download shortcut', async () => {
  const { calls, run } = capture(() => envelope({ saved_path: 'C:/tmp/x.png', size_bytes: 1234 }));
  const lark = createLark({ run });

  const res = await lark.downloadImage({
    messageId: 'om_1',
    fileKey: 'img_v3_02abc_DEF',
    outputPath: 'C:/tmp/checkproblem/job/image-1',
  });

  assert.deepEqual(res, { path: 'C:/tmp/x.png', size: 1234 });
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'lark-cli');
  assert.deepEqual(args.slice(0, 2), ['im', '+messages-resources-download']);
  assert.equal(flag(args, '--message-id'), 'om_1');
  assert.equal(flag(args, '--file-key'), 'img_v3_02abc_DEF');
  assert.equal(flag(args, '--type'), 'image');
  assert.equal(flag(args, '--output'), 'C:/tmp/checkproblem/job/image-1');
  assert.equal(flag(args, '--as'), 'user');
  assert.ok(args.includes('--json'));
  assert.deepEqual(opts, {});
});

test('downloadImage is suppressed under dryRun and refuses unsafe ids', async () => {
  const { calls, run } = capture(() => envelope({ saved_path: 'C:/tmp/x.png' }));
  const dry = createLark({ run, dryRun: true, log: { info() {}, warn() {} } });
  assert.deepEqual(await dry.downloadImage({ messageId: 'om_1', fileKey: 'img_a', outputPath: 'p' }), { path: '' });
  assert.equal(calls.length, 0);

  const lark = createLark({ run });
  for (const bad of [
    { messageId: 'om_1; rm -rf /', fileKey: 'img_a', outputPath: 'p' },
    { messageId: 'om_1', fileKey: 'img_a && whoami', outputPath: 'p' },
    { messageId: 'om_1', fileKey: 'img_a', outputPath: '' },
  ]) {
    await assert.rejects(() => lark.downloadImage(bad), LarkError);
  }
  assert.equal(calls.length, 0);
});
