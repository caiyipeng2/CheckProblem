import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence, extractTerms } from '../src/search.js';

test('extractTerms keeps identifiers and drops function-word bigrams', () => {
  const terms = extractTerms('玩家反馈通关奖励没到账，reward_1001 没发，db 表');
  assert.ok(terms.includes('reward_1001'), 'an identifier is the strongest signal');
  assert.ok(terms.includes('玩家'));
  assert.ok(terms.includes('奖励'));
  assert.ok(!terms.includes('没到'), 'a bigram built from function words is noise');
  assert.ok(!terms.includes('什么'));
  assert.equal(terms.length <= 12, true);
});

test('extractTerms returns nothing for an empty question', () => {
  assert.deepEqual(extractTerms(''), []);
  assert.deepEqual(extractTerms('   '), []);
  assert.deepEqual(extractTerms(undefined), []);
});

test('extractTerms tolerates a question with no ASCII identifiers', () => {
  const terms = extractTerms('奖励没到账');
  assert.ok(terms.length > 0);
  assert.ok(terms.every((term) => /^[\u4e00-\u9fff]+$/.test(term)));
});

const grepOut = [
  'Assets/Scripts/Feedback.cs:58:    sb.Append("玩家反馈");',
  'Assets/Scripts/Feedback.cs:29:    反馈时间',
  'Assets/Config/Reward.cs:12: public int reward_1001; // 通关奖励',
  'Assets/Config/Reward.cs:14: 通关奖励配置',
  '',
].join('\r\n');

function fakeRun(res) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof res === 'function' ? res(cmd, args) : res;
  };
  return { run, calls };
}

test('collectEvidence parses CRLF grep output and ranks by distinct keywords', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: grepOut, stderr: '' });
  const ev = await collectEvidence({ question: '玩家反馈通关奖励 reward_1001', repoDir: 'C:/repo', run });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-C', 'C:/repo', 'grep']);
  assert.ok(calls[0].args.includes('-f'), 'patterns travel in a file, not in argv');
  for (const arg of calls[0].args) {
    assert.equal(/[\u4e00-\u9fff]/.test(arg), false, 'no Chinese keyword may reach argv');
  }

  assert.equal(ev.files.length, 2);
  assert.equal(ev.files[0].path, 'Assets/Config/Reward.cs', 'the specific identifier outranks a common word');
  assert.match(ev.digest, /reward_1001/);
  assert.match(ev.digest, /Feedback\.cs/);
  assert.equal(ev.note, '');
});

test('collectEvidence treats exit 1 as "nothing found", not an error', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: '' });
  const ev = await collectEvidence({ question: '玩家反馈', repoDir: 'C:/repo', run });
  assert.equal(ev.files.length, 0);
  assert.equal(ev.digest, '');
  assert.equal(ev.note, '没有命中');
});

test('collectEvidence reports a real grep failure and stays quiet about it', async () => {
  const warnings = [];
  const { run } = fakeRun({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  const ev = await collectEvidence({
    question: '玩家反馈',
    repoDir: 'C:/repo',
    run,
    log: { warn: (m) => warnings.push(m) },
  });
  assert.equal(ev.digest, '');
  assert.equal(ev.note, '本地检索失败');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a git repository/);
});

test('collectEvidence skips the search when the question has no searchable words', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: '', stderr: '' });
  const ev = await collectEvidence({ question: '？？', repoDir: 'C:/repo', run });
  assert.equal(calls.length, 0);
  assert.match(ev.note, /没有可检索的词/);
});