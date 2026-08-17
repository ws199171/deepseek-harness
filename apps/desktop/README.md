# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

The dsh desktop shell: an Electron app that hosts the DeepSeek Harness Web UI on Windows, macOS, and Linux. Plan of record: `DOC/dsh-desktop/PLAN.md`.

## Current form (M2 — in-process host over loopback web transport)

The Electron main process boots the `web` profile through the CLI's `runProfile` (the same entry `dsh web` uses) and owns the resulting cordis tree. The renderer loads from the profile's loopback web server and uses its HTTP and WebSocket carriers:

```
renderer (WebApiClient)
        │
        │ HTTP POST + WebSocket downlinks
        ▼
loopback web server ──▶ toFetchHandler(ctx.apiProxy)
```

The webserver serves the frontend dist at `http://127.0.0.1:<port>` and carries both unary calls and event streams. M2b will replace that with a `file://` load and a complete IPC event-stream carrier to avoid the listening socket.

## Run (development)

```sh
pnpm install                      # once, from the repository root
pnpm run start                    # build preload.cjs and launch Electron
```

The start script sets `NODE_OPTIONS=--import=tsx/esm`, so the Electron main process loads `src/main.ts` directly. That keeps `runProfile`'s `INSTALL_ANCHOR` pointed at the real `apps/cli/package.json` — the same constraint `pnpm dsh web` already follows (see .agents/notes dsh-source-launch-tsx-esm).

## Roadmap

- M2b: load the frontend dist through `file://`, then patch the webserver row out of the desktop profile — the runtime will own zero listening ports.
- M3: electron-builder packaging for win/mac/linux, native modules rebuilt against the Electron ABI.
