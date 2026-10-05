---
description: "Condition-triggered orchestration guidance that asks the model to batch independent concurrency-safe calls and to reach for run_code on repeated work, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-orchestration-sentinel

English | [中文](README.zh.md)

## Summary

This package watches how the model is issuing tool calls and, at two points, adds one short reminder to the next request. When several consecutive steps each issue a single concurrency-safe call, it points out that independent work can be issued in one message, which the harness then runs in parallel. When one tool is called repeatedly and the PTC transport is available to that agent, it points out that `run_code` can do the repeating in one call. Both reminders describe only what was observed and attach a conditional suggestion: neither claims to know whether a dependency exists, and neither names calls as mergeable after the fact. The reminders are advisory and bounded — a session spends a small number of them, and a model that is already batching draws none.

## Table of Contents

- [Use this package](#use-this-package)
  - [When to choose it](#when-to-choose-it)
  - [Running it, tuning it, turning it off](#running-it-tuning-it-turning-it-off)
  - [What you get](#what-you-get)
- [Understand the implementation](#understand-the-implementation)
  - [Design philosophy](#design-philosophy)
  - [The two mechanisms](#the-two-mechanisms)
  - [Where the decision is made](#where-the-decision-is-made)
  - [Why the log alone accounts for every emission](#why-the-log-alone-accounts-for-every-emission)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## Use this package

The package is a function plugin: the `dsh` base bundle mounts it enabled, and a deployment tunes it with the fields below — either by overriding its row in its own patch layer or from the Settings page. It injects `tools`, `systemPrompt`, and `sessionProjections`; a profile lacking one of those services fails loudly rather than running partially.

### When to choose it

Choose it when a deployment sees a model issuing one independent, read-only call per step and paying a round trip for each, or repeatedly calling one tool where a small program would do. The reminders cost nothing until the pattern actually appears.

Skip it when the workload is inherently serial — a dependency chain produces exactly the single-call steps this package treats as a signal — and skip it when another plugin already supplies standing batching instructions. Two plugins saying the same thing in the same request both pay for the tokens.

### What you get

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the plugin runs at all. |
| `observeOnly` | `false` | Decide and log, but contribute nothing: the mode used to measure how often an intervention window appears before any guidance is injected. |
| `windowSteps` | `4` | Trailing steps the repeated-tool window inspects. |
| `singleCallStreak` | `3` | Consecutive single-call steps that trigger the batching reminder. |
| `repeatedToolCalls` | `6` | Occurrences of one tool inside the window that trigger the `run_code` suggestion. |
| `cooldownSteps` | `3` | Minimum steps between two emissions inside the same turn. |
| `maxEmissions` | `3` | Emissions allowed per session; `0` suppresses every emission and every observation record. |
| `enableSplit` | `true` | Whether the batching mechanism is eligible. |
| `enablePtcSuggestion` | `true` | Whether the `run_code` mechanism is eligible; visibility of `run_code` still gates it. |

### Running it, tuning it, turning it off

It ships enabled, because the guidance is conditional: a session that never shows the pattern pays nothing. To see the folding without any model-visible guidance — the mode for measuring whether the pattern is common before letting the reminders out — override the row:

```yaml
- id: orchestration-sentinel
  config:
    observeOnly: true
```

The model then sees nothing, but every step where a mechanism would have fired is logged once:

```text
orchestration-sentinel: would advise "split" at turn 1 step 4 (observe-only, nothing contributed)
```

That line is the measurement. Because the contribution is empty, no snapshot is recorded and neither the session budget nor the per-turn cooldown advances, so the log counts every boundary the window held rather than the emissions it would have produced.

To remove the behaviour entirely, disable the row in a patch layer (`disabled: true` on `orchestration-sentinel`) — the plugin, its projection unit and its budget all disappear with it — or set `enabled: false` in its config to keep the row mounted but inert.

<a id="understand-the-implementation"></a>

## Understand the implementation

### Design philosophy

The plugin owns no authoritative state and adds no event type. Everything it decides on is folded out of the session log, and every word it contributes is recorded there, so a resumed or forked session reconstructs the same decisions by replaying. It also writes nothing to the system prompt: a changing system-prompt section would replace the prompt's first surface node and invalidate the cacheable prefix, which is the opposite of what a token-economy plugin should do.

### The two mechanisms

A **batching reminder** fires when the last `singleCallStreak` steps each issued exactly one call and every one of those calls is classified concurrency-safe by the registry. A step that issues two or more calls breaks the run, so compliance silences the reminder without any extra bookkeeping.

A **`run_code` suggestion** fires when one tool appears at least `repeatedToolCalls` times inside the trailing `windowSteps`, every occurrence is concurrency-safe, and `run_code` is visible to that agent — in a deployment whose tools presentation mode hides the PTC transport, the suggestion would be unactionable, so it is not made. This mechanism stays silent for the rest of a turn in which the shipped loop-hygiene guard has already told the model it is repeating itself: repeating one operation verbatim is that guard's finding, and turning it into a program would codify the loop rather than shorten it.

### Where the decision is made

The decision runs inside this package's dynamic-context provider rather than in an `agent/pre-step` listener. Agent-loop assembles the prompt and materializes dynamic context *before* it dispatches the pre-step waterfall, so a listener's decision would reach the model one step later than intended; deciding during assembly places the reminder in the same step the model is about to write, which is the only step it can still influence.

### Why the log alone accounts for every emission

Guidance text is a pure function of the observed window, including the turn and the covered step range. Agent-loop records a runtime-context snapshot only when its text changes, so an unchanged window costs nothing twice; and a snapshot re-materialized after compaction repeats the same text, which the fold recognizes and does not count as a second intervention. The session budget is therefore derived from the log rather than remembered, and an audit tool counting those snapshots reaches the same number the plugin does.

<a id="further-exploration"></a>

## Further Exploration

- [The loop-hygiene guard](../repeat-tool-reminder/README.md) — the sibling package this one defers the PTC suggestion to.
- [Tools subsystem](../../../docs/subsystems/tools.md) — concurrency classification and the execution pipeline.
- [Session projections](../../../docs/subsystems/session-projection.md) — the fold unit this package registers.

<a id="model-experience"></a>

## Model Experience

### Batching reminder

#### What the model sees

Once `singleCallStreak` steps have each issued one concurrency-safe call, the next request carries the contribution below as a dynamic runtime-context snapshot. `<turn>` and the step span are the observed window; `<count>` is the configured streak. No tool schema changes.

##### Batching reminder text

```markdown
[orchestration] (turn <turn>, step <first>–<last>): these <count> steps each issued exactly one tool call. If the read-only work still ahead of you in this step does not depend on an earlier result, issue those calls together in one message; the harness schedules concurrency-safe calls in one message in parallel.
```

#### Token effect

Zero tokens until the pattern appears. Each emission is retained history and bounded by `maxEmissions` per session and `cooldownSteps` between emissions inside a turn.

#### KV Cache effect

Append-only; the snapshot follows the retained history, so it extends the reusable prefix instead of replacing it. A later emission with different text appends again.

### run_code suggestion

#### What the model sees

When one concurrency-safe tool repeats inside the window and `run_code` is visible, the next request carries the contribution below instead of the batching reminder. `<tool>` is the repeated tool and `<count>` its occurrences.

##### run_code suggestion text

```markdown
[orchestration] (turn <turn>, step <first>–<last>): <tool> has been called <count> times. If the work left is one operation repeated over a set of inputs, run_code can do it in a single call.
```

#### Token effect

Zero tokens until the pattern appears, then the same session budget and per-turn cooldown as the batching reminder. The suggestion never substitutes for the tool schema: it is additional context, not a configuration change.

#### KV Cache effect

Append-only, exactly as the batching reminder: newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current constraints, not a task backlog.

- **Concurrency is judged by tool name** — the probe classifies through the agent's visible definitions with empty arguments, which is exact for every shipped tool (all are `() => true` or declare no classifier) but optimistic for a third-party classifier that inspects arguments. Because both texts are conditional suggestions that assert nothing about executed calls, the cost of that optimism is a mistimed reminder, not incorrect guidance.
- **Dependency chains look like the signal** — a genuinely serial workload produces one concurrency-safe call per step, which is exactly the batching window; `singleCallStreak` and `maxEmissions` are the pressure valves.
- **The first emission is late by construction** — a run of `singleCallStreak` steps must complete before the pattern exists, so the earliest reminder arrives on the next step.
- **`run_code` visibility is read per step** — a deployment that changes its tools presentation mode mid-session changes whether the suggestion is actionable; the check is re-evaluated each assembly.
- **Two saying the same thing** — with a standing batching instruction from another plugin, both texts ride in the same request and both cost tokens; there is no priority mechanism between system-prompt sections.
- **Config values are trusted as delivered** — the exported schema rejects out-of-range values, but the plugin itself never re-validates at runtime, so a deployment path that bypasses schema application hands it the raw value.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- `src/state.ts` is the whole of the plugin's persisted state: one projection unit folding `tool/call` and its own runtime-context snapshots. `STATE_VERSION` must be bumped whenever its fields or fold semantics change, and `BUFFER_STEPS` must grow with the `windowSteps`/`singleCallStreak` ceilings.
- `src/decide.ts` is pure and takes concurrency classification as an injected probe, because a registry can change under a live session and a checkpoint must never record a conclusion a later registry would contradict.
- The observation mode exists to falsify the plugin's own premise: if the intervention window rarely appears in real sessions, the reminder cannot matter and the package should not grow further.
- `tests/sentinel.spec.ts` drives a real agent loop against a scripted adapter, `tests/loader-composition.spec.ts` activates the plugin through a test-only `cordis.yml` read by the real Loader, and `tests/context.spec.ts` covers the contribution contract that a live loop cannot reach.

</details>
