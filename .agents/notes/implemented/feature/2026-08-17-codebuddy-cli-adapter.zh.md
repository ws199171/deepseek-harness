# Agent Note: CodeBuddy CLI adapter

Status: implemented

[English](2026-08-17-codebuddy-cli-adapter.md) | 中文

## Problem

产品需要一种模型提供方：它使用用户已有的 CodeBuddy CLI（命令行界面）认证，而不要求 DeepSeek API key。通用的可执行文件设置无法安全地提供该能力，因为不同 CLI 程序的参数约定、会话行为和流式协议不同。

## Decision

`@deepseek-ai/dsh-llm-cli` 在 base bundle 中注册 `codebuddy-cli` 路由。每次模型请求都会通过 `ctx.subprocess` 启动一个 CodeBuddy 子进程，将提示词追加为最后一个位置参数，并把 CodeBuddy `stream-json` 输出转换为 `StreamChunk`。

每次请求在存在时都会通过 `--append-system-prompt` 追加已组装的 Harness 系统提示词。会话请求会追加 `--session-id <id>`，在 `llm-cli.cwd` 未覆盖时使用会话选中的 workspace，并且只转发最新的人类用户文本，因为 CodeBuddy 持有该会话的历史。Plugin 上下文使用相同的 user role，但不会取代人类输入。无状态调用方会将完整 Harness 对话展平，不会重复系统提示词。每当完整 `assistant` 行到达时，adapter 就输出文本，并且只会在收到终态 `result` 行或报告失败后关闭该块。

每次委托运行都会传递配置的 CodeBuddy `--permission-mode`；其默认值为 `bypassPermissions`，因为 print 模式无法完成交互式审批。此策略在 CodeBuddy 内部生效。Harness 权限预设和工具沙箱不会拦截委托 CLI 内部的文件或 shell 操作。

Models 页面会在把 CodeBuddy 可执行文件和 `--model` 帮助列表写入 `llm-cli` 设置分节之前发现并探活它。对话模型选择器会按会话从这些 ID 中选择一个，adapter 将其作为 `--model <id>` 转发。发现列表只包含 adapter 已实现调用和输出协议的 CLI 程序。增加其他 CLI 需要一个拥有其独立协议的 adapter 扩展。

## Alternatives considered

**将每个检测到的 CLI 都视为兼容。**不予采用，因为常见 CLI 名称不代表相同的提示词、会话或 `stream-json` 语义，而且成功的可执行文件探活并不能保证之后的模型请求可靠。

**通过 stdin 传递提示词。**不予采用，因为 CodeBuddy 的 print 模式从位置参数接收提示词。

**等进程结束后再缓冲 stdout。**不予采用，因为模型流必须在终态事件之前发布完整的 assistant 文本；缓冲会让运行时间长的 CLI 响应看起来停滞。

## Consequences

用户已有的 CodeBuddy 凭据可以为选中的会话模型提供服务，而无需 DeepSeek API key；模型发现则确保模型选择器只列出 adapter 能调用的 CodeBuddy ID。

CodeBuddy 持有工具执行和会话存储，因此 Harness 只记录最终文本，无法回放其内部工具活动。默认的 `bypassPermissions` 模式还会让这些内部工具使用桌面进程的 OS 访问权限，而非会话的 Harness 权限预设。该提供方依赖 CodeBuddy 当前的 print 和 `stream-json` 行为；供应商协议变更会造成请求或探活失败，而不会回退到兼容模式。
