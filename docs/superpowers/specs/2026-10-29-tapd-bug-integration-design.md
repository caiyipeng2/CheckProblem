# 蔡龙 → TAPD 缺陷单接入 — 设计文档

日期：2026-10-29 ｜ 状态：待评审 ｜ 关联：`docs/superpowers/specs/2026-10-28-lark-code-agent-design.md`

## 1. 背景与目标

蔡龙服务在群里完成一次代码排查后，结论目前只落在群回复里，需要人工再抄一遍到 TAPD 建单。
目标是把「已完成的查询」一键变成一张符合团队模板的 TAPD 缺陷单：操作员在完成态卡片上按
「提交 TAPD 缺陷单」，服务用分析结果拼出标题与描述，按固定字段建单，并把单号链接回填到卡片。

约束继承上一轮的决策：卡片按钮手动提交（不自动建单）、每个游戏项目对应一个 TAPD workspace、
标题 = `[项目]` + 结论首句、截图不上传只留飞书线索。本轮按用户给的模板把描述拆成固定小节。

## 2. 不做什么（v1 范围外）

- 不做自动建单：只有人按按钮才写 TAPD。
- v1 不改单：更新与状态流转接口实测可用，但蔡龙只建一次单，后续流转留给测试同学；
  需要「重复点击改覆盖」时再加（见 §6 的幂等取舍）。
- 不删单：TAPD OpenAPI 没有删除缺陷接口，个人令牌也没有 `bugs::delete`。误提的单只能在页面上删，
  或由服务把状态流转成 `rejected` 作废。
- 不上传截图，不做图片附件接口。
- 不做齿轮（Idle_Gear_Defence）：它在另一个令牌下，等令牌到位再按同一配置结构加一条。
- 不做群消息 → 缺陷单的其他入口（如「取消」态、「超时」态不出现按钮）。

## 3. 本轮已验证的 TAPD 事实

全部来自对 workspace `59180547`（武器店）的真实调用，令牌是「个人访问令牌」，以
`Authorization: Bearer <token>` 发送，表单 `application/x-www-form-urlencoded`。

| 事实 | 结论 |
| --- | --- |
| `POST /bugs` 建单 | 成功，`{"status":1,"info":"success"}`，返回 `data.Bug.id` |
| `POST /bugs` 带 `id` | **就是更新**（官方「更新缺陷」接口）。实测 `modified` 前进、`id`/`created` 不变 |
| 更新时状态流转 | `id + status=rejected + resolution=duplicated` 成功，`new → rejected` |
| `POST /bugs` 带 `bugid` | 参数名不对时按新建处理：`bugid` 被忽略，落库成一张新单 |
| `/bugs/update`、`/bugs/delete` | 403 `bugs::update` / `bugs::delete`。`/bugs/update` 不是官方更新路径（官方就是 `POST /bugs` + `id`）；缺陷章节的官方文档里没有删除接口，只有 `delete_link_bugs`（取消关联） |
| `GET /bugs`、`/bugs/get_fields_lable`、`/bugs/get_fields_info` | 可用 |
| `GET /versions` | 403 `versions::_get`，版本列表读不到，版本名只能写在配置里 |
| `GET /workspaces/user_participant_projects` | 可用，已用它拿到各项目 workspace id |
| `GET /workspaces/projects?company_id=` | 403，公司级接口对个人令牌不开放（`api account tapd_my_token not allowed to access project`） |
| 缺陷详情链接 | `https://www.tapd.cn/tapd_fe/{workspace_id}/bug/detail/{bug_id}` 返回 200；`GET /bugs` 不返回 url 字段，链接由我们自己拼 |
| 换行 | `description` 里 `\n` 原样存取，无需 HTML |
| 人员字段 | 传昵称，分号结尾：`current_owner=小鱼;`、`te=蔡逸鹏;`、`cc=南柯;` 均写入成功 |

403 的两类语义要分清，否则会被误导：

- `api account tapd_my_token not allowed to access project …` —— 令牌的项目授权范围问题。
- `user <uid> doesn't have permission <资源>::<动作> of workspace …` —— 你这个账号在该项目的角色权限问题。
  个人访问令牌没有独立权限开关，它就是你账号的权限投影。实测结论：建单、更新、状态流转都有权限；
  `versions::*` 与 `bugs::delete` 没有（后者 TAPD 也没开放接口）。
- 踩过的坑：任何 `<资源>/<未知子路径>` 都会被网关拼出一个 `<资源>::<动作>` 权限名并报 403，
  看起来像「没权限」，其实可能只是路径不存在。判断接口是否存在以官方文档为准，别拿 403 反推。


字段映射以 `get_fields_info`（含本项目候选值）为准，之前根据 UI 猜的 `baseline_find` 是错的：

