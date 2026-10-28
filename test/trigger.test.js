import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPlainText,
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
