# 蔡龙 → TAPD 缺陷单接入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让操作员在「查询完成」的飞书卡片上按一次按钮，就把这次分析结果按团队模板写成一张 TAPD 缺陷单，并把单号链接回填到同一张卡片。

**Architecture:** 在现有单进程轮询服务里加一条纯出站的写路径。`src/tapd.js` 负责字段拼装与 HTTPS 表单请求（注入 `fetch`，离线可测）；`state.reports` 保存最近 20 条完成态报告，作为卡片按钮回调的寻址目标；提单动作复用现有卡片回调通道（`card-events` → `engine.enqueueCardAction` → `card-requests.processPending`），不新增监听器、不新增进程。

**Tech Stack:** Node.js 24（ESM，内置 `node:test`，零第三方依赖）、全局 `fetch`、`lark-cli` 卡片 PATCH、TAPD OpenAPI `https://api.tapd.cn`。

**Spec:** `docs/superpowers/specs/2026-10-29-tapd-bug-integration-design.md`

## Global Constraints

- 零第三方 npm 依赖；ESM（`"type": "module"`）；测试命令 `node --test`，单文件用 `node --test test/x.test.js`。
- 所有副作用（fetch、读文件、飞书、git）必须可注入，测试全程离线，不发真实请求。
- 令牌文件路径 `C:/Users/EDY/.checkproblem/tapd.token` 只出现在被 gitignore 的 `config.json`；令牌**绝不**进日志、argv、错误消息、卡片内容。
- TAPD 请求只允许 `https://api.tapd.cn` 前缀；`Content-Type: application/x-www-form-urlencoded`；`Authorization: Bearer <token>`。
- 标题 ≤ 100 字，描述 ≤ 6000 字；卡片 JSON ≤ 30 KiB（`src/cards.js:91` 已有硬校验，不得放宽）。
- 模板字段值（发现版本/使用机型/处理人/测试人/抄送人/严重度/优先级/重现规律）只来自配置，永不来自群消息。
- 一次点击只建一单：消耗卡片 `revision` 作为幂等键；`submitting` 未收到结果时不得自动补发。
- 不动生产部署（`武器店策划程序沟通` 群的旧实例与其 `config.json`）；联调只在「蔡龙自测」群。
- 每个任务结束时 `npm test` 全绿再提交；提交信息用英文、说清「为什么」。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/analyze.js` | 提示词契约：新增【复现】段，供工单「操作步骤」使用 | Modify `:81-87` |
| `src/tapd.js` | TAPD 唯一出入口：解析分析文本、拼字段、发请求、拼链接 | Create |
| `test/tapd.test.js` | `tapd.js` 单测（纯函数 + 注入 fetch 的客户端） | Create |
| `src/config.js` | 解析并校验 `tapd` 段，把 camelCase 字段名映射成 TAPD 参数名 | Modify `:16-74` |
| `test/config.test.js` | 配置校验用例 | Modify（追加） |
| `src/cards.js` | 完成态卡片的提单按钮、已提单链接、失败提示 | Modify `:34-93` |
| `test/cards.test.js` | 按钮渲染与「未配置不渲染」用例 | Modify（追加） |
| `src/card-requests.js` | 完成态报告存储、`tapd` 回调消费、幂等与卡片回填 | Modify 全文 |
| `src/state.js` | `reports` 字段的读取兜底 | Modify `:36-53` |
| `src/index.js` | 把分析原文写进 job，交给 `finish()`；透传 `tapd` 客户端 | Modify `:43`、`:137-158` |
| `test/card-engine.test.js` | 端到端：完成 → 报告入库 → 按按钮 → 建单 → 卡片回填 | Modify（追加） |
| `bin/checkproblem.js` | 进程入口装配 `createTapdClient` | Modify `:60-97` |
| `config.example.json` | 带 `tapd` 段的示例配置（不含真实令牌） | Modify/Create |

---

### Task 1: 分析输出契约增加【复现】段

**Files:**
- Modify: `src/analyze.js:81-87`（`buildPrompt` 的【输出格式】块）
- Test: `test/analyze.test.js`（追加用例）

**Interfaces:**
- Consumes: 无。
- Produces: 模型输出固定五段 `【结论】【复现】【定位】【依据】【建议】`；`【复现】` 内是 1-2 行、每行一步的纯文本，可能带 `1.` 前缀。Task 2 的 `parseAnalysis` 依赖这套标签字面量。

- [ ] **Step 1: 写失败测试**

在 `test/analyze.test.js` 末尾追加：

```js
test('buildPrompt asks for a repro section the TAPD ticket can use', () => {
  const p = buildPrompt({ question: 'uid 16115645 奖励没到账' });
  assert.match(p, /必须严格使用以下五段/);
  const at = p.indexOf('【复现】');
  assert.ok(at > p.indexOf('【结论】') && at < p.indexOf('【定位】'), '复现 sits between 结论 and 定位');
  assert.match(p, /【复现】玩家或策划能照做的动作，最多 2 步，每步单独一行/);
});

