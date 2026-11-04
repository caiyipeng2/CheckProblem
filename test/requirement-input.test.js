import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocumentLink,
  classifyRequirementMessage,
  resolveRequestReference,
} from '../src/requirement-input.js';

const BOT = 'ou_bot';
const HOSTS = ['hellowd.feishu.cn'];
const DOCX = 'https://hellowd.feishu.cn/docx/OCgddiDEfo9jojxG5v1cMsh5n1w?from=from_copylink';
const MENTION = { key: '@_user_1', id: { open_id: BOT }, name: '蔡龙' };

const bodyMsg = (msgType, content, extra = {}) => ({
  msg_type: msgType,
  body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
  ...extra,
});
const textMsg = (text, extra = {}) => bodyMsg('text', { text }, extra);
const startOptions = { selfOpenId: BOT, hosts: HOSTS };

test('normalizes copy links without changing document identity', () => {
  const a = normalizeDocumentLink('https://hellowd.feishu.cn/docx/abc?from=copy', { hosts: HOSTS });
  const b = normalizeDocumentLink('https://hellowd.feishu.cn/docx/abc#part', { hosts: HOSTS });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { kind: 'docx', token: 'abc', url: 'https://hellowd.feishu.cn/docx/abc' });
  assert.equal(normalizeDocumentLink('https://hellowd.feishu.cn/wiki/abc/', { hosts: HOSTS }).kind, 'wiki');
});

test('document links reject untrusted hosts, credentials, schemes and ports', () => {
  for (const raw of [
    'https://other.feishu.cn/docx/abc',
    'https://u@hellowd.feishu.cn/docx/abc',
    'https://u:p@hellowd.feishu.cn/docx/abc',
    'http://hellowd.feishu.cn/docx/abc',
    'https://hellowd.feishu.cn:8443/docx/abc',
    'https://hellowd.feishu.cn:443/docx/abc',
    'https://@hellowd.feishu.cn/docx/abc',
    'not a url',
    '',
  ]) {
    assert.throws(() => normalizeDocumentLink(raw, { hosts: HOSTS }),
      { message: 'UNTRUSTED_DOCUMENT_URL' }, raw);
  }
});

test('document links require a supported docx or wiki path', () => {
  for (const raw of [
    'https://hellowd.feishu.cn/sheets/abc',
    'https://hellowd.feishu.cn/docx/abc/extra',
    'https://hellowd.feishu.cn/docx/abc-def',
    'https://hellowd.feishu.cn/docx/',
  ]) {
    assert.throws(() => normalizeDocumentLink(raw, { hosts: HOSTS }),
      { message: 'UNSUPPORTED_DOCUMENT_URL' }, raw);
  }
});

test('the configured host allowlist is compared case-insensitively', () => {
  assert.equal(
    normalizeDocumentLink('https://HELLOWD.FEISHU.CN/docx/abc', { hosts: ['Hellowd.Feishu.CN'] }).url,
    'https://hellowd.feishu.cn/docx/abc',
  );
});

test('a text message with the bot mention starts a split and yields its document', () => {
  const message = textMsg(`@_user_1 拆分需求 ${DOCX}，谢谢`, { mentions: [MENTION] });
  assert.deepEqual(classifyRequirementMessage(message, startOptions), {
    kind: 'start',
    documents: [{
      kind: 'docx',
      token: 'OCgddiDEfo9jojxG5v1cMsh5n1w',
      url: 'https://hellowd.feishu.cn/docx/OCgddiDEfo9jojxG5v1cMsh5n1w',
    }],
  });
});

test('copy links of the same document collapse to one entry', () => {
  const message = textMsg(
    '@_user_1 拆分需求 https://hellowd.feishu.cn/docx/abc?from=copy https://hellowd.feishu.cn/docx/abc#part',
    { mentions: [MENTION] },
  );
  const result = classifyRequirementMessage(message, startOptions);
  assert.deepEqual(result.documents.map((doc) => [doc.kind, doc.token]), [['docx', 'abc']]);
});

