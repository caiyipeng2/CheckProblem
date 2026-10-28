# CheckProblem 运行手册

本手册写给需要让服务持续运行的人。服务以登录用户本人的飞书身份（`lark-cli api … --as user`）默认每 15 秒轮询一个群：消息正文含「蔡龙」或被 @蔡龙 时，服务回复该消息请群成员确认；任意成员在确认窗口（默认 10 分钟）内回复「确认」后，服务对 `repo.dir` 做一次 `git fetch`、按问题关键词本地检索、再交给模型分析，把四段式诊断回复到原消息；回复「取消」则放弃。落款为 `—— 蔡龙自动分析 · <分支>@<sha>[+未提交数] · 由 <确认人> 确认`，例如 `feature/Medal-Challenge@b7540c6+22`。同一时间只处理一个任务。

## 前置检查

逐项确认后再启动：

- `node -v`：输出应为 `v22` 或更高。服务是 ESM、无 npm 第三方依赖，但 `package.json` 要求 Node >= 22。
- `lark-cli auth status`：当前身份应为 `user`，且该账号是目标群成员、能读消息和发消息。服务所有飞书调用都固定 `--as user`；只有 app/bot 身份不够（app 也不在群里）。
- `codex --version`：能打印版本即可。再确认 `codex exec` 在该 Windows 用户下可用（登录态、网络、模型配额）。
- `git --version`：服务直接调用系统 `git` 做 fetch（`copy` 模式）或 clone / fetch / reset / clean（`clone` 模式）。
- `repo.dir`：当前部署是服务专用副本 `repo/Idle_Outpost`（`repo.mode` = `clone`），每轮分析前 `fetch` → `reset --hard origin/master` → `clean -fd`，**一律基于最新远端代码**；本地改动不会被保留。目录不存在时会从 `repo.url` clone（约 4 GB，30 分钟预算）。若要让服务改读某个工作副本，把 `repo.mode` 改成 `copy`（只 fetch，不动工作区）。
- `config.json`：`chatId`、`selfOpenId` 必填；首次 clone 还需要 `repo.url`；`repo.dir` 必须可写。缺 `chatId` / `selfOpenId` 时进程加载配置就会报错，不会启动。
- 首次启动（还没有状态文件时）只处理启动之后的新消息：游标在启动时播种为当前时间，启动前的群历史不会被分析。

## 启动与停止

以下命令默认在 `E:\lark-code-agent` 下执行；用绝对路径启动也可以。默认配置始终是仓库根目录的 `config.json`（由脚本位置决定，不受当前工作目录影响）。启动后应看到 `starting (once=false, dryRun=false, chat=oc_...)`，随后约每 15 秒轮询一次，正常轮询不写日志。

常驻运行：

```bash
node bin/checkproblem.js
```

单轮运行：

```bash
node bin/checkproblem.js --once
```

只跑一轮就退出。正常退出码为 0——注意**单轮内的 tick 失败（网络、超时等）也只写日志，退出码仍是 0**，要确认这一轮是否真的成功得看日志；缺 scope 或启动期致命错误才是 1。若这一轮发现了触发消息，服务会发出确认提示并把 `awaiting` 任务写进 `state/state.json` 后退出——要完成「确认 → 分析」，需要常驻进程继续处理，或在成员回复「确认」后再执行一次 `--once`。

试运行：

```bash
node bin/checkproblem.js --once --dry-run
```

会真实调用飞书读取当前页消息，但所有回复和发消息都被拦下，只在日志里写 `[dry-run] reply …` / `[dry-run] send …`，不会发到群里。注意它仍有副作用：会推进 `state/state.json` 的游标；如果这一轮遇到触发词，还会留下一个 `awaiting` 任务。用它验证完连通性后，正式启动前建议停服并删除 `state/state.json`，否则这些消息会被当成已处理；那个残留任务在正式启动后还可能补发超时通知，或被群里的「确认」直接触发。

指定另一份配置：

```bash
node bin/checkproblem.js --config D:\path\config.local.json
```

