---
description: "Execution view for the dsh web client: one flat ledger row per step, with recorded titles, lifecycle, duration, and expandable detail."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-execution-viewer

English | [中文](README.zh.md)

## Summary

The Execution view shows one Session's work as a flat ledger: one row per reasoning run or tool call, with its category, recorded title, lifecycle state, and duration. Selecting a row expands the recorded command, arguments, result, failure code, or reasoning text. A running step walks its own clock until it settles.

The view is a Conversation target beside Chat and Trajectory, so it never competes with Chat's process grouping for the same rows. The browser folds its ledger from the Session window the Client already holds: no Host service, Remote face, Session event type, or configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Open the Execution tab in the conversation's view ring. Steps appear in `anchorSeq` order, grouped under their Turn, and the ledger reaches the same conclusions after a reconnect or an older page is prepended: it reads durable events, and live chunks only preview what the durable settlement will confirm.

A row shows its category (read, search, run, web search, subagent, plan, and the other recorded categories), the structured title taken from its recorded arguments, its lifecycle, and its duration. States are `preparing` before a call is committed, `running` until a result lands, `succeeded` or `failed` at the result, and `unfinished` when the Turn closed without one. A reasoning row reports `running`, `succeeded`, or `interrupted`.

Selecting a row expands the slot-owned detail body, which renders the recorded command, the raw argument JSON, the result text, the failure code, or the reasoning text. A deployment may replace that body by registering its own component in `conversation.execution.detail`.

The step category mapping is owned here rather than imported from Chat, so the two surfaces classify recorded tool names independently. Tool names are open: an unrecognized name is a legitimate `tool` step that keeps its recorded name.

### Reading the two halves of one step

A tool call arrives twice over. While the model streams, `assistant/live-chunk` frames carry the call's name and argument fragments, which produce a `preparing` row; when the attempt settles, the durable `tool/call` and `tool/result` events carry the authoritative name, arguments, and result, and the row moves to its final state. Dropping every live frame leaves the same rows, because the fold treats the durable half as the conclusion.

Reasoning works the same way. The durable settlement's `reasoning-chunks` record is authoritative for both text and span, and it replaces whatever live deltas accumulated. `interrupted` on that settlement is the recorded marker for a Turn cancelled mid-stream, so an interrupted run is reported as interrupted rather than inferred from a Turn boundary.

## Model Experience

None, as the package renders recorded conversation state in the browser and contributes nothing model-facing.

#### KV Cache effect

None; the view neither assembles nor mutates any provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints; they describe deliberate scope, not unfinished work.

- **The view is a separate tab** — the Execution ledger shares no rows with Chat, so a reader switches views instead of seeing both at once. This is the design decision that keeps the two process presentations from duplicating each other.
- **Live preview shortens at settlement** — a dropped or reconnected stream falls back to the durable settlement, so reasoning that was streaming can appear shorter until the settlement arrives. That is the platform's transient/durable split, not loss of recorded text.
- **`unfinished` is derived, not recorded** — a call without a result in a closed Turn is reported as unfinished. A future mechanism that legitimately defers a result to a later Turn would make that judgement wrong.
- **The ledger is read-only** — it offers no composer, approval, or steering surface; sending a message or answering a question happens in Chat.
- **Step categories are classified per package** — this view keeps its own tool-name mapping instead of sharing Chat's, so a new tool category must be added in both places.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package contributes one Conversation target, its folds, and one view entry; it owns no cross-process relationship that independent observers could see diverge.
