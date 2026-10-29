import test from 'node:test';
import assert from 'node:assert/strict';
import { bugUrl, buildBugPayload, createTapdClient, parseAnalysis } from '../src/tapd.js';

const ANALYSIS = [
  '【结论】配置缺失：奖励表没有 27019278 这一档',
  '【复现】1. 进入铁匠铺',
  '【复现】2. 点击锻造按钮',
  '【定位】Assets/a.cs:12',
  '【依据】表里没有该档位。',
  '【建议】补一行配置。',
].join('\n');

const report = {
  projectId: 'weapon',
  question: 'uid：27019278 锻造按钮不能点击',
  analysis: ANALYSIS,
  provenance: 'master@a1b2c3d',
  confirmer: '蔡逸鹏',
  images: [{ messageId: 'om_1', fileKey: 'img_v3_a' }, { messageId: 'om_1', fileKey: 'img_v3_b' }],
  triggerMessageId: 'om_1',
};
const entry = {
  workspaceId: '59180547',
  tokenFile: 'C:/secrets/tapd.token',
  fields: { version_report: '每周迭代版本', os: '线上安卓', te: '蔡逸鹏;', current_owner: '小鱼;', cc: '南柯;' },
};
const projects = [{ id: 'weapon', name: '武器店' }];

test('parseAnalysis splits the five fixed sections', () => {
  assert.deepEqual(parseAnalysis(ANALYSIS), {
    conclusion: '配置缺失：奖励表没有 27019278 这一档',
    repro: '1. 进入铁匠铺\n2. 点击锻造按钮',
    location: 'Assets/a.cs:12',
    evidence: '表里没有该档位。',
    advice: '补一行配置。',
  });
});

test('parseAnalysis tolerates missing and empty input', () => {
  assert.deepEqual(parseAnalysis('【结论】数据问题：存档坏了'), {
    conclusion: '数据问题：存档坏了', repro: '', location: '', evidence: '', advice: '',
  });
  assert.deepEqual(parseAnalysis(''), { conclusion: '', repro: '', location: '', evidence: '', advice: '' });
  assert.deepEqual(parseAnalysis(undefined), { conclusion: '', repro: '', location: '', evidence: '', advice: '' });
});

test('bugUrl uses the tapd_fe detail route', () => {
  assert.equal(bugUrl('59180547', '1159180547001002353'),
    'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1159180547001002353');
});

test('payload title is [project] plus the first clause of the conclusion', () => {
  const payload = buildBugPayload({ report, entry, projects });
  assert.equal(payload.title, '[武器店] 配置缺失：奖励表没有 27019278 这一档');
});

test('payload title cuts at the first sentence mark and caps at 100 chars', () => {
  const long = { ...report, analysis: `【结论】${'钉'.repeat(200)}。后半句不要` };
  const payload = buildBugPayload({ report: long, entry, projects });
  assert.equal(payload.title.length, 100);
  assert.ok(payload.title.startsWith('[武器店] '));
  assert.ok(!payload.title.includes('后半句'), 'only the first clause survives');
});

test('payload description follows the team ticket template', () => {
  const description = buildBugPayload({ report, entry, projects }).description;
  assert.ok(description.startsWith('【问题描述】\nuid：27019278 锻造按钮不能点击\n\n【操作步骤】\n'));
  assert.match(description, /【操作步骤】\n1\. 进入铁匠铺\n2\. 点击锻造按钮\n/);
  assert.match(description, /【预期结果】\n正常\n/);
  assert.match(description, /【实际结果】\nuid：27019278 锻造按钮不能点击\n（另有 2 张截图，见飞书群消息 om_1，本单不附带图片）\n/);
  assert.match(description, /【蔡龙自动分析】\n结论：配置缺失：奖励表没有 27019278 这一档\n/);
  assert.match(description, /—— 蔡龙自动分析 · master@a1b2c3d · 由 蔡逸鹏 确认$/);
});