| 模板项 | API 字段 | 本项目候选值 / 实测 |
| --- | --- | --- |
| 发现版本 | `version_report` | `每周迭代版本` / `上线前冒烟优化版本`（没有叫「最新版本」的选项） |
| 使用机型 | `os`（UI 标签是「操作系统」） | 自由文本可写入，已验证 `线上安卓` |
| 测试人员 | `te` | `蔡逸鹏;` |
| 处理人 | `current_owner` | `小鱼;`（UI 显示「小鱼（余腾）」） |
| 抄送人 | `cc` | `南柯;` |
| 严重程度 | `severity` | `fatal\|serious\|normal\|prompt\|advice` |
| 优先级 | `priority` | `urgent\|high\|medium\|low\|insignificant` |
| 重现规律 | `frequency` | `必现` / `偶现` |
| 模块 | `module` | `优化模块` / `缺陷模块` |
| 标题 / 描述 | `title` / `description` | 必填 / 富文本 |

近 400 条缺陷里出现过的昵称：蔡逸鹏、刘子康、南柯、曾诚、刘学、潘永泽、胡勇杰、段熠璇、乐成、
余峰、宋谷若、小鱼、祝炜锋、张佳欢、邵冲、魏翔、史力数、高韩。**没有「丁可」**，见 §10。

## 4. 建单内容模板

分析输出已有固定四段（`src/analyze.js` 的输出契约）：【结论】【定位】【依据】【建议】。
描述按用户模板拼装，小节标签用中文方括号，纯文本换行：

```
【问题描述】
<群里原始问题原文（job.question）>

【操作步骤】
1. <模型给出的复现步骤>
2. ...

【预期结果】
正常

【实际结果】
<群里原始问题原文>
（另有 N 张截图，见飞书群 <triggerMessageId>，本单不附带图片）

【蔡龙自动分析】
结论：<【结论】原文>
定位：<【定位】原文>
依据：<【依据】原文>
建议：<【建议】原文>
—— 蔡龙自动分析 · <provenance> · 由 <confirmer> 确认
```

标题：`[<项目名>] <【结论】首句>`，首句按第一个 `。`/`；`/换行截断，整体不超过 100 字。

「操作步骤」目前不是模型输出的一部分。方案是给 `buildPrompt` 增加第五段【复现】（最多 2 步、
每步一行、写玩家/策划能照做的动作），群回复一并显示。代价是群回复多一行；收益是复现步骤由
模型基于真实证据给出，而不是服务端从「建议」里硬编。备选：模板里把【建议】当操作步骤写，
零提示词改动，但「建议」是给程序的动作，放进「操作步骤」会误导测试同学——不采用。

截图说明：飞书没有可编程获取「消息分享链接」的接口，`image_key` 对 TAPD 也无意义，所以
【实际结果】只留群消息 ID 与张数，不写假链接。

## 5. 架构

```
卡片(完成态) --tapd 按钮--> card-events --> engine.enqueueCardAction
                                                |
                                     state.reports 命中 requestId
                                                |
                                    tapd.buildBugPayload(report, config)
                                                |
                                     tapd.createBug() --fetch--> api.tapd.cn
                                                |
                              report.tapd = {status, bugId, url}  --> 重新 PATCH 卡片
```

新增/改动模块：

- `src/tapd.js`（新）
  - `buildBugPayload({ report, entry, fields })`：纯函数，输出 `URLSearchParams` 形状的表单对象。
  - `bugUrl(workspaceId, bugId)`：纯函数，拼详情链接。
  - `createTapdClient({ tokenFile, baseUrl, request, log, timeoutMs })`：`request` 注入（默认 `globalThis.fetch`），
    每次调用才从 `tokenFile` 读令牌，不落日志、不进错误消息；非 `https://` 的 baseUrl 直接拒绝。
- `src/analyze.js`：输出契约加【复现】段。
- `src/cards.js`：完成态多一个 `tapd` 按钮 + 一行提单状态/链接；未配置 workspace 的项目不渲染按钮。
- `src/card-requests.js`：`finish(job,'completed')` 把完成态快照写入 `state.reports`（保留最近 20 条）；
  `enqueue` 允许 `action==='tapd'` 命中 `state.reports`；`processPending` 处理提单事件。
- `src/config.js`：解析 `tapd` 段并校验。

`state.reports` 的条目就是完成态 job 的快照（含 `requestId`、`revision`、`question`、`analysis`、
`provenance`、`confirmer`、`images`、`promptMessageId`、`projectId`、`branch`）再加 `tapd` 子对象。
`src/state.js` 的 `loadState` 已经把未识别字段原样带出，新增 `reports` 数组只需要在读取时做一次
类型兜底（非数组则丢弃），不需要版本升级。

## 6. 幂等与时序

TAPD 侧没有幂等键，OpenAPI 又没有删除缺陷接口，**重复建单只能人工去页面上删**，所以按「一次点击一个
revision」处理：

1. 点击 → `enqueue` 校验 `action.revision === report.revision`，不匹配直接丢弃（旧卡片版本已失效）。
2. 先把 `report.tapd = { status:'submitting' }` 并 `report.revision += 1` 落盘，再发请求。
   这一步之后旧 revision 的卡片值不再被接受，同一张卡片连点两次只会成功进入一次。
3. 成功 → `report.tapd = { status:'done', bugId, url, at }`；失败 → `{ status:'failed', error }`。
4. 失败与完成都重新 PATCH 卡片；PATCH 失败沿用现有 `state.cardUpdates` 重试队列。
5. 重启后仍停在 `submitting` 的条目：卡片显示「提交状态未知，请先在 TAPD 确认，避免重复建单」，
   按钮保持禁用。这是诚实的取舍——宁可让人多看一眼，也不自动补发第二张单。

