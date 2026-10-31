# 策划文档拆分与 TAPD 父子需求 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现显式文档触发、可追溯的功能拆分、人工版本审核和可恢复的 TAPD 父子需求创建，不影响现有故障排查。

**Architecture:** 新增独立的文档来源适配器、结构化拆分器、审核协调器和提交账本，复用 Lark 卡片传输及已批准的模型调用。TAPD 需求适配器与缺陷适配器分开；重操作共享单执行槽，消息接收及轻量审核不等待长任务。

**Tech Stack:** Node.js >=22、ESM、node:test、node:assert/strict、原生 fetch、现有 lark-cli；不新增 npm 依赖。素材解析使用已验证可在常驻服务调用的 CLI 能力，不依赖 Desktop 会话工具。

**Spec:** `docs/superpowers/specs/2026-10-30-planning-document-story-decomposition-design.md`（聊天方案与书面规格已获用户确认）。

## Global Constraints

- 自动分析不等于自动建单。
- 一张子需求对应一个边界明确、可开发、可验收的功能闭环，而不是一个章节、一个按钮或一个配置实例。
- 不包含：监听任意文档编辑、自动覆盖既有需求、删除需求、自动派工或估工期、自动修改游戏代码、默认扫描游戏仓库、自动发布生产服务。
- 首版流程只在明确配置的自测入口启用。不得修改生产配置、重启生产实例或向业务群发送测试消息。
- 真实 TAPD 写入验证须另获用户授权，不因本规格获批而自动获得授权。
- TAPD 与模型凭据只从已批准的本地凭据文件读取，不进入参数、错误、日志、卡片、需求正文或 Git。
- 首版不把飞书附件复制上传到 TAPD。
- 提交账本不随最近 20 条分析报告清理，首版不自动删除。
- 不宣称具备 TAPD 端到端 exactly-once 保证；依赖本地防重、停止不确定重试和人工核对控制重复风险。
- 保持 ESM、可注入副作用和现有依赖约束；额外依赖不得静默安装。
- 文档写入只限本规格、本计划及获批实施所需的现有运行手册；不要额外生成过程文档。
- 当前阶段仅编写计划。所有实现、配置变更和服务操作等待计划审阅；提交/推送 Git 仅在有明确授权时执行。

---

## 0. 执行前必读和可行性门禁

工作仓库 `E:/lark-code-agent`，不是 Desktop 默认会话目录。开始执行前读取项目指令，检查 Git 状态，遵循 using-git-worktrees 技能取得隔离目录；不能删除当前未提交的规格和计划。本文引用的位置以写计划时源码为准，执行时重新定位。

已确认入口：

- `src/index.js:43,186-326`：createEngine、tick、卡片事件路由；当前 tick 会等待卡片队列。
- `src/card-requests.js:8,211-264`：现有故障卡队列和被 await 的 runJob。
- `src/trigger.js:19-35`：富文本提取忽略链接节点，不能用于新需求链接提取。
- `src/lark.js:51-240`：createLark，replyCard/updateCard/listMessages/reply；私有 call 不应为新功能随意导出。
- `src/chat.js:17,57`：resolveApiKey 和 askChat({prompt,images,baseUrl,model,apiKey,timeoutMs,fetchImpl}) → {text}；没有现成 JSON 输出模式。
- `src/config.js:114-159`：loadConfig；现有 tapd 配置是缺陷字段。
- `src/state.js:39-65`：普通状态损坏会复位，不能用来加载需求提交账本。
- `bin/checkproblem.js:63-117,133-181`：依赖装配、轮询和 shutdown。
- `src/tapd.js:181-227`：仅 createBug，不可假设它支持 stories。

### 必须先核实的外部契约

Task 1 是阻塞后续适配器实现的只读门禁，不是允许边写边猜的研究事项：

1. TAPD 创建需求的官方方法/路径、准确字段及父子关系写法，字段/类型/模板/人员/迭代读取方式。
2. lark-cli 的文档结构、分页、wiki 解析、图片/画板下载、内嵌表和 Excel 内容读取是否可由常驻 Node 进程调用。
3. 客户端卡片的按钮、分页和多选/输入能力，以及列表消息包含的 parent_id/root_id/富文本链接实际结构。

创建权限只有授权自测写入才能证实；Task 1 只核实文档契约和读取能力。若 Excel/表格等必要能力只能通过 Desktop MCP、需要新依赖或手工读取才能实现，停止对应适配器任务，向用户提出具体范围或依赖调整，不能把“未实现的解析”伪装成首版完成。视频按规格明确走人工说明/排除路径，不需要自动视频识别。

## 1. 文件边界与统一契约

### 文件责任

