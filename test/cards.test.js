import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryCard } from '../src/cards.js';

const projects = [{ id: 'weapon', name: '武器店', branch: 'master' }];
const job = {
  requestId: 'request-1', revision: 3, status: 'awaiting', projectId: 'weapon',
  branch: 'master', branches: ['master', 'feature/rewards'],
  question: '<at id=all>所有人</at> [点我](javascript:evil)',
};
function walk(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (value.tag) result.push(value);
  Object.values(value).forEach((entry) => {
    if (Array.isArray(entry)) entry.forEach((v) => walk(v, result));
    else walk(entry, result);
  });
  return result;
}

test('untrusted question remains plain text, never markup or an action', () => {
  const nodes = walk(buildQueryCard({ job, projects }));
  assert.ok(nodes.some((n) => n.tag === 'plain_text' && n.content === job.question));
  assert.ok(!nodes.some((n) => n.tag === 'markdown' && n.content.includes('<at')));
  for (const n of nodes.filter((n) => n.behaviors)) {
    assert.deepEqual(n.behaviors[0].value, { requestId: 'request-1', revision: 3, action: n.name });
  }
});

test('terminal cards disable all controls', () => {
  for (const status of ['running', 'completed', 'cancelled', 'expired', 'failed', 'interrupted']) {
    const nodes = walk(buildQueryCard({ job: { ...job, status }, projects }));
    const controls = nodes.filter((n) => ['button', 'select_static'].includes(n.tag));
    assert.equal(controls.length, 4);
    assert.ok(controls.every((n) => n.disabled));
  }
});

test('custom timeout is displayed rather than a hard-coded ten minutes', () => {
  const rendered = JSON.stringify(buildQueryCard({ job: { ...job, timeoutSec: 120 }, projects }));
  assert.match(rendered, /2 分钟/);
  assert.doesNotMatch(rendered, /10 分钟/);
});

test('large Unicode branch catalogs fit the API limit and remain reachable across pages', () => {
  const branches = Array.from({ length: 400 }, (_, i) => `feature/${i}-${'分'.repeat(200)}`);
  const seen = new Set();
  let branchPage = 0;
  for (let page = 0; page < 401; page++) {
    const card = buildQueryCard({ job: { ...job, branches, branch: branches[399], branchPage }, projects });
    assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 30 * 1024);
    const select = walk(card).find((n) => n.name === 'branch');
    assert.ok(select.options.length <= 100);
    assert.ok(select.options.some((o) => o.value === select.initial_option));
    select.options.filter((o) => branches.includes(o.value)).forEach((o) => seen.add(o.value));
    const next = select.options.find((o) => o.text.content.startsWith('下一页'));
    if (!next) break;
    branchPage = Number(next.value.slice(':page:'.length));
  }
  assert.equal(seen.size, 400);
});

const tapdEntry = { workspaceId: '59180547', tokenFile: 'C:/secrets/tapd.token', fields: {} };
const done = { status: 'completed', analysis: '【结论】配置缺失：表里没有该档位' };

test('a completed card offers the TAPD submit button only when the project has a workspace', () => {
  const withTapd = walk(buildQueryCard({ job: { ...job, ...done }, projects, tapd: tapdEntry }));
  const button = withTapd.find((node) => node.tag === 'button' && node.name === 'tapd');
  assert.ok(button, 'the submit button exists');
  assert.equal(button.disabled, false, 'a finished report is submittable');
  assert.deepEqual(button.behaviors[0].value, { requestId: 'request-1', revision: 3, action: 'tapd' });
  assert.ok(button.text.content.includes('提交 TAPD'));

  const without = walk(buildQueryCard({ job: { ...job, ...done }, projects }));
  assert.ok(!without.some((node) => node.name === 'tapd'), 'no workspace, no button');
});

test('only the awaiting card keeps start and cancel live, the TAPD button is separate', () => {
  const nodes = walk(buildQueryCard({ job: { ...job, ...done }, projects, tapd: tapdEntry }));
  const controls = nodes.filter((node) => ['button', 'select_static'].includes(node.tag));
  assert.equal(controls.filter((node) => node.disabled).length, controls.length - 1, 'everything but tapd is disabled');
});

test('a submitted card shows the ticket link instead of the button', () => {
  const nodes = walk(buildQueryCard({
    job: { ...job, ...done, tapd: { status: 'done', bugId: '1159180547001002353', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1159180547001002353' } },
    projects,
    tapd: tapdEntry,
  }));
  assert.ok(!nodes.some((node) => node.name === 'tapd' && node.tag === 'button'), 'the button is gone');
  const markdown = nodes.find((node) => node.tag === 'markdown' && node.content.includes('tapd_fe'));
  assert.match(markdown.content, /\[TAPD 1159180547001002353\]\(https:\/\/www\.tapd\.cn\/tapd_fe\/59180547\/bug\/detail\/1159180547001002353\)/);
});

test('submitting disables the button and a failure invites a retry', () => {
  const busy = JSON.stringify(buildQueryCard({ job: { ...job, ...done, tapd: { status: 'submitting' } }, projects, tapd: tapdEntry }));
  assert.match(busy, /提交中/);
  assert.match(busy, /"disabled":true/);
  assert.match(busy, /若服务已重启，请先在 TAPD 确认是否已建单/);

  const failed = JSON.stringify(buildQueryCard({
    job: { ...job, ...done, tapd: { status: 'failed', error: '标题不能为空' } },
    projects,
    tapd: tapdEntry,
  }));
  assert.match(failed, /重试提交 TAPD 缺陷单/);
  assert.match(failed, /TAPD 提单失败：标题不能为空/);
});

test('an unawaiting job without a finished status never renders the button', () => {
  for (const status of ['awaiting', 'running', 'expired', 'failed', 'cancelled', 'interrupted']) {
    const rendered = JSON.stringify(buildQueryCard({ job: { ...job, status }, projects, tapd: tapdEntry }));
    assert.ok(!rendered.includes('"action":"tapd"'), `${status} cannot submit`);
  }
});

test('the TAPD button never breaks the 30 KiB card limit', () => {
  const branches = Array.from({ length: 120 }, (_, i) => `feature/${'分支'.repeat(30)}-${i}`);
  const card = buildQueryCard({
    job: { ...job, ...done, branches, branch: branches[0], branchPage: 0 },
    projects,
    tapd: tapdEntry,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 30 * 1024);
});