## 7. 配置

```jsonc
"tapd": {
  "tokenFile": "C:/Users/EDY/.checkproblem/tapd.token",
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
    "digit":  { "workspaceId": "52360842", "fields": { "versionReport": "版本1" } },
    "gear":   { "workspaceId": "<待补>", "tokenFile": "C:/Users/EDY/.checkproblem/tapd-gear.token" }
  }
}
```

workspace id 由 `GET /workspaces/user_participant_projects` 实测得到：武器店 `59180547`、
数字门 `52360842`（该账号还看得到军营 32241144、原始人 41963983、瘦身 48678814、矿场 63366884，
齿轮不在其中，符合「另一个令牌」）。数字门的 `get_fields_info` 字段名与武器店一致，但发现版本候选
只有占位的 `版本1`，所以版本名按项目覆盖。

- `tapd` 缺失或 `workspaces` 为空 → 功能整体关闭，卡片不出现按钮，行为与现在完全一致。
- `workspaces` 的 key 必须是已配置的项目 id；`workspaceId` 必须是纯数字串；`fields` 可按项目覆盖。
- 齿轮换令牌靠的是项目级 `tokenFile` 覆盖，不再往同一个令牌上加权限。
- `config.json` 在 `.gitignore` 里（`state/` 也是），令牌路径只出现在私有配置，仓库只存示例。

## 8. 安全

- 令牌只从文件读，绝不写日志、不进 argv、不进错误消息、不回显到卡片；`createTapdClient` 抛出的
  错误信息统一脱敏掉 header。
- 描述内容全部来自群消息与模型输出：属于不可信文本，但走 `fetch` + `URLSearchParams` 表单编码，
  不经过 cmd.exe，与 `src/runner.js` 的引号地狱无关。仍做长度上限（描述 ≤ 6000 字，标题 ≤ 100 字）。
- 只允许 `https://api.tapd.cn` 前缀的 baseUrl；请求带 `AbortSignal.timeout`（默认 15 秒），
  超时按失败处理，避免拖住 poll tick。
- 人员/版本字段值来自配置而非群消息，操作员无法通过消息内容指定收件人。

## 9. 失败处理

| 情况 | 表现 |
| --- | --- |
| 令牌文件缺失/为空 | 卡片显示「TAPD 未配置：令牌文件缺失」，不重试 |
| `status:0` 带 `info` | `failed` + 截断后的 `info`（例如昵称不存在） |
| HTTP 非 2xx / 网络异常 / 超时 | `failed` + 简短原因，按钮可再按（revision 已在提交时消耗，所以按钮按下后卡片刷新为「重试提交」的新 revision） |
| PATCH 卡片失败 | 进 `state.cardUpdates` 重试，单已建成功，不回滚 |
| 项目没有 workspace 映射 | 不渲染按钮 |

## 10. 待确认（不阻塞开发，先按默认值实现）

1. 「发现版本：最新版本」——本项目只有 `每周迭代版本` / `上线前冒烟优化版本` 两个选项，且
   `GET /versions` 无权限，无法程序化取「最新」。默认写 `每周迭代版本`，要改只需改配置。
2. 「使用机型」按 `os` 落。请在 TAPD 里打开测试单 `1159180547001002352` 确认「线上安卓」是不是
   显示在「使用机型」框里。
3. 「丁可」在近 400 条缺陷的昵称里查不到，默认抄送只用 `南柯;`；要加丁可请给准确昵称。
4. 自测单收尾：`...002351`、`...002352` 你已经在页面上删掉了；验证更新通路新建的 `...002353`
   已经用接口流转成 `rejected`（解决方法 duplicated），它只能由你在页面上删——TAPD 没有删除缺陷接口。

## 11. 测试计划

延续「所有副作用注入、离线可测」的做法：

- `test/tapd.test.js`：`buildBugPayload` 的标题截断、描述分节拼装、缺字段兜底、不可信文本不破坏
  表单；`bugUrl` 拼接；client 用假 `request` 断言 header 用 Bearer、body 是表单编码、令牌不出现在
  任何日志/错误里、非 https 拒绝、超时按失败。
- `test/cards.test.js`：完成态出现 `tapd` 按钮、未配置时不出现、已提单后显示链接、卡片体积仍 < 30 KiB。
- `test/card-requests.test.js`：`finish('completed')` 写入 `state.reports` 并只保留最近 20 条；
  `tapd` 事件的 revision 校验、连点两次只建一单、`failed` 后重试、重启后 `submitting` 不自动补发。
- `test/analyze.test.js`：输出契约新增【复现】段的提示词断言。

## 12. 上线顺序

1. 实现 + 全量 `npm test` 绿。
2. 只在自测群配置 `tapd.workspaces.weapon`，用一条真实排查结果建一张单，核对 UI 字段位置与描述渲染。
3. 核对通过后补齐 `digit`（数字门）的 workspace，再考虑齿轮令牌。
