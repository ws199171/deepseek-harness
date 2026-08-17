# @deepseek-ai/dsh-llm-cli

English | [中文](README.zh.md)

Delegating LLM adapter that answers model calls by running a CLI child process — no API key needed. The configured CodeBuddy CLI (default: `codebuddy`) carries its own authentication and runs its own agentic loop with its own tools; the harness forwards conversation text and streams the final answer back as one text block.

## Roles

| Role | Where |
|---|---|
| Service Definition | `@deepseek-ai/dsh-llm` (`LlmAdapter`) |
| Service Provider | this package (`CliAdapter`, route `codebuddy-cli`) |
| Consumer | `@deepseek-ai/dsh-agent-loop` and auxiliary LLM callers |

## How it works

One model call = one CLI child run:

1. The adapter resolves the executable facts (`command`, `args`, `cwd`, `env`, `permissionMode`) through the plugin's per-request thunk.
2. It spawns the child through the shared subprocess seam (`ctx.subprocess`), inheriting process-tree termination and environment scrubbing.
3. The prompt is appended as the child's final positional argument.
4. The child's `--output-format stream-json` stdout lines are parsed: `assistant` events carry the **cumulative** message text (deltas are computed against the last observed text) and the terminal `result` event settles the stream (`stop`, `max-turns`, or `error`).
5. StreamChunks emitted: `block-start` → `text-delta`* → `block-end` → `finish`.

### Sessions

When a call carries `sessionId` (agent-loop requests do), the adapter appends `--session-id <id>` and forwards **only the newest human-authored user text**: plugin context also has the user role and is excluded. The CLI's own session owns the history, so every turn reuses it instead of re-reading the conversation. Stateless callers (session titles, compaction) flatten the whole conversation into one prompt instead.

### Permissions

Every child receives `--permission-mode <permissionMode>`. The default is `bypassPermissions` because CodeBuddy's print mode has no interactive approval channel; without a non-interactive policy, project reads and other tool calls can be rejected instead of completing the request.

This setting governs CodeBuddy's internal tools. Harness permission presets are not forwarded, and the Harness filesystem and shell sandboxes do not mediate those tools. The default therefore lets CodeBuddy access the host with the desktop process's OS permissions. Deployments that require a narrower CodeBuddy policy must set `permissionMode` explicitly and rely on CodeBuddy's enforcement.

## Configuration

Everything is optional; defaults target CodeBuddy:

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

On Windows, a bare `command` (no `.exe`/`.cmd` suffix) is wrapped in `cmd.exe /d /s /c` so npm/pnpm shims resolve; on POSIX argv is never shell-interpreted.

Persistent conversation requests run in the workspace selected for that Harness session. An explicit `cwd` overrides it for every request; calls without either value use the desktop process's working directory.

The Models page runs `codebuddy --help` to discover the IDs accepted by CodeBuddy's `--model` option. Adding the discovered catalog stores those IDs in `models`; the conversation model picker then selects one per session, and each request carries `--model <selected-id>`. A deployment that configures this package without the Models page supplies the same IDs in `models`. The CLI executes tools itself, so the Harness tool loop and session log only record the final answer text, not the CLI's internal tool steps.

## Model Experience

### CodeBuddy model request

#### What the model sees

The adapter appends the assembled Harness system prompt through CodeBuddy's `--append-system-prompt` option when present. A request with `sessionId` forwards its newest user text as a positional CodeBuddy prompt; stateless callers receive the flattened conversation without duplicating the system prompt.

#### Token effect

Each request adds a CodeBuddy prompt. The Harness request history is flattened only for stateless calls; CodeBuddy owns persistent-session history and its token accounting.

#### KV Cache effect

Harness does not send a provider request with a reusable prefix. CodeBuddy owns any provider-side KV-cache reuse and eviction.

## Known Limitations and Deferred Work

- **One text block per call.** The CLI's internal tool activity is invisible to the harness session log; only the final answer crosses the boundary.
- **Only CodeBuddy is supported.** Other CLIs need an adapter extension that owns their invocation and output protocols.
- **`tools`, `temperature`, `stop`, and `maxTokens` are not forwarded** — the CLI owns its own execution policy.
- **Usage is optional.** The adapter emits `usage` only when a CodeBuddy `result` event supplies both input and output token counts.
- **Session persistence lives in the CLI's own store**, not the harness session log; deleting a harness session does not delete the CLI session.
