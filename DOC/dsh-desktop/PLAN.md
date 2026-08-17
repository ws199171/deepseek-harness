# dsh Desktop 桌面壳落地方案（A+B 组合）

> 状态：执行中
> 目标：为 DeepSeek Harness 提供 Windows / macOS / Linux 三平台桌面应用

## 背景与决策

Web UI 需要手动起服务 + 开浏览器，使用不便。官方架构已为 Electron 预留路线：

- `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md` 明确
  "A future Electron application reuses the same web client packages over an IPC fetch carrier"；
- `AbstractApiClient` 只需实现 `doFetch` 即可换传输载体，且 `resolveBase()` 已处理
  `file://`（origin 为 `null`）场景，走 `http://dsh.internal` 假 authority；
- `InProcessApiClient + toFetchHandler(api)` 是同构点，可直接作为 IPC 另一端引擎。

**决策：A+B 组合路径** —— 先用 B（spawn 子进程壳）快速拿到可用桌面形态并验证 Electron
环境（原生模块 ABI），随后演进到 A（host 入 main 进程、IPC 桥、零端口），最后三平台打包。

## 里程碑

### M1 — 快速验证壳（方案 B）

- [x] 立项文档（本文件）
- [x] `apps/desktop/`：Electron main 进程 spawn `dsh web`，捕获就绪 URL 后开窗口加载
- [x] 应用退出时可靠清理子进程；子进程异常退出时提示并关窗（代码路径就绪；自动验证待 M3 测试基建）
- [x] dev 模式跑通：UI 在 Electron 中正常渲染，原生模块（node-pty 等）工作
- [x] 单实例锁、macOS GUI PATH 受限环境下的 node 解析（`src/resolver.ts`）
- [x] 验收：无终端环境启动桌面应用即可使用

> 验证记录（2026-08-17，macOS）：`pnpm run start` 后窗口打开并加载
> `http://127.0.0.1:61989`（HTTP 200，renderer 正常）；第二次启动被单实例锁拒绝；
> 依赖预检死循环通过 `apps/desktop/.npmrc`（`verify-deps-before-run=false`）解决；
> `pnpm-workspace.yaml` 按 supply-chain 白名单策略批准 `electron: true`。

### M2 — 官方架构演进（方案 A）

- [x] `IpcApiClient extends AbstractApiClient`（renderer 侧）：`doFetch` 走 IPC，
  流式响应通过 `ReadableStream` 复接（connection 包 `ipc-api-client.ts`）
- [x] main 侧 IPC handler：`DesktopFetchServer` 持有同一 `Response` 引用泵流，
  含流式分块（SSE/下载）、abort 映射与 webContents allow-list
- [x] `preload.ts`：contextBridge 暴露 fetch 转发与事件订阅（CJS 产物）
- [x] host 直接跑在 main 进程（`runProfile('web')` 通过 tsx 动态导入 CLI 源码，
  保留 `INSTALL_ANCHOR` 路径常量）
- [ ] 桌面专用 profile patch 掉 webserver 行（M2b，file:// 加载适配时一并处理）
- [ ] 前端 `file://` 加载适配（M2b，`__DSH_BOOT__` manifest 插件 URL 改造）
- [ ] 验收：零 HTTP 端口运行，功能与 Web 版一致（前端走 IPC transport）

> 验证记录（2026-08-17，macOS）：M2 启动成功；进程拓扑显示无 `bin.ts web` 子进程，
> Electron 主进程（PID 97475）作为父进程直接监听 3080；host 与 IPC fetch server
> 在同一进程中。lints 与 typecheck 干净。`runProfile` 通过 tsx 动态导入 CLI 源码
> 规避了构建产物的 `INSTALL_ANCHOR` 路径解析 bug（这是 CLI 的约束，非 desktop
> 引入的问题）。

### M3 — 三平台打包

- [ ] electron-builder 配置（win/mac/linux）
- [ ] 原生模块按 Electron ABI 重编译（`electron-rebuild`）
- [ ] 打包产物冒烟验证

## 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 前端 `file://` 下插件 manifest URL 加载 | 高 | M2 最先验证；可能需小改 `dsh-client-modules` 的 manifest 注入 |
| 原生模块（node-pty/koffi/landlock）Electron ABI | 中 | M1 即验证；用 `electron-rebuild` 处理 |
| macOS GUI 启动时 PATH 不含 node/pnpm | 中 | M1 实现可执行文件解析（env 覆盖 → PATH 查找 → 常见安装位置） |
| host teardown 时序（窗口关闭 vs 子进程退出） | 中 | M1 定生命周期契约：窗口关 → SIGTERM 子进程 → 等待退出 |

## 关键代码锚点（调研结论）

- `apps/cli/src/bin.ts` — CLI 入口；`dsh web` 走 `runProfile`
- `apps/cli/src/profile-boot.ts` — profile 启动路径（M2 复用）
- `packages/host/apiproxy/src/fetch/client.ts` — `AbstractApiClient`（M2 子类化目标）
- `packages/host/apiproxy/src/fetch/handler.ts` — `toFetchHandler`（M2 的 IPC 另一端引擎）
- `packages/client/connection/src/client/web-api-client.ts` — 浏览器载体参考实现
- `packages/host/webserver/src/index.ts` — HTTP 载体（M2 中被 patch 掉）
- `packages/bundle/web-app/package.json` — web bundle 依赖清单

## 目录规划

```
apps/desktop/            # Electron 应用（workspaces 已含 apps/*）
  package.json
  tsdown.config.ts       # main 进程构建（M1 起）
  src/main.ts            # 主进程：spawn/窗口/生命周期
  src/resolver.ts        # node 可执行文件解析
  src/ipc/               # M2：IPC 桥（handler + preload + client）
  build/                 # M3：electron-builder 配置与资源
```
