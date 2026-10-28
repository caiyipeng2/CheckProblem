# lark-cli 实测输出形状

实测环境：lark-cli 1.0.98，身份 `--as user`，账号 蔡逸鹏。
本文件只记录字段名与类型，不含真实消息内容与人名。

## 0. 关键结论：走原始 API，不走 `im +*` 快捷命令

`im +chat-messages-list` 与 `im +messages-search` 在 1.0.98 下**即使传了 `--no-reactions`** 也仍然静态要求
`im:message.reactions:read`，本租户该 scope 无法授予（授权页返回 `newly_granted: []`）。

错误形状：

```json
{
  "ok": false,
  "identity": "user",
  "error": {
    "type": "authorization",
    "subtype": "missing_scope",
    "message": "missing required scope(s): im:message.reactions:read",
    "missing_scopes": ["im:message.reactions:read"],
    "identity": "user"
  }
}
```

原始 API 通道不需要该 scope（读用 `im:message:readonly` / `im:message.group_msg:get_as_user`，回复用 `im:message`），
因此服务一律使用 `lark-cli api`。

**Git Bash 路径陷阱：** `lark-cli api GET /open-apis/im/v1/messages` 在 Git Bash 下会被 MSYS 转换成
`/open-apis/D:/Git/Git/open-apis/im/v1/messages`，返回 `404 page not found`。交互式调用需加 `MSYS_NO_PATHCONV=1`。
从 Node 用 `spawn` + 参数数组调用时不受影响。

## 1. 统一信封

成功：

```json
{ "ok": true, "identity": "user", "data": { } }
```

失败：

```json
{ "ok": false, "identity": "user", "error": { "type": "string", "subtype": "string", "code": 0, "message": "string" } }
```

进程退出码：成功 0，失败 3。

## 2. 拉取群消息

请求（路径不带 `/open-apis` 前缀时 CLI 会自动补，带了就原样使用；从 Node 调用统一写完整路径）：

```
lark-cli api GET /open-apis/im/v1/messages \
  --params '{"container_id_type":"chat","container_id":"<chat_id>","page_size":20,"sort_type":"ByCreateTimeDesc"}' \
  --as user --json
```

`sort_type`：`ByCreateTimeAsc` / `ByCreateTimeDesc`。

响应 `data`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `items` | array | 消息列表 |
| `has_more` | boolean | 是否还有下一页 |
| `page_token` | string | 下一页游标 |

`items[]` 元素：

| 字段 | 类型 | 说明 |
|---|---|---|
| `message_id` | string | `om_xxx` |
| `msg_type` | string | 实测出现 `text` / `file` / `system`；其余可能 `post` / `image` / `audio` / `video` / `interactive` / `sticker` |
| `create_time` | string | **毫秒时间戳字符串**（如 `"1793162767785"`），不是 `HH:MM:SS` |
| `update_time` | string | 同上 |
| `deleted` | boolean | 是否已撤回 |
| `updated` | boolean | 是否被编辑过 |
| `chat_id` | string | `oc_xxx` |
| `chat_type` | string | `group` / `p2p` |
| `chat_default_name` | string | 群名 |
| `parent_id` | string | 父消息（回复关系），顶层消息为空串 |
| `root_id` | string | 话题根消息，顶层消息为空串 |
| `message_position` | string | 群内序号 |
| `body.content` | string | **JSON 字符串**，需二次 `JSON.parse` |
| `sender` | object | 见下 |

`sender` 三种形态（实测）：

```json
{ "id": "ou_xxx", "id_type": "open_id", "sender_type": "user", "tenant_key": "..." }
{ "id": "cli_xxx", "id_type": "app_id", "sender_type": "app", "tenant_key": "..." }
{ "id": "", "id_type": "", "sender_type": "", "tenant_key": "" }
```

第三种是 `msg_type: "system"` 的系统消息。**没有 `name` 字段**，需要显示名时另调通讯录。

`body.content` 按 `msg_type` 反序列化后的形状：

```json
// text
{ "text": "字符串" }
// file
{ "file_key": "file_v3_xxx", "file_name": "字符串" }
// system
{ "template": "字符串", "from_user": ["字符串"], "to_chatters": ["字符串"], "divider_text": {} }
```

### mentions

Lark 文档中 `items[]` 可含顶层 `mentions` 数组（本租户暂未采集到样本，未实测）：

```json
[{ "key": "@_user_1", "id": { "open_id": "ou_xxx" }, "name": "显示名", "tenant_key": "..." }]
```

含 @ 的 text 正文里该位置被替换为 `@_user_1` 之类的占位符，**不会出现人名原文**。
因此触发判定必须同时接受「正文含关键词」与「`mentions` 中某项 `name` 含关键词」两种证据。

## 3. 回复消息

请求：

```
lark-cli api POST /open-apis/im/v1/messages/<message_id>/reply \
  --data '{"content":"{\"text\":\"正文\"}","msg_type":"text"}' \
  --as user --json
```

`content` 是 **JSON 字符串**，不是对象。仅 `--dry-run` 验证过请求体，未真实发送。

成功响应（Lark 文档形状，未实测）：

```json
{ "ok": true, "identity": "user", "data": { "message_id": "om_xxx", "chat_id": "oc_xxx", "create_time": "..." } }
```

## 4. 发消息到群

```
lark-cli api POST /open-apis/im/v1/messages \
  --params '{"receive_id_type":"chat_id"}' \
  --data '{"receive_id":"oc_xxx","msg_type":"text","content":"{\"text\":\"正文\"}"}' \
  --as user --json
```

仅按文档整理，未实测。

## 5. 通讯录：open_id 反查姓名

```
lark-cli contact +get-user --user-id ou_xxx --as user --json
```

```json
{
  "ok": true,
  "identity": "user",
  "data": { "user": { "name": "显示名", "user_id": "ou_xxx", "i18n_name": { "zh_cn": "显示名", "en_us": "", "ja_jp": "" } } }
}
```

`data.user.name` 可直接用作确认人显示名。该命令不受 reactions scope 门禁影响。