test('payload falls back when the model gave no repro', () => {
  const description = buildBugPayload({
    report: { ...report, analysis: '【结论】外部依赖：网关超时' },
    entry,
    projects,
  }).description;
  assert.match(description, /【操作步骤】\n1\. 按【问题描述】里的操作复现\n/);
});

test('an analysis outside the five-section contract is refused, never filed', () => {
  for (const analysis of ['模型给了一段散文，没有任何小节标签', '', '   \n  ', undefined]) {
    assert.throws(
      () => buildBugPayload({ report: { ...report, analysis }, entry, projects }),
      (err) => {
        assert.match(err.message, /tapd: 分析内容无法解析/);
        assert.equal(err.unsent, true, 'nothing was sent, so a retry is safe');
        return true;
      },
    );
  }
});

test('payload never trusts a name we cannot resolve and keeps configured field values', () => {
  const payload = buildBugPayload({ report, entry, projects });
  assert.equal(payload.workspace_id, '59180547');
  assert.equal(payload.current_owner, '小鱼;');
  assert.equal(payload.version_report, '每周迭代版本');
  assert.equal(payload.priority, undefined, 'unconfigured fields stay absent');
  assert.ok(!JSON.stringify(payload).includes('tapd.token'), 'the token path never rides along');
});

test('payload description is clipped to the ticket limit', () => {
  const huge = { ...report, question: '问'.repeat(9000) };
  const payload = buildBugPayload({ report: huge, entry, projects });
  assert.ok(payload.description.length <= 6000);
});

test('payload keeps the analysis and the footer when the question is a wall of text', () => {
  const description = buildBugPayload({
    report: { ...report, question: '问'.repeat(9000) },
    entry,
    projects,
  }).description;
  assert.ok(description.length <= 6000, 'the hard ticket limit still holds');
  assert.match(description, /【蔡龙自动分析】\n结论：配置缺失：奖励表没有 27019278 这一档\n/);
  assert.ok(description.includes('定位：Assets/a.cs:12'), 'the whole analysis block survives');
  assert.ok(description.includes('依据：表里没有该档位。'), 'the whole analysis block survives');
  assert.ok(description.includes('建议：补一行配置。'), 'the whole analysis block survives');
  assert.match(description, /—— 蔡龙自动分析 · master@a1b2c3d · 由 蔡逸鹏 确认$/, 'attribution is never evicted');
  assert.ok(description.includes('（内容过长，已截断）'), 'a reader can tell the question was long, not mangled');
});

const TOKEN = '44f57463aa5eb3adaa6c5604967696aa24e24d85';

// What TAPD actually writes when we hit an unknown route: an HTML login page, not JSON.
const LOGIN_PAGE = '<html><head><title>登录</title></head><body>请用账号登录 TAPD</body></html>';

