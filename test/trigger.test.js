import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlainText,
  extractImageKeys,
  isTrigger,
  hasTrigger,
  classifyConfirmation,
  timeOf,
  isUnseen,
} from '../src/trigger.js';

// Real lark-cli items carry the JSON body at `body.content`.
const bodyMsg = (msgType, content, extra = {}) => ({
  msg_type: msgType,
  body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
  ...extra,
});

test('extractPlainText reads text messages from body.content', () => {
  assert.equal(extractPlainText(bodyMsg('text', { text: '蔡龙 查一下' })), '蔡龙 查一下');
});

test('extractPlainText falls back to legacy top-level content', () => {
  assert.equal(extractPlainText({ msg_type: 'text', content: '{"text":"蔡龙 查一下"}' }), '蔡龙 查一下');
});

test('extractPlainText joins post text nodes', () => {
  const content = JSON.stringify({
    zh_cn: { title: '', content: [[{ tag: 'text', text: '蔡龙' }, { tag: 'text', text: ' 奖励没到账' }]] },
  });
  assert.equal(extractPlainText({ msg_type: 'post', body: { content } }), '蔡龙 奖励没到账');
});

test('extractPlainText reads the flat post payload returned by the message API', () => {
  const content = JSON.stringify({
    title: '',
    content: [
      [{ tag: 'text', text: 'uid：27019278 锻造按钮不能点击' }],
      [{ tag: 'img', image_key: 'img_v3_0216u_bd5509b5-6b0a-403e-99ec-a02b457be67g' }],
    ],
  });
  const msg = bodyMsg('post', content);
  assert.equal(extractPlainText(msg), 'uid：27019278 锻造按钮不能点击');
  assert.equal(hasTrigger(msg, '蔡龙'), true);
});

test('extractPlainText returns empty string for unknown types and bad json', () => {
  assert.equal(extractPlainText(bodyMsg('image', { image_key: 'img_x' })), '');
  assert.equal(extractPlainText(bodyMsg('text', 'not-json')), '');
  assert.equal(extractPlainText({}), '');
  assert.equal(extractPlainText(undefined), '');
});

test('isTrigger matches keyword anywhere', () => {
  assert.equal(isTrigger('蔡龙 帮我看看奖励', '蔡龙'), true);
  assert.equal(isTrigger('蔡龙', '蔡龙'), true);
  assert.equal(isTrigger('这个问题蔡龙看过没', '蔡龙'), true);
  assert.equal(isTrigger('奖励没到账', '蔡龙'), false);
  assert.equal(isTrigger('', '蔡龙'), false);
  assert.equal(isTrigger('蔡龙', ''), false);
});

test('feedback trigger rules accept each approved phrase or numeric uid independently', () => {
  for (const text of [
    'uid：16115645 奖励没有到账',
    'UID:16115645',
    'Uid ： 16115645',
    '请查一下（uid: 16115645）',
    '玩家反馈竞技场奖励没到账',
    '麻烦有时间看看奖励记录',
  ]) {
    assert.equal(isTrigger(text, '蔡龙'), true, text);
    assert.equal(hasTrigger(bodyMsg('text', { text }), '蔡龙'), true, text);
  }
});

test('feedback trigger rules reject ordinary chatter and malformed uid fields', () => {
  for (const text of ['奖励没有到账', '有时间看看', 'uid', 'uid:', 'uid：abc', 'guid:123', 'uid:123abc', 'uid:12.5']) {
    assert.equal(hasTrigger(bodyMsg('text', { text }), '蔡龙'), false, text);
  }
});

test('feedback trigger rules work in rich text and without a name keyword', () => {
  assert.equal(hasTrigger(bodyMsg('post', { zh_cn: { content: [[
    { tag: 'text', text: '玩家反馈' }, { tag: 'text', text: '奖励未到账' },
  ]] } }), '蔡龙'), true);
  assert.equal(hasTrigger(bodyMsg('text', { text: 'uid：16115645' }), ''), true);
});

test('hasTrigger accepts a mention name in place of the placeholder', () => {
  const msg = bodyMsg('text', { text: '@_user_1 奖励没到账' }, {
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' }, name: '蔡龙', tenant_key: 'tk_x' }],
  });
  assert.equal(hasTrigger(msg, '蔡龙'), true);
});

test('hasTrigger ignores mentions whose name is a different bot', () => {
  const msg = bodyMsg('text', { text: '@_user_1 奖励没到账' }, {
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_y' }, name: '其他机器人', tenant_key: 'tk_x' }],
  });
  assert.equal(hasTrigger(msg, '蔡龙'), false);
});

