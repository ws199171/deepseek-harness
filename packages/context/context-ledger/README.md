---
description: "The project context ledger: project identity, durable project memory with a trust gradient, a mechanical session archive, directory conventions delivered on touch, and an adaptive injection budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-context-ledger

English | [中文](README.zh.md)

## Summary

A project-scoped ledger that keeps what a project has learned. Every session in the same project receives one runtime-context block carrying the project's identity and the headlines of the facts a human has confirmed, so a later session starts already knowing them. Everything else — bodies, unconfirmed proposals, archived sessions, directory conventions — stays out of the standing payload and is reachable through seven `ledger_*` tools, or delivered once when a tool touches a directory that has its own `CONTEXT.md`. Injection size is capped by a budget profile or chosen adaptively from the session's remaining window.

## Table of Contents

- [Use this package](#use-this-package) - [Understand the implementation](#understand-the-implementation) - [Further Exploration](#further-exploration) - [Dev Note](#dev-note) - [Model Experience](#model-experience) - [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-context-ledger-bundle`, or the plugin row directly:

```yaml
- id: dsh-context-ledger
  name: '@deepseek-ai/dsh-context-ledger'
  config:
    budgetProfile: adaptive
```

The plugin requires only `systemPrompt` and `tools`. The filesystem provider, session store, session query, token meter, model router, and approval surface are all read through `ctx.get`, so a deployment missing one loses exactly that capability: no filesystem provider contributes no block, no approval surface leaves facts unconfirmable, and no session query archives nothing.

<a id="understand-the-implementation"></a>
## Understand the implementation

**One block, compared as text.** `ctx.systemPrompt.context()` registers a provider whose text is the rendered block, and the provider reads a per-session cache that every filesystem read is kept out of — so an assembly never blocks on I/O. The cache is refreshed at checkpoints (session start, a turn boundary, the end of a compaction) and after a `tools/result` that could have changed the project. Rendering is deterministic with a fixed field order, and the cache is compared by rendered text rather than by a derived key, so what is injected and what the cache believes cannot disagree.

**A trust gradient, not a switch.** A fact written by the model is `auto`: counted in the catalog line but never injected. Only a recorded human approval promotes it to `confirmed` (injected) or `curated`. This is the whole reason the injection is safe to make standing: the model can record freely, and nothing becomes a permanent per-request cost without a person saying so.

**Injection is bounded in bytes, not tokens.** A token-denominated ceiling would need a tokenizer this plugin does not have, and reporting a byte count as a token count would overstate what is known. The profiles are `frugal`, `balanced`, `full`, or `adaptive`, which picks the widest rung whose whole-block ceiling fits a configured fraction of the session's free window. Shedding is whole-value and ordered — headlines, then the catalog line, then the stack line, then the project name — because a truncated headline asserts something false while a missing optional line does not.

**The archive is mechanical.** A row is derived from a session's committed events with no model call, so it cannot disagree with the log it came from: duration, turns, steps, tool calls, compactions, goal changes, how the last turn ended, and the files it touched. There are no summaries, because a summary would be a second and lossier account of the same session.

**Conventions are delivered once, on touch.** A `CONTEXT.md` applies to its own directory and its descendants; when a tool result shows a file inside the project was touched, the applicable files are delivered nearest-first as one `user/message` through the inbox, and each is delivered at most once per session. Delivery is deliberately late: a convention's value is highest exactly when the work reaches it, and its cost is otherwise a standing tax.

No runtime invariant companion is published: every observation this package makes is of state it does not own — the session log, the filesystem, and its own cache — so there is no owned relationship two independent observers could see diverge.

<a id="further-exploration"></a>
## Further Exploration

- [`docs/subsystems/compaction.md`](../../../docs/subsystems/compaction.md) — the retention mechanism the block relies on, and why the ledger needs no change to survive a replacement engine. - [`packages/context/agent-instructions/`](../agent-instructions/README.md) — the sibling that owns behavioral instruction files, which this package deliberately does not duplicate. - [cordis composition reference](../../preset/agent-preset/skills/cordis-composition-reference/references/packages.md) — where this package's config surfaces.

<a id="dev-note"></a>
## Dev Note

The memory directory is markdown with a JSON frontmatter header, one file per fact, because the bodies are prose a person is expected to read and edit and because deleting the directory is then a complete and self-evident way to forget everything. There is deliberately no derived index file: listing scans the directory, which keeps one source of truth for content and removes the question of what to do when a cache and its source disagree.

<a id="model-experience"></a>
## Model Experience

### The project context block

#### What the model sees

Every request in a session whose working directory resolves to a project carries one durable user-role runtime-context snapshot. It names the project, its root, the manifests present at that root, and — once a human has confirmed one — the memory catalog line and one headline per fact that earned a slot.

##### Project context template

```markdown
<project_context>
Project: demo
Root: /work/demo
Stack: package.json
Memory: 3 recorded, 1 shown (build 1, decision 2)
- [build] Run the suite with pnpm test
</project_context>
```

#### Token effect

Bounded by the profile's `maxIdentityBytes` for the whole block and `maxIndexBytes` for the headlines alone. The block is re-materialized only when its rendered text changes, so a session that learns nothing new pays nothing beyond the cache it already holds. A session whose window cannot hold even the root line contributes nothing at all.

#### KV Cache effect

The snapshot is a durable message inside the compactable region, so it holds its position in the prefix until a compaction replaces the span containing it. At that point the projection that owns the snapshot forgets it in the same step it is removed, and the next assembly emits the current value again — so the block reappears at a new history position rather than mutating the reusable prefix in place. Between checkpoints the text does not change, which is what keeps an unchanged project from churning the prefix.

### Directory conventions

#### What the model sees

After a successful `read`, `write`, or `edit` inside the project, the next request includes one sourced `user/message` carrying the `CONTEXT.md` files that apply to the touched directory, nearest first.

##### Convention message template

```markdown
Conventions for directories this session has touched:

## src/CONTEXT.md

<src declarations>

## CONTEXT.md

<root declarations>
```

#### Token effect

Each touched directory delivers its applicable files once per session. The message is bounded by `maxConventionFileBytes` per file and `maxConventionSessionBytes` for the session; a file over the per-file ceiling is reported as a note rather than dropped, because a convention the model was never told about is indistinguishable from one that does not exist.

#### KV Cache effect

Append-only, at the end of history, so delivery never invalidates the reusable prefix.

### Ledger tool results

#### What the model sees

`ledger_write` and `ledger_promote` report what was recorded and at which tier; `ledger_read`, `ledger_search`, `ledger_history`, and `ledger_handoff` return the requested records; `ledger_status` reports the rung in force, its ceilings, the census, and the session's token usage.

##### Ledger status rendering

```markdown
project: /work/demo
budget: rung balanced, configured balanced (static profile)
ceilings: {"profile":"balanced","maxIndexEntries":16,"maxIdentityBytes":2048}
recorded: 3 total {"build":1,"note":2} tiers {"confirmed":1,"auto":2}
injected: 1 · retrievable only: 2
injected block: 412 bytes
session usage: 1200 tokens used of 200000 (deepseek/demo)
```

#### Token effect

Tool results enter history like any other result and are bounded by the same ceilings they read: `maxEntryBytes` for one body, `maxSearchResults` and `maxExcerptChars` for search, `maxArchiveRows` for history and handoff, and `maxBriefBytes` for a brief. Only `output.render` reaches the model, so a canonical value never inflates the transcript.

#### KV Cache effect

Ordinary tool-result appends. No ledger call mutates an earlier message.

## Known Limitations and Deferred Work

- **One request can go without the block after a compaction.** The snapshot projection runs before the pre-step waterfall where pressure compaction happens, so the step on which a compaction removes the snapshot omits it and the next assembly restores it. Overflow recovery can miss it for one retried request. Injecting a fresh copy after every compaction was rejected as trading a bounded, self-healing gap for unbounded log growth.
- **Only local-only memory exists.** Entries live under the Harness home keyed by project root, so a fact recorded in one checkout does not travel to another, and one project path is one ledger.
- **A session whose project was never resolved is not archived**, because there is no ledger to file it under.
- **The adaptive rung is chosen at checkpoints, not per request.** A window that fills mid-turn keeps its rung until the next turn boundary, which trades a little accuracy for prefix stability.
- **Conventions are not refreshed.** A `CONTEXT.md` edited after delivery is not re-sent in the same session.
- **A tombstoned entry stays in the catalog.** There is no delete; the catalog line counts every stored entry, so retiring a fact means editing the memory directory by hand.
