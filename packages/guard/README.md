---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-tool-call timeout policy, and the orchestration sentinel, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for three common failure patterns. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish, so a stuck loop stops burning time and tokens. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timed-out error to the model instead of stalling the session. `orchestration-sentinel` notices when independent concurrency-safe calls are being issued one per step, or when one tool is being called repeatedly, and asks the model to batch or to use `run_code`, so the loop stops paying a round trip per call. The first two ship enabled in the `dsh` base bundle; a composition can tune or remove them. All three ship enabled in the `dsh` base bundle, and a composition can tune or remove any of them. The sentinel is the one member that is advisory guidance rather than a guard: it speaks only when the log shows the pattern it reacts to, so a session that already batches pays nothing for it.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three small plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`orchestration-sentinel/`](orchestration-sentinel/README.md) | Reminds the model to batch independent concurrency-safe calls, and suggests `run_code` for repeated work |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the two guards' configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions all three build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.
- [Orchestration sentinel README](orchestration-sentinel/README.md) — when the batching reminder fires, what it costs, and why it defers to the loop-hygiene guard.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
