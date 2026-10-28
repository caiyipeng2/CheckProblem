# CheckProblem

飞书群「蔡龙」提问分析助手：轮询指定群聊，发现包含「蔡龙」的提问后请群成员确认，随后同步 Idle_Outpost 仓库并用 `codex exec` 结合最新代码给出分析回复。

当前实现为项目骨架：配置加载与按天文件日志。飞书接入、仓库同步与 codex 调用在后续任务实现。

## 环境

- Node.js >= 22
- ESM，无第三方依赖

## 测试

```bash
npm test
```

等价于 `node --test`（自动发现 `test/` 下的测试文件）。

## 配置

根目录 `config.json` 为运行配置。`chatId` 与 `selfOpenId` 必填，缺失或为空时 `loadConfig` 会报错；其余字段由 `src/config.js` 中的默认值补齐。

`repo.dir` 以及运行时路径 `paths.stateFile`、`paths.logDir`、`paths.jobsDir` 均相对于配置文件所在目录解析为绝对路径。

## 目录

- `src/config.js` — 读取配置、校验必填项、合并默认值并解析路径
- `src/logger.js` — 创建日志目录并写入 `logs/app-YYYY-MM-DD.log`
- `test/` — 基于 `node:test` 的单元测试
