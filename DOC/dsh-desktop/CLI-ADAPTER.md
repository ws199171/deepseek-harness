# CLI 模型执行方案（llm-cli 插件）

> 需求：设置 API KEY 后才可以执行。接入主流 CLI（如 CodeBuddy CLI），后台运行 CLI，请求 AI 时走 CLI——无需 API KEY。

## 落地形态

按插件方案实现：新包 `@deepseek-ai/dsh-llm-cli`（`packages/llm/llm-cli/`），
实现 `LlmAdapter` 并注册 provider route `codebuddy-cli`，已挂入 base bundle
（所有 profile 共享，web UI 的 Models 页可选）。

## 架构（委托模式）

```
harness agent-loop ──llm/stream──▶ CliAdapter ──spawn──▶ ctx.subprocess ──▶ codebuddy CLI
        ▲                            │  (stream-json 行协议)          │
        │  StreamChunk ◀─────────────┘  stdout 解析 ◀─────────────────┘
```

- **每次模型调用 = 一次 CLI 子进程运行**（prompt 走 argv 位置参数）
- CLI 自带认证并运行自己的 agentic 循环（自己的工具集）——**无需 API KEY**
- harness 只转发对话文本、接回最终答案（单文本块）
- 会话保持：`sessionId` → `--session-id <id>`，CLI 自己的会话拥有历史，
  每轮只转发最新 user 文本；无 sessionId 的辅助调用（标题/压缩）扁平化全对话

## StreamChunk 映射

```
block-start(text) → text-delta*（assistant 事件累积文本增量）
  → block-end → usage（result.usage 存在时） → finish(stop|max-tokens|error)
```

## 配置（全部可选，默认 CodeBuddy）

```yaml
llm-cli:
  command: codebuddy
  args: ['--print', '--output-format', 'stream-json']
  provider: codebuddy-cli
  displayName: 'CodeBuddy CLI'
  models: [{ id: codebuddy, name: CodeBuddy }]
  cwd: /path/to/workspace
  sessionIdArg: --session-id
  disposeGraceMs: 3000
```

Windows 下裸命令名自动包裹 `cmd.exe /d /s /c`（.cmd shim 兼容）。

## 交付文件

| 文件 | 内容 |
|---|---|
| `packages/llm/llm-cli/src/adapter.ts` | `CliAdapter`（spawn/泵流/终态/abort） |
| `packages/llm/llm-cli/src/wire.ts` | stream-json 行协议解析（累积文本增量、result 终态、usage） |
| `packages/llm/llm-cli/src/translate.ts` | 对话扁平化 / 尾部 user 文本提取 |
| `packages/llm/llm-cli/src/index.ts` | 插件注册（热更新 thunk + settings section） |
| `packages/llm/llm-cli/src/invariant.ts` | 测试不变式伴随文件 |
| `packages/llm/llm-cli/tests/*` | 19 个测试（wire/translate 单元 + adapter 真实子进程集成） |
| `packages/bundle/base/cordis.patch.yml` | base bundle 挂载 `llm-cli` 行 |
| `packages/llm/README.md` / `tsconfig.host.json` | group 表格 + project reference |

## 验证记录（2026-08-17）

- `tsc -b`、lint、246/246 vitest（含 ui-settings-models 全套）、`pnpm run build` 全部通过
- 真实 e2e：`codebuddy --print --output-format stream-json`（v2.132.0）经
  CliAdapter 返回"好的"，usage `{inputTokens:46296, outputTokens:4}`，
  finish `stop`，文本正确组装
- 关键发现：CodeBuddy 的 prompt 必须走 **argv 位置参数**（stdin 无效），
  assistant 事件文本是**累积式**（增量 = 当前全文 - 上次全文）

## CLI 发现与探活（本阶段新增）

### Host 侧：`llm-cli-discovery` Typert Remote

- `src/spec.ts`：Zod schemas（`CliDiscovered` 含 presence/commands/path/version/health/detail）
- `src/discovery.ts`：纯函数探测——PATH + 平台常见安装目录解析、`--version` 捕获、
  stream-json 探活（`assistant` + `result` 事件判定，判定用全量输出、预览取末尾 4 行）
- `src/service.ts`：`TypertRemoteService` 暴露 `discover`（枚举已支持的 CodeBuddy CLI）+
  `test`（单个 CLI 最小探活）
- `src/types.ts`：client-safe `./types` 子路径导出

### Client 侧：Models 页 CLI 委托面板

- `CliProviderPanel.tsx`：**检测已安装 CLI** 按钮 + 每条 CLI 状态点
  （绿=安装且探活通过，红=未安装/探活失败，灰=未知）+ **运行探活** 按钮 +
  **使用此 CLI** 一键切换（写入 `command` 设置项，adapter 下一请求即生效）
- `ProviderEditor` 新增 `'cli'` layout（`llm-cli` namespace 专属），
  无 API key 输入框——CLI 自带认证
- `api-remotes/client` 挂载 `llmCliDiscoveryRemote`，`ctx.remote['llm-cli-discovery']`
- 中英文案齐备；CSS 全部使用 token sheet 变量（styles gate 通过）

### 端到端验证（Electron 桌面壳内）

- `discover`：codebuddy **present**（`/opt/homebrew/bin/codebuddy` 2.132.0）
- `test`：`ok: true` —— "CodeBuddy CLI answered the stream-json probe in under 30000ms"
- 完整链路：Electron renderer → IPC 桥 → typert gateway → subprocess seam → 真实 CLI

### 踩坑记录

- cordis 的 dotted 服务（`remote.<ns>`）桥接只在 `Service` 子类实例上生效；
  测试 bench 的 `remote` 服务必须是 `Service` 实例（普通对象拿不到 namespace）
- probe 判定不能读截断预览：system init 单帧超长会占满前 4 行，assistant/result
  帧在尾部（已改为全量判定 + 尾部预览）

## 已知限制

见 `packages/llm/llm-cli/README.md` 的 Known Limitations：单文本块、
CLI 内部工具活动不可见、tools/temperature/stop/maxTokens 不转发、
会话持久化在 CLI 自己的存储。
