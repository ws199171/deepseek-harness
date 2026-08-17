# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

dsh desktop shell：一个在 Windows、macOS 和 Linux 上托管 DeepSeek Harness Web UI 的 Electron 应用。计划记录见 `DOC/dsh-desktop/PLAN.md`。

## 当前形态（M2：经由回环 Web 传输的进程内 Host）

Electron 主进程通过 CLI 的 `runProfile`（与 `dsh web` 使用相同入口）启动 `web` profile，并持有生成的 Cordis 树。renderer 从 profile 的回环 web server 加载，并使用其 HTTP 与 WebSocket 载体：

```
renderer (WebApiClient)
        │
        │ HTTP POST + WebSocket downlinks
        ▼
loopback web server ──▶ toFetchHandler(ctx.apiProxy)
```

webserver 在 `http://127.0.0.1:<port>` 提供 frontend dist，并承载 unary 调用与事件流。M2b 将改为 `file://` 加载和完整的 IPC 事件流载体，以免监听端口。

## 运行（开发）

```sh
pnpm install                      # once, from the repository root
pnpm run start                    # build preload.cjs and launch Electron
```

启动脚本设置 `NODE_OPTIONS=--import=tsx/esm`，因此 Electron 主进程会直接加载 `src/main.ts`。这样 `runProfile` 的 `INSTALL_ANCHOR` 会指向真实的 `apps/cli/package.json`，与 `pnpm dsh web` 遵循同一约束（见 .agents/notes dsh-source-launch-tsx-esm）。

## 路线图

- M2b：通过 `file://` 加载 frontend dist，然后从 desktop profile 移除 webserver 行，运行时将不再监听端口。
- M3：使用 electron-builder 为 Windows/macOS/Linux 打包，并针对 Electron ABI 重建原生模块。
