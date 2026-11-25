# Direct Chat 引擎插件

在现有的 Direct Chat Cordis 条目里添加 `config.engineModules`，然后重新载入该配置。每个条目指向 DSH 服务端可读取的本地 ESM 文件，支持绝对路径和 `file:` URL。引擎列表会使用模块声明的名称。

```yaml
- insert:
    - id: direct-chat
      name: dsh-direct-chat
      config:
        engineModules:
          - /path/to/echo-engine.mjs
```

默认启用 `agy`、`codex` 和 `claude`。可以在同一配置中用 `engines` 指定所需的内置引擎，或传入 `engines: []` 只加载自定义引擎。

## 最小模块

将以下内容保存到配置指定的位置。这个示例会原样回复收到的文本。

```js
import { randomUUID } from 'node:crypto'

export const engine = {
  id: 'echo',
  label: 'Echo',
  async start({ resumeId, emit, signal }) {
    signal?.throwIfAborted()
    return {
      id: resumeId ?? randomUUID(),
      options: [],
      async prompt(text) {
        signal?.throwIfAborted()
        emit('update', {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        })
        return { stopReason: 'end_turn' }
      },
      async configure() { return [] },
      async cancel() {},
      async close() {},
    }
  },
}
```

模块可以用具名的 `engine` 导出或默认导出。引擎 ID 在配置内唯一，使用小写字母开头，并由小写字母、数字、连字符和下划线组成。

## 接入 CLI

`start` 接收工作目录 `cwd`、原生会话 ID `resumeId`、事件函数 `emit` 和关闭信号 `signal`。返回的适配器通过 `prompt(text, attachments)` 处理一轮请求，`configure(id, value)` 返回更新后的选项，`cancel()` 和 `close()` 分别取消当前轮和释放会话。支持图片或音频时，在 `capabilities` 中声明相应的 `image` 或 `audio` 字段。

引擎可用 `capabilities.imageMimeTypes` 指定当前模型支持的图片格式。通过 `available_commands_update` 发布 `availableCommands: [{ name, description, input?: { hint } }]`，网页在加号和斜杠选择器中显示这些命令。选择原生命令会填入草稿，发送时由适配器映射到该 CLI 的执行方式。

| 事件 | 数据 |
| --- | --- |
| `update` | `{ update }`，其中 `update.sessionUpdate` 使用 ACP 更新格式 |
| `permission` | `{ toolCall, options }`，适配器用 `approve(toolCallId, optionId)` 接收选择 |
| `agent` | `{ id, name, status, detail? }`，使用 CLI 提供的代理标识和状态 |
| `usage` | `{ inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, contextUsed?, contextSize? }`，使用本轮计数 |

可选的 `history.list({ home, directory })` 返回终端会话列表。每项需要 `remoteId` 和绝对路径 `cwd`，可以提供 `title`、以毫秒表示的 `createdAt` 和 `updatedAt`、`status` 以及同引擎父会话的 `nativeParent`。列表项中用于读取本机记录的信息会传给 `history.messages(entry)`。此方法返回按顺序排列的 `{ role, text }` 消息。可选的 `history.metrics(entry)` 在打开对应会话时读取最近已完成轮次的用量，返回 `{ inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, contextUsed?, contextSize?, turnMs?, tps? }`。上下文取最近一次窗口快照，和整轮累计 Token 分开。推理 Token 是输出的子集。无法核实的字段省略。

无法经 CLI 继续的历史条目可以返回 `resumable: false`。需要 CLI 回放历史的引擎可声明 `replayHistory: true`，并在支持回放的 `start` 中处理宿主传入的同名选项。回放成功后发送 `emit('history', { messages })`。当引擎能恢复已保存的空会话时，可以声明 `resumeEmpty: true`。

支持原生归档的引擎可导出 `async setArchived({ remoteId, cwd, archived, signal })`。传入 `true` 归档、`false` 恢复；只有原生操作完成或会话已经处于目标状态时才返回。引擎应在 `history.list` 的会话记录中返回布尔值 `archived`，包含已归档的会话，供网页读取 CLI 的最新状态。未实现该方法的引擎在网页中禁用原生归档。

支持原生单条永久删除的引擎可导出 `async deleteSession({ remoteId, cwd, signal })`。CLI 能力随版本变化时可同时导出 `async supportsDelete()`。网页只对支持的主会话提供确认按钮，宿主要求请求带上用户确认的会话 ID，并在原生删除成功后清理关联的网页记录。

引擎可实现 `rename({ remoteId, cwd, title, signal })` 写入自身会话标题。成功后网页清除该会话以前的显示名覆盖。账户额度通过 `accountUsage({ cwd, signal })` 提供，返回 `{ status, limits: [{ label, poolId?, poolLabel?, windowLabel?, usedPercent?, resetsAt? }] }`。同一额度池的窗口使用相同的 `poolId` 和 `poolLabel`，各自通过 `windowLabel` 标明周期。重置时间使用 Unix 毫秒。适配器可实现只读 `context()` 返回当前窗口的 `{ used?, size?, categories: [{ name, tokens }] }`，用于上下文详情。
