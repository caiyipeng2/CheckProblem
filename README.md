# CheckProblem

飞书群「蔡龙」提问分析助手：以登录用户本人的飞书身份轮询指定群，发现包含「蔡龙」或被 @蔡龙 的提问后请群成员确认，确认后同步 Idle_Outpost 仓库并用 `codex exec` 结合最新代码给出分析。

## 工作方式

- 默认每 15 秒读取目标群最新一页消息；正文含「蔡龙」或 mention 显示名含「蔡龙」即触发（服务账号自己发的消息除外）。
- 服务回复原消息，请任意群成员在 10 分钟内回复「确认」开始分析，回复「取消」放弃。
- 确认后把 `repo/Idle_Outpost` 同步到 `master` 最新，再以只读沙箱运行 `codex exec`，回复【结论】【定位】【依据】【建议】和落款 `—— 蔡龙自动分析 · master@<sha> · 由 <确认人> 确认`。
- 同一时间只处理一个任务。分析中被杀留下的 `running` 任务不会重跑，下次启动会在原消息说明「上次分析中断，请重新发起」。

## 架构

入口 `bin/checkproblem.js` 只做参数解析与依赖装配；`src/` 按职责分层：`config.js` 读取配置、校验必填项并解析路径，`logger.js` 写按天文件日志，`lark.js` 封装全部 `lark-cli api … --as user` 调用（拉消息、回复、查显示名），`trigger.js` 判定触发词与确认/取消并比较消息游标，`index.js` 是轮询状态机（确认、超时、单任务、崩溃恢复），`state.js` 持久化 `state/state.json`（临时文件 + 重命名），`repo.js` 维护专用 clone（clone / fetch / reset / clean），`analyze.js` 组装提示词、执行 `codex exec -s read-only` 并清洗输出，`reply.js` 管理固定提示语、结果落款与裁剪，`runner.js` 是所有子进程的唯一出口（参数转义、超时、整棵进程树终止）。

## 快速开始

需要 Node.js >= 22、已登录的 `lark-cli`（用户身份）和可用的 `codex`。npm 依赖为零，不需要 `npm install`。

```bash
npm test
node bin/checkproblem.js --once --dry-run
node bin/checkproblem.js
```

第一条跑测试；第二条真实轮询一次飞书但不发任何消息，用来确认身份、群和触发词；第三条正式常驻。`--once` 只跑一轮，`--config <path>` 可换配置文件。

## 运行手册

部署前置、启动与停止、日志与状态、故障处理、改监听群与触发词、仓库安全和开机自启见 [docs/runbook.md](docs/runbook.md)。

## 已知限制

- 机器人无法加入该群（租户拿不到所需授权 scope），确认只能靠群成员文字回复「确认」/「取消」，没有卡片按钮。
- 同一时间只处理一个任务；等待确认期间，新的「蔡龙」提问会收到「已有查询待确认」的提示，不会排队；分析进行中到达的提问会在本轮结束后由下一次轮询处理。
- 两次轮询之间超过约 50 条消息时，触发消息可能已不在最新一页而被漏掉。
- 分析是只读的，只检索代码，不会修改 clone。