test('buildPrompt still states exactly one output contract after adding 复现', () => {
  const p = buildPrompt({ question: 'q' });
  assert.equal(p.split('【输出格式】必须严格使用').length - 1, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/analyze.test.js`
Expected: FAIL，报 `必须严格使用以下五段` 不匹配（当前文案是「四段」）。

- [ ] **Step 3: 改提示词**

`src/analyze.js` 里把这一段（`:81-86`）：

```js
    '【输出格式】必须严格使用以下四段，整体不超过 300 字，不要开场白、不要总结：',
    '【结论】一句话给出确定判断，写成「类别：直接原因」。类别只能是：代码缺陷 / 配置缺失 / 数据问题 / 外部依赖。',
    '不要写「无法判定」「需要进一步排查」。线索确实对不上时，也要写「最可能是<类别>：<理由>」，并说明还缺哪条证据才能确诊。',
    '【定位】最多 2 条 `路径:行号`，用换行分隔；【依据】里提到的文件必须出现在这里，确实没有才写「无」。',
```

替换为：

```js
    '【输出格式】必须严格使用以下五段，整体不超过 300 字，不要开场白、不要总结：',
    '【结论】一句话给出确定判断，写成「类别：直接原因」。类别只能是：代码缺陷 / 配置缺失 / 数据问题 / 外部依赖。',
    '不要写「无法判定」「需要进一步排查」。线索确实对不上时，也要写「最可能是<类别>：<理由>」，并说明还缺哪条证据才能确诊。',
    '【复现】玩家或策划能照做的动作，最多 2 步，每步单独一行，不要写代码；这条会直接进缺陷单的「操作步骤」。',
    '【定位】最多 2 条 `路径:行号`，用换行分隔；【依据】里提到的文件必须出现在这里，确实没有才写「无」。',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/analyze.test.js && npm test`
Expected: PASS，全量 317 tests 绿（原 315 + 2）。

- [ ] **Step 5: 提交**

```bash
git add src/analyze.js test/analyze.test.js
git commit -m "feat: ask the model for repro steps so tickets need no guessing"
```

---

### Task 2: `src/tapd.js` 的纯函数：解析、链接、建单载荷

**Files:**
- Create: `src/tapd.js`
- Test: `test/tapd.test.js`（Create，本任务只写纯函数部分）

**Interfaces:**
- Consumes: Task 1 的五段标签字面量。
- Produces:
  - `parseAnalysis(text) -> { conclusion, location, evidence, advice, repro }`（缺段为 `''`）
  - `bugUrl(workspaceId, bugId) -> string`
  - `buildBugPayload({ report, entry, projects }) -> Record<string, string>`，键就是 TAPD 表单参数名（`workspace_id`、`title`、`description`、以及 `entry.fields` 里的 `version_report` / `os` / `te` / `current_owner` / `cc` / `severity` / `priority` / `frequency`）
  - `report` 用到的字段：`projectId`、`question`、`analysis`、`provenance`、`confirmer`、`images`（数组）、`triggerMessageId`

- [ ] **Step 1: 写失败测试**

Create `test/tapd.test.js`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tapd.test.js`
Expected: FAIL — `Cannot find module '../src/tapd.js'`（或等价的 import 错误）。

- [ ] **Step 3: 写实现**

Create `src/tapd.js`：

```js
// TAPD OpenAPI: the only place that turns a finished 蔡龙 analysis into a bug ticket.
//
// The ticket is a one-way write, so the module needs no state of its own. Free-form
// group text goes out as an x-www-form-urlencoded body over fetch: unlike the npm
// `.cmd` shims in src/runner.js it never meets cmd.exe, so no quoting rules apply —
// length is the only thing that has to be bounded.

import { readFileSync } from 'node:fs';
import { resolveApiKey } from './chat.js';

const SECTIONS = { 结论: 'conclusion', 定位: 'location', 依据: 'evidence', 建议: 'advice', 复现: 'repro' };
const EMPTY = Object.freeze({ conclusion: '', repro: '', location: '', evidence: '', advice: '' });
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 6000;

export function parseAnalysis(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ...EMPTY };
  const parts = { conclusion: '', repro: '', location: '', evidence: '', advice: '' };
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const label = /^【(结论|复现|定位|依据|建议)】/.exec(line)?.[1];
    if (label) {
      current = SECTIONS[label];
      parts[current] = line.slice(label.length + 2).trim();
      continue;
    }
    // Continuation lines only matter inside a section; anything before the first
    // label is model noise and is dropped.
    if (current && line !== '') parts[current] = `${parts[current]}\n${line}`.trim();
  }
  return parts;
}

export function bugUrl(workspaceId, bugId) {
  return `https://www.tapd.cn/tapd_fe/${workspaceId}/bug/detail/${bugId}`;
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

function firstClause(text) {
  return String(text ?? '').split(/[。\n；;]/).map((part) => part.trim()).find((part) => part !== '') ?? '';
}

function steps(repro) {
  const lines = String(repro ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^\d+[.、)]\s*/, '').replace(/^[-*·]\s*/, ''))
    .filter((line) => line !== '')
    .slice(0, 2);
  const usable = lines.length ? lines : ['按【问题描述】里的操作复现'];
  return usable.map((line, index) => `${index + 1}. ${line}`);
}

export function buildBugPayload({ report, entry, projects = [] }) {
  const parts = parseAnalysis(report.analysis);
  const name = projects.find((project) => project.id === report.projectId)?.name ?? report.projectId;
  const question = String(report.question ?? '').trim();
  const images = Array.isArray(report.images) ? report.images : [];
  const description = [
    '【问题描述】', question || '（无）', '',
    '【操作步骤】', ...steps(parts.repro), '',
    '【预期结果】', '正常', '',
    '【实际结果】', question || '（无）',
    ...(images.length
      ? [`（另有 ${images.length} 张截图，见飞书群消息 ${report.triggerMessageId}，本单不附带图片）`]
      : []),
    '',
    '【蔡龙自动分析】',
    `结论：${parts.conclusion || '（无）'}`,
    `定位：${parts.location || '（无）'}`,
    `依据：${parts.evidence || '（无）'}`,
    `建议：${parts.advice || '（无）'}`,
    `—— 蔡龙自动分析 · ${report.provenance ?? ''} · 由 ${report.confirmer ?? ''} 确认`,
  ].join('\n');

  return {
    workspace_id: String(entry.workspaceId),
    title: clip(`[${name}] ${firstClause(parts.conclusion)}`, TITLE_LIMIT),
    description: clip(description, DESCRIPTION_LIMIT),
    ...entry.fields,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tapd.test.js`
Expected: PASS，9 tests。若「title cuts at the first sentence mark」失败，说明 `clip` 与 `firstClause` 的顺序不对——先取首句再截断，截断只在首句本身超长时生效。

- [ ] **Step 5: 提交**

```bash
git add src/tapd.js test/tapd.test.js
git commit -m "feat: shape a TAPD bug payload from a finished analysis"
```

---

### Task 3: `createTapdClient`：带令牌、带超时、可注入的 HTTP 出口

**Files:**
- Modify: `src/tapd.js`（追加导出）
- Test: `test/tapd.test.js`（追加）

**Interfaces:**
- Consumes: `resolveApiKey({ apiKeyEnv, apiKeyFile, readFile })`（`src/chat.js:17`，已有的「操作者自己写的密钥文件」读取器，顺带剥 `key：` 前缀）。
- Produces: `createTapdClient({ tokenFile, baseUrl?, request?, readFile?, log?, timeoutMs? }) -> { createBug(payload, { tokenFile? }) -> Promise<{ bugId, url }> }`；失败 `throw Error`，消息里只有 HTTP 状态与 TAPD 的 `info` 文本，**不含令牌**。Task 6 依赖 `createBug` 这一个方法。

- [ ] **Step 1: 写失败测试**

追加到 `test/tapd.test.js`：

```js
import { createTapdClient } from '../src/tapd.js';

const TOKEN = '44f57463aa5eb3adaa6c5604967696aa24e24d85';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
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
  ['non json body', null, 200, /HTTP 200/],
  ['success without an id', { status: 1, info: 'success', data: [] }, 200, /未返回缺陷 ID/],
]) {
  test(`createBug fails loudly: ${label}`, async () => {
    const { client, logs } = clientWith([], body ?? 'not-json', status);
    await assert.rejects(() => client.createBug({ workspace_id: '1', title: 'T' }), expected);
    assert.equal(logs.length, 0, 'createBug does not log on its own');
  });
}

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
  await assert.rejects(() => client.createBug({ workspace_id: '1', title: 'T' }), /令牌/);
  assert.deepEqual(calls, []);
});

