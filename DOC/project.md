# DeepSeek Harness 项目总览

> 基于仓库 `0.1.0-rc.5`（HEAD `47f943859b`）的一手整理，2026-08-17。
> 本文是「整个项目」的总览地图；架构细节见同目录 [architecture.md](architecture.md)，仓库权威文档见 [docs/](../docs/)。

**DeepSeek Harness（`dsh`）** 是 DeepSeek AI 开源的 Agent Harness，采用 **一切皆插件** 的架构，运行在 vendored 的 [Cordis](https://github.com/cordiverse/cordis) 框架之上（其设计见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)）。

当前处于 **developer preview**，迭代极快，**会有破坏兼容的变更**。许可证 MIT。

## 目录

1. [快速开始](#1-快速开始)
2. [仓库顶层布局](#2-仓库顶层布局)
3. [包分组体系](#3-包分组体系)
4. [产品组装层（apps）](#4-产品组装层apps)
5. [运行时与语言栈（Python / Native）](#5-运行时与语言栈python--native)
6. [示例（examples）](#6-示例examples)
7. [架构核心概念（精简）](#7-架构核心概念精简)
8. [工程体系：构建 / 测试 / 门禁](#8-工程体系构建--测试--门禁)
9. [依赖与 Vendoring 策略](#9-依赖与-vendoring-策略)
10. [开发命令速查](#10-开发命令速查)
11. [文档导航](#11-文档导航)

---

## 1. 快速开始

### 从 npm 运行

```sh
npx @deepseek-ai/dsh web
```

默认启动 Web UI，服务于 `http://127.0.0.1:3080`。

### 从源码运行

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 2. 仓库顶层布局

```
vendor/     vendored 的 Cordis 框架及基础库（cosmokit、schemastery、cordis、loader、include、group、timer、hmr、logger-console）
packages/   全部 @deepseek-ai/dsh-* workspace，位于 packages/<group>/<pkg>/
apps/       产品组装：cli（dsh 二进制）、desktop（Electron 壳）、web（Vite SPA）
native/     landlock-run：Landlock 自限制后执行的启动器
python/     Python SDK（deepseek_harness）与打包的运行时二进制
examples/   可运行的 cordis.yml 叶子，叠在 packages/examples 的 demo bundle 之上
docs/       双语架构文档、子系统参考、cookbook、postmortem、生成目录
scripts/    仓库门禁（gates）、生成器、发布工具
website/    VitePress 投影的选定双语文档
.agents/    Agent 工作流与 Agent Notes（决策记录）
DOC/        本项目自有的中文整理文档（本文件所在）
```

- **工程基线**：pnpm workspace（`pnpm@11.7.0`）、Node `^22.19.0 || >=24.0.0`、全 ESM（`"type": "module"`）、TypeScript `strict: true`。
- **npm scope**：每个包都是 `@deepseek-ai/dsh-<name>`；vendored 包被重命名（rescope）。
- **发布前姿态**：无外部消费者，优先正确基础而非兼容 shim；旧磁盘格式被拒，`SESSION_FORMAT_VERSION` 保持 `0` 无兼容承诺。

## 3. 包分组体系

包按 `packages/<group>/<pkg>/` 组织，[packages/README.md](../packages/README.md) 是权威分组地图（**Group README 拥有包与 ctx 键的映射**）。全部为 Product（稳定 API），少数为 POC / Support：

| 分组 | 角色 | 关键包 / ctx 键 |
|---|---|---|
| `core/` | 产品 API 脊柱 | `session`(`ctx.sessions`)、`system-prompt`(`ctx.systemPrompt`)、`tools`(`ctx.tools`)、`agent`(`ctx.agents`)、`agent-loop`(`ctx.agentLoop`)、`agent-default-model`、`scope` |
| `api/` | 远程 BFF 组装 + Typert RPC 网关 | `remotes`、`gateway` |
| `typert/` | 类型图生成 / 加载 / 运行时注册表 | `generator`、`loader`、`registry` |
| `llm/` | LLM 能力族 | `llm`(`ctx.llm`)、`llm-deepseek`、`llm-pi-ai`、`llm-cli`、`llm-retry`、`token-meter` |
| `e2b/` | E2B providers（POC） | 沙箱 / FS / 子进程 e2b provider |
| `subprocess/` | 子进程能力族 | `subprocess`(`ctx.subprocess`)、`subprocess-local` |
| `shell/` | Bash 能力族 | `shell`(`ctx.shell`)、`bash-local`、`bash-sandbox`、`pwsh-local`、`tool-bash`、`tool-pwsh` |
| `terminal/` | 持久 PTY 能力族 | `terminal`(`ctx.terminals`)、`terminal-bash`、`tool-terminal` |
| `code-runtime/` | 代码执行能力族（Code Mode） | `code-runtime`、`worker-thread` provider、`run_code` Consumer |
| `sandbox/` | 进程限制接缝 | `sandbox`(`ctx.sandbox`)、bwrap/Landlock/Seatbelt/Windows ACL 后端 |
| `fs/` | 文件系统能力族 | `fs`(`ctx.fs`)、`fs-local`、`fs-sandbox`、`fs-e2b`、`tool-fs`、`tool-fs-search`、`fs-observation-policy` |
| `lsp/` | LSP 能力族 | `lsp`(`ctx.lsp`)、`lsp-stdio`、`tool-lsp` |
| `skill/` | 技能能力族 | `skill`(`ctx.skills`)、`skill-badge`、`skill-filesystem`、`tool-skill` |
| `compaction/` | 压缩能力族 | `compaction`(`ctx.compaction`)、`compaction-basic`、`tool-result-pruner`、`command-compact` |
| `context/` | 模型可见请求上下文 | workspace instructions、time context |
| `subagent/` | 子代理能力族 | `subagent`(`ctx.subagents`)、in-process spawn/fork、ACP/Codex/Claude Code、`tool-subagent`、`tool-ralph` |
| `jobs/` | 后台任务运行时 | `jobs`(`ctx.jobs`)、`tool-jobs`、`job_*` |
| `workflow/` | 工作流接缝 | `workflow`、`workflow-worker-thread`、`tool-workflow`、`tool-ralph` |
| `web/` | Web 能力族 | `web`(`ctx.web`)、search/fetch provider、`tool-web` |
| `attachment/` | 持久附件身份与存储 | `attachment-local` |
| `spill/` | 工具结果溢出接缝 | `spill`、`spill-local`、`spill-policy` |
| `todo/` | 模型侧 `todo_write` 工具 | `tool-todo` |
| `plan/` | Plan 协作状态 | `plan-mode` |
| `goal/` | 同会话目标持久化 | `goal`、`goal-round-driver`、`command-goal`、`tool-goal` |
| `schedule/` | 会话内定时后续 | schedule_* 工具 |
| `feedback/` | 人类反馈 | `command-feedback` |
| `preset/` | 每会话 agent 组合（preset cordis.yml） | — |
| `guard/` | 循环卫生守卫 | `repeat-tool-reminder`、`tool-call-timeout-policy` |
| `bundle/` | 可安装的 `dsh --profile` patch 层 | `base`、`web-app`、`headless` |
| `extensions/` | 运行时自修改（agent 挂载/卸载插件） | 实时插件/服务检查 |
| `hooks/` | Hook 桥 + Claude Code/Codex 线协议库 | 外部 hooks.json → 本地拦截点 |
| `session/` | 持久会话数据面 | `session-persistence`(`ctx.sessionPersistence`)、JSONL/SQLite 后端、`session-projection`、`session-title`、`session-telemetry` |
| `session-query/` | 会话检索族 | 逻辑语料、有界读取、谱系、语义过滤、SQLite FTS |
| `settings/` | 用户设置接缝 | `settings`(`ctx.settings`)、`settings-file` |
| `credentials/` | 凭据引用接缝 | `credentials`、env/`.env` provider |
| `storage/` | 非会话存储中枢 | 后端 + 域表单 |
| `workspace/` | 工作区实体 | — |
| `sdk/` | 进程外运行时 SDK | `protocol`、`client`、`server`（JSON-RPC） |
| `acp/` | 仅自动化的 Agent Client Protocol 服务器 | JSON-RPC over stdio |
| `interaction/` | 人机协作面 | `commands`(`ctx.commands`)、`user-approval`(`ctx.approval`)、`permission-presets`、`user-questions`、`tool-ask-user` |
| `boot/` | 共享 app-bin 引导胶水 | app-boot |
| `host/` | Web-GUI 宿主半 | API 网关 + HTTP 路由 |
| `client/` | Web-GUI 浏览器半 | shell、wire、对象服务、slot 系统、`ui-*` |
| `identity/` | 匿名身份 | `ctx.identity` |
| `examples/` | Demo bundles（Support） | agent-spine-demo + CLI/ACP/JSON-RPC bins |
| `test-support/` | 测试基建（Support） | testkits、invariants、replay、Loader smokes |
| `util/` | 零依赖工具（Support） | `Branded<B>`、Harness home/path、timeout、retention |

**依赖规则**：扩展插件依赖 Service Definition，绝不依赖具体 provider；`dsh-agent-loop` 可替换。依赖图自动生成于 [docs/module-graph.md](../docs/module-graph.md)。

## 4. 产品组装层（apps）

三种入口共享同一 Cordis 插件树：

| 应用 | 包名 | 形态 | 说明 |
|---|---|---|---|
| `apps/cli` | `@deepseek-ai/dsh` | `dsh` 二进制 | 源启动经 tsx ESM hook；`--profile <name>` 组合插件树；`--dump-config` 查看启动树；含 agent-presets（code/cordis/minimal/standard） |
| `apps/web` | `@deepseek-ai/dsh-web-frontend` | Vite SPA | 浏览器半（`packages/client`）+ host 半（`packages/host`）；经 `window.__DSH_BOOT__` 引导 |
| `apps/desktop` | `@deepseek-ai/dsh-desktop` | Electron 壳 | main 进程经 `runProfile` 启动 web profile，渲染器走 loopback HTTP/WS；M2b 演进为 `file://` + IPC 零端口 |

**Base 组合**：`dsh-base`（`packages/bundle/base/cordis.patch.yml`）是每个 profile 的第一层，含 80+ 插件（模型适配器、工具、持久化、沙箱/审批策略、设置、凭据、遥测等），完整清单见 [apps/cli/composition.md](../apps/cli/composition.md)。`dsh-web-app` 加浏览器应用；`dsh-headless` 加一次性运行器（无服务器）。

## 5. 运行时与语言栈（Python / Native）

### Python SDK（`python/`）

用子进程方式驱动 Harness，经 stdio 上的换行分隔 JSON-RPC 通信：

| 目录 | Dist / 模块 | 角色 |
|---|---|---|
| `sdk/` | `deepseek-harness-sdk` / `deepseek_harness` | 高层 turns API + 底层 JSON-RPC 客户端 |
| `sdk-runtime/` | `deepseek-harness-runtime-bin` | 打包的运行时二进制 + 默认 agent 配置 |

SDK 默认启动匹配的打包运行时，除非调用方显式选择 channel。

### Native（`native/`）

`landlock-run/` 是 Landlock「先自限制再执行」启动器的源码与发布源，三包 npm 家族（entry + 各平台 optional dependency，npm 只装匹配平台的那个）。主仓库的 `Landlock Run` workflow 构建测试各架构，`Landlock Run Release` 组装产物、打包校验后发布。

## 6. 示例（examples）

可运行的 demo 叶子，各持自己的配置、前置条件与命令：

| 示例 | 说明 |
|---|---|
| `headless-agent` | 非交互 agent：接收一个任务、运行、输出机器/人类可读格式 |
| `jsonrpc-agent` | 经 Python SDK + JSON-RPC 驱动的无人值守编码 agent |
| `acp-agent` | Agent Client Protocol 自动化服务器（会话/权限/取消） |
| `web-cordis` | 自指 agent：可检查并修改自身内存中的 Cordis 插件树 |
| `web-schedule` | 可选 Web overlay：会话内定时提醒（schedule_* 工具） |
| `mcp-memory` | 经通用 MCP 客户端连接第三方记忆服务器 |

## 7. 架构核心概念（精简）

细节见 [architecture.md](architecture.md)；此处只列骨架。

- **Cordis 插件模型**：插件 = 实现 Service 的对象；context = 服务仓库；`inject` 声明依赖；类型化事件（emit/waterfall/parallel/serial）；注册是可逆副作用（`ctx.effect()`/`ctx.on()`）。
- **能力接缝（Seam）**：Service Definition / Service Provider / Consumer 三件套。替换一个 provider（如把 fs + subprocess 指向 E2B）即改变整个产品。
- **会话系统**：事件溯源——`Session` 是仅追加的 `SessionEvent` 日志，模型历史由 `deriveMessages()` 派生；**模型可见即已记录**。
- **轮次流程**：step = 一次模型请求 + 工具调用；turn = 零或多个 step。`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 是 waterfall 扩展点（必须 `next()` 委托）。
- **组合层**：Profile（命名组装）→ Bundle（分发格式）→ Preset（每会话 agent 组合）；patch 按 id 替换整行 config。
- **核心不变式**：14 条汇总见 [architecture.md](architecture.md#12-核心设计不变式汇总)。

## 8. 工程体系：构建 / 测试 / 门禁

### 构建

```
pnpm run build        # build:lib (tsc -b + tsdown，host/client 两套 face) + build:web (Vite)
pnpm run typecheck    # tsc -b 类型检查（contracts-ready 后）
pnpm run clean        # 清理构建产物
```

- **Source plane vs artifact plane**：静态门禁与测试经 tsconfig `paths` 解析 `src`；消费 `lib/` 的门禁显式声明该依赖。
- **编译器 face 显式**：每包一个聚合 face（`api/remotes` 除外）。

### 测试分层

| 命令 | 用途 |
|---|---|
| `pnpm run test` | vitest 单元测试 |
| `pnpm run test:coverage` | **CI 覆盖率门禁：`packages/*/*/src` 每文件 100%** |
| `pnpm run test:snapshot` | keyless ACP/headless 回放（`-t <name>` 过滤） |
| `pnpm run test:snapshot:record` | 重录期望输出（需 key） |
| `pnpm run test:e2e` | 真实 API 测试（无 `DEEPSEEK_API_KEY` 自跳过） |
| `pnpm run test:web` | 浏览器快照（先 build） |
| `pnpm run test:gui` | client + host 测试 |

**测试策略**（[docs/testing.md](../docs/testing.md)）：优先真实实现而非 mock；测试走真实入口路径；每个非平凡模型/协议/人类可见变更必须带 keyless snapshot。

### 门禁（gates）

门禁经 `tsx scripts/run-gates.ts` 调度（校验过的门禁图 + 有界调度）：

| 命令 | 用途 |
|---|---|
| `pnpm run check:all` | 全部门禁 |
| `pnpm run check:ci` | CI 主门禁（linux 有 `check:ci:linux-primary`） |
| `pnpm run doc-sync` | 文档新鲜度（catalog 生成、md 链接/换行、类型等价、翻译配对、预算） |
| `pnpm run hygiene` | 打包健康（knip、publint、constraints、invariants、cordis-config、node-next-types、runtime-closure、vendored-links） |
| `pnpm run duplication` | 跨文件 TS 克隆检测（jscpd） |
| `pnpm run lint` | oxlint |
| `pnpm run check:windows-wine` | 仅在诊断已知 Windows 失败时用（需 wine） |

## 9. 依赖与 Vendoring 策略

- **Vendored Cordis**（`vendor/`）：钉住的源码副本（上游 SHA 记录于 [vendor/README.md](../vendor/README.md)），`linkWorkspacePackages: true` 保证本地构建解析到 workspace 钉住源码；`overrides` 把 `@deepseek-ai/cosmokit`/`schemastery` 指到 `link:vendor/*`。
- **本地修改**：vendor 记录 18 条相对上游的修改，更新 vendor 后必须重新应用（`pnpm run rescope-vendor`）。
- **构建脚本白名单**（`allowBuilds`）：pnpm 10+ 默认 `strictDepBuilds`，任何带 install/build 脚本的依赖必须显式列出，否则安装报错；仅允许真正需要的（esbuild、lefthook、node-pty、koffi、electron 等）。
- **补丁**：`patchedDependencies` 管理（如 `node-pty@1.1.0`）。
- **发布**：`release:*` 系列脚本管 dsh 家族与 vendor 家族的 bump/pack/publish；`publish:npm-baseline` 发布公开基线。

## 10. 开发命令速查

| 命令 | 说明 |
|---|---|
| `pnpm dsh --profile headless "task"` | 从源码跑一个任务（需 `DEEPSEEK_API_KEY`） |
| `pnpm run demo:cordis` | agent 修改自身运行时（需 key） |
| `pnpm run demo:acp` | ACP 自动化服务器（需 key） |
| `pnpm run demo:code-mode` | Code Mode demo |
| `pnpm run dev:web` | web 开发（`--poll` 监听） |
| `pnpm run mock:llm` | 本地 LLM mock 服务器 |
| `pnpm run docs:dev` / `docs:build` | VitePress 文档站点 |
| `pnpm run website:build` | 网站构建（兼做死链检查） |

**Secrets / .env**：真实 API 测试与 demo 读 `DEEPSEEK_API_KEY`、可选 `DEEPSEEK_BASE_URL`、根 `.env`。永不提交凭据；CI e2e 无 key 自跳过。

## 11. 文档导航

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](../docs/architecture.md) | 架构权威地图（改动 `packages/` 前必读） |
| [docs/cordis-primer.md](../docs/cordis-primer.md) | Cordis 入门 |
| [docs/development.md](../docs/development.md) | 开发指南（TS 项目布局、门禁） |
| [docs/testing.md](../docs/testing.md) | 测试策略与 key 政策 |
| [docs/glossary.md](../docs/glossary.md) | 术语表 |
| [docs/capability-seams.md](../docs/capability-seams.md) | 能力接缝图 |
| [docs/event-producer-consumer.md](../docs/event-producer-consumer.md) | 事件生产/消费映射 |
| [docs/module-graph.md](../docs/module-graph.md) | 包依赖图 |
| [docs/subsystems/](../docs/subsystems/) | 每子系统一页 |
| [docs/cookbook/](../docs/cookbook/) | 扩展 cookbook（加包/工具/LLM 适配器/会话节点） |
| [docs/cordis-api/](../docs/cordis-api/) | Cordis API 参考 |
| [docs/postmortem/](../docs/postmortem/) | 事后复盘 |
| [AGENTS.md](../AGENTS.md) | 项目指令（约定、命令、防御模式） |

---

**相关整理文档**：[architecture.md](architecture.md)（架构细节）、[dsh-desktop/PLAN.md](dsh-desktop/PLAN.md)（桌面壳方案）、[dsh-desktop/CLI-ADAPTER.md](dsh-desktop/CLI-ADAPTER.md)（CLI 模型执行方案）。
