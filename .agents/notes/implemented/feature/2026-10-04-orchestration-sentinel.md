# Agent Note: Orchestration sentinel

Status: implemented

English | [中文](2026-10-04-orchestration-sentinel.zh.md)

## Problem

A model that issues one concurrency-safe tool call per step pays a round trip for each one, even when the calls are independent and the harness would run them in parallel from a single message. A model that calls one tool repeatedly — a read per file in a directory — pays a call per item where a small program would do.

Standing instructions do not fit. Prose in the system prompt ("batch independent calls", "prefer `run_code` for repetition") costs tokens on every request of every session in a deployment, whether or not the pattern occurs, and it cannot react to what the model is actually doing. Worse, a system-prompt section that changes replaces the prompt's first surface node and invalidates the cacheable prefix, so a token-economy reminder would first have to pay for a cache rebuild.

## Decision

`@deepseek-ai/dsh-orchestration-sentinel` (`packages/guard/orchestration-sentinel`) contributes one dynamic runtime context, and only when the log shows the pattern. It is advisory: it never blocks, never rewrites a call, and asserts nothing about calls that already ran.

### Where the decision runs

Inside the contribution's own text provider, not in an `agent/pre-step` listener. The loop assembles the prompt and materializes dynamic context *before* it dispatches the pre-step waterfall (`packages/core/agent-loop/src/agent.ts`, `preStep`), so a listener's decision would first be visible one step later. Deciding during assembly places the reminder in the same step the model is about to write, which is the only step it can still influence. The window the provider reads contains completed steps only, which is exactly the evidence the mechanisms need.

### The two mechanisms

A **batching reminder** fires when the last `singleCallStreak` steps each issued exactly one call and every one of those calls is classified concurrency-safe by the tool registry. A step issuing two or more calls breaks the run in the folded state, so compliance silences the reminder without a separate feedback path.

A **`run_code` suggestion** fires when one tool appears at least `repeatedToolCalls` times inside the trailing `windowSteps`, every occurrence is concurrency-safe, and `run_code` is visible to that agent. Visibility is the gate that makes the suggestion actionable: in a deployment whose tools presentation mode hides the PTC transport, `run_code` cannot be called, and the deployment ships no suggestion.

Both texts are pure functions of the observed window, including the turn and the covered step range, so identical observations produce identical text.

### State

One `ctx.sessionProjections` unit is the whole of the plugin's persisted state. It folds `tool/call` events into a per-turn step buffer and folds the plugin's own emitted snapshots back in to count emissions. The plugin therefore owns no authoritative state: a resumed or forked session reconstructs the same window and the same budget by replaying the log, and an audit tool counting those snapshots reaches the same number the plugin does. A snapshot re-materialized after compaction repeats the same text and is not counted twice.

### Deference to the loop-hygiene guard

`repeat-tool-reminder` reports loops in which one tool is called with identical arguments. That situation also satisfies the `run_code` mechanism's shape, and answering it with "turn this into a program" would codify the loop rather than shorten it. For the rest of such a turn the plugin withholds the `run_code` suggestion; the batching reminder is unaffected, because it answers a different question. The check reads a source name out of the log, so it holds whether or not that guard is loaded.

### Config and composition

`enabled`, `observeOnly`, `windowSteps`, `singleCallStreak`, `repeatedToolCalls`, `cooldownSteps`, `maxEmissions`, `enableSplit`, `enablePtcSuggestion`; `windowSteps` and `singleCallStreak` are capped at 8, which the fixed 16-step fold buffer covers. The package is in no bundle: a deployment opts in with its own patch row, so the shipped default composition is unchanged.

## Alternatives considered

- **`tools/post-execute` with `PostToolDecision.additionalContexts`** — the channel the sibling loop-hygiene guard uses, with a `notice`-form source and precise attribution to the call that triggered it. Rejected on timing: post-execute runs while the step is still in flight, so the step's call set is not final and the reminder would arrive after the model had already chosen its next actions. It would also lose the re-materialization that makes a compaction-removed snapshot come back on its own.
- **Deciding in an `agent/pre-step` listener** — the first implementation. Rejected after a loop-driven test showed the reminder landing one step late, which moved the reminder past the moment it exists to influence.
- **A standing `systemPrompt.section()` rule** — rejected: unconditional request cost, and a changing system section replaces the first surface node and invalidates the cacheable prefix.
- **Inferring cross-step dependencies** — rejected: not observable. Both texts therefore stay conditional and name no specific call as mergeable.
- **Holding the window in a plugin-side map instead of a projection unit** — rejected: the session emission budget would reset on resume, so the stated per-session cap would not hold, and nothing would reconstruct the window after a restart.
- **Counting emissions in an in-memory counter** — rejected: the count must be derivable from the log, because the log has to account for everything the model saw.

## Consequences

Bought: zero request cost until the pattern actually appears; every word the model saw is in the log and every emission is auditable from it; decisions are restart- and fork-stable; compliance silences the reminder by itself; and `observeOnly` measures whether the intervention window is common before anything is injected.

Cost: the first emission is late by construction, since a run of steps must complete before the pattern exists. Concurrency is judged by tool name with empty arguments — exact for every shipped tool (all are `() => true` or declare no classifier) but optimistic for a third-party classifier that inspects arguments; because both texts are conditional suggestions, that optimism mistimes a reminder rather than misleads about an executed call. There is no priority mechanism between system-prompt contexts, so a deployment running another plugin with standing batching instructions pays for both texts. Distribution is manual: the package is in no bundle.

## Testing

`tests/sentinel.spec.ts` drives a real agent loop against a scripted adapter and asserts the guidance recorded in the session log; `tests/loader-composition.spec.ts` activates the plugin through a test-only `cordis.yml` read by the real Loader and asserts the assembled model-visible snapshot; `tests/context.spec.ts` covers the contribution contract a live loop cannot reach; `tests/{config,state,guidance,decide}.spec.ts` cover the schema, the fold, the texts and the decision. Per-file coverage is 100% on `src/**`.

## Deferred

- A keyless recorded-session snapshot for this scenario needs an owner-owned recording.
- Injection is on only when a deployment turns it on: the observation mode exists to measure the intervention window first, against pre-registered kill criteria, before any guidance reaches a model.
- Whether the row joins a bundle, and whether it ships enabled, waits on that same evidence.