`--config` 的相对路径按当前工作目录解析。`state/`、`logs/` 以及相对的 `repo.dir` 都相对于**配置文件所在目录**解析，不跟代码目录走。

停止：

- 前台运行时按 Ctrl+C，或直接关闭终端窗口；也可以在任务管理器里结束对应的 `node.exe`（先确认命令行是 `bin/checkproblem.js`，不要误杀其他 node 进程）。
- 分析进行中被停掉，下次启动会向原消息回复 `上次分析中断，请重新发起`，不会自动重试。
- 同一时间只允许一个实例：启动时会在 `state/checkproblem.lock` 写自己的 pid，已有一个存活实例时新进程直接报 `another instance is already running (pid N)` 并以退出码 1 结束。异常退出留下的锁会按 pid 自动接管，不需要手工删除。

## 状态与日志

运行文件默认在 `config.json` 所在目录下，不存在会自动创建：

- `logs/app-YYYY-MM-DD.log`：每个事件一行，格式为 `ISO 时间 [级别] [模块] 消息`，同时回显到控制台。文件名日期取 **UTC**，北京时间为早上 08:00 切换文件。正常轮询不写日志，只记录启动、克隆/同步、等待确认、确认人、分析送达、超时、取消、失败、崩溃恢复等事件。启动时会自动删除 14 天前的 `app-*.log`；`logs/jobs/` 下的文件不会自动清理，需要人工归档。
- `logs/jobs/<message_id>.md`：只有在回复超过 `maxReplyChars` 被裁剪时才写，内容是未裁剪的完整分析（含落款）。文件名是被触发的那条消息的 `message_id`。回复本身没被裁剪时不会有这个文件。
- `state/state.json`：轮询游标 `lastSeen`（`createTimeMs` + `messageId`）和当前任务 `job`（`null`，或 `awaiting` / `running`，含触发消息、问题、上下文、过期时间、确认人）。写入采用临时文件 + 重命名。文件缺失或损坏时会在启动时重新播种为「当前时间」，即忽略历史消息。

内置的时间预算和固定上限：

| 项目 | 值 | 说明 |
|---|---|---|
| 轮询间隔 | 15 秒 | `pollIntervalSec`；主循环是串行的（`await` 上一轮再睡 15 秒），轮询不会重叠。分析进行期间不轮询，直到该轮结束 |
| 确认窗口 | 600 秒 | `confirmTimeoutSec`；超时后回复 `查询请求已超时，如需分析请重新发起。` |
| 子进程默认超时 | 120 秒 | 未单独指定预算的调用：lark-cli 读写、git reset/clean/rev-parse、通讯录查询 |
| git clone / fetch | 1800 秒 | 网络操作，超时按失败处理 |
| 本地预检索 | 60 秒 | 单遍 `git grep`，命中文件取前 8 个、摘要 ≤6000 字符；失败不影响分析 |
| chat 引擎 | 120 秒 | `analyze.attempts[0]`（`deepseek-flash`，公司网关）；单轮请求，实测约 8 秒。取不到 key 时直接跳过 |
| codex 快档 | 240 秒 | `analyze.attempts[1]`（`codex-fast`，low 推理）；实测在本仓库上给不出答案，仅作兜底 |
| codex 深档 | 600 秒 | `analyze.attempts[2]`（`codex-deep`）；前两个都失败才启动 |
| 消息页大小 | 50 条 | 固定值，不翻页 |
| 回复长度 | 4000 字符 | `maxReplyChars`，包含落款 |

## 常见故障

先看 `logs/app-*.log` 最后几行。群里的 `分析失败：…` 只截取错误信息前 200 字，完整原因在日志的 `analysis failed for <message_id>: …` 一行。