test('two distinct documents are both retained', () => {
  const message = textMsg(
    '@_user_1 拆分需求 https://hellowd.feishu.cn/docx/abc https://hellowd.feishu.cn/wiki/def',
    { mentions: [MENTION] },
  );
  const result = classifyRequirementMessage(message, startOptions);
  assert.deepEqual(result.documents.map((doc) => [doc.kind, doc.token]), [['docx', 'abc'], ['wiki', 'def']]);
});

test('the poller hands mentions back as a flat open_id string', () => {
  // im/v1/messages returns `mentions[].id` as the id itself plus `id_type`,
  // not the nested `{ open_id }` shape used by message events.
  const flatBot = { id: BOT, id_type: 'open_id', key: '@_user_1', name: '蔡龙' };
  const start = textMsg(`@_user_1 拆分需求 ${DOCX}`, { mentions: [flatBot] });
  assert.deepEqual(classifyRequirementMessage(start, startOptions).documents.map((doc) => doc.token), [
    'OCgddiDEfo9jojxG5v1cMsh5n1w',
  ]);

  const flatOther = { id: 'ou_other', id_type: 'open_id', key: '@_user_1', name: '其他机器人' };
  assert.equal(
    classifyRequirementMessage(textMsg(`@_user_1 拆分需求 ${DOCX}`, { mentions: [flatOther] }), startOptions),
    null,
  );
});

test('a plain document link without the bot mention never starts a split', () => {
  assert.equal(classifyRequirementMessage(
    textMsg(`拆分需求 ${DOCX}`), startOptions,
  ), null);
  assert.equal(classifyRequirementMessage(
    textMsg(`拆分需求 ${DOCX}`, { mentions: [{ id: { open_id: 'ou_other' }, name: '其他机器人' }] }),
    startOptions,
  ), null);
  assert.equal(classifyRequirementMessage(undefined, startOptions), null);
});

test('the start command must be the prefix of the cleaned message', () => {
  for (const text of [
    `@_user_1 不要拆分需求 ${DOCX}`,
    `@_user_1 请参考拆分需求文档 ${DOCX}`,
  ]) {
    const message = textMsg(text, { mentions: [MENTION] });
    assert.equal(classifyRequirementMessage(message, startOptions), null, text);
  }
});

test('a post extracts a link from an a node and the mention from an at node', () => {
  const message = bodyMsg('post', {
    zh_cn: {
      title: '',
      content: [[
        { tag: 'text', text: '@_user_1 拆分需求' },
        { tag: 'a', href: 'https://hellowd.feishu.cn/docx/abc?from=copy', text: '文档' },
        { tag: 'at', user_id: BOT, user_name: '蔡龙' },
      ]],
    },
  });
  assert.deepEqual(classifyRequirementMessage(message, startOptions), {
    kind: 'start',
    documents: [{ kind: 'docx', token: 'abc', url: 'https://hellowd.feishu.cn/docx/abc' }],
  });
});

test('a post collects md text URLs and ignores a non-bot at node', () => {
  const message = bodyMsg('post', {
    content: [[
      { tag: 'md', text: '拆分需求 [文档](https://hellowd.feishu.cn/docx/abc)' },
      { tag: 'at', user_id: 'ou_other', user_name: '别人' },
    ]],
  });
  assert.equal(classifyRequirementMessage(message, startOptions), null);

  const mentioned = bodyMsg('post', {
    content: [[
      { tag: 'md', text: '拆分需求 [文档](https://hellowd.feishu.cn/docx/abc)' },
      { tag: 'at', user_id: BOT, user_name: '蔡龙' },
    ]],
  });
  assert.deepEqual(classifyRequirementMessage(mentioned, startOptions).documents.map((doc) => doc.token), ['abc']);
});

