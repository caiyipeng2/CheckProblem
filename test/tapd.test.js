import test from 'node:test';
import assert from 'node:assert/strict';
import { bugUrl, buildBugPayload, parseAnalysis } from '../src/tapd.js';

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
