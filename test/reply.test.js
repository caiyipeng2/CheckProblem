import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_PROMPT,
  TIMEOUT_NOTICE,
  CANCELLED_NOTICE,
  formatResult,
  truncate,
  clipForReply,
} from '../src/reply.js';

const FOOTER = '—— 蔡龙自动分析 · master@a1b2c3d · 由 南柯 确认';

test('canned notices tell members what to do', () => {
  assert.match(CONFIRM_PROMPT, /确认/);
  assert.match(CONFIRM_PROMPT, /10\s*分钟/);
  assert.match(CONFIRM_PROMPT, /取消/);
  assert.match(TIMEOUT_NOTICE, /超时/);
  assert.match(CANCELLED_NOTICE, /已取消/);
});

test('formatResult carries analysis and footer', () => {
  const text = formatResult({ analysis: '【结论】奖励未发放', provenance: 'master@a1b2c3d', confirmer: '南柯' });
  assert.match(text, /【结论】奖励未发放/);
  assert.match(text, /master@a1b2c3d/);
  assert.match(text, /南柯/);
  assert.equal(text, `【结论】奖励未发放\n\n${FOOTER}`);
});

test('formatResult trims the analysis before the blank line', () => {
  const text = formatResult({ analysis: '【结论】奖励未发放\n', provenance: 'master@a1b2c3d', confirmer: '南柯' });
  assert.equal(text, `【结论】奖励未发放\n\n${FOOTER}`);
  assert.doesNotMatch(text, /\n\n\n/);
});

test('formatResult tolerates missing analysis and provenance fields', () => {
  assert.doesNotThrow(() => formatResult({ analysis: undefined, provenance: 'master@a1b2c3d', confirmer: '南柯' }));
  assert.doesNotThrow(() => formatResult({}));
});

test('truncate keeps short text and clamps long text', () => {
  assert.deepEqual(truncate('abc', 10), { text: 'abc', truncated: false });
  assert.deepEqual(truncate('a'.repeat(20), 10), { text: 'a'.repeat(10), truncated: true });
});

test('clipForReply leaves a short reply untouched', () => {
  const args = { analysis: '【结论】奖励补发', provenance: 'master@a1b2c3d', confirmer: '南柯' };
  const res = clipForReply({ ...args, maxChars: 2000 });
  assert.equal(res.truncated, false);
  assert.equal(res.text, formatResult(args));
  assert.equal(res.full, formatResult(args));
});

test('clipForReply clips the body but keeps the footer intact', () => {
  const analysis = '【结论】奖励未发放，需要补发。'.repeat(40);
  const res = clipForReply({ analysis, provenance: 'master@a1b2c3d', confirmer: '南柯', maxChars: 200 });
  assert.equal(res.truncated, true);
  assert.ok(res.text.length <= 200);
  assert.match(res.text, /master@a1b2c3d · 由 南柯 确认$/);
  assert.ok(res.full.length > 200);
  assert.ok(res.full.startsWith(analysis.slice(0, 20)));
});

test('clipForReply keeps the footer on its own paragraph', () => {
  const analysis = '【结论】奖励未发放，需要补发。'.repeat(40);
  const res = clipForReply({ analysis, provenance: 'master@a1b2c3d', confirmer: '南柯', maxChars: 200 });
  assert.equal(res.truncated, true);
  assert.match(res.text, /\n\n—— 蔡龙自动分析/);
  assert.doesNotMatch(res.text, /[^。\n]—— 蔡龙自动分析/);
});

test('clipForReply keeps a footer longer than maxChars instead of cutting it', () => {
  const analysis = '【结论】奖励未发放，需要补发。'.repeat(40);
  const res = clipForReply({ analysis, provenance: 'master@a1b2c3d', confirmer: '南柯', maxChars: 10 });
  assert.equal(res.truncated, true);
  assert.equal(res.text, FOOTER);
  assert.ok(res.text.length > 10);
});

test('clipForReply tolerates an empty analysis', () => {
  const args = { analysis: '', provenance: 'master@a1b2c3d', confirmer: '南柯' };
  const res = clipForReply({ ...args, maxChars: 2000 });
  assert.equal(res.truncated, false);
  assert.ok(res.text.endsWith(FOOTER));
  assert.doesNotThrow(() => clipForReply({ analysis: undefined, maxChars: 2000 }));
});