| 现象 | 原因 | 处理 |
|---|---|---|
| 进程退出，退出码 1；日志出现 `missing scopes: … — run lark-cli auth login --scope "<scope>"` | 用户身份缺少某个 API scope（首次部署、换租户、授权被撤销）。缺 scope 无法靠重试恢复，服务会主动退出而不是空转 | 按日志列出的 scope 逐个补授权：`lark-cli auth login --scope "<scope>"`，然后重启服务 |
| 日志持续出现 `tick failed (N in a row): …`，错误信息为 token 无效/过期、鉴权失败一类 | 用户 access token 过期或被撤销。服务不会自己重新登录，只会每轮记一条失败；连续 5 次会额外打一行告警 | 重新执行 `lark-cli auth login`（必要时带上原有 scope），观察下一轮日志；仍失败再重启服务 |
| 群里有新消息但服务毫无反应，日志只有启动行或没有新事件 | `config.json` 的 `chatId` 不是目标群；`triggerKeyword` 与消息里的写法不一致；或游标已经越过这条消息（服务停机期间收到的、且仍在新一页里的消息会在重启后被处理；超出最新 50 条的旧消息则看不到） | 核对 `chatId` 和 `triggerKeyword`；把消息时间与 `state/state.json` 的 `lastSeen.createTimeMs` 对比；停服删除 `state/state.json` 后重启（游标重置为启动时刻），再发一条含触发词的新消息 |
| 群回复 `分析失败：not a git repository: …` | `repo.dir` 指错了，或该目录还初始化 git | 核对 `config.json` 的 `repo.dir`；`copy` 模式只接受已存在的 git 工作副本 |
| 群回复 `分析失败：git fetch failed: …`（`clone` 模式） | 访问仓库失败、磁盘不足或凭据失效 | 检查网络、磁盘、`repo.url` 与 git 凭据；仓库约 4 GB，预算 30 分钟 |
| 群回复 `分析失败：所有分析引擎都失败：codex-fast: 超时（240 秒）；codex-deep: …` | 所有引擎都没能在各自预算内给出答案 | 原任务已结束，重新发起即可。频繁失败可调大 `analyze.attempts` 里的 `timeoutSec`，或换更快的模型；同时检查 codex 登录态、网络与模型配额。分析是只读的，重跑没有副作用 |
| 日志出现 `search failed: …`，但分析照常返回 | 本地 `git grep` 失败（仓库损坏、路径不对等） | 不必处理：模型会在没有线索的情况下自行检索，只是更慢、定位精度更低。反复出现且分析变慢时再查 |
| 群回复其它 `分析失败：…` | git reset/clean 失败、codex 非零退出或空输出、回复消息失败等 | 按日志中 `analysis failed for <message_id>: …` 的完整错误处理；修好后重新发触发消息（原触发消息已标记为已读，不会自动重来） |
| 任务卡住：`state/state.json` 里的 `job` 一直不为 `null`，或需要强制复位 | 进程被强杀/崩溃留下 `running` 任务；或状态文件被外部异常修改 | 先停服。普通崩溃残留直接重启即可：首轮会向原消息回复 `上次分析中断，请重新发起` 并清空 `running`。若仍卡住，删除 `state/state.json` 再启动。删除会重置游标到启动时刻：历史消息和停机期间的消息都不会重放，也不会补发中断提示，需要处理就重新发一条触发消息 |

## 修改监听群与触发词

配置在启动时读取一次，改完必须重启。`config.json` 各项及真实默认值：

| 键 | 默认值 | 说明 |
|---|---|---|
| `chatId` | 无默认，必填 | 监听群 ID（`oc_…`） |
| `selfOpenId` | 无默认，必填 | 服务账号的 open_id（`ou_…`）；该账号自己发的消息不参与触发。必须与 `lark-cli` 登录账号一致，否则服务可能把自己带「蔡龙」的回复当成新提问 |
| `triggerKeyword` | `"蔡龙"` | 正文包含该词，或 @ 提及的显示名包含该词即触发；空字符串等于关闭触发 |
| `confirmTimeoutSec` | `600` | 确认窗口，秒 |
| `pollIntervalSec` | `15` | 轮询间隔，秒 |
| `contextMessages` | `5` | 随问题一起交给 codex 的前置消息条数（同一页内，每条截 200 字） |
| `maxReplyChars` | `4000` | 回复总长上限（含落款）；超出时截断正文，完整版存 `logs/jobs/` |
| `repo.mode` | `"clone"` | `clone` = 服务专用副本，每轮 reset --hard / clean -fd 到最新远端；`copy` = 只 fetch 并读工作副本，不动工作区 |
| `repo.dir` | 无默认；当前为 `repo/Idle_Outpost` | 被分析的目录；相对路径按配置文件目录解析 |
| `repo.url` | 无默认 | 仓库地址，`clone` 模式首次使用 |
| `repo.branch` | `"master"` | `clone` 模式的同步分支；`copy` 模式取工作副本当前分支 |
| `analyze.attempts` | 见下 | 按顺序尝试的分析引擎，每个有自己的预算 |

