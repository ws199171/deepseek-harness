---
description: "Delegating LLM adapter that answers each model call by running a CLI child (CodeBuddy by default) which carries its own authentication and agent loop."
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-cli`

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-cli` registers one LLM route, `codebuddy-cli`, whose answers come from a CLI child process instead of a provider endpoint. The configured CLI carries its own authentication and runs its own agent loop with its own tools, so the harness forwards conversation text and streams back the final answer: no API key, no endpoint, and no harness tool vocabulary on the wire. Every call spawns one child through the shared subprocess seam and consumes its `stream-json` output, and a `llm-cli` settings section changes the command, arguments, catalog, and permission policy on the next request.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a deployment must hold a conversation without an API key, or when the model should be reached through a CLI that already carries the user's own sign-in. The route is the only thing it adds: sessions, tools, the agent loop, and the Models page belong to the composition around it.

The single-provider twin of this package is the [bundled CLI profile](../../bundle/llm-cli/README.md), which mounts this route and turns off the HTTP provider rows. Choose the bundle to replace the API source; choose the plugin to add the route beside one.

### Roles

| Role | Where |
|---|---|
| Service Definition | [`@deepseek-ai/dsh-llm`](../llm/README.md) (`LlmAdapter`) |
| Service Provider | this package (`CliAdapter`, route `codebuddy-cli`) |
| Consumer | `@deepseek-ai/dsh-agent-loop` and auxiliary LLM callers |
| Depends on | [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.md) |

### How one call works

1. The adapter resolves executable facts — command, arguments, working directory, environment, permission policy — through a per-operation thunk the plugin owns.
2. It spawns one child through the shared subprocess seam, inheriting process-tree termination and environment scrubbing.
3. The prompt is appended as the child's final positional argument, because a print-mode CLI reads its prompt there and not from stdin.
4. The child's `stream-json` stdout lines are parsed: `assistant` events carry the cumulative message text, so deltas are computed against the last text observed, and the terminal `result` event settles the run.
5. The adapter emits `block-start`, the text deltas, `block-end`, any reported usage, and one terminal `finish`.

### Configure the route

Every field is optional in YAML and defaults to CodeBuddy. A missing section still registers a serving route.

```yaml
- id: llm-cli
  name: '@deepseek-ai/dsh-llm-cli'
  config:
    command: codebuddy
    args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
    acpArgs: ['--acp']
    modelDiscoveryArgs: ['--help']
    models: []
    transport: print
    permissionMode: bypassPermissions
    sessionIdArg: --session-id
    disposeGraceMs: 3000
```

`cwd` pins the child's workspace for every request; leaving it out lets a persistent session run in the workspace the session store records, falling back to the process directory. `sessionIdArg` set to an empty string disables CLI-side sessions, which makes every call stateless. `env` is layered over the seam's scrubbed base.

### Transports

`transport` decides how a call reaches the CLI, and the two modes differ in what they pay per call:

- `print` (the default) starts the arguments in `args` for that call and reads its `stream-json` stdout. `--include-partial-messages` is what makes the answer arrive while the CLI is still generating it; without it the caller waits out the whole run and then receives one message.
- `acp` starts one child per route with `acpArgs` and prompts a session on it, so the CLI's cold start is paid once rather than once per call. The conversation's ACP session owns its history, and the CLI's own thinking arrives as its own block instead of staying inside the child.

### Bounding the delegated loop

`tools`, `maxTurns`, and `effort` reach the CLI's own agent loop, which is otherwise unbounded from here when it is. An empty `tools` disables every built-in tool, which is the closest this route comes to a bare model call: the CLI answers without running anything. `maxTurns` caps the CLI's agentic turns, and `effort` names the reasoning level it forwards. Leaving any of the three out leaves the CLI's own default in charge — which is the right choice unless the deployment has a reason to want otherwise.

### Model ids

The plugin offers the CLI's own catalog rather than shipping one: it runs `modelDiscoveryArgs` through the subprocess seam and parses the ids the CLI lists for its `--model` option. The `models` list is an advisory catalog for deployments that cannot interrogate the CLI; discovered ids come first and configured ids the CLI did not report follow, each once.

### Sessions

