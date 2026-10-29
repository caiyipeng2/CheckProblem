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
