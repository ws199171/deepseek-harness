# DeepSeek Harness 架构整理

> 基于仓库文档与源码的一手阅读撰写（快照 `0.1.0-rc.5`，HEAD `47f943859b`，2026-08-17）。
> 仓库自带权威文档见 [docs/architecture.md](../docs/architecture.md)（含[中文版](../docs/architecture.zh.md)）与 [docs/cordis-primer.md](../docs/cordis-primer.md)；改动 `packages/` 前必须先读前者。

**一句话总结**：DeepSeek Harness 是一个建立在 vendored [Cordis](../docs/cordis-primer.md) 之上的插件化 Agent Harness——**一切皆插件**。模型适配器、工具注册表、会话日志、Agent 循环本身都是插件，每一部分都可以从配置替换，不存在需要打补丁的特权内核。

## 目录

1. [顶层布局](#1-顶层布局)
2. [Cordis 插件模型（框架底座）](#2-cordis-插件模型框架底座)
3. [核心包：产品 API 脊柱](#3-核心包产品-api-脊柱)
4. [agent-loop：默认驱动器实现](#4-agent-loop默认驱动器实现)
5. [能力接缝（Capability Seams）](#5-能力接缝capability-seams)
6. [会话系统：事件溯源 + 模型可见即已记录](#6-会话系统事件溯源--模型可见即已记录)
7. [轮次流程与运行时数据流](#7-轮次流程与运行时数据流)
8. [产品组装层：CLI / Web GUI / Desktop](#8-产品组装层cli--web-gui--desktop)
9. [人机协作面与进程外接口](#9-人机协作面与进程外接口)
10. [组合层：Profile / Bundle / Preset](#10-组合层profile--bundle--preset)
11. [基础设施：门禁、测试、文档](#11-基础设施门禁测试文档)
12. [核心设计不变式（汇总）](#12-核心设计不变式汇总)
13. [参考](#参考)

---

## 1. 顶层布局

```
vendor/     vendored 的 Cordis 框架及基础库（cosmokit、schemastery、cordis、loader、include、group、timer、hmr、logger-console）
packages/   全部 @deepseek-ai/dsh-* workspace，位于 packages/<group>/<pkg>/
apps/       产品组装：cli（dsh 二进制）、desktop（Electron shell）、web（Vite SPA）
native/     landlock-run：Landlock 自限制后执行的启动器
python/     Python SDK（deepseek_harness）与打包的运行时二进制
examples/   可运行的 cordis.yml 叶子，叠在 packages/examples 的 demo bundle 之上
docs/       双语架构文档、子系统参考、cookbook、postmortem、生成目录
scripts/    仓库门禁（gates）、生成器、发布工具
website/    VitePress 投影的选定双语文档
.agents/    Agent 工作流与 Agent Notes（决策记录）
```

- **包分组**：[packages/README.md](../packages/README.md) 的层次表是权威分组地图。`core/` 是产品 API 脊柱（稳定 API），其余为各能力家族（llm、shell、fs、subagent、session、interaction、sdk 等）。
- **工程基线**：pnpm workspace（`pnpm@11.7.0`）、Node `^22.19 || >=24`、全 ESM、`strict: true`。构建 = `tsc -b`（host/client 两套 face）+ `tsdown`；测试分层为 unit / 覆盖率门禁（每文件 100%）/ keyless snapshot / 真实 API e2e（无 key 自跳过）/ 浏览器快照。所有门禁经 `tsx scripts/run-gates.ts` 调度。

## 2. Cordis 插件模型（框架底座）

来自 [docs/cordis-primer.md](../docs/cordis-primer.md) 的五个核心概念：

1. **插件是实现 Service 的对象**——可以是带可选 `inject` 与 `apply(ctx)` 的函数，也可以是 `Service` 子类，由 Cordis 挂载进当前 context。
2. **context 是服务的仓库**——服务声明稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），其他插件按 key 找服务，而非导入具体实现。
3. **用 `inject` 声明依赖**——插件等到所需服务存在后才激活，加载顺序由服务需求表达，而非手工启动序列。
4. **类型化事件通信**——通过 TypeScript declaration merging 声明事件名，按 `emit` / `waterfall` / `parallel` / `serial` 分发，分别对应观察、包装、扇出、按序执行。分发模式是事件的公共契约（`@mode` 标签）。
5. **注册是可逆副作用**——prompt 分节、工具 schema、适配器、provider、监听器都经 `ctx.effect()` / `ctx.on()` 安装，重载与卸载时按序撤销。

**Waterfall 语义**：around-middleware。监听器收到 `(...args, next)`，调用 `next()` 委托（可能包装后的结果），不调用则短路。单决策事件中，短路就是设计（策略监听器可自己拍板）；只做注解/观察的监听器必须委托。

**Loader 配置**：`@deepseek-ai/cordis-plugin-include` 把 `!!js` 解析为表达式节点；条目的 `config`（在声明注入激活后、针对该插件 context 求值）与 `disabled` 字段可插值，其余元数据保持字面量。环境选择插件用 overlay。

**本地修改**：[vendor/README.md](../vendor/README.md) 记录了 18 条相对上游的本地修改（fiber 生命周期加固、事务化 Loader/Include 协调、`!!js` 补丁语义、`dsh --dump-config` 支持、`applyEntryPatches` 导出等），更新 vendor 包后必须重新应用。

## 3. 核心包：产品 API 脊柱

来自 [packages/core/README.md](../packages/core/README.md)，这些是**产品**包——插件与消费者构建所依赖的稳定面：

| 包 | 职责 | ctx 键 |
|---|---|---|
| `core/scope` | 作用域化注册原语（库，无 ctx 键） | — |
| `core/session` | 事件溯源式会话日志 + 内存存储 | `ctx.sessions` |
| `core/system-prompt` | prompt 与工具 schema 组装注册表 | `ctx.systemPrompt` |
| `core/tools` | 作用域化工具注册表与执行流水线 | `ctx.tools` |
| `core/agent` | Agent 接口、注册表、`agent/*` 事件词汇 | `ctx.agents` |
| `core/agent-default-model` | Agent 入口共享的默认模型选择 | `ctx.agentDefaultModel` |
| `core/agent-loop` | 默认具体 Agent 驱动器 | `ctx.agentLoop` |

关键设计：**`agent` 拥有公共契约，`agent-loop` 是其默认实现；扩展插件依赖 seam（`dsh-agent`），驱动器保持可替换**。`dsh-agent` 的 README 明确写出：每个插件（UI、hooks、编排器）都对这里定义的 `Agent` handle 编程，它零循环依赖。

`dsh-scope`：一个 agent = 一个作用域键；通过 `agent.ctx` 的注册对该 agent 单独可见且随其生命周期撤销。注意 `agent.ctx` 是**可见性组合，不是权威边界**——作用域安全是非目标。

## 4. agent-loop：默认驱动器实现

`packages/core/agent-loop` 是唯一含具体循环逻辑的包。源码结构：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`AgentLoop extends Service implements AgentFactory`，创建/恢复 Agent，拥有有序拆解 |
| `src/agent.ts` | `ReactLoopAgent implements Agent`——默认驱动器状态机 |
| `src/tool-calls.ts` | 一步内工具调度的调度器（排他调用成屏障、并行调用有界滚动池） |
| `src/runtime-context.ts` | 运行时上下文投影 |
| `src/constants.ts` | `DEFAULT_MAX_PARALLEL_TOOL_CALLS` 等常量 |
| `src/invariant.ts` | 注册到 `ctx.invariants` 的运行时关系检查 |

### Agent 生命周期（`src/index.ts`）

- **`AgentLoop` 是 `Service`**，`static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']`——按依赖声明注入，而非手工排序。
- **创建即注册**：构造器通过 `ctx.effect(() => ctx.agents.setFactory(this))` 把自身注册为工厂；同时注册 `ctx.systemPrompt.variable('provider'|'model'|'cwd')` 三个 prompt 变量。
- **FactoryOwnership** 聚合所有活跃 agent 的拆解：factory 卸载时 `AbortController.abort('agent loop is not active')`，并等待所有 `liveAgents` 与 `startupTasks` 结算。
- **prepare() 的发布序列**（严格顺序）：
  1. `sessions.enter(session)` → `agents.enter(agent, owner)`（注册表碰撞检查、静默插入）
  2. `sessions.announce(session)` → `agents.announce(agent)`（发出 `agent/created`，恰一次）
  3. `emitAgentEvent(..., 'agent/session-start', { source })`——第一个受支持的启动注入点
  4. 每一步之间 `assertLive()` 重查活性；任何一步失败则 `dispose()` 回滚。
- **拆解是 memoized 的单点静默**：`dispose()` 先 `machine.cancel({kind:'disposed'})` → `await machine.whenIdle()` → `scope.dispose()` → 注销两个注册表 → 撤销追踪。多个竞速 owner 共享同一 promise。
- **配置驱动 agent**：`config.agents[]` 数组在构造时逐个 create/resume；支持 `sessionId`（新鲜创建）与 `resumeSessionId`（从持久化恢复），二者互斥且拒绝重复精确身份。
- **launcher 身份**：`ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, ...)` 允许启动器在 Loader 挂载前固定配置 agent 的会话身份，使 overlay 重指模型路由不会丢失身份。

### 驱动器状态机（`src/agent.ts`）

`ReactLoopAgent` 的 phase 是判别联合：`idle` / `maintenance`（维护期，等待唤醒）/ `running { turn, step, wakeRequested }`。关键点：

- **每个请求都由会话日志派生**（模块注释原话："Every request is derived from the session log"）。
- 构造器构建一次**融合分发器** `agentEvents(loopCtx, this)`，热路径不再分配。
- `scope = createScope(loopCtx, this)`，`ctx = scope.ctx.extend({ agent: this })`——每个 agent 一个作用域 context。
- `send()` 处理唤醒时序：唤醒输入不能加入已中止的活动，会重新分类为 next-turn。
- `requestProposal()` 移除 adapter 派生的默认值，让插件提议下一个请求配置。

### 工具调度（`src/tool-calls.ts`）

- **排他调用是屏障，并行调用用有界滚动池**；dispatch 可重叠，而策略、结果、结果上下文保持模型顺序。
- 每个 `PlannedCall` 从 `ToolCallBlock` 提取 `{ callId, name, arguments, agent, signal }` 构造 `ToolExecutionInput`。
- **Abort 会为未启动的调用记录合成错误结果**，保证回放有效；终止性调度失败则保留已记录的 `tool/call` 事件，不虚构结果。
- agent 通过 `ctx.agents.requireInitiator()` 取得，循环边界提供 initiator。

## 5. 能力接缝（Capability Seams）

**接缝** = 可替换能力，三种角色：**Service Definition**（声明接口的 `ctx.<key>` 持有者）、**Service Provider**（实现）、**Consumer**（使用方，通常是对模型暴露的工具）。"一个角色不是接缝；添加能力 = 三者一并设计。"

来自 [docs/architecture.md](../docs/architecture.md) 与 [packages/README.md](../packages/README.md) 的主要接缝：

| 接缝 | Service Definition | Provider 示例 | Consumer 示例 |
|---|---|---|---|
| LLM | `llm/llm`（`ctx.llm`） | `llm-deepseek`、`llm-pi-ai`、`llm-cli`、`llm-replay` | `agent-loop`、compaction |
| Bash | `shell/shell`（`ctx.shell`） | `bash-local`、`bash-sandbox`、`pwsh-local` | `tool-bash`、`tool-pwsh`、hook 桥（范式 seam） |
| Subprocess | `subprocess/subprocess`（`ctx.subprocess`） | `subprocess-local`、`subprocess-e2b` | bash 执行器、PTY 后端、LSP host、进程外 subagent |
| Filesystem | `fs/fs`（`ctx.fs`）+ `fs/*` 策略事件 | `fs-local`、`fs-sandbox`、`fs-e2b` | `tool-fs`、`tool-fs-search`、`fs-observation-policy` |
| Web | `web/web`（`ctx.web`） | exa/perplexity/deepseek 搜索、http fetch | `tool-web` |
| Skill | `skill/skill`（`ctx.skills`） | `skill-badge`、`skill-filesystem` | `tool-skill` |
| LSP | `lsp/lsp`（`ctx.lsp`） | `lsp-stdio` | `tool-lsp` |
| Subagent | `subagent/subagent`（`ctx.subagents`） | in-process spawn/fork、ACP、Codex、Claude Code、dsh-sdk | `tool-subagent`、`tool-ralph` 等 |
| Terminal | `terminal`（`ctx.terminals`） | `terminal-bash` | `tool-terminal` |
| Sandbox | `sandbox/sandbox`（`ctx.sandbox`） | bwrap/Landlock/Seatbelt、windows ACL | `bash-sandbox`、`fs-sandbox` |
| Persistence | `session/session-persistence`（`ctx.sessionPersistence`） | JSONL、SQLite | agent-loop、hooks、session-query |
| Approval | `interaction/user-approval`（`ctx.approval`） | ACP 桥 | tools、`tool-bash`；无应答者 fail closed |
| Compaction | `compaction/compaction`（`ctx.compaction`） | `compaction-basic`、tool-result-pruner | `command-compact` |

**接缝的价值**：替换一个 provider 就改变整个产品。文件系统与子进程 provider 共享同一个执行世界，把它们指向远程沙箱（E2B）时，Bash、PTY、LSP 一起迁移，无需 provider 专用 fork。

## 6. 会话系统：事件溯源 + 模型可见即已记录

来自 [packages/core/session/README.md](../packages/core/session/README.md) 与 [docs/architecture.zh.md](../docs/architecture.zh.md)：

- **`Session` 是仅追加的类型化 `SessionEvent` 日志**，是 agent 全部交互历史的唯一事实源。**LLM 消息历史由 `deriveMessages()` 从日志派生，绝不单独存储**。之上维护一个 surface 投影层（消息产生事件的有序投影），支撑高效派生与 compaction。
- **持久 vs 实时事件**：`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久会话事件；`agent/*`、`llm/stream`、`tools/*` 是分属三个事件域的实时扩展点。
- **核心不变式：模型可见即已记录。** 抵达模型请求的一切都必须能从日志重建，并由运行时不变量断言。新增模型可见输入 = 新增 `SessionEventMap` 成员并渲染自日志。
- **事件词汇**（`SessionEventMap`，merge-extensible，插件可 declaration-merge 自己的类型）：turn/start、turn/end（+`TurnEndReasonMap`）、step/start、step/end、user/message、assistant/chunk（原始逐 token，保真回放）、assistant/message、tool/call、tool/result、request/header 等。
- **结构化元数据**：每个 `SessionEvent` 可选 `sourceEventSeqs`（引用来源事件 seq）、`surfaceOp`（如何进入 surface）、`ignorable`（标记未知类型可安全跳过；缺省则未知类型拒绝重建会话）。
- **持久化**（`packages/session/`，[persistence.md](../docs/subsystems/persistence.md)）：持久化单元就是现有 `SessionEvent`，无并行持久化消息类型。后端 `session-persistence-jsonl`（逐会话追加 JSONL，默认 checksummed Zstandard 帧，崩溃安全原子写）与 `session-persistence-sqlite`（node:sqlite，每事件一行，`SCHEMA_VERSION` pragma），共用 `runPersistenceContract` 契约套件与 `PersistenceCoordinator`（有界写批处理）。
- **崩溃恢复**：绝不截断中断的 turn——以合成的事件关闭它（`tool/result`/`step/end`/`turn/end {kind:'interrupted'}`），只丢弃撕裂的尾部片段。
- **派生设施**：`session-projection`（GUI 投影）、`session-projection-cache`（持久化检查点）、`session-title`（唯一 title provider 槽）、`session-telemetry`（OTel）。

## 7. 轮次流程与运行时数据流

来自 [docs/architecture.md](../docs/architecture.md#turn-flow)：

- **step** = 一次模型请求 + 它调用的工具；**turn** = 零或多个 step（领取首条输入前打开，不再欠工作时关闭）。

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

- **Waterfall 事件**：`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`，监听器必须 `next()` 委托；`agent/turn-stopping` 是 serial 事件，无 `next()`。
- **Agent handle**（[docs/subsystems/core.md](../docs/subsystems/core.md#the-agent-handle)）：`agent.inbox`（可持久投影）、`agent.followup`（唤醒、next-turn）、`agent.steer`（唤醒、next-step）、`agent.inject`（非唤醒上下文）、`agent.cancel(cause, {keepInbox})`、`agent.whenIdle()`。取消是协作式/静默的（调用方持有的 `AbortSignal`）。

### 工具执行流水线（dsh-tools）

来自 [packages/core/tools/README.md](../packages/core/tools/README.md)：

- **管道**：`tools/pre-execute`（可扩展 allow/deny/ask 门）→ 单调注册守卫（`ctx.tools.guard()`）→ `tools/execute`（超时/重试/指标包装）→ `tools/post-execute`（检查/替换结果、附加上下文）→ definition 持有的 `finalizeContent` → 只观察的 `tools/result` 通知。
- **关键设计**：`ToolDefinition` = `ToolSchema` + 强制 `output { schema, render }` + `execute(args, exec)`；`defineTool()` DSL 提供类型化参数 schema。工具声明**纯函数**的 `presentCall()`/`presentResult()` 渲染意图（`generic`/`terminal`/`diff`/`search`/`read`/`web`），UI 无需特判工具名。
- **并行执行**：`isConcurrencySafe(args)` 分类器决定并行，exclusive 调用是排序屏障。
- **Code Mode**：`mode: code|both` 暴露保留的 `run_code` 传输 + 生成式 SDK（TS/Python）；代码模式下模型只能直接调用 `run_code`，其余工具在策略前解析为 `UNKNOWN_TOOL`。

### LLM 流式（dsh-llm）

来自 [packages/llm/README.md](../packages/llm/README.md) 与 [docs/subsystems/llm-streaming.md](../docs/subsystems/llm-streaming.md)：

- **适配器契约**：唯一必需方法是抽象 `LlmAdapter.stream()`；适配器注册到 `ctx.llm`（`registerAdapter(providers, adapter)`）。不变式：`usage` 先于 `finish`、工具调用参数保持原始 JSON 字符串、两条合法错误路径（throw 或 in-band `finish {kind:'error'|'aborted'}`）、一次适配器调用 = 一次 provider 尝试。
- **`StreamChunk`** 是闭合判别联合：`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`。`BlockAssembler` 折叠为完整 assistant 消息。
- **适配器**：`llm-deepseek`（直连）、`llm-pi-ai`（多 provider）、`llm-cli`（委托 CodeBuddy CLI，无需 API key）、`llm-retry`（监听 `agent/request-error`）、`token-meter`（回放感知测量）。

## 8. 产品组装层：CLI / Web GUI / Desktop

`apps/` 是产品组装层，三种入口共享同一 Cordis 插件树：

| 应用 | 形态 | 说明 |
|---|---|---|
| `apps/cli` | `dsh` 二进制 | 源启动经 tsx ESM hook；`--profile <name>` 组合插件树；`--dump-config` 查看实际启动树 |
| `apps/web` | Vite SPA | 浏览器半（`packages/client`）+ host 半（`packages/host`，API 网关 + HTTP 路由）；经 `window.__DSH_BOOT__` 引导 |
| `apps/desktop` | Electron 壳 | spawn `dsh web` 子进程，捕获就绪 URL 后开窗口加载；`AbstractApiClient` 换传输载体（IPC fetch）演进为 host 入 main 进程 |

- **桌面路线**：A+B 组合路径——先 B（spawn 子进程壳）快速验证 Electron 环境与原生模块 ABI，再演进到 A（host 入 main 进程、IPC 桥、零端口）。详见 `DOC/dsh-desktop/PLAN.md`。
- **CLI 委托（llm-cli）**：新插件 `@deepseek-ai/dsh-llm-cli`（`packages/llm/llm-cli/`）实现 `LlmAdapter` 并注册 provider route `codebuddy-cli`，已挂入 base bundle——无需 API KEY，CLI 自带认证。详见 `DOC/dsh-desktop/CLI-ADAPTER.md`。

## 9. 人机协作面与进程外接口

### interaction（[packages/interaction/README.md](../packages/interaction/README.md)）

| 包 | 职责 | ctx 键 |
|---|---|---|
| `commands` | 人类命令注册/分发（不经模型 turn） | `ctx.commands` |
| `user-approval` | 一次性审批协调（allowed-once/rejected/cancelled/unavailable），无应答者 fail closed | `ctx.approval` |
| `permission-presets` | 用户可见权限预设表（workspace-write / danger-full-access） | `ctx.permissionPresets` |
| `user-questions` | provider 中立的人类问答接缝 | `ctx.userQuestions` |
| `tool-ask-user` | 向模型暴露人类提问 | 注册于 `ctx.tools` |

### SDK / ACP / API / Host / Client

- **SDK**（[packages/sdk/README.md](../packages/sdk/README.md)）：`protocol`（线协议）、`client`（TS 客户端）、`server`（stdio JSON-RPC 服务器）。把 Harness 运行时当子进程驱动。
- **ACP**（[packages/acp/README.md](../packages/acp/README.md)）：仅自动化用途的 Agent Client Protocol 服务器（JSON-RPC over stdio），是传输适配器而非 UI 集成。
- **API/Typert**（[packages/api/README.md](../packages/api/README.md)）：`remotes` + `gateway`（Typert unary RPC 网关）；`packages/typert` 是类型图系统（generator/loader/registry）。
- **Host/Client**：`packages/host`（Web-GUI 宿主半：API 网关 + HTTP 路由服务器）、`packages/client`（浏览器半：shell、wire、对象服务、slot 系统、`ui-*` 插件）。
- **Hooks**（[packages/hooks/README.md](../packages/hooks/README.md)）：共享 shell-hook 线协议库 + Claude Code/Codex 桥——把外部 `hooks.json` 钩子翻译成本地类型化拦截点，"原生钩子就是普通 Cordis 插件"。
- **Settings/Credentials/Identity**：`settings`（分层解析、热提交）、`credentials`（配置只带引用不带秘密，每次操作解析）、`identity`（匿名 ID，非认证账号）。

## 10. 组合层：Profile / Bundle / Preset

来自 [docs/architecture.zh.md](../docs/architecture.zh.md#profile-与组合包) 与 [packages/preset/README.md](../packages/preset/README.md)：

- **Profile**：Harness home（`$DSH_HOME`，默认 `~/.dsh`）下命名的组装，列出所叠 bundles + 用户自己的 `cordis.patch.yml`。`web` 与 `headless` 作为模板交付。
- **Bundle**：Cordis 配置行及其挂载代码的分发格式（`package.json` 的 `dsh.bundle` 字段指向 patch 文件），插入的内容始终可被上层 patch。
- **层序**：按 profile 列出的顺序应用每个 bundle 的 patch → profile 的 `cordis.patch.yml` → home 级 → `--patch` overlay。**一条 patch 按 id 替换整行 config（无深合并），或插入新行**。
- **`dsh-base`** 是每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。它按平台门控 shell 栈（win32 上 bash 行禁用、pwsh 行启用）。`dsh-web-app` 加浏览器应用；`dsh-headless` 加一次性运行器（无服务器）。
- 查看本机实际启动树：`dsh --profile web --dump-config`。
- **Preset**：目录持一份 `agent.cordis.yml`，挂到 agent 的作用域 context 下 → 每会话工具/prompt 组合。引用进程级全局服务行的 preset 在挂载时被拒；`isolate` realm 保持每 agent 服务私有。

## 11. 基础设施：门禁、测试、文档

- **门禁**（[docs/development.md](../docs/development.md)）：`scripts/run-gates.ts` 持有校验过的门禁图与有界调度；`test:coverage` 是每文件 100% 的 CI 覆盖率门；`doc-sync` 管文档新鲜度（catalog 生成、md 链接/换行、类型等价、翻译配对、预算）；`hygiene` 管打包健康（knip、publint、constraints、invariants、cordis-config、node-next-types、runtime-closure、vendored-links）。
- **测试策略**（[docs/testing.md](../docs/testing.md)）：优先真实实现而非 mock；"验证世界，而非自我汇报"；测试走真实入口路径（内置 `lib/` 走原生 Node）；source plane 与 artifact plane 永不混淆；每个非平凡模型/协议/人类可见变更必须带 keyless snapshot。
- **文档层级**（[docs/AGENTS.md](../docs/AGENTS.md)）：根 AGENTS → 子树 AGENTS → architecture.md（有序地图）→ subsystems/（每子系统一页，含生成的 `cordis-surface` 区域）→ Agent Notes（决策记录）→ postmortem → cookbook。双语 EN/中文，机器校验配对，字数预算强制。**每个事实只有一个家**。
- **Agent Notes**：`.agents/notes/{proposed,implemented,rejected,archived}/`，非平凡变更同 PR 必须带一个。

## 12. 核心设计不变式（汇总）

1. **一切皆插件**——无特权核心；扩展 = 旁挂插件，替换 = 换 provider。
2. **模型可见即已记录**——新模型可见输入必须新增 `SessionEventMap` 成员。
3. **注册即效应**——一切贡献经 `ctx.effect()`/`ctx.on()`，返回 disposer。
4. **Waterfall 监听器必须调用 `next()`** 委托；否则短路链。
5. **能力接缝 = Service Definition / Provider / Consumer 三件套**，永不只做一个角色。
6. **扩展插件依赖 Service Definition，绝不依赖具体 provider**——`dsh-agent-loop` 是唯一具体循环且保持可替换。
7. **插件优先，循环不动**——新行为挂文档化扩展点；改 `agent-loop` 必须同步更新 architecture 文档。
8. **在类型化同进程边界信任 TypeScript**——只在解析/config、队列、模型/工具 JSON、持久/文件、worker/进程、wire 边界做校验。
9. **按判别标签 switch**；闭合联合以 `assertNever` 收尾；merge-extensible 联合走文档化默认。
10. **跨边界不透明 ID 品牌化**（`Branded<B>`），绝不用裸 `string`。
11. **插件内无硬编码可调项**——部署差异是可由 `cordis.yml` 改动的校验 `Config` 字段；误配置 loud 失败。
12. **追加式会话日志**；崩溃恢复关闭（绝不截断）中断 turn；未知必读事件类型拒绝重建（除非 `ignorable`）。
13. **发布前姿态：基础优先于兼容**——无外部消费者，改名/重打包自由，老格式被拒，`SESSION_FORMAT_VERSION` 保持 `0` 无兼容承诺。
14. **每个非平凡变更同 PR 必须带 Agent Note**。

## 参考

- 架构权威文档：[docs/architecture.md](../docs/architecture.md) / [中文版](../docs/architecture.zh.md)
- Cordis 入门：[docs/cordis-primer.md](../docs/cordis-primer.md)
- 包分组与依赖：[packages/README.md](../packages/README.md)、[docs/module-graph.md](../docs/module-graph.md)
- 能力接缝：[docs/capability-seams.md](../docs/capability-seams.md)
- 事件生产/消费：[docs/event-producer-consumer.md](../docs/event-producer-consumer.md)
- vendor 修改日志：[vendor/README.md](../vendor/README.md)
- agent-loop 源码：`packages/core/agent-loop/src/{index,agent,tool-calls}.ts`