`analyze.attempts` 的默认值：

```json
[
  { "label": "deepseek-flash", "kind": "chat", "baseUrl": "http://192.168.11.66:8080", "model": "deepseek-flash", "apiKeyFile": "C:/Users/EDY/.checkproblem/deepseek.key", "timeoutSec": 120 },
  { "label": "codex-fast", "command": "codex", "model": "gpt-5.6-luna", "reasoningEffort": "low", "timeoutSec": 240 },
  { "label": "codex-deep", "command": "codex", "timeoutSec": 600 }
]
```

每个引擎两项必填：`label` 和 `timeoutSec`。`kind` 缺省是 `codex`（走 `codex exec`，可用 `command` / `model` / `reasoningEffort` / `extraArgs` 调参）；`kind: "chat"` 走单轮 `POST {baseUrl}/chat/completions`，用 `baseUrl`、`model`、以及凭据二选一：`apiKeyEnv`（环境变量名，默认 `DEEPSEEK_API_KEY`）或 `apiKeyFile`（一行纯文本的 key 文件路径，环境变量优先）。推荐用 key 文件：`mkdir -p ~/.checkproblem` 后把 key 写进 `~/.checkproblem/deepseek.key`（一行；若写成 `key：xxx` 形式，前缀会被自动去掉）。key 不会进仓库，也不会出现在日志里。

**数据外发**：`kind: "chat"` 会把「问题 + 检索命中的代码片段」发到你配置的接口。配置的是公网服务时，等于把这段源码发出去——请确认可接受，或改指向公司内部网关。

第一个引擎超时或失败后立刻尝试下一个，回复里不区分来源，但日志会记录实际使用的是哪个引擎。
| `dryRun` | `false` | 为 `true` 时等价于命令行加 `--dry-run` |

几点注意：

- 确认提示里的「10 分钟内」是固定文案：改 `confirmTimeoutSec` 只改实际超时窗口，提示语仍写 10 分钟。落款中的分支与提交来自实际分析的对象，不需要也不应该手改。
- 触发词按子串匹配；@ 触发的依据是消息 `mentions` 里的显示名，正文此时是 `@_user_xxx` 占位符。
- 更换 `chatId` 前先停服并处理 `state/state.json`（删除，或手工把 `job` 置为 `null`），避免旧群的待确认任务跟到新群。
- `chatId` 或 `selfOpenId` 缺失/为空时，加载配置直接报错（如 `config: chatId is required`），进程不会启动。
- 用 `--config` 指向另一份文件时，`state/`、`logs/` 和相对的 `repo.dir` 都会跟着那份文件所在目录走。

## 仓库安全

两种模式的行为差别必须分清：

- `copy`（备用模式）：只执行 `git -C <dir> fetch --prune origin`，随后 `rev-parse` 与 `status --porcelain` 只读查询。**不 reset、不 clean、不 checkout、不切换分支**，工作副本里的未提交改动不会被碰到，并且会参与分析、在落款里记为 `+<数量>`。fetch 失败只记一条 warn，分析照常进行（读的是磁盘上的文件）。
- `clone`（当前部署）：服务专用的副本，每轮 `fetch` → `reset --hard origin/<branch>` → `clean -fd`。`reset --hard` 会丢弃该副本上的本地提交与未提交修改，`clean -fd` 会删除未跟踪文件（不加 `-x`，被忽略的构建产物保留）。**绝不能把 `clone` 模式的 `repo.dir` 指向开发工作副本。**