test('hasTrigger falls back to message text when mentions is absent', () => {
  assert.equal(hasTrigger(bodyMsg('text', { text: '蔡龙 奖励没到账' }), '蔡龙'), true);
  assert.equal(hasTrigger(bodyMsg('text', { text: '奖励没到账' }), '蔡龙'), false);
});

test('hasTrigger tolerates malformed mentions and empty keyword', () => {
  const msg = bodyMsg('text', { text: '@_user_1 奖励没到账' }, {
    mentions: [{ key: '@_user_1' }, { name: null }, null],
  });
  assert.equal(hasTrigger(msg, '蔡龙'), false);
  assert.equal(hasTrigger({ mentions: [{ name: '' }] }, ''), false);
  assert.equal(
    hasTrigger({ msg_type: 'text', mentions: 'not-an-array', content: '{"text":"蔡龙"}' }, '蔡龙'),
    true,
  );
});

test('classifyConfirmation requires exact whole message', () => {
  assert.equal(classifyConfirmation('确认'), 'confirm');
  assert.equal(classifyConfirmation(' 确认 '), 'confirm');
  assert.equal(classifyConfirmation('确认啦'), null);
  assert.equal(classifyConfirmation('同意'), 'confirm');
  assert.equal(classifyConfirmation('开始查询'), 'confirm');
  assert.equal(classifyConfirmation('开始'), 'confirm');
  assert.equal(classifyConfirmation('1'), 'confirm');
  assert.equal(classifyConfirmation('取消'), 'cancel');
  assert.equal(classifyConfirmation('忽略'), 'cancel');
  assert.equal(classifyConfirmation('不用'), 'cancel');
  assert.equal(classifyConfirmation('我确认一下再说'), null);
  assert.equal(classifyConfirmation('确认了没'), null);
  assert.equal(classifyConfirmation(''), null);
});

test('timeOf parses millisecond string timestamps', () => {
  assert.equal(timeOf({ create_time: '1793162767785' }), 1793162767785);
  assert.equal(timeOf({}), 0);
  assert.equal(timeOf({ create_time: 'not-a-number' }), 0);
});

test('isUnseen compares time then message id', () => {
  const lastSeen = { createTimeMs: 1793162767785, messageId: 'om_b' };
  assert.equal(isUnseen(lastSeen, { message_id: 'om_c', create_time: '1793162767786' }), true);
  assert.equal(isUnseen(lastSeen, { message_id: 'om_a', create_time: '1793162767784' }), false);
  assert.equal(isUnseen(lastSeen, { message_id: 'om_c', create_time: '1793162767785' }), true);
  assert.equal(isUnseen(lastSeen, { message_id: 'om_a', create_time: '1793162767785' }), false);
  assert.equal(isUnseen(lastSeen, { message_id: 'om_b', create_time: '1793162767785' }), false);
});

test('extractImageKeys reads image messages and rich-text img nodes', () => {
  assert.deepEqual(
    extractImageKeys(bodyMsg('image', { image_key: 'img_v3_02abc-DEF_1' })),
    ['img_v3_02abc-DEF_1'],
  );

  const post = bodyMsg('post', {
    zh_cn: {
      title: '',
      content: [
        [{ tag: 'text', text: '看下这两张' }],
        [{ tag: 'img', image_key: 'img_v3_one' }, { tag: 'img', image_key: 'img_v3_two' }],
      ],
    },
  });
  assert.deepEqual(extractImageKeys(post), ['img_v3_one', 'img_v3_two']);
});

test('extractImageKeys ignores text, malformed keys and missing bodies', () => {
  assert.deepEqual(extractImageKeys(bodyMsg('text', { text: 'uid: 16115645' })), []);
  assert.deepEqual(extractImageKeys(bodyMsg('image', { image_key: 'img_bad key' })), []);
  assert.deepEqual(extractImageKeys(bodyMsg('image', { image_key: 42 })), []);
  assert.deepEqual(extractImageKeys(bodyMsg('image', 'not-json')), []);
  assert.deepEqual(extractImageKeys({ msg_type: 'post', body: { content: 'not-json' } }), []);
  assert.deepEqual(extractImageKeys(undefined), []);
});

test('extractImageKeys de-duplicates repeated keys inside one post', () => {
  const post = bodyMsg('post', {
    zh_cn: { content: [[{ tag: 'img', image_key: 'img_same' }, { tag: 'img', image_key: 'img_same' }]] },
  });
  assert.deepEqual(extractImageKeys(post), ['img_same']);
});