| 文件 | 操作 | 单一责任 |
| --- | --- | --- |
| src/requirement-input.js | 新增 | 纯消息分类、链接提取、文档规范化和线程定位 |
| src/requirement-config.js | 新增 | 新需求配置校验；由 config.js 调用 |
| src/requirement-store.js | 新增 | 独立草稿/提交台账的持久化和恢复 |
| src/planning-document.js | 新增 | Lark 文档/素材结构化读取、快照和重检 |
| src/requirement-draft.js | 新增 | 结构契约、覆盖/来源/依赖校验和批次冻结 |
| src/decompose.js | 新增 | 分块提取、聚合、模型草稿修改，调用上述校验 |
| src/tapd-stories.js | 新增 | TAPD 需求只读/创建适配器及 HTML 模板 |
| src/requirement-submit.js | 新增 | 父子顺序创建、每项台账和未知结果核对 |
| src/requirement-cards.js | 新增 | 需求草稿分页、详情和确认卡纯渲染 |
| src/requirement-requests.js | 新增 | 身份/版本校验、审核动作、协调来源和提交 |
| src/work-slot.js | 新增 | 共享的单重操作执行槽 |
| src/config.js | 修改 | 在归一化项目/TAPD后调用需求配置校验 |
| src/index.js | 修改 | 新流程优先路由、轻量轮询、共享槽、shutdown方法 |
| src/card-requests.js | 修改 | 仅把长故障分析移到共享槽，不改缺陷业务规则 |
| bin/checkproblem.js | 修改 | 依赖装配、关闭时等待已发起的操作落盘 |
| test/requirement-fixtures.js | 新增 | 脱敏合成样例和统一测试工厂 |
| test/*.test.js | 新增/修改 | 每个新模块一份同名测试；现有 engine/card/CLI 回归 |
| docs/runbook.md | 修改 | 获批实施后补充只读检查、审核、恢复和自测步骤 |

不要预先创建空文件。每个文件随自己的 RED→GREEN 任务创建。

### 数据结构（所有任务按此命名）

```js
// Snapshot
({ documentId, url, title, revision, fingerprint,
   blocks: [{ id, heading, kind, text }],
   resources: [{ id, kind, sourceBlockId, status, fingerprint, text, reason }],
   comments: [{ id, sourceBlockId, text }], commentsComplete: false });
// resource.status: parsed | explained | excluded | pending
// kind: image | whiteboard | spreadsheet | workbook | video | reference

// Draft
({ version, facts: [{ id, sourceIds, text, kind }],
   stories: [{ key, title, rules, acceptance, sourceIds, factIds,
     dependencies, issueIds, owner, disposition }],
   issues: [{ id, question, storyKeys, blocking, resolvedBy }],
   exclusions: [{ factIds, reason, approvedBy }],
   decisions: [{ id, actorId, text, sourceIds }], resourceDecisions: [] });
// fact.kind: source | comment | decision | suggestion
// disposition: proposed | approved | deferred | excluded
// rules/acceptance: [{ text, factIds }]; sourceIds 包含 block/resource/comment ID

// Request
({ id, chatId, triggerMessageId, cardMessageIds, initiatorId, reviewerIds,
   projectId, status, snapshot, draft, parentStoryId, submissions, viewByActor });

// FrozenBatch（提交内容不可变）
({ id, requestId, draftVersion, workspaceId, documentId, sourceFingerprint,
   parent: { mode, storyId, fields }, stories: [{ key, fields, dependencies }],
   actorId, approvedAt, payloadHash });
// parent.mode: create | bind

// Request.submissions 中每条记录
({ batch, status, items }); // batch 为 FrozenBatch，提交后不可变
// SubmissionItem
({ key, marker, payloadHash, status, storyId, errorCode });
// status: pending | sending | created | rejected | unknown
```

示例测试中的 submissions[0].items 指台账记录，submitter 通过 record.batch 取得冻结内容。父项 key 固定为 parent，子项使用 story.key。

统一异步失败采用固定错误 code，不把远端原文带入日志。纯校验失败用 `{code, paths}` 描述，便于测试精确断言。不要在生产模块加入为测试专用的分支。

### 配置输入（新增 requirements 块，不复用 bug fields）

```js
{
  requirements: {
    allowedSenders: ['ou_test'],
    reviewers: ['ou_reviewer'],
    documentHosts: ['hellowd.feishu.cn'],
    modelAttempt: 0,
    projects: {
      weapon: {
        parentTypeId: 'verified-parent-type',
        childTypeId: 'verified-child-type',
        templateId: 'verified-template',
        owners: ['已核实的成员昵称'],
        iterationIds: ['0', 'verified-iteration']
      }
    }
  }
}
```

以上字符串为测试形状，不是运行配置的候选值。实际 IDs 必须来自 Task 1 的真实契约和元数据。允许群限定为现有 config.chatId，首版不额外做多群监听；不同环境使用不同实例配置。发起人自动拥有该请求审核权，reviewers 为额外审核人。workspace/tokenFile 仅取对应已配置的 TAPD 项目映射。modelAttempt 指向现有 analyze.attempts 的一个明确 chat 端点，必须有 apiKeyFile，使用 apiKeyEnv:''；不使用命令型分析回退。

### 有界处理与失败含义

Task 5/6 的 limits 初始常量：正文及表格提取总计最多 500,000 字符、每次平台分页读取最多 500 页、最多 100 个关联资源、单资源下载最多 20 MiB、每请求下载总计最多 200 MiB。模型分块正文上限 12,000 字符，超长单块按连续偏移拆片并保留原 blockId；每请求最多 100 次模型调用（含归并、视觉与一次结构修复），每次沿用所选模型 attempt 的 timeoutSec。

这些是服务保护上限，不是平台承诺。触限均记录未读取/未分析范围并暂停相应草稿，绝不以截断文本继续可提交状态；若真实样例触限，应报告并经用户确认调整，不自动提高。任务列表每页最多5条、详情每页按最多6,000 UTF-8字节文本分段，最终序列化仍检查30KiB；单次确认最多创建50张子单，超过时要求分批审核并保持同一父单。生产限值必须与相应测试共享导出常量，不能在多处复制。

## Task 1：只读核实平台契约

**Files:** 更新本计划“外部契约核实记录”小节；新增 `test/fixtures/requirement-platform.json`（仅合成/脱敏协议字段）。

**Interfaces:** 输入已提供的文档和 TAPD 样例；输出经核实的只读响应形状、创建契约和固定字段表，供 Tasks 5、7、9 使用。

- [ ] 读取 lark-doc 及对应资源技能参考，先核对命令再调用。文档可重现读取命令：

```bash
lark-cli docs +fetch --doc "https://hellowd.feishu.cn/docx/OCgddiDEfo9jojxG5v1cMsh5n1w" --as user --detail with-ids
```

- [ ] 使用已批准文件令牌、GET /stories 按 id 读取 1159180547001005141、1159180547001004412，按 parent_id 读取全部子单；只输出非敏感字段，查齐分页。不得 POST、不得 dump 原始响应头。
- [ ] 从 TAPD 官方文档核实创建和查询的字段、父子类型/模板、分页契约、候选查询接口，记录文档来源与读取结果，区分“契约存在”和“写权限已测”。
- [ ] 实测服务运行环境可读取一个图片、画板、内嵌表和 Excel，核实 payload/limit/分页；没有能力的资源进入阻塞评估，不能偷换成只保存链接。
- [ ] 脱敏协议 fixture 只保留字段形状与合成值，记录实际消息 parent_id/root_id 及 post 链接结构；禁止提交原始业务全文、令牌、签名下载地址。
- [ ] 更新本计划末尾核实记录。必要能力不足时停下，提出具体调整并等待确认，再进入受影响任务。

**门禁证据：** 不进行远端写入。只有本任务可行性通过后 Tasks 5、7、9 的平台绑定细节才具备实施前提。

## Task 2：纯输入解析与关闭默认配置

**Files:** Create `src/requirement-input.js`, `src/requirement-config.js`, `test/requirement-input.test.js`, `test/requirement-config.test.js`; Modify `src/config.js`, `test/config.test.js`。

**Interfaces:**
- `normalizeDocumentLink(url, {hosts}) → {kind, token, url}`，拒绝 userinfo、非 HTTPS、非允许 host/path；去无关 query/hash。
- `classifyRequirementMessage(message, {selfOpenId, hosts}) → null | {kind:'start', documents} | {kind:'edit', requestId, text, parentId, rootId}`。
- `resolveRequestReference(message, requests) → requestId | null`；歧义抛出 `AMBIGUOUS_REQUEST`。
- `normalizeRequirements(raw, {projects, tapd, analyze, root}) → undefined | config`；未配置完全不启用。

- [ ] 写 RED：相同 docx 链接不同查询参数只产生一个文档；无机器人 mention 的普通链接不触发；post 的 a 节点可提取；双文档保留两个并交协调器拒绝。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocumentLink } from '../src/requirement-input.js';
test('normalizes copy links without changing document identity', () => {
  const opts = { hosts: ['hellowd.feishu.cn'] };
  const a = normalizeDocumentLink('https://hellowd.feishu.cn/docx/abc?from=copy', opts);
  const b = normalizeDocumentLink('https://hellowd.feishu.cn/docx/abc#part', opts);
  assert.deepEqual(a, b);
  assert.equal(a.token, 'abc');
  assert.throws(() => normalizeDocumentLink('https://u@hellowd.feishu.cn/docx/abc', opts));
});
```

- [ ] 执行 `node --test test/requirement-input.test.js test/requirement-config.test.js`，先观察缺失实现失败；创建函数后确认行为断言确实覆盖相应规则。
- [ ] 实现纯解析：new URL 解析 host 和 path，post 遍历 text/md/a/at，不执行任何网络请求。编辑需“修改拆分”显式前缀与唯一线程或请求标识。

```js
const url = new URL(rawUrl);
if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !hosts.includes(url.hostname)) throw new Error('UNTRUSTED_DOCUMENT_URL');
const match = /^\/(docx|wiki)\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
if (!match) throw new Error('UNSUPPORTED_DOCUMENT_URL');
url.search = '';
url.hash = '';
```

- [ ] 配置测试覆盖未知项目/无 TAPD 映射/空 reviewer/非白名单 host/命令型 modelAttempt/缺少 key 文件路径；错误只输出字段名。配置缺省时旧 config 深比较不变。
- [ ] 实现 normalizeRequirements 并在 loadConfig 已归一化后调用，路径派生为 `root/state/requirements.json` 与 `root/state/requirement-assets`。不改现有生产或自测配置文件。
- [ ] 运行新增测试与 `node --test test/config.test.js test/trigger.test.js`；核对 diff，只在获得 Git 提交授权后提交这一单元。

## Task 3：独立持久化草稿与创建台账

**Files:** Create `src/requirement-store.js`, `test/requirement-store.test.js`。

**Interfaces:** `openRequirementStore(file, {io}) → {get(id), list(), transaction(fn), close()}`。transaction 串行、复制当前状态后调用纯 fn(next)，成功写入后才发布新内存值；返回 Promise。get/list 返回副本。仅 ENOENT 可初始化 `{version:1,requests:{}}`。

- [ ] RED：保存 unknown 项后重新加载仍存在；损坏 JSON 抛错，不能初始化空账本。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRequirementStore } from '../src/requirement-store.js';
test('corrupt submission ledger never becomes an empty store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'requirements-'));
  try {
    const file = join(dir, 'ledger.json');
    writeFileSync(file, '{broken');
    assert.throws(() => openRequirementStore(file), /LEDGER_CORRUPT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] `node --test test/requirement-store.test.js` 观察 RED。
- [ ] 实现独立的 schema version 与完整性校验；写临时文件、flush 文件、关闭后原子 rename；临时文件名唯一。不声称 Windows 上具备跨断电的数据库事务保证。写入失败不更新内存，阻止外部创建。

```js
const next = structuredClone(current);
const result = fn(next);
validateLedger(next);
await writeAtomic(next);
current = next;
return result;
```

- [ ] 补充 RED→GREEN：两个异步事务都保留、不超过20条自动裁剪、未知schema拒绝、rename失败保留旧数据、get返回值无法篡改内存。
- [ ] `node --test test/requirement-store.test.js test/state.test.js`；提交授权存在时才提交。

## Task 4：草稿结构、覆盖与冻结校验

**Files:** Create `src/requirement-draft.js`, `test/requirement-draft.test.js`, `test/requirement-fixtures.js`。

**Interfaces:**
- `validateDraft({draft,snapshot,actorIds}) → draft` 或固定 code 异常。
- `submissionEligibility({draft, snapshot, selectedKeys, createdKeys}) → {allowed, blockers}`。
- `freezeBatch({request, selectedKeys, target, actorId, now, batchId}) → FrozenBatch`；target 含 workspaceId、parent、child defaults，来源仅取可信配置/审核选择。
- `applyReviewDecision({request,actorId,decision}) → updatedRequest`，允许审批/延期/排除、资源说明、问题答复和字段选择，不调用模型。

- [ ] 建合成 fixture 工厂 `makeSnapshot()`、`makeDraft()`、`makeRequest()`：两个事实 F1/F2、一张 M01，rules/acceptance 都引用 F1/F2；一个 pending 视频只影响 M02。全任务复用这三个确切名称。
- [ ] RED：原文事实 F2 无归属时拒绝，不允许“成功拆分”。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft } from '../src/requirement-draft.js';
import { makeSnapshot, makeDraft } from './requirement-fixtures.js';
test('rejects an uncovered source requirement', () => {
  const draft = makeDraft();
  draft.stories[0].factIds = ['F1'];
  assert.throws(() => validateDraft({ draft, snapshot: makeSnapshot(), actorIds: ['ou_test'] }),
    { message: 'UNCOVERED_FACT' });
});
```

- [ ] `node --test test/requirement-draft.test.js` 观察 RED。
- [ ] 实现显式字段/类型/长度校验，稳定 key 唯一、事实来源存在、rules与acceptance可追溯；循环依赖 DFS；未批准 suggestion 不可提交；用户决定只能来自服务端写入 decisions。

```js
const accounted = new Set([
  ...draft.stories.flatMap(s => s.factIds),
  ...draft.exclusions.flatMap(e => e.factIds),
]);
for (const fact of draft.facts) {
  if (!accounted.has(fact.id)) throw new Error('UNCOVERED_FACT');
}
```

问题所阻塞事实必须仍有延期子单归属，防止仅提一个问题就从覆盖表消失。
- [ ] 补齐测试：自依赖/环/不存在依赖、未知来源、把 suggestion 假装 source、没有验收、未读视频只阻塞关联单、已建依赖可满足、内容变化必须增加版本；freeze 后源 request 再修改不影响批次指纹。
- [ ] `node --test test/requirement-draft.test.js test/requirement-store.test.js` 全绿后审查并按授权提交。

## Task 5：文档和素材读取、完整性与版本重检

**Files:** Create `src/planning-document.js`, `test/planning-document.test.js`; 使用 Task 1 fixture。不改通用 lark 私有 call。

**Interfaces:** `createPlanningDocumentReader({run, resourceReaders, hosts, assetsDir, limits}) → {read(link), revalidate(snapshot), cleanup(requestId)}`。
read 返回 Snapshot；revalidate 返回 `{unchanged, changes}`，无法核实时抛出 `SOURCE_RECHECK_FAILED`。
resourceReaders 每个 kind 提供 `async ({resource, requestDir}) → {text,fingerprint,sourceIds}`；由本模块使用 Task 1 核实的 CLI 能力构造生产实现，不接受永远 pending 的占位适配器。

- [ ] RED：合成正文一页、表格两页、一个无权限图片，读取结果保留两页表格及 pending 图片，不把整体判作完整。

```js
test('unread media remains visible in the source manifest', async () => {
  const reader = createPlanningDocumentReader(platformFixture({ imageReadable: false }));
  const snapshot = await reader.read(testDocLink);
  assert.equal(snapshot.resources.find(r => r.kind === 'image').status, 'pending');
  assert.ok(snapshot.blocks.some(b => b.text.includes('table-page-2')));
});
```

`platformFixture(options)` 与 `testDocLink` 在本测试文件定义，依 Task 1 fixture 构造真实 CLI 响应，不 mock 返回 Snapshot。
- [ ] `node --test test/planning-document.test.js` 观察 RED。
- [ ] 实现 docx/wiki 分派、正文/评论结构化、资源清单、全分页读取。仅传 token/安全参数到 CLI；正文与模型输入不用 shell 拼接。拒绝 result.truncated 和非零退出；授权错误映射为固定 code。
- [ ] 图片/画板使用真实下载字节作指纹并交现有视觉 chat；表格/Excel通过已核实读取器获取单元格；视频标 pending，不能读取 alt 就改 parsed。若 Task 1 无可行实现，停在门禁，不交付虚假的覆盖完成。
- [ ] 资源临时路径由 requestId 派生，路径不得由远端文件名决定；只下载平台 token 资源，避免任意 URL HTTP 抓取。仅允许配置 hosts；外链 reference 留待用户显式处理。
- [ ] 添加来源 hash 测试：附件内容变化但主 revision 不变也必须 revalidate 失败；主版本变化、无法重读、读取上限、引用循环均不允许静默通过。

```js
const before = await reader.read(testDocLink);
fixture.replaceWorkbookCell('B2', 'changed');
assert.equal((await reader.revalidate(before)).unchanged, false);
```

- [ ] `node --test test/planning-document.test.js test/lark.test.js` 全绿；不保留令牌或临时签名 URL 进 Snapshot；按授权提交。

## Task 6：分块拆分与自然语言改稿

**Files:** Create `src/decompose.js`, `test/decompose.test.js`; Modify 测试工厂以提供跨章节样例。

**Interfaces:** `createDecomposer({chat,limits}) → {analyze(snapshot), revise({snapshot,draft,instruction})}`，chat({prompt,images}) → {text} 使用现有 askChat；返回的 Draft 不含自动批准信息。

- [ ] RED：正文末尾的奖励规则必须出现在覆盖中；同一功能跨两章合并，不按章节产生重复单。

```js
test('retains late-section facts and rejects invented sources', async () => {
  const d = createDecomposer({ chat: scriptedChat(validChunkReplies), limits: testLimits });
  const draft = await d.analyze(longSnapshot);
  assert.ok(draft.facts.some(f => f.sourceIds.includes('last-block')));
  assert.throws(() => validateDraft({
    draft: { ...draft, facts: [{ id: 'bad', sourceIds: ['missing'], text: 'x', kind: 'source' }] },
    snapshot: longSnapshot, actorIds: [],
  }));
});
```

在测试内定义 scriptedChat、合成回复和 longSnapshot；它只替代外部模型，使用真实 chunk/merge/validate 逻辑。
- [ ] `node --test test/decompose.test.js` 观察 RED。
- [ ] 实现三阶段：按完整块预算切片提取 facts → 跨块聚合 stories/dependencies → 服务端校验覆盖与冲突。最终输入超过预算时使用按来源分组的多级归并，任何事实不可裁切；达到操作上限返回 `ANALYSIS_LIMIT`。
- [ ] 提示词把正文标为数据、不接受正文指令变更目标或权限；要求严格 JSON。先 JSON.parse 再 validateDraft，结构修复最多一次且不使用工具型回退；失败回待分析，不回部分可提交结果。

```js
const { text } = await chat({ prompt, images });
const candidate = JSON.parse(text);
return validateDraft({ draft: candidate, snapshot, actorIds: [] });
```

- [ ] revise 接收人工指令和已批准 decisions，生成全草稿候选；服务端保留历史决策、稳定 key 和既有单映射；规则变更使对应 approval 失效。不能接受模型输出 actorId/created IDs/审批状态。
- [ ] 添加 RED→GREEN：配置“待补充”不编造、评论冲突生成issue、15/13示例不写死、竞品alt不当证据、恶意文档要求自动建单无效、重复 key 拒绝、修改不覆盖已建单。
- [ ] 跑 `node --test test/decompose.test.js test/requirement-draft.test.js test/chat.test.js`；按授权提交。

## Task 7：独立 TAPD 需求适配器及模板

**Files:** Create `src/tapd-stories.js`, `test/tapd-stories.test.js`。

**Interfaces:**
- `buildParentFields({request,target,marker}) → fields`。
- `buildChildFields({story,request,target,parentId,dependencyIds,marker}) → fields`。
- `createTapdStories({request,readFile,tokenFile,timeoutMs}) → {getStory, listChildren, findParents, findByMarker, createStory}`。
- getStory({workspaceId,id}) → normalized Story；listChildren/findParents/findByMarker 返回 `{items,complete}`，内部查齐分页或明确不完整。
- createStory({workspaceId,fields}) → `{id}`；错误 code 为 `UNSENT`、`REJECTED` 或 `UNKNOWN`，只有已核实的拒绝响应可归 rejected。

- [ ] RED：模板转义正文、不带 bug 字段、包含来源版本与追踪标识，parent ID 为指定 ID。

```js
test('child payload escapes text and keeps the approved parent', () => {
  const fields = buildChildFields({
    story: { ...makeDraft().stories[0], title: '<img onerror=x>' },
    request: makeRequest(), target: storyTarget, parentId: 'P1',
    dependencyIds: {}, marker: 'req-r1-M01',
  });
  assert.equal(fields.parent_id, 'P1');
  assert.ok(!fields.description.includes('<img onerror=x>'));
  assert.ok(fields.description.includes('req-r1-M01'));
  assert.equal(Object.hasOwn(fields, 'current_owner'), false);
});
```

`storyTarget` 使用 Task 1 已核实的字段名称和合成 ID。
- [ ] `node --test test/tapd-stories.test.js` 观察 RED。
- [ ] 依 Task 1 确认的官方契约实现字段映射与创建请求；不要从 createBug 的路径替换来推断参数。API 主机固定，token 只在 headers，拒绝重定向携带认证，超时错误脱敏。
- [ ] 查询按原生参数编码，分页直到完整；findParents 比较正文中的规范化 doc ID，不以标题判断已存在。findByMarker 精确核对 workspace/parent/marker；搜索不完整不可报告无结果。
- [ ] 填写创建缺ID、非JSON、连接中断、超时测试均为 UNKNOWN；未读到凭据为 UNSENT；模拟明确业务校验拒绝为 REJECTED。响应中任何可疑原文不拼入错误。
- [ ] `node --test test/tapd-stories.test.js test/tapd.test.js`，旧缺陷客户端行为不变。无授权时只跑假 fetch，不做远端写入；按授权提交。

## Task 8：父子提交与未知结果恢复

**Files:** Create `src/requirement-submit.js`, `test/requirement-submit.test.js`。

**Interfaces:** `createRequirementSubmitter({store,tapd,documents,clock}) → {submit({requestId,batchId}), reconcile({requestId,batchId}), resume({requestId,batchId,actorId})}`。批次必须已由审核协调器冻结并存储。submit 不接收任意调用方 payload。

- [ ] RED：一个子单超时，父单和之前成功子单只创建一次；再 submit 不重发未知项。

```js
test('unknown child result never causes an automatic repeat', async () => {
  const h = await submissionHarness({ unknownKey: 'M02' });
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  await h.submitter.submit({ requestId: 'r1', batchId: 'b1' });
  const batch = h.store.get('r1').submissions[0];
  assert.equal(batch.items.find(i => i.key === 'parent').status, 'created');
  assert.equal(batch.items.find(i => i.key === 'M02').status, 'unknown');
  assert.deepEqual(h.remote.createdKeys, ['parent', 'M01', 'M02']);
});
```

submissionHarness 在本测试定义，使用真实临时 store 与有远端状态的假 TAPD；断言台账和远端条目，不仅断言调用次数。
- [ ] `node --test test/requirement-submit.test.js` 观察 RED。
- [ ] 实现同 workspace/doc 身份锁定，重检来源和目标字段；不一致则暂停且没有 POST。bind 模式先读父单核对 workspace/文档，由审核确认差异不能悄悄绑定。
- [ ] 每项先保存 sending/marker/hash，再发起创建；成功立即保存ID。不确定时停止批次，子单按拓扑顺序；父单失败不能创建子单。

```js
await store.transaction(state => setItem(state, requestId, batchId, key, { status: 'sending' }));
let result;
try { result = await tapd.createStory({ workspaceId, fields }); }
catch (error) {
  await store.transaction(state => setItem(state, requestId, batchId, key,
    { status: error.code === 'REJECTED' ? 'rejected' : error.code === 'UNSENT' ? 'pending' : 'unknown' }));
  return;
}
await store.transaction(state => setItem(state, requestId, batchId, key,
  { status: 'created', storyId: result.id }));
```

setItem 是该模块内私有纯更新函数，写入成功才继续下一项；记录成功失败时不能吞掉本地写错而继续远端创建。
- [ ] reconcile 仅 GET；唯一精确匹配补ID，多匹配/不完整/无匹配保留 unknown。人工核对后关联实际ID仍执行 getStory 验证；未找到不能开放一键无条件重试未知项。
- [ ] 重启把 sending 视为unknown，created不重放；显式resume只恢复已证实未创建项。部分剩余单后续审批仍使用已保存父ID；description依赖用已知ID生成，不回写已有单。
- [ ] 测试双击、restart、账本写失败先于网络、远端成功落盘失败、partial、父单绑定、附件变化、错误workspace、页面回填失败不重建；全绿按授权提交。

## Task 9：分页卡片与审核动作

**Files:** Create `src/requirement-cards.js`, `test/requirement-cards.test.js`。

**Interfaces:** `buildRequirementCard({request,view,viewerId}) → card`；view `{page,storyKey,detailPage,mode}`。callback value 固定 `{workflow:'requirements',requestId,draftVersion,action,key,page}`，敏感目标字段不取自callback。

- [ ] RED：长草稿分页不超30KiB，列表、详情、确认均有版本；未读素材/blocked故事显示原因，提交禁用。

```js
test('renders bounded pages without silently dropping story details', () => {
  const request = makeRequest();
  request.draft.stories[0].rules = Array.from({ length: 40 }, (_, n) =>
    ({ text: `规则${n}:` + '长文本'.repeat(80), factIds: ['F1'] }));
  const card = buildRequirementCard({ request, view: { mode: 'detail', storyKey: 'M01', detailPage: 0 }, viewerId: 'ou_test' });
  assert.ok(Buffer.byteLength(JSON.stringify(card), 'utf8') <= 30 * 1024);
  assert.ok(JSON.stringify(card).includes('detail_next'));
});
```

- [ ] `node --test test/requirement-cards.test.js` 观察 RED。
- [ ] 纯渲染沿用现有 Card 2.0 控件模式；正文用 plain_text，长详情按规则段分页且显示总段数。单个极长规则再分页，不截断落盘内容。更新共享卡只改变视图，不代表其他人完成审核。
- [ ] 审核动作：查看/翻页、批准或延期/排除子单、回答问题入口、项目/负责人/迭代选择、绑定父单、确认页、提交/取消/核对/继续。涉及输入的动作按 Task 1 支持的控件；复杂内容通过明确线程编辑命令，不制造未支持的表单。
- [ ] 确认页显示全部待创建标题、暂缓标题、bind/create模式、总写入数量；多页确认记录每个审核人的已查看范围，内容版本变化清除范围，最后提交前检查该审核人已查看选中子单的完整详情与确认页。
- [ ] 添加测试：恶意HTML、变更版本、共享翻页无审批副作用、目标选择不隐式批准、unknown禁用再提交。`node --test test/requirement-cards.test.js test/cards.test.js`；按授权提交。

## Task 10：审核协调器与交互闭环

**Files:** Create `src/requirement-requests.js`, `test/requirement-requests.test.js`。

**Interfaces:** `createRequirementRequests({config,store,lark,documents,decomposer,submitter,slot,clock,log}) → {handleMessage(message),enqueue(event),flush(),whenIdle()}`。
handleMessage → Promise<boolean> 表示是否为本流程消费；只等待轻量确认落盘/反馈，不等完整分析。enqueue 同步 boolean，验证后安排异步工作；flush处理待刷卡，不等待重操作。

- [ ] RED：越权、旧版本及跨群按钮不能批准/建单；修改后的老确认卡无效。

```js
test('an old review cannot submit an edited draft', async () => {
  const h = await reviewHarness();
  const oldEvent = h.action('submit');
  await h.edit('修改拆分：将M01延期');
  h.flow.enqueue(oldEvent);
  await h.flow.whenIdle();
  assert.equal(h.store.get('r1').submissions.length, 0);
});
```

reviewHarness 使用真实draft/store/submitter，fake外部Lark/model；以台账结果断言。
- [ ] `node --test test/requirement-requests.test.js` 观察 RED。
- [ ] 先校验 chat/sender/request/message/version；只有允许发起人及项目reviewer，不能只检查openid格式。编辑请求唯一线程定位，歧义给出请求标识要求。
- [ ] 同文档返回现有草稿/映射；多链接要求选择；项目模糊暂停到用户选择。读取/分析占slot，完成释放，待审核不占；忙时明确反馈且不静默排队。
- [ ] 内容修改/来源说明/字段变更串行递增版本并重校验，提交中不可编辑冻结批次；分页不改版本。LLM只处理业务改稿，人员/目标/批准等必须由服务端从白名单和真实用户动作确定。
- [ ] 提交前生成freezeBatch存储、完整详情查看校验、来源重检、父单候选检查、选择子集依赖校验；对现有实际文档默认绑定已有父单并逐单比对。看不全的旧需求清单不能判定无重复。
- [ ] 重启恢复草稿卡，读取/分析中标可重试，sending交submitter核对；刷卡重试独立于远端创建，不丢创建结果。
- [ ] 添加测试：自然语言改稿留决策、未读素材说明/排除必须有actor、查不到父单要求确认、已有单差异不更新、批准子集后再提交剩余不重建总单；通过后按授权提交。

## Task 11：共享执行槽与运行时接线

**Files:** Create `src/work-slot.js`, `test/work-slot.test.js`; Modify `src/index.js`, `src/card-requests.js`, `bin/checkproblem.js`, `test/engine.test.js`, `test/card-engine.test.js`, `test/card-cli.test.js`。

**Interfaces:** `createWorkSlot() → {tryStart(owner,work),isBusy(),whenIdle()}`。
tryStart 同步返回 `{accepted:false}` 或 `{accepted:true,done:Promise}`，先占槽再调 work；done 失败必须由调用者处理，finally释放。engine增加 `whenIdle()`，供once模式和关闭时等待。

- [ ] RED：正在执行的查询占槽但不阻塞下一次poll及轻量审核；新的重分析收到忙反馈，不能抢占。

```js
test('a busy slot refuses concurrent heavy work and releases after completion', async () => {
  const slot = createWorkSlot();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = slot.tryStart('bug:r1', () => gate);
  assert.equal(first.accepted, true);
  assert.equal(slot.tryStart('requirements:r2', async () => {}).accepted, false);
  release();
  await first.done;
  assert.equal(slot.isBusy(), false);
});
```

- [ ] `node --test test/work-slot.test.js` 观察 RED，再最小实现同步占槽+finally释放。
- [ ] 在 card-requests 的 start 接受点使用同一个slot；必须先原子占槽再改变job/revision，拒绝占槽时保持可重试的awaiting状态并返回忙提示。runJob从await drain改为tracked promise，只有新卡流程启用时才需要新路由但共享逻辑不复制两套实现。保留“查询中写失败不跑隐藏分析”、重复点击、取消和revision护栏。
- [ ] 在engine每个未读message进入旧 awaiting/trigger路径之前调用 requirements.handleMessage，消费后正常markSeen；规划命令不得落入旧 hasTrigger。运行中bug job也不能被新普通问题覆盖，必须busy回复。不能让新的后台runJob在firstTick恢复检查前启动并被误判成中断任务：启动恢复完成后才开放start调度，并为该竞态加回归。
- [ ] enqueueCardAction 根据 workflow 精确路由：requirements动作只交新流程，旧卡留原实现；未知命名空间拒绝，不能在新流程拒绝后再试旧流程。
- [ ] bin装配 config→store→slot→documents/decomposer/tapdStories→submitter→requirements→engine。chat用固定配置attempt和file-only凭据；dryRun保持不进行真实TAPD写入、不执行真实提交。
- [ ] 正常shutdown停止接收新事件，等待有超时界限的已发起操作结束并持久化，最后释放进程锁；SIGKILL无法等待，靠unknown恢复。once模式调用whenIdle以保留可重复测试行为。
- [ ] 修订受异步时序影响的旧测试：使用engine.whenIdle等待真正后台任务，不靠任意sleep/setTimeout。加“被阻塞的fake分析中还能listMessages/处理审核”的回归。
- [ ] 运行 `node --test test/work-slot.test.js test/engine.test.js test/card-engine.test.js test/card-cli.test.js test/e2e.test.js`；任何旧功能回归先修复再继续；按授权提交。

## Task 12：端到端验证、运维说明与获批自测

**Files:** Create `test/requirements-e2e.test.js`; Modify `docs/runbook.md`。实际自测配置仅在用户授权后单独改，不入Git。

**Interfaces:** 使用前述真实模块串联，外部仅替换CLI/model/TAPD transport。不增加生产测试开关。

- [ ] 写一条完整RED集成用例：消息→全文/素材→分块拆分→改稿→确认→bind已有父→创建子单→读取核对。此用例应先暴露此前接线未覆盖的真实缺口，再修最小问题；若直接通过，保留为回归，不虚称完成过RED。

```js
test('reviewed document creates only approved children under the bound parent', async () => {
  const h = await endToEndHarness();
  await h.sendPlanningDocument();
  await h.engine.whenIdle();
  await h.review({ parentId: 'existing-parent', selectedKeys: ['M01'] });
  await h.engine.whenIdle();
  assert.deepEqual(h.remote.stories.map(s => [s.key, s.parent_id]), [['M01', 'existing-parent']]);
  assert.equal(h.store.list()[0].draft.stories.find(s => s.key === 'M02').disposition, 'deferred');
  assert.equal(h.remote.bugs.length, 0);
});
```

endToEndHarness在本测试实现，以Task 1脱敏协议fixture经runner进入真实读取器；不是伪造整个工作流结果。
- [ ] 补充完整失败链路：文档变更、未读素材、循环依赖、创建未知、持久化失败、重启恢复、重复发文档、跨项目绑定、已有单差异、其他人点击、markdown注入；全套 `npm test`，检查真实退出码，不用管道掩盖失败。
- [ ] 独立审查聚焦并发状态、权限、密钥、无重复创建、来源遗漏和旧功能回归；必须检查真实diff，不只接受审查代理总结。
- [ ] 更新现有runbook：配置需求字段的来源、显式触发/修改命令、素材说明/排除、父单绑定、未知状态核对、停止/重启自测实例的方法、回滚代码时台账必须保留。不要修改旧章节无关内容。
- [ ] 只读运行实际《勋章挑战系统》，核实resource清单、已有父单和10张子单内容比较、常驻服务身份可读；输出预览，不建单。
- [ ] 请求用户批准具体自测workspace、父单新建或绑定、最大创建数量、测试标题及清理方式。未批准则停在“离线和只读验证完成，真实创建未验证”。不得把既有缺陷测试的授权延伸到需求写入。
- [ ] 获批后启动独立自测实例，在真实飞书客户端使用：触发、分页、改稿、旧卡拒绝、审批、创建结果、部分失败恢复。能通过浏览器访问时同时核对TAPD页面；不可操作真实客户端时明确报告尚未验证，不能只以卡片JSON通过宣称UI完成。
- [ ] 读取真实TAPD父子关系、类型/迭代/负责人和渲染格式。测试单清理由用户决定，不自动删除。不动生产配置或服务。
- [ ] 使用verification-before-completion技能确认实际测试输出和验证范围；按用户授权处理提交/推送。最终报告区分已测试、未测试、待上线授权。

## 2. 顺序与依赖

执行顺序：Task 1 → Tasks 2/3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10 → Task 11 → Task 12。

Tasks 2/3可并行；Tasks 5/7在Task 1通过后可分派独立人员，但统一数据契约不可各自改名。其余按顺序，避免审核协调器、运行时和共享测试同时被不同实现者修改。

每个实现任务按列出的行为逐条进行2–5分钟级RED→GREEN循环，不一次写完测试再一次写全部实现。每任务完成后检查实际diff并自审，提交必须遵守当前用户授权。

## 3. 规格覆盖自检

| 规格要求 | 实施任务 |
| --- | --- |
| 显式触发/项目选择/线程编辑 | 2、10、11 |
| 完整来源/图片表格/视频人工处理 | 1、5、6 |
| 来源重检含独立素材变化 | 5、8 |
| 功能粒度/状态归并/覆盖/不造规则 | 4、6 |
| 分页/审核/身份/版本/子集 | 4、9、10 |
| TAPD原生父子/类型/模板 | 1、7、8 |
| 旧父单和子单正文比较 | 7、10、12 |
| 持久化/未知结果/部分恢复 | 3、8、10 |
| 重操作共享槽/非阻塞轮询 | 10、11 |
| 凭据/不可信输入/安全富文本 | 2、5、6、7、9、11 |
| 不影响旧排查/缺陷功能 | 2、7、11、12 |
| 真实自测和生产授权边界 | 1、12 |

## 4. 外部契约核实记录

计划编写时已确认：GET /stories读取示例及父子关系成功；docs +fetch返回revision、content、reference_map。需求创建、完整素材提取及卡片新增交互的契约尚未实测，本计划不声称已通过。

Task 1执行时仅在此追加核实证据（官方方法/路径/字段、调用身份、脱敏响应结构、分页/限制），再落实相应适配器。若契约无法满足规格，停下调整方案，不在实现中用猜测补齐。此段是明确的前置验证门禁，不授权远端写入。