test('untrusted or unsupported links are skipped instead of failing the classifier', () => {
  for (const link of [
    'https://evil.example/docx/abc',
    'http://hellowd.feishu.cn/docx/abc',
    'https://hellowd.feishu.cn/sheets/abc',
  ]) {
    assert.equal(classifyRequirementMessage(
      textMsg(`@_user_1 拆分需求 ${link}`, { mentions: [MENTION] }),
      startOptions,
    ), null, link);
  }
});

const REQUESTS = [
  { id: 'r1', triggerMessageId: 'om_trigger', cardMessageIds: ['om_card'] },
  { id: 'r2', triggerMessageId: 'om_other', cardMessageIds: [] },
];

test('an edit requires the explicit prefix and a unique thread reference', () => {
  const message = textMsg('@_user_1 修改拆分：将M01延期', {
    mentions: [MENTION], parent_id: 'om_trigger', root_id: 'om_trigger',
  });
  assert.deepEqual(classifyRequirementMessage(message, { ...startOptions, requests: REQUESTS }), {
    kind: 'edit',
    requestId: 'r1',
    text: '将M01延期',
    parentId: 'om_trigger',
    rootId: 'om_trigger',
  });

  const cardRoot = textMsg('@_user_1 修改拆分 排除M02', {
    mentions: [MENTION], parent_id: 'om_unrelated', root_id: 'om_card',
  });
  assert.equal(
    classifyRequirementMessage(cardRoot, { ...startOptions, requests: REQUESTS }).requestId,
    'r1',
  );
});

test('an edit can reference the request id as a whole token', () => {
  const message = textMsg('@_user_1 修改拆分 r2 将M01延期', {
    mentions: [MENTION], parent_id: 'om_unknown', root_id: 'om_unknown',
  });
  assert.equal(
    classifyRequirementMessage(message, { ...startOptions, requests: REQUESTS }).requestId,
    'r2',
  );
});

test('a request id only matches on whole-token boundaries', () => {
  assert.equal(resolveRequestReference(
    textMsg('please r1x'), [{ id: 'r1', triggerMessageId: 'om_t', cardMessageIds: [] }],
  ), null);
  assert.equal(resolveRequestReference(
    textMsg('please r1'), [{ id: 'r1', triggerMessageId: 'om_t', cardMessageIds: [] }],
  ), 'r1');
});

test('a request id that only appears inside a URL is not a reference', () => {
  assert.equal(resolveRequestReference(
    textMsg('see https://example.com/requests/r1'),
    [{ id: 'r1', triggerMessageId: 'om_t', cardMessageIds: [] }],
  ), null);
});

test('an ambiguous edit reference throws AMBIGUOUS_REQUEST', () => {
  const message = textMsg('@_user_1 修改拆分 r1 r2 将M01延期', { mentions: [MENTION] });
  assert.throws(
    () => classifyRequirementMessage(message, { ...startOptions, requests: REQUESTS }),
    { message: 'AMBIGUOUS_REQUEST' },
  );
});

test('ordinary chatter and edits without a unique reference return null', () => {
  const options = { ...startOptions, requests: REQUESTS };
  assert.equal(classifyRequirementMessage(
    textMsg('@_user_1 补充一下', { mentions: [MENTION], parent_id: 'om_trigger', root_id: 'om_trigger' }),
    options,
  ), null);
  assert.equal(classifyRequirementMessage(
    textMsg('@_user_1 麻烦修改拆分：将M01延期', {
      mentions: [MENTION], parent_id: 'om_trigger', root_id: 'om_trigger',
    }),
    options,
  ), null);
  assert.equal(classifyRequirementMessage(
    textMsg('@_user_1 修改拆分：将M01延期', { mentions: [MENTION], parent_id: 'om_none', root_id: 'om_none' }),
    options,
  ), null);
  assert.equal(classifyRequirementMessage(
    textMsg('@_user_1 修改拆分：将M01延期', {
      mentions: [MENTION], parent_id: 'om_trigger', root_id: 'om_trigger',
    }),
    startOptions,
  ), null);
});