A request carrying `sessionId` forwards only the newest human-authored user text, with `sessionIdArg` naming the CLI's own session that already owns the history. Plugin-injected user-role context also uses the user role, so the message source — not the role alone — decides which text is the human's. Stateless callers such as session titles and compaction flatten the whole conversation instead, because they have no CLI-side history to continue.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Module map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: settings, route registration, model discovery |
| [`src/adapter.ts`](src/adapter.ts) | `CliAdapter`: argv construction, the stdout pump, chunk emission |
| [`src/wire.ts`](src/wire.ts) | Line-protocol parsing and cumulative-delta computation |
| [`src/translate.ts`](src/translate.ts) | Harness messages to CLI prompt text, and the system-prompt split |
| [`src/config.ts`](src/config.ts) | Volatile config fields and the one resolve step to executable facts |
| [`src/discovery.ts`](src/discovery.ts) | The CLI's own listing command, run through the subprocess seam |
| [`tests/`](tests/) | Unit, fixture-child, and real-composition suites |

### Two seams, and nothing else

The plugin injects `llm` and `subprocess` and looks up `sessions` untyped. It therefore mounts in a composition that has no session store, and it registers no Remote surface, no client package, and no base-bundle row — mounting it changes no other package.

### Why the prompt is an argument

CodeBuddy's print mode reads its prompt from the trailing positional argument; stdin is not a channel it consumes. The adapter therefore keeps `argv` constant per resolution and appends the prompt last, which is also why an empty entry in `args` is refused: it would shift the CLI's own reading of the prompt.

### Why the system prompt moves

A loop-built request leaves `GenerateOptions.system` undefined and carries the prompt as the leading system-role message. The adapter reads both, preferring the explicit field, and passes the result through `--append-system-prompt`. The flattened conversation then contains only user and assistant text, so the prompt is never duplicated into the positional argument.

### Invariant ownership

No runtime invariant companion is published because the adapter's observable contract — one child per call, deltas computed against the last text seen, one terminal `finish` — is asserted by its own suite against a real subprocess seam; the package registers nothing and holds no mutable relation to audit inside the tree.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [The LLM service and adapter registry](../llm/README.md) — the seam this package provides a route for.
- [The process seam](../../subprocess/subprocess/README.md) — child lifecycle, stdio dispositions, and managed-range termination.
- [The bundled CLI profile](../../bundle/llm-cli/README.md) — this route mounted as the model source over `dsh-base`.
- [Settings](../../settings/settings/README.md) — how a `llm-cli` section is stored, validated, and reported.

-----

<a id="model-experience"></a>
## Model Experience

### CodeBuddy CLI model request

#### What the model sees

Each request is one fresh `codebuddy --print --output-format stream-json` child. A persistent-session request carries only the newest human-authored user text as its trailing positional prompt, beside `--session-id <harness session id>`; a stateless request carries the flattened conversation instead. The assembled harness system prompt is appended through `--append-system-prompt` when present, and the selected id arrives as `--model <id>`. Harness tool declarations, `temperature`, `maxTokens`, and `stop` are not forwarded, because the CLI owns its own loop.

#### Token effect

One positional prompt plus one system-prompt argument per call. Prompt length follows the newest human text for a persistent session and the whole conversation for a stateless one. The CLI's own history, its internal tool activity, and its provider-side accounting never enter the harness request.

#### KV Cache effect

The harness sends no per-request provider payload, so it contributes no reusable prefix and observes no provider-side cache state. CodeBuddy owns any provider-side reuse and eviction behind its own session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only the final answer crosses the boundary** — the CLI's internal tool steps and intermediate files stay invisible to the harness session log, so the transcript records one text block per call and cannot replay what the CLI did.
- **The CLI's own policy decides tool approval** — `permissionMode` governs CodeBuddy's tools; harness permission presets, the filesystem sandbox, and the shell sandbox do not mediate them. The default `bypassPermissions` therefore grants the child the desktop process's OS access.
- **Only CodeBuddy-shaped output is understood** — both the `stream-json` vocabulary and the positional-prompt invocation are CodeBuddy's. Another CLI needs its own adapter rather than a configuration change.
- **A missing executable yields no models** — the route still mounts and serves its configured catalog, but the conversation picker then offers nothing the CLI would have discovered.
- **A tool limit is reported as one text block** — a turn-limit or error result terminates the run with the text produced so far; partial output is kept rather than discarded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The child's stdout is read line by line and settles on the first terminal event; later lines in the same chunk are trailing output and are dropped. A cancellation settles the pump the same way, so text a dying child writes after the caller cancels never reaches the answer. A cancellation that arrives after the child already reported its terminal is refused instead: the outcome is what the CLI said, and a late cancel cannot retract an answer that is already complete.

</details>