// A string body is the literal text TAPD wrote and nothing else, so it must reach the
// client exactly as printed and stay unparseable. Any other body is an envelope,
// serialised here the way a JSON response would have arrived.
function response(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function clientWith(capture, body, status = 200) {
  const logs = [];
  const client = createTapdClient({
    tokenFile: 'C:/secrets/tapd.token',
    readFile: () => `key：${TOKEN}\n`,
    request: async (url, init) => { capture.push({ url, init }); return response(body, status); },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  return { client, logs };
}

test('createBug posts a form body with the bearer token and returns the ticket', async () => {
  const calls = [];
  const { client } = clientWith(calls, { status: 1, info: 'success', data: { Bug: { id: '1159180547001002353' } } });
  const result = await client.createBug({ workspace_id: '59180547', title: 'T', description: 'D' });
  assert.deepEqual(result, {
    bugId: '1159180547001002353',
    url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1159180547001002353',
  });
  assert.equal(calls[0].url, 'https://api.tapd.cn/bugs');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].init.body, 'workspace_id=59180547&title=T&description=D');
  assert.ok(calls[0].init.signal, 'every request carries a timeout signal');
});

test('a project-specific token file wins over the default one', async () => {
  const calls = [];
  const seen = [];
  const client = createTapdClient({
    tokenFile: 'C:/secrets/default.token',
    readFile: (file) => { seen.push(file); return `tok-${file.length}`; },
    request: async (url, init) => { calls.push(init.headers.Authorization); return response({ status: 1, data: { Bug: { id: '1' } } }); },
  });
  await client.createBug({ workspace_id: '1' }, { tokenFile: 'C:/secrets/gear.token' });
  assert.deepEqual(seen, ['C:/secrets/gear.token']);
  assert.match(calls[0], new RegExp(`Bearer tok-${'C:/secrets/gear.token'.length}`));
});

for (const [label, body, status, expected] of [
  ['rejected by TAPD', { status: 0, info: '标题不能为空' }, 200, /标题不能为空/],
  ['http error', { status: 0, info: 'bad gateway note' }, 502, /HTTP 502/],
  ['non json body', LOGIN_PAGE, 200, /HTTP 200/],
  ['success without an id', { status: 1, info: 'success', data: [] }, 200, /未返回缺陷 ID/],
]) {
  test(`createBug fails loudly: ${label}`, async () => {
    const { client, logs } = clientWith([], body, status);
    const err = await client.createBug({ workspace_id: '1', title: 'T' }).catch((e) => e);
    assert.match(err.message, expected);
    // A request that went out may have landed: only a failure raised before
    // the request may claim the ticket is provably absent.
    assert.notEqual(err.unsent, true, `${label} is not classified as unsent`);
    assert.equal(logs.length, 0, 'createBug does not log on its own');
  });
}

// createBug's parse guard is the difference between our own prefixed failure and a raw
// SyntaxError that quotes the login page, so the unparseable body gets assertions the
// shared status regex cannot make.
test('createBug turns an unparseable body into its own failure, not a JSON error', async () => {
  const { client, logs } = clientWith([], LOGIN_PAGE);
  const err = await client.createBug({ workspace_id: '1', title: 'T' }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.notEqual(err.name, 'SyntaxError', 'the parse failure is owned by createBug');
  assert.equal(err.message, 'tapd: 建单失败（HTTP 200） 未返回缺陷 ID');
  assert.ok(!err.message.includes('<html'), 'the login page never reaches the operator');
  assert.ok(!err.message.includes(TOKEN), 'and neither does the token');
  assert.equal(logs.length, 0, 'createBug does not log on its own');
});

test('the token never appears in any error message', async () => {
  const { client } = clientWith([], { status: 0, info: 'boom' });
  const err = await client.createBug({ workspace_id: '1', title: 'T' }).catch((e) => e);
  assert.ok(!String(err.message).includes(TOKEN));
});

test('an unreadable token file is refused before any request is sent', async () => {
  const calls = [];
  const client = createTapdClient({
    tokenFile: 'C:/missing/tapd.token',
    readFile: () => { throw new Error('ENOENT'); },
    request: async (url, init) => { calls.push(url); return response({ status: 1, data: { Bug: { id: '1' } } }); },
  });
  const err = await client.createBug({ workspace_id: '1', title: 'T' }).catch((e) => e);
  assert.match(err.message, /令牌/);
  assert.equal(err.unsent, true, 'the failure is provably before the request');
  assert.deepEqual(calls, []);
});

test('an empty token file is refused the same way as a missing one', async () => {
  const calls = [];
  const client = createTapdClient({
    tokenFile: 'C:/empty/tapd.token',
    readFile: () => '  \n',
    request: async (url) => { calls.push(url); return response({ status: 1, data: { Bug: { id: '1' } } }); },
  });
  const err = await client.createBug({ workspace_id: '1', title: 'T' }).catch((e) => e);
  assert.match(err.message, /令牌/);
  assert.equal(err.unsent, true);
  assert.deepEqual(calls, []);
});

test('plain http base urls are refused at construction', () => {
  assert.throws(() => createTapdClient({ tokenFile: 'x', baseUrl: 'http://api.tapd.cn', request: async () => response({}) }), /https/);
  assert.throws(() => createTapdClient({ tokenFile: 'x', baseUrl: 'https://evil.example.com', request: async () => response({}) }), /api\.tapd\.cn/);
});
