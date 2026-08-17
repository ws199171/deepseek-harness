# @deepseek-ai/dsh-llm-cli

[English](README.md) | 中文

委托 LLM adapter：每个模型请求运行一次 CLI 子进程，无需 API key。配置的 CodeBuddy CLI（默认值：`codebuddy`）使用自己的认证并执行自己的 agentic 循环和工具；Harness 转发对话文本，并将最终回答作为单个文本块流回。

## 角色

| 角色 | 位置 |
|---|---|
| Service Definition | `@deepseek-ai/dsh-llm`（`LlmAdapter`） |
| Service Provider | 此包（`CliAdapter`、`codebuddy-cli` 路由） |
| Consumer | `@deepseek-ai/dsh-agent-loop` 和辅助 LLM 调用方 |

## 工作方式

一次模型调用对应一次 CLI 子进程：

1. adapter 通过插件的按请求 thunk 解析可执行事实（`command`、`args`、`cwd`、`env`、`permissionMode`）。
2. 它通过共享 subprocess seam（`ctx.subprocess`）启动子进程，继承进程树终止和环境清理行为。
3. prompt 追加为子进程的最后一个位置参数。
4. 子进程的 `--output-format stream-json` stdout 行会被解析：`assistant` 事件携带**累积**消息文本（adapter 根据上一次文本计算增量），终态 `result` 事件结束流（`stop`、`max-turns` 或 `error`）。
5. 输出的 StreamChunk 顺序为：`block-start` → `text-delta`* → `block-end` → `finish`。

### 会话

调用带有 `sessionId` 时（agent-loop 请求会带），adapter 会追加 `--session-id <id>` 并只转发**最新的人类 user 文本**；plugin 上下文同样使用 user role，但会被排除。CLI 自己的会话保存历史，因此每轮会复用该会话而不重读完整对话。无状态调用方（会话标题、压缩）会将完整对话展平为一个 prompt。

### 权限

每个子进程都会收到 `--permission-mode <permissionMode>`。默认值为 `bypassPermissions`，因为 CodeBuddy 的 print 模式没有交互式审批通道；如果没有非交互策略，项目读取和其他工具调用可能被拒绝，导致请求无法完成。

此设置管理 CodeBuddy 的内部工具。Harness 权限预设不会传给 CodeBuddy，Harness 的文件系统和 shell 沙箱也不会拦截这些工具。因此，默认配置允许 CodeBuddy 使用桌面进程的 OS 权限访问主机。需要收紧权限的部署必须显式设置 `permissionMode`，并依赖 CodeBuddy 自身的权限机制。

## 配置

所有字段均可选，默认面向 CodeBuddy：

```yaml
# cordis.yml entry or the `llm-cli:` user-settings section
llm-cli:
  command: codebuddy                    # CLI executable on PATH
  args: ['--print', '--output-format', 'stream-json']
  provider: codebuddy-cli               # provider route id (registration-time fact)
  displayName: 'CodeBuddy CLI'
  models: []                          # populated by CodeBuddy discovery in the Models page
  cwd: /path/to/workspace               # overrides session workspace; process cwd is the final fallback
  env: {}                               # layered over the subprocess seam's base
  sessionIdArg: --session-id            # argument carrying the persistent session id
  permissionMode: bypassPermissions     # CodeBuddy's internal tool-approval policy
  disposeGraceMs: 3000
```

在 Windows 上，裸 `command`（没有 `.exe`/`.cmd` 后缀）会包进 `cmd.exe /d /s /c`，使 npm/pnpm shim 能被解析；在 POSIX 上 argv 永不经 shell 解释。

持久对话请求会在对应 Harness 会话选中的 workspace 中运行。显式 `cwd` 会覆盖所有请求的 workspace；两者都不存在的调用使用桌面进程的工作目录。

Models 页面通过 `codebuddy --help` 发现 CodeBuddy 的 `--model` 选项接受的 ID。添加发现到的模型目录会将这些 ID 写入 `models`；对话模型选择器随后为每个会话选择一个模型，并且每个请求都会携带 `--model <selected-id>`。不使用 Models 页面的部署可直接在 `models` 中提供相同的 ID。CLI 自己执行工具，因此 Harness 的工具循环和会话日志只记录最终回答文本，不记录 CLI 的内部工具步骤。

## Model Experience

### CodeBuddy 模型请求

#### 模型可见内容

adapter 在存在时通过 CodeBuddy 的 `--append-system-prompt` 选项追加已组装的 Harness 系统提示词。带有 `sessionId` 的请求会将最新用户文本作为 CodeBuddy 位置提示词转发；无状态调用方接收展平后的对话，不重复系统提示词。

#### token 影响

每次请求会添加一个 CodeBuddy 提示词。Harness 请求历史只会在无状态调用中展平；CodeBuddy 持有持久会话历史及其 token 计量。

#### KV Cache 影响

Harness 不发送带有可复用前缀的提供方请求。CodeBuddy 持有所有提供方侧 KV Cache 的复用和驱逐。

## 已知限制与延后工作

- **每次调用只有一个文本块。** CLI 的内部工具活动对 Harness 会话日志不可见，只有最终回答会跨越该进程边界。
- **仅支持 CodeBuddy。** 其他 CLI 需要一个拥有其调用和输出协议的 adapter 扩展。
- **不会转发 `tools`、`temperature`、`stop` 和 `maxTokens`。** CLI 拥有自己的执行策略。
- **usage 是可选的。** 只有 CodeBuddy 的 `result` 事件同时提供输入和输出 token 计数时，adapter 才输出 `usage`。
- **会话持久化存放在 CLI 自己的存储中。** 删除 Harness 会话不会删除对应的 CLI 会话。