通用约束：

- 服务从不 push，也不会碰 `repo.dir` 之外的项目目录（运行时另写 `logs/` 和 `state/`）。
- 分析引擎本身不写仓库：`codex` 以 `-s read-only` 运行，`kind: chat` 的引擎只收到检索出的代码片段文本。
- `repo.dir` 必须是一个 git 仓库；不是时启动后第一次分析会报 `not a git repository: …`。
- 想让服务改看某个工作副本（含未提交改动），把 `repo.mode` 改成 `copy` 并把 `repo.dir` 指向它；那样落款会带 `+<未提交数>`。

## 开机自启

**只有在负责人明确同意后才能安装。** 未经同意不要执行下面的 `schtasks` 命令。

在 cmd.exe 中执行（PowerShell 的引号转义规则不同，不要直接粘贴）：

```bat
schtasks /Create /TN "CheckProblem" /TR "node \"E:\lark-code-agent\bin\checkproblem.js\"" /SC ONLOGON /RL LIMITED /F
```

查询/验证：

```bat
schtasks /Query /TN "CheckProblem" /V /FO LIST
```

删除：

```bat
schtasks /Delete /TN "CheckProblem" /F
```

注意：

- 触发器是登录时（`ONLOGON`），任务运行在当前用户的登录会话里。机器必须有人登录，服务才会起来；锁屏不影响，注销或重启后需要重新登录。服务器重启后如果没人登录，服务不会运行。
- `lark-cli` 的凭据存放在用户配置目录（`%USERPROFILE%`）里。必须用执行过 `lark-cli auth login` 的同一个 Windows 账号安装和运行；换账号会读不到凭据。
- `/TR` 里写的是 `node`，没有绝对路径，所以 `node` 必须在计划任务用户的 `PATH` 中。
- 计划任务只负责拉起，没有配置失败重启；进程异常退出后不会自动恢复，需要手动启动或重新登录。
- 不要再手动启动一个实例，避免双实例共用状态文件。

## 已知限制

- 机器人无法加入该群，`im +…` 快捷命令所需的 `im:message.reactions:read` 在本租户也无法授予。服务只能用个人身份调原始 API，确认只能靠群成员文字回复（`确认` / `取消`，另接受 `同意`、`开始`、`1` / `忽略`、`不用` 等少量同义词），没有卡片按钮。
- 服务账号自己发的消息不会触发（否则它自己的分析回复里含「蔡龙」，会自问自答）。所以**你自己在群里发「蔡龙 …」不会生效**，需要另一位群成员发这条提问。
- 同一时间只处理一个任务：等待确认期间，新的「蔡龙」提问会收到「已有查询待确认，请先确认或取消。」的提示，不会排队；分析进行中到达的提问会在本轮结束后由下一次轮询处理（同理只处理最新一页）。
- 两次轮询之间如果冒出超过约 50 条消息，触发消息可能已经不在最新一页（固定 50 条、不翻页）；游标会推进到已读到的最新消息，这条提问就被漏掉。轮询是串行的：一次分析期间（最长为主引擎 + 备用引擎的预算之和）完全不轮询，所以真正的「漏消息窗口」是这次分析加上前后各一个轮询间隔，而不是 15 秒。
- 预检索靠问句里的 ASCII 标识符（如 `reward_1001`）和中文二元组。中文没有分词，问题描述越笼统（「奖励没到」），线索越散；把出问题的接口名、配置键、报错文本写进提问，命中率会明显提高。
- 分析是只读的：`copy` 模式只 fetch，`clone` 模式只有 git 同步会写仓库；模型本身拿不到写权限。
- 游标跨重启保留：服务停机期间群里的消息不会丢，重启后凡是仍在最新 50 条内的，会照常触发（可能补发一次确认提示）。要避免这种补发，停服删除 `state/state.json`，重启后只处理启动之后的消息。