test('plain http base urls are refused at construction', () => {
  assert.throws(() => createTapdClient({ tokenFile: 'x', request: async () => response({}) }), /https/);
  assert.throws(() => createTapdClient({ tokenFile: 'x', baseUrl: 'https://evil.example.com', request: async () => response({}) }), /api\.tapd\.cn/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tapd.test.js`
Expected: FAIL — `createTapdClient` is not exported。

- [ ] **Step 3: 写实现**

`src/tapd.js` 顶部 import 之后补常量与导出：

```js
const DEFAULT_BASE_URL = 'https://api.tapd.cn';
const DEFAULT_TIMEOUT_MS = 15_000;
const INFO_LIMIT = 160;

// One secret-file reader for the whole service: src/chat.js already strips the
// "key：" prefix an operator tends to type, and returns undefined instead of
// throwing so the caller decides what a missing credential means.
export function createTapdClient({
  tokenFile,
  baseUrl = DEFAULT_BASE_URL,
  request = globalThis.fetch,
  readFile = (file) => readFileSync(file, 'utf8'),
  log = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!tokenFile) throw new Error('tapd: tokenFile is required');
  if (!/^https:\/\/api\.tapd\.cn(\/.*)?$/.test(baseUrl)) {
    throw new Error(`tapd: baseUrl must be https://api.tapd.cn, got ${String(baseUrl).slice(0, 60)}`);
  }
  if (typeof request !== 'function') throw new Error('tapd: request is required');

  return {
    async createBug(payload, { tokenFile: override } = {}) {
      const token = resolveApiKey({ apiKeyEnv: '', apiKeyFile: override ?? tokenFile, readFile });
      if (!token) throw new Error('tapd: 令牌文件不可读或为空');

      const res = await request(`${baseUrl}/bugs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body is a failure, handled below. TAPD answers its unknown
        // routes with an HTML login page, which lands here.
      }
      const bugId = parsed?.data?.Bug?.id;
      if (parsed?.status !== 1 || !bugId) {
        const info = typeof parsed?.info === 'string' ? clip(parsed.info, INFO_LIMIT) : '';
        throw new Error(`tapd: 建单失败（HTTP ${res.status}${info ? ` ${info}` : ''}）${info ? '' : ' 未返回缺陷 ID'}`);
      }
      log?.info?.(`tapd: bug ${bugId} created in workspace ${payload.workspace_id}`);
      return { bugId: String(bugId), url: bugUrl(String(payload.workspace_id), String(bugId)) };
    },
  };
}
```

> 注意：`log?.info?.` 只写 bugId 与 workspace，不写 payload（含描述正文）；测试里断言 `logs.length === 0` 的桩不会走成功分支，所以不受影响。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tapd.test.js && npm test`
Expected: PASS。`createBug fails loudly: success without an id` 若失败，检查 `parsed?.status !== 1 || !bugId` 的短路顺序——无 bugId 时必须仍然报错，不能返回 `undefined`。

- [ ] **Step 5: 提交**

```bash
git add src/tapd.js test/tapd.test.js
git commit -m "feat: send TAPD bug writes over an injected bearer fetch"
```

---

### Task 4: 配置解析 `tapd` 段

**Files:**
- Modify: `src/config.js`（新增导出 `normalizeTapd`，`loadConfig` 里接入）
- Test: `test/config.test.js`（追加）

**Interfaces:**
- Consumes: 已解析的 `projects` 数组（`normalizeProjects` 输出）。
- Produces: `config.tapd -> { baseUrl, tokenFile, workspaces: { [projectId]: { workspaceId, tokenFile, fields } } } | undefined`；`fields` 的键已是 TAPD 参数名（`version_report`、`os`、`te`、`current_owner`、`cc`、`severity`、`priority`、`frequency`）。Task 5/6 只读 `config.tapd.workspaces[projectId]`。

- [ ] **Step 1: 写失败测试**

追加到 `test/config.test.js`（沿用文件里 `mkdtempSync` 的写法）：

```js
const tapdBase = () => ({
  chatId: 'oc_x', selfOpenId: 'ou_x',
  projects: [{ id: 'weapon', name: '武器店', url: 'https://example.com/w.git', dir: 'repo/w' }],
  tapd: {
    tokenFile: 'C:/secrets/tapd.token',
    fields: { versionReport: '每周迭代版本', currentOwner: '小鱼;', priority: 'medium' },
    workspaces: {
      weapon: { workspaceId: '59180547' },
      gear: { workspaceId: '12345678', fields: { currentOwner: '阿鱼;' } },
    },
  },
});

function writeTapd(t, value) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-tapd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test('tapd config resolves per-project entries with merged fields', (t) => {
  const cfg = loadConfig(writeTapd(t, { ...tapdBase(), projects: [...tapdBase().projects,
    { id: 'gear', name: '齿轮', url: 'https://example.com/g.git', dir: 'repo/g' }] }));
  assert.equal(cfg.tapd.baseUrl, 'https://api.tapd.cn');
  assert.equal(cfg.tapd.workspaces.weapon.workspaceId, '59180547');
  assert.equal(cfg.tapd.workspaces.weapon.tokenFile, 'C:/secrets/tapd.token');
  assert.deepEqual(cfg.tapd.workspaces.weapon.fields, {
    version_report: '每周迭代版本', current_owner: '小鱼;', priority: 'medium',
  });
  assert.equal(cfg.tapd.workspaces.gear.fields.current_owner, '阿鱼;', 'per-project field wins');
  assert.equal(cfg.tapd.workspaces.gear.version_report, undefined);
});

test('a per-project token file overrides the default', (t) => {
  const value = tapdBase();
  value.tapd.workspaces.weapon.tokenFile = 'C:/secrets/gear.token';
  assert.equal(loadConfig(writeTapd(t, value)).tapd.workspaces.weapon.tokenFile, 'C:/secrets/gear.token');
});

test('no tapd section means the feature is off', (t) => {
  const value = tapdBase();
  delete value.tapd;
  assert.equal(loadConfig(writeTapd(t, value)).tapd, undefined);
});

for (const [label, mutate, pattern] of [
  ['tokenFile missing', (v) => { delete v.tapd.tokenFile; }, /tokenFile/],
  ['http base url', (v) => { v.tapd.baseUrl = 'http://api.tapd.cn'; }, /https/],
  ['workspace id not digits', (v) => { v.tapd.workspaces.weapon.workspaceId = 'abc'; }, /workspaceId/],
  ['unknown project', (v) => { v.tapd.workspaces.nope = { workspaceId: '12345678' }; }, /no matching project/],
  ['unknown field name', (v) => { v.tapd.fields.reporter = 'x'; }, /reporter/],
  ['over long field value', (v) => { v.tapd.fields.os = '机'.repeat(101); }, /too long/],
  ['tapd without projects', (v) => { delete v.projects; }, /requires projects/],
]) {
  test(`tapd config rejects ${label}`, (t) => {
    const value = tapdBase();
    mutate(value);
    assert.throws(() => loadConfig(writeTapd(t, value)), pattern);
  });
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL — `cfg.tapd` 为 `undefined`（还没有解析逻辑）。

- [ ] **Step 3: 写实现**

`src/config.js` 在 `DEFAULTS` 之后加：

```js
// TAPD takes a fixed set of fields, and the operator writes them with the UI names.
// Mapping once here means src/tapd.js never guesses parameter names, and an unknown
// key fails at startup instead of silently dropping a value the tester expects.
const TAPD_FIELDS = {
  versionReport: 'version_report',
  os: 'os',
  te: 'te',
  currentOwner: 'current_owner',
  cc: 'cc',
  severity: 'severity',
  priority: 'priority',
  frequency: 'frequency',
};
const TAPD_VALUE_LIMIT = 100;
const WORKSPACE_ID = /^\d{6,20}$/;

function tapdFields(raw, where) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!(key in TAPD_FIELDS)) throw new Error(`config: ${where} has unknown field ${key}`);
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length > TAPD_VALUE_LIMIT) throw new Error(`config: ${where}.${key} is too long`);
    if (text.trim() !== '') out[TAPD_FIELDS[key]] = text;
  }
  return out;
}

export function normalizeTapd(raw, projects) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('config: tapd must be an object');
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('config: tapd requires projects');
  const tokenFile = typeof raw.tokenFile === 'string' && raw.tokenFile.trim() !== '' ? raw.tokenFile.trim() : null;
  if (!tokenFile) throw new Error('config: tapd.tokenFile is required');
  const baseUrl = raw.baseUrl === undefined ? 'https://api.tapd.cn' : String(raw.baseUrl);
  if (!/^https:\/\/api\.tapd\.cn(\/.*)?$/.test(baseUrl)) throw new Error('config: tapd.baseUrl must be https://api.tapd.cn');
  const base = tapdFields(raw.fields, 'tapd.fields');
  const ids = new Set(projects.map((project) => project.id));
  const workspaces = {};
  for (const [projectId, value] of Object.entries(raw.workspaces ?? {})) {
    if (!ids.has(projectId)) throw new Error(`config: tapd.workspaces.${projectId} has no matching project`);
    const workspaceId = String(value?.workspaceId ?? '');
    if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`config: tapd.workspaces.${projectId}.workspaceId must be 6-20 digits`);
    const override = value?.tokenFile === undefined ? tokenFile : String(value.tokenFile).trim();
    if (override === '') throw new Error(`config: tapd.workspaces.${projectId}.tokenFile is empty`);
    workspaces[projectId] = { workspaceId, tokenFile: override, fields: { ...base, ...tapdFields(value?.fields, `tapd.workspaces.${projectId}.fields`) } };
  }
  return { baseUrl, tokenFile, workspaces };
}
```

并在 `loadConfig` 的返回对象里，把 `...raw` 之后的 `projectConfig` 扩成同时带上 tapd（`const projects` 已在 `:43` 解析好）：

```js
  const tapd = normalizeTapd(raw.tapd, projects);
  // ...
  return {
    ...DEFAULTS,
    ...raw,
    ...projectConfig,
    ...(tapd ? { tapd } : {}),
    // 其余保持不变
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/config.test.js && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: validate the TAPD ticket fields at config load"
```

---

### Task 5: 完成态卡片增加提单按钮与状态行

**Files:**
- Modify: `src/cards.js:34-93`（`buildQueryCard`）
- Test: `test/cards.test.js`（追加）

**Interfaces:**
- Consumes: `job.tapd -> undefined | { status: 'submitting' | 'done' | 'failed', bugId?, url?, error? }`。
- Produces: `buildQueryCard({ job, projects, tapd })`；`tapd` 是 Task 4 的 entry（或 `null`）。新增按钮 `name: 'tapd'`、`behaviors[0].value.action === 'tapd'`、回调 `revision` 就是 `job.revision`。Task 6 依赖这两个字面量。

- [ ] **Step 1: 写失败测试**

追加到 `test/cards.test.js`（复用文件顶部的 `walk`、`projects`、`job`）：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/cards.test.js`
Expected: FAIL — 找不到 `name === 'tapd'` 的按钮。

- [ ] **Step 3: 写实现**

`src/cards.js` 的 `buildQueryCard` 签名改为 `({ job, projects, tapd = null })`，在按钮行之后追加元素并把新行插进 `elements`：

```js
  const submitted = job.tapd?.status === 'done' ? job.tapd : null;
  const showTapd = Boolean(tapd) && job.status === 'completed' && !submitted;
  const tapdRow = showTapd ? row([column([{
    tag: 'button',
    name: 'tapd',
    text: plain(job.tapd?.status === 'submitting'
      ? '提交中…'
      : job.tapd?.status === 'failed' ? '重试提交 TAPD 缺陷单' : '提交 TAPD 缺陷单'),
    type: 'default',
    width: 'fill',
    disabled: job.tapd?.status === 'submitting',
    behaviors: callback('tapd'),
  })]) : null;
  // A press is booked before the request goes out, so `submitting` also covers
  // "the process died mid-request": the note tells the operator to look at TAPD
  // rather than trust the card.
  const tapdNote = job.tapd?.status === 'failed'
    ? text(`TAPD 提单失败：${String(job.tapd.error).slice(0, 200)}`)
    : job.tapd?.status === 'submitting'
      ? text('若服务已重启，请先在 TAPD 确认是否已建单，避免重复提交。')
      : null;
```

`elements` 数组整体替换为（前三项与现状逐字一致，只是末尾多了提单行）：

```js
      elements: [
        row([column([
          row([column([text('项目')]), column([projectSelect], 4)]),
          row([column([text('分支')]), column([branchSelect], 4)]),
        ])]),
        { ...row([column([
          { tag: 'markdown', content: '**原问题**' },
          text(String(job.question).slice(0, 600)),
          ...(job.images?.length ? [text(`截图 ${job.images.length} 张（查询时一并分析）`)] : []),
        ])]), background_style: 'grey-50' },
        text(`${note}${job.provenance ? `\n${selectedProject?.name ?? ''} · ${job.provenance}` : ''}`),
        row([
          column([{
            tag: 'button', name: 'start', text: plain('开始查询'), type: 'primary_filled',
            width: 'fill', disabled: !active || !job.branch, behaviors: callback('start'),
          }]),
          column([{
            tag: 'button', name: 'cancel', text: plain('取消'), type: 'default',
            width: 'fill', disabled: !active, behaviors: callback('cancel'),
          }]),
        ]),
        ...(tapdRow ? [tapdRow] : []),
        ...(submitted ? [{ tag: 'markdown', content: `已提单：[TAPD ${submitted.bugId}](${submitted.url})` }] : []),
        ...(tapdNote ? [tapdNote] : []),
      ],
```

已提单的 markdown 与按钮互斥（`showTapd` 已排除 `submitted`），所以「一张完成态卡片只有一个提单入口」这条不变量在渲染层就成立。30 KiB 的既有硬校验（`:91`）不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/cards.test.js && npm test`
Expected: PASS。原 `terminal cards disable all controls` 用例仍然只数到 4 个控件，因为它不传 `tapd`。

- [ ] **Step 5: 提交**

```bash
git add src/cards.js test/cards.test.js
git commit -m "feat: put a one-shot TAPD submit button on finished cards"
```

---

### Task 6: 完成态报告存储与 `tapd` 回调消费

**Files:**
- Modify: `src/card-requests.js:4-141`
- Modify: `src/state.js:36-53`（`loadState` 的 `reports` 兜底）
- Test: `test/card-engine.test.js`（追加）、`test/state.test.js`（追加）

**Interfaces:**
- Consumes: Task 3 的 `tapd.createBug(payload, { tokenFile })`、Task 2 的 `buildBugPayload`/`bugUrl`、Task 5 的 `name: 'tapd'` 按钮与 `action: 'tapd'`、Task 4 的 `config.tapd.workspaces`。
- Produces:
  - `state.reports: Report[]`，`Report = job 快照 + { finishedAt, tapd? }`，最多 20 条，`status === 'completed'`
  - `createCardRequests({ ..., tapd })` 接受客户端或 `null`
  - `enqueue()` 现在对 `action === 'tapd'` 返回 `true`
  - `engine` 无需新导出（`enqueueCardAction` 已经覆盖）

- [ ] **Step 1: 写失败测试（state 兜底）**

追加到 `test/state.test.js`：

```js
test('loadState keeps recent reports and drops a corrupt ones field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'st-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({
    version: 1, startedAt: 1, lastSeen: { createTimeMs: 5, messageId: 'om_5' }, job: null,
    reports: Array.from({ length: 25 }, (_, i) => ({ requestId: `r${i}`, status: 'completed' })),
  }));
  assert.equal(loadState(file).reports.length, 20);
  assert.equal(loadState(file).reports.at(-1).requestId, 'r24');

  writeFileSync(file, JSON.stringify({
    version: 1, startedAt: 1, lastSeen: { createTimeMs: 5, messageId: 'om_5' }, job: null, reports: 'oops',
  }));
  assert.deepEqual(loadState(file).reports, []);
});
```

Run: `node --test test/state.test.js` → 先 FAIL（`reports` 未定义/长度 25）。

- [ ] **Step 2: 实现 state 兜底**

两处改动，缺一不可——`test/state.test.js:45-108` 用 `assert.deepEqual(loadState(...), initialState(...))`
逐字段比较，所以默认值必须同时出现在 `initialState` 与 `loadState` 里：

`src/state.js` 的 `initialState`（`:10-19`）在 `job: null,` 之后加：

```js
    // Finished reports the TAPD button can still address. Kept small on purpose:
    // the card that renders them lives in Feishu, not here.
    reports: [],
```

`src/state.js` 的 `loadState` 返回对象里，`job:` 之前加：

```js
      // Only the shape is trusted; a hand-edited or half-written file must not
      // feed the ticket button a report that cannot be addressed.
      reports: Array.isArray(parsed.reports) ? parsed.reports.slice(-20) : [],
```

Run: `node --test test/state.test.js && npm test` → PASS。若 `test/e2e.test.js` 里有对 state 的
逐字段比较，同样以 `initialState` 为准，不要改断言迁就实现。

- [ ] **Step 3: 写失败测试（卡片链路）**

追加到 `test/card-engine.test.js`。`harness()` 只加两个新入参，都走顶层 `overrides`，不要塞进
`overrides.engine`（`createEngine` 的字段顺序会被 `...overrides.engine` 覆盖，埋坑）：

```js
  const config = {
    // …现有字段保持不变…
    ...(overrides.tapdConfig ? { tapd: overrides.tapdConfig } : {}),
  };
  const engine = createEngine({
    // …现有字段保持不变…
    tapd: overrides.tapdClient ?? null,
    ...overrides.engine,
  });
```

用例：

```js
const TAPD_CONFIG = {
  baseUrl: 'https://api.tapd.cn',
  tokenFile: 'C:/secrets/tapd.token',
  workspaces: { weapon: { workspaceId: '59180547', tokenFile: 'C:/secrets/tapd.token', fields: { current_owner: '小鱼;' } } },
};
const FULL_ANALYSIS = [
  '【结论】配置缺失：奖励表没有该档位',
  '【复现】1. 打开铁匠铺 2. 点击锻造',
  '【定位】Assets/a.cs:12',
  '【依据】表里没有。',
  '【建议】补一行配置。',
].join('\n');

function submittedHarness(overrides = {}) {
  // `engine` is merged instead of replaced so a test that only swaps the TAPD
  // client still gets the five-section analysis text the ticket is built from.
  const { engine: engineOverrides, ...rest } = overrides;
  return harness({
    tapdConfig: TAPD_CONFIG,
    ...rest,
    engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }), ...engineOverrides },
  });
}

async function completeOneJob(h) {
  await h.engine.tick();                                // 群消息触发 -> 建卡片
  h.engine.enqueueCardAction(h.event('start'));         // 点「开始查询」
  await h.engine.tick();                                // 跑分析 -> 查询完成 + 回填卡片
  return h.state.reports[0];
}

test('a completed report is remembered with its analysis text', async () => {
  const h = submittedHarness();
  const report = await completeOneJob(h);
  assert.equal(report.status, 'completed');
  assert.equal(report.analysis, FULL_ANALYSIS);
  assert.equal(report.projectId, 'weapon');
  assert.equal(report.tapd, undefined);
});

test('the submit button creates one ticket and stamps the card', async () => {
  const created = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { created.push(payload); return { bugId: '1159180547001002353', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1159180547001002353' }; } },
  });
  const report = await completeOneJob(h);
  const press = {
    type: 'card.action.trigger', event_id: 'evt-tapd-1', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), true);
  await h.engine.tick();
  assert.equal(created.length, 1);
  assert.equal(created[0].workspace_id, '59180547');
  assert.equal(created[0].current_owner, '小鱼;');
  assert.equal(h.state.reports[0].tapd.status, 'done');
  assert.match(h.state.reports[0].tapd.url, /tapd_fe\/59180547\/bug\/detail\/1159180547001002353$/);
  // The card was PATCHed with the link, not the button.
  assert.ok(JSON.stringify(h.updates.at(-1)).includes('已提单：[TAPD 1159180547001002353]'));
  assert.ok(!JSON.stringify(h.updates.at(-1)).includes('"action":"tapd"'), 'no second bite at the same card');
});

test('pressing submit twice in a row still creates one ticket', async () => {
  const created = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { created.push(payload); return { bugId: '1', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/1' }; } },
  });
  const report = await completeOneJob(h);
  const press = (revision) => ({
    type: 'card.action.trigger', event_id: `evt-${revision}`, chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision }),
  });
  h.engine.enqueueCardAction(press(report.revision));
  h.engine.enqueueCardAction(press(report.revision));
  await h.engine.tick();
  assert.equal(created.length, 1);
});

test('an event for an unknown or already submitted report is refused', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  const report = await completeOneJob(h);
  const base = { type: 'card.action.trigger', event_id: 'evt-x', chat_id: 'oc_test', message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button' };
  assert.equal(h.engine.enqueueCardAction({ ...base, action_value: JSON.stringify({ action: 'tapd', requestId: 'nope', revision: report.revision }) }), false);
  assert.equal(h.engine.enqueueCardAction({ ...base, message_id: 'om_other', action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }) }), false);
  assert.equal(h.engine.enqueueCardAction({ ...base, action_tag: 'input', action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }) }), false);
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd, undefined);
});

test('a failed submit invites a retry on a fresh card revision', async () => {
  const attempts = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { attempts.push(payload); throw new Error('tapd: 建单失败（HTTP 502 bad）'); } },
  });
  const report = await completeOneJob(h);
  const press = (revision) => ({
    type: 'card.action.trigger', event_id: `evt-${revision}`, chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision }),
  });
  h.engine.enqueueCardAction(press(report.revision));
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd.status, 'failed');
  assert.match(h.state.reports[0].tapd.error, /HTTP 502/);
  const retryRevision = h.state.reports[0].revision;
  assert.ok(retryRevision > report.revision, 'the failed press consumed its revision');
  h.engine.enqueueCardAction(press(retryRevision));
  await h.engine.tick();
  assert.equal(attempts.length, 2);
});

test('a submit left in flight after a restart is never auto-retried', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  const report = await completeOneJob(h);
  report.tapd = { status: 'submitting' };
  const press = {
    type: 'card.action.trigger', event_id: 'evt-stale', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), true);
  await h.engine.tick();
  assert.equal(h.state.reports[0].tapd.status, 'submitting', 'the operator has to look, not the service');
});

test('without a workspace mapping the finished card carries no submit action', async () => {
  const h = harness({ engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }) } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  assert.equal(h.state.reports.length, 1, 'the report is still remembered');
  assert.ok(!JSON.stringify(h.updates.at(-1)).includes('"action":"tapd"'));
});

test('only the newest twenty completed reports are kept', async () => {
  const h = submittedHarness({ tapdClient: { createBug: async () => ({ bugId: '1', url: 'u' }) } });
  h.state.reports = Array.from({ length: 20 }, (_, i) => ({ requestId: `old${i}`, status: 'completed' }));
  await completeOneJob(h);
  assert.equal(h.state.reports.length, 20);
  assert.equal(h.state.reports.at(-1).question, '蔡龙 查询奖励逻辑');
  assert.ok(!h.state.reports.some((item) => item.requestId === 'old0'));
});
```

Run: `node --test test/card-engine.test.js` → FAIL（`state.reports` 不存在）。

- [ ] **Step 4: 实现 card-requests**

`src/card-requests.js` 逐处改动：

```js
import { buildBugPayload } from './tapd.js';

const REPORT_LIMIT = 20;

export function createCardRequests({ config, state, lark, listBranches, clock, saveState, log, runJob, tapd = null }) {
```

`card()` 与 `entryFor()`（放在 `const card = ...` 处）：

```js
  const entryFor = (projectId) => (tapd ? config.tapd?.workspaces?.[projectId] ?? null : null);
  const card = (job) => buildQueryCard({ job, projects: config.projects, tapd: entryFor(job.projectId) });
```

`finish()` 在推入 `state.cardUpdates` 之前记住完成态报告：

```js
  function rememberReport(closed) {
    const previous = (Array.isArray(state.reports) ? state.reports : [])
      .filter((item) => item.requestId !== closed.requestId);
    const snapshot = { ...closed, finishedAt: clock() };
    state.reports = [...previous, snapshot].slice(-REPORT_LIMIT);
    return snapshot;
  }

  async function finish(job, status) {
    if (!job.card) return;
    let closed = { ...job, status, note: '', branches: job.branch ? [job.branch] : [], branchPage: 0 };
    // A completed job becomes the stored report object itself, so the card we
    // are about to PATCH and the report a later press finds are the same thing.
    if (status === 'completed') closed = rememberReport(closed);
    const pending = { messageId: closed.promptMessageId, card: card(closed) };
    state.cardUpdates = (state.cardUpdates ?? []).filter((item) => item.messageId !== pending.messageId);
    state.cardUpdates.push(pending);
    if (state.job?.requestId === job.requestId) state.job = null;
    saveState(state);
    await retryTerminalUpdates();
  }
```

`enqueue()`：把与状态无关的校验抽成一个函数，`tapd` 分支不再要求 `state.job`：

```js
  // Everything that must hold for any card action, regardless of which job it
  // belongs to: same chat, a plausible operator, and a parseable action value.
  function readEvent(event) {
    if (event?.type !== 'card.action.trigger') return null;
    if (event.chat_id !== config.chatId) return null;
    if (typeof event.operator_id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(event.operator_id)) return null;
    if (typeof event.event_id !== 'string' || !event.event_id || event.event_id.length > 200) return null;
    if (typeof event.action_value !== 'string' || event.action_value.length > 1000) return null;
    if (event.option !== undefined && (typeof event.option !== 'string' || event.option.length > 500)) return null;
    try {
      const action = JSON.parse(event.action_value);
      if (!action || typeof action.requestId !== 'string' || !Number.isSafeInteger(action.revision)) return null;
      return { action, event };
    } catch {
      return null;
    }
  }

  function enqueue(event) {
    const read = readEvent(event);
    if (!read) return false;
    const { action, event: cardEvent } = read;
    if (queue.length >= 100) throw new Error('卡片事件队列已满，停止接收以避免丢失操作');

    if (action.action === 'tapd') {
      if (!tapd || cardEvent.action_tag !== 'button') return false;
      const report = (state.reports ?? []).find((item) => item.requestId === action.requestId);
      if (!report || report.status !== 'completed') return false;
      if (cardEvent.message_id !== report.promptMessageId) return false;
      // The revision is the idempotency key: the card we are looking at is the
      // one that rendered this number, and a press consumes it.
      if (action.revision !== report.revision) return false;
      if (report.tapd?.status === 'done' || report.tapd?.status === 'submitting') return false;
      queue.push({ action: 'tapd', requestId: action.requestId, revision: action.revision, operatorId: cardEvent.operator_id });
      return true;
    }

    const job = state.job;
    if (!job?.card || job.status !== 'awaiting') return false;
    if (cardEvent.message_id !== job.promptMessageId) return false;
    const expectedTag = ['project', 'branch'].includes(action.action) ? 'select_static' : 'button';
    if (!['project', 'branch', 'start', 'cancel'].includes(action.action) || cardEvent.action_tag !== expectedTag) return false;
    if (action.requestId !== job.requestId) return false;
    queue.push({ action: action.action, requestId: action.requestId, revision: action.revision,
      option: cardEvent.option, operatorId: cardEvent.operator_id });
    return true;
  }
```

新增 `submitTapd()`，并在 `processPending()` 的循环里最先分流：

```js
  async function submitTapd(event) {
    const report = (state.reports ?? []).find((item) => item.requestId === event.requestId);
    if (!report) return;
    const entry = entryFor(report.projectId);
    if (!entry) return;
    if (report.revision !== event.revision || report.tapd?.status === 'done' || report.tapd?.status === 'submitting') return;

    // Book the press before the network call: a second click on the old card
    // revision is now rejected, and a crash mid-request leaves `submitting`
    // rather than a silent second ticket.
    report.revision += 1;
    report.tapd = { status: 'submitting' };
    saveState(state);
    try {
      const { bugId, url } = await tapd.createBug(
        buildBugPayload({ report, entry, projects: config.projects }),
        { tokenFile: entry.tokenFile },
      );
      report.tapd = { status: 'done', bugId, url, at: clock() };
      log?.info?.(`tapd: ${report.triggerMessageId} -> bug ${bugId}`);
    } catch (err) {
      report.tapd = { status: 'failed', error: String(err?.message ?? err).slice(0, 200) };
      log?.warn?.(`tapd submit failed for ${report.triggerMessageId}: ${report.tapd.error}`);
    }
    saveState(state);

    const pending = { messageId: report.promptMessageId, card: card(report) };
    state.cardUpdates = (state.cardUpdates ?? []).filter((item) => item.messageId !== pending.messageId);
    state.cardUpdates.push(pending);
    await retryTerminalUpdates();
  }
```

`processPending()` 整体替换为下面这版——只在循环开头多一条 `tapd` 分流，其余分支逐字照搬现状
（`src/card-requests.js:104-139`）：

```js
  async function processPending() {
    if (await cancelPending()) return;
    await retryTerminalUpdates();
    if (state.job?.cardNeedsUpdate) await publish(state.job);
    while (queue.length) {
      if (await cancelPending()) return;
      const event = queue.shift();
      if (event.action === 'tapd') {
        await submitTapd(event);
        continue;
      }
      const job = state.job;
      if (!job?.card || job.status !== 'awaiting' || job.requestId !== event.requestId) continue;
      if (clock() > job.expiresAt) continue;
      if (job.revision !== event.revision) {
        log?.warn?.('ignoring an action on an outdated card revision');
        continue;
      }
      if (event.action === 'project') {
        if (!config.projects.some((p) => p.id === event.option)) continue;
        const candidate = { ...job, projectId: event.option, revision: job.revision + 1 };
        await loadBranches(candidate);
        card(candidate);
        Object.assign(job, candidate);
        await publish(job);
      } else if (event.action === 'branch') {
        if (!buildBranchOptions(job).some((option) => option.value === event.option)) continue;
        const candidate = { ...job, revision: job.revision + 1 };
        if (event.option.startsWith(':page:')) candidate.branchPage = Number(event.option.slice(6));
        else candidate.branch = event.option;
        card(candidate);
        Object.assign(job, candidate);
        await publish(job);
      } else if (event.action === 'start') {
        const project = config.projects.find((p) => p.id === job.projectId);
        if (!project || !job.branch || !job.branches.includes(job.branch)) continue;
        await runJob({ sender: { id: event.operatorId } }, { ...project, branch: job.branch });
      }
    }
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/card-engine.test.js test/cards.test.js test/state.test.js && npm test`
Expected: PASS。`pressing submit twice` 若建了两张单，说明两次入队都通过了 `enqueue`——第二次必须在 `report.tapd.status === 'submitting'` 或 `revision` 已自增之后被拒（入队时两次都还看不到 `submitting`，所以真正的守卫是 `processPending` 里对 `event.revision` 的复核）。

- [ ] **Step 6: 提交**

```bash
git add src/card-requests.js src/state.js test/card-engine.test.js test/state.test.js
git commit -m "feat: keep finished reports addressable and submit each card press once"
```

---

### Task 7: 把分析原文交给报告，并在进程入口装配客户端

**Files:**
- Modify: `src/index.js:43`（`createEngine` 参数）、`:137-158`（`runJob` 记录分析原文）
- Modify: `bin/checkproblem.js:60-97`
- Create/Modify: `config.example.json`
- Test: `test/card-engine.test.js`（追加）

**Interfaces:**
- Consumes: Task 6 的 `createEngine({ ..., tapd })`、Task 3 的 `createTapdClient`、Task 4 的 `config.tapd`。
- Produces: `job.analysis`（模型清洗后的纯文本）出现在 `state.job` 与 `state.reports` 里；服务启动时按配置决定是否装配 TAPD 客户端。

- [ ] **Step 1: 写失败测试**

追加到 `test/card-engine.test.js`：

```js
test('the running job keeps the raw analysis so the ticket can reuse it', async () => {
  const seen = [];
  const h = submittedHarness({
    tapdClient: { createBug: async (payload) => { seen.push(payload); return { bugId: '9', url: 'https://www.tapd.cn/tapd_fe/59180547/bug/detail/9' }; } },
  });
  const report = await completeOneJob(h);
  assert.equal(report.analysis.includes('【复现】'), true);
  assert.equal(h.replies.at(-1).text.includes('【复现】'), true, 'the group still sees the same answer');

  h.engine.enqueueCardAction({
    type: 'card.action.trigger', event_id: 'evt-tapd-9', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  });
  await h.engine.tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0].description, /【操作步骤】\n1\. 打开铁匠铺 2\. 点击锻造\n/);
});

test('no TAPD client means no submit path at all', async () => {
  const h = harness({ tapdConfig: TAPD_CONFIG, engine: { runAnalysis: async () => ({ text: FULL_ANALYSIS }) } });
  await h.engine.tick();
  h.engine.enqueueCardAction(h.event('start'));
  await h.engine.tick();
  const report = h.state.reports[0];
  const press = {
    type: 'card.action.trigger', event_id: 'evt-off', chat_id: 'oc_test',
    message_id: report.promptMessageId, operator_id: 'ou_member', action_tag: 'button',
    action_value: JSON.stringify({ action: 'tapd', requestId: report.requestId, revision: report.revision }),
  };
  assert.equal(h.engine.enqueueCardAction(press), false);
});
```

Run: `node --test test/card-engine.test.js` → FAIL：`h.state.reports[0].analysis` 是 `undefined`（`runJob` 还没写 `job.analysis`）。

- [ ] **Step 2: 改 `src/index.js`**

`createEngine` 签名加 `tapd = null`：

```js
export function createEngine({ config, lark, syncRepo, runAnalysis, state, clock, log, saveState, retrieve, listBranches, tapd = null }) {
  const cards = config.projects ? createCardRequests({
    config, state, lark, listBranches, clock, saveState, log, runJob, tapd,
  }) : null;
```

`runJob` 里，`const { text } = await runAnalysis(...)` 之后立刻记账（在 `clipForReply` 之前）：

```js
      const { text } = await runAnalysis(prompt, repo, { images });
      // The finished report is rendered from this text, so it has to be the
      // model's own answer, not the reply clipped to `maxReplyChars`.
      job.analysis = text;
      saveState(state);
```

- [ ] **Step 3: 跑测试确认通过**

Run: `node --test test/card-engine.test.js && npm test`
Expected: PASS。

- [ ] **Step 4: 装配进程入口**

`bin/checkproblem.js` 在 `const lark = createLark(...)` 之后加：

```js
// TAPD is opt-in: a config without a `tapd` section leaves the client null and
// the finished card exactly as it was before this feature.
const tapd = config.tapd && Object.keys(config.tapd.workspaces).length
  ? createTapdClient({ tokenFile: config.tapd.tokenFile, baseUrl: config.tapd.baseUrl, log })
  : null;
if (tapd) log.info(`tapd enabled for ${Object.keys(config.tapd.workspaces).join(', ')}`);
```

`createEngine({ ... })` 里加 `tapd`，并在 import 区补：

```js
import { createTapdClient } from '../src/tapd.js';
```

- [ ] **Step 5: 更新示例配置**

`config.example.json` 的 `projects` 段之后加（真实令牌永远不进仓库）：

```json
  "tapd": {
    "tokenFile": "C:/Users/<你>/.checkproblem/tapd.token",
    "fields": {
      "versionReport": "每周迭代版本",
      "os": "线上安卓",
      "te": "蔡逸鹏;",
      "currentOwner": "小鱼;",
      "cc": "南柯;",
      "severity": "normal",
      "priority": "medium",
      "frequency": "必现"
    },
    "workspaces": {
      "weapon": { "workspaceId": "59180547" },
      "digit": { "workspaceId": "52360842", "fields": { "versionReport": "版本1" } }
    }
  }
```

- [ ] **Step 6: 干跑验证装配不会崩**

Run: `node bin/checkproblem.js --once --dry-run --config state/card-test/config.json`
Expected: 退出码 0，日志里没有 `tapd enabled`（自测配置此时还没有 `tapd` 段），无异常栈。

- [ ] **Step 7: 提交**

```bash
git add src/index.js bin/checkproblem.js config.example.json test/card-engine.test.js
git commit -m "feat: hand the analysis text to the ticket builder and wire the client"
```

---

### Task 8: 自测群实跑验证（人工核对，不写代码）

**Files:**
- Modify: `state/card-test/config.json`（被 gitignore，只加 `tapd` 段）
- Modify: `docs/runbook.md`（追加提单操作与故障处理两节）

- [ ] **Step 1: 全量回归**

Run: `npm test`
Expected: 全部 PASS（预计 340 上下，无 skip、无 fail）。

- [ ] **Step 2: 给自测配置加 `tapd` 段**

在 `state/card-test/config.json` 里加与 `config.example.json` 相同的 `tapd` 块，`tokenFile` 指向 `C:/Users/EDY/.checkproblem/tapd.token`，`workspaces` 只开 `weapon`。
Run: `node -e "import('./src/config.js').then(m=>console.log(Object.keys(m.loadConfig('state/card-test/config.json').tapd.workspaces)))"`
Expected: 打印 `[ 'weapon' ]`。

- [ ] **Step 3: 重启自测服务**

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | Format-List"
```

确认 PID 27564 这类自测实例仍在，`taskkill /PID <自测pid> /F` 只杀自测实例，**绝不碰生产实例**（命令行里带 `--config state/card-test/config.json` 的才是自测），然后按 runbook 重启自测实例。

- [ ] **Step 4: 在「蔡龙自测」群发一条真实问题并按按钮**

发 `uid：<真实uid> <现象>`（或带截图），点开始查询 → 等卡片变成「查询完成」→ 点「提交 TAPD 缺陷单」。
Expected: 卡片刷成「已提单：[TAPD <id>](链接)」，日志出现 `tapd: om_… -> bug 115918054700100…`。

- [ ] **Step 5: 在 TAPD 页面逐项核对（这张单就是验收单）**

- [ ] 「使用机型」框里是 `线上安卓`（验证 `os` 的猜测；若不对，改 `src/config.js` 的 `TAPD_FIELDS` 映射并补测试）
- [ ] 「发现版本」是 `每周迭代版本`
- [ ] 「处理人」= 小鱼（余腾）、「测试人员」= 蔡逸鹏、「抄送人」= 南柯
- [ ] 「严重程度/优先级/重现规律」按配置显示
- [ ] 描述渲染成四个小节 + 【蔡龙自动分析】，换行没有塌成一段
- [ ] 「操作步骤」是模型给的复现步骤，不是「按【问题描述】里的操作复现」兜底句

- [ ] **Step 6: 补 runbook 并把验证结论写进 spec**

`docs/runbook.md` 追加：

```markdown
## 提 TAPD 缺陷单
完成态卡片上的「提交 TAPD 缺陷单」只会建一次单：按钮的 revision 随点击消耗。
- 卡片显示「TAPD 提单失败：…」→ 可再按一次「重试提交」；原因在 logs/ 里。
- 卡片停在「提交中…」且服务重启过 → 先按日志与 TAPD 列表确认是否已建单，不要重复触发。
- 误提单只能页面删除：TAPD 没有删除缺陷接口。
```

spec 的 §10「待确认」按核对结果改成结论（版本名、`os` 落位、是否需要 `cc` 加丁可）。

- [ ] **Step 7: 提交并推送**

```bash
git add docs/runbook.md docs/superpowers/specs/2026-10-29-tapd-bug-integration-design.md
git commit -m "docs: record the live TAPD ticket check"
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin feat/checkproblem-v1
```

---

## 验收清单（整个计划完成的标准）

- `npm test` 全绿，且 `test/tapd.test.js` 里有一条断言「错误消息不含令牌」。
- 未配置 `tapd` 时，卡片 JSON 与改动前逐字节一致（`test/cards.test.js` 的 `terminal cards disable all controls` 仍数到 4 个控件）。
- 同一张完成态卡片连点两次只建一单；`failed` 后可以重试；重启后 `submitting` 不自动补发。
- 自测群跑通一次真实建单，TAPD 页面上六个字段落位与描述分节均被肉眼确认。
- 生产实例（`武器店策划程序沟通`）的 `config.json` 与进程未被触碰。
