# Agent Note: Project context ledger — durable project context as a standalone DSH plugin

Status: proposed

English | [中文](2026-10-02-project-context-ledger.zh.md)

## Problem

DeepSeek Harness resolves a *workspace*, not a *project*. When a session starts in some directory, the model learns nothing about which project this is, what that project has already decided, or what the previous session left behind. Three consequences follow: every new session rebuilds the same mental model from scratch; project-level decisions live only in conversation history and die at the first compaction; and a long task that overruns its window cannot be continued anywhere.

Existing first-party packages cover one part of this and no more. `dsh-agent-instructions` loads `AGENTS.md`/`CLAUDE.md` guidance but stores no memory, keeps no archive, and performs no handoff. `docs/cookbook/extension-cookbook.md` defines Memory as a one-line recipe — "section provider + tool" — with no implementation behind it. `dsh-session-reference` can snapshot another session, but nothing turns that into continuity.

Two community plugins occupy the obvious name and neither is usable. `buhuikongpan/dsh-project-context` injects one fixed paragraph announcing that the directory is a project; it has no memory, archive, or handoff. `P02-1010751281/dsh-project-context` advertises exactly the missing feature set — session archive with a mechanical index, memory consolidation, automatic handoff — but fails L5 runtime verification on dsh 0.1.7-rc.2 (`boot failed`) and 0.1.7-alpha.2 (plugin directory tree failed to load), so there is no working baseline to improve. It also writes memory into `CONTEXT.md` and `MEMORY.md` as the source of truth, which bypasses the session log and violates *Model-visible ⟺ logged*.

Four failure modes are already characterized: compaction discarding injected constraints, context fragmentation across agents producing collective policy violations, attention dilution from polluted context, and hard window overflow. DSH's architectural advantage is that context handling can be audited and replaced; no plugin currently applies that advantage at the project scale.

Two constraints govern the whole design rather than any one layer.

**The new context must not cost more than it saves.** A plugin that carries project knowledge into every session is worthless if the carrying consumes the budget that made the task possible. Restraint is a functional requirement here, not a tuning exercise.

**A third-party plugin cannot add to the session log.** Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and `Session.append()` cannot set that marker, so a plugin that appends a new event type leaves a log its own reader refuses. Every durable thing this design records therefore lives outside the log, and everything the model sees is carried by extension points that already log.

## Proposal

Add **`dsh-context-ledger`**, a standalone DSH plugin installed into a profile bundle. It requires no change to DSH source. It gives a session a durable notion of *project*: which project this is, what conventions it carries, what has been learned, what the last session concluded, and how much context budget remains.

The plugin is organized as six layers, each built only on documented extension points.

Activation is deployment-level through a validated `enabled` field. Only sessions carrying a `cwd` participate; system and background sessions are untouched. A per-session toggle is not offered, because recording one durably would require a plugin-owned session event (see No plugin-owned session events).

Three principles hold across every layer:

**Local only.** The plugin writes nothing inside the project tree. Memory lives under `$DSH_HOME`, keyed by the resolved project root, and never enters version control. A project's memory belongs to one user on one machine.

**Nothing is carried that is not earned.** Project-scope knowledge is injected into every session of that project, so its size is a standing tax on every future session. Only confirmed, short entries earn a permanently injected slot.

**Two scopes, two lifetimes.** Project scope outlives sessions and is bounded; session scope dies with its session and is never re-injected.

### Layer map

| Layer | Owns | DSH extension point | Built |
|---|---|---|---|
| 1 Identity | Project root, stack line, memory index | `ctx.systemPrompt.context()` | Yes |
| 2 Conventions | Directory-scoped `CONTEXT.md`, progressive disclosure | `tools/result` touch tracking, `agent.inject()` | Yes |
| 3 Memory | Record, read, search, confirm, local persistence | `ctx.tools.register()`, files under `$DSH_HOME` | Yes |
| 4 Continuity | Mechanical session archive, handoff brief | `ctx.sessions` flush, `ctx.sessionQuery`, plugin-owned files | Partial |
| 5 Model-visible surface | What the ledger contributes to a request | Runtime-context snapshot; inbox injection for conventions | Yes |
| 6 Budget | Profile, ceilings, adaptive rung, census, session usage | `ctx.tokenMeter`, `ctx.llm`, resolved budget | Yes |

### Context scopes and lifetime

**Project scope** is knowledge that belongs to the project and outlives any one session: build commands, ownership boundaries, decisions already settled, recurring pitfalls. It is injected into every session of that project through Layer 1. Because that injection is unconditional, its size is capped twice over — a hard entry-count ceiling and a hard byte ceiling — and admission is restricted to entries a human confirmed (see Trust gradient). An entry that loses a slot is not deleted; it becomes retrievable only, through `ledger_read` and `ledger_search`.

**Session scope** is knowledge that belongs to the work in progress: the current sub-goal, a hypothesis being tested, an intermediate finding. It is not built, and it has no viable mechanism yet. Recording it was to happen through session events, which a third-party plugin cannot create; writing it to disk would contradict the non-persistence rule that defines the scope; and injecting it as a per-request block would make it outlive its session by remaining in history. The layer is therefore deferred as a design problem rather than as unwritten code, and nothing about it is load-bearing for the layers above.

| | Project scope | Session scope |
|---|---|---|
| Outlives its session | Yes | **No** |
| Injected every request | Yes, bounded | No — lives in the session's own history |
| Written to disk | Yes, under `$DSH_HOME` | **No** |
| Visible to a new session | Yes, if it has a slot | **No** |
| Admission requires confirmation | Yes | No |
| Failure if removed | Falls back to retrievable-only | Treated as never recorded |

Session scope is explicitly not a staging area: an entry does not graduate from session to project scope by being useful, because "useful" has no mechanical test. Promotion is a separate act with a recorded approver, which is what keeps the permanently injected payload under human control.

### Layer 1 — Project identity

The plugin resolves the project root by walking up from the session `cwd` and matching `projectRootMarkers` (default `['.git']`). A marker counts whether it is a directory or a file, so a worktree or submodule root is found. Unlike the first-party loader's equivalent walk, the miss is reported rather than erased: a bare directory is not a project, and the plugin contributes nothing rather than asserting an identity it does not have.

One dynamic context named `context-ledger:identity` is registered through `ctx.systemPrompt.context()`, placed ahead of `SANDBOX_POLICY`. The provider is re-evaluated for every assembly and emits the project name, the project root, the manifests that exist, and the memory headlines that earned a slot. Because the assembled snapshot declares that it supersedes earlier runtime-context snapshots, a branch switch or a newly confirmed fact becomes visible on the next step without explicit invalidation.

The block is deliberately small and deliberately stable. Rendering is a deterministic function of its inputs — fixed field order, LF endings, no timestamps, no locale formatting — so consecutive steps emit byte-identical text when nothing changed. Unstable prefix text invalidates the prompt cache on every request, which costs far more than the block itself; the same class of bug is documented for tool enumeration order. Deterministic ordering is therefore part of the contract, not an implementation detail.

The cache is keyed by the rendered text rather than by a digest of the inputs. A digest is a proxy for the text, and a proxy can omit an input and serve a stale block; comparing the text cannot.

### Layer 2 — Conventions

Built. This layer does not reimplement instruction loading: `dsh-agent-instructions` already owns `AGENTS.md`/`CLAUDE.md` discovery, baseline plus `.local` overlay resolution, per-directory dedup, on-touch refresh, and durable user-role injection, and duplicating any of it would create two owners for one fact.

The ledger adds a file class that package deliberately does not claim: directory-scoped `CONTEXT.md`. These carry task-shaped project knowledge — how to run the tests, which module is being migrated — rather than behavioral instructions. They are authored by people and read from the project tree; the plugin never writes them.

Delivery follows progressive disclosure. `tools/result` tracks the paths a successful `read`/`write`/`edit` touched, and a touched path is resolved to its candidate convention files by walking from that file's own directory up to the project root. The nearest convention therefore arrives first, and a root-level one still covers everything. Candidates are marked delivered before they are read, so a directory touched repeatedly is probed once, and each file is delivered at most once per session.

Delivery goes through `agent.inject()`, not the always-on block. That is what makes a convention's cost one-off instead of per-request, and the inbox is the sanctioned seeded-context channel: the Harness logs the splice as `agent/inbox/spliced`, so the injection stays within *model-visible ⟺ logged*.

Two bounds apply. A file over the per-file ceiling is delivered as a note rather than dropped — a convention the model was never told about is indistinguishable from one that does not exist — and the session's total convention bytes are capped separately, so a project with many `CONTEXT.md` files cannot accumulate an unbounded one-off cost.

The delivered message carries a source kind this plugin owns. `MessageSourceMap` is merge-extensible on purpose: each producer declares its own kind and consumers fall through unknown ones. The session format confirms the openness rather than merely implying it — its migration chain maps an unrecognized plugin identity to `plugin:<name>` instead of rejecting it — so no registration is needed and no first-party kind can be shadowed.

An earlier draft routed delivery through an `agent/pre-step` waterfall with inbox splicing, mirroring `dsh-agent-instructions`. The inbox alone is enough: this plugin adds context for the next step and never rewrites a decision, so the waterfall and its step-open bookkeeping would have been machinery with nothing to decide.

### Layer 3 — Memory

Memory persists under `$DSH_HOME/context-ledger/`, keyed by the resolved project root plus a hash of its path, with a readable name prefix so the directory is identifiable while debugging. Nothing is written inside the project tree, so nothing can be committed and no `.gitignore` discipline is required of the user.

One markdown file per entry, with a versioned JSON frontmatter header. JSON rather than YAML because the header must round-trip exactly and parsing it needs no dependency; markdown because the body is prose a person is expected to read and edit. A write lands in a temporary sibling and is renamed into place, so a reader never observes a half-written entry and an interrupted write leaves the previous contents intact.

There is deliberately no derived index file. Listing scans the directory, which keeps a single source of truth for content and removes the question of what to do when a cache and its source disagree. Entry ids are derived from the kind and a normalized title, so re-recording the same fact updates it in place instead of accumulating near-duplicates.

Writes go through the model-facing tools and never through a direct file write by a human, but the files remain editable: an unreadable or malformed file is reported with its reason and skipped, never fatal to a listing.

An entry's tier is preserved across a rewrite. Rewriting a confirmed fact with new wording does not silently demote it, because that would undo a human decision as a side effect of an edit.

A global scope for cross-project facts is planned and not built; the store is project-scoped only.

### Layer 4 — Continuity

The archive is built. Every session that ran inside a project is archived when it is disposed, and the row is derived from that session's log alone — no model call — so it cannot itself lose information and cannot disagree with the log it came from. A row records the span, turn count, step count, tool-call count, compaction count, goal-change count, how the last turn ended, and the files the session touched.

Capture is ordered rather than incidental. Disposal fires after the driver has quiesced, so the in-memory log is complete, but buffered events may not be durable; the plugin therefore flushes the session before reading it, because reading first would archive a row that silently misses the tail. Disposal is an emit rather than a serial dispatch, so nothing awaits capture: it owns its failures and can never surface as a teardown error. A session whose project was never resolved is not archived, because there is no ledger to file it under.

Two parts of the intended design are deferred, both for the same reason — the reachable seam does not accept what the design wanted to give it.

**A cross-session snapshot.** `ctx.sessionReferenceResolver.prepare()` is the sanctioned way to build a bounded read-only view of another session, and it works from a plugin. But that service is not in the shipped bundle, so a brief that depended on it would be dead code in a default deployment. It belongs with a deployment that mounts the service.

**An automatic continuation.** Opening a fresh session and seeding it with the brief is not reachable: `ctx.subagents.startContinuable` creates a new session but takes its seed from the provider rather than the caller, and `ctx.agents.create({ seed })` is agent-loop factory infrastructure rather than a published plugin seam. A subagent is also the wrong shape — a delegated task, not a continuation of the main thread.

So the handoff produces a **brief** instead. It is a pure function of the archive rows and the injected facts, byte-bounded, and it sheds in a fixed order: the facts first, because a session started in the same project receives them automatically and they are the only genuinely redundant part at the destination; then the path lists; then every row but the most recent; then everything but the header and the closing instruction. Nothing is truncated mid-value.

The brief's last line is the actual instruction, and it is the point of the layer: start a fresh session in this project rather than continuing one that is nearly full, because the new session gets the project block and the confirmed facts on its own, and the brief only adds what is in flight.

Compaction counts come from folding `compaction/start` events rather than from a projection. `CompactionEngine` exposes only the compact operations, not current usage, and a plugin-owned projection unit would need a zod schema and a merged projection key. Folding the same log the counts come from avoids both, and avoids depending on `session-stats` being mounted — it is not in the shipped bundle.

That fold reads the `compaction/start` and `compaction/end` pair, which raises the question of whether a deployment could swap in its own compaction engine and silently stop emitting it. It cannot. The pair is mandatory rather than conventional: the compaction invariant fails a `compact-checkpoint` replacement with no matching `compaction/start`, and the session format rejects a summary without a start or a successful end without exactly one summary. An engine that emitted neither would fail its own checks, so the archive's compaction count rests on a platform guarantee rather than on an engine behaving well.

### Layer 5 — Model-visible surface

Everything the ledger puts in front of the model travels through extension points that already log, so *Model-visible ⟺ logged* holds without a plugin-owned event type.

The identity block is a runtime-context snapshot. `RuntimeContextProjection` materializes it as a durable user-role message, and only when the retained text differs. That has two consequences worth stating: each materially changed snapshot is exactly one logged message, and byte-stability is not a nicety but what keeps the log from filling with repeats.

Per-entry bookkeeping — its body, its timestamps, its tier history — never reaches a request at all. Only a bounded headline does, and only for entries a human confirmed. Bodies are fetched on demand, so their output is bounded by the tool result limit like any other tool.

This layer replaces an earlier plan to register a message projection per plugin event. That plan is not implementable: a projection interprets an event type, and a third-party plugin cannot create one.

### Layer 6 — Budget and introspection

`ledger_status` reports the resolved budget profile and its ceilings, the census by kind and tier, how many entries have a slot, how many are retrievable only, how many files were skipped, the byte size of the injected block, and session token usage with the basis it was derived from. It keeps no state of its own.

It is the counterpart to Codex's `_context` tool: it lets the model see budget pressure before it becomes a failure rather than discovering it after a truncated turn.

Session usage comes from the token meter's `measure(session)` and, when a route is resolvable, the model's declared context window. Compaction does not expose usage, so the window is resolved from the routed model independently. A route that cannot be resolved costs only the window figure, not the whole report.

### Budget profiles

A `budgetProfile` selects a named bundle of ceilings, and the plugin resolves that request into a concrete `BudgetSpec` before enforcing anything:

```ts
resolveBudget(request?: {
  profile?: 'frugal' | 'balanced' | 'full'
  overrides?: Partial<BudgetCeilings>
}): BudgetSpec
```

`resolveBudget` is an explicit step in the owning implementation rather than a hidden default inside the injection path, so the numbers actually enforced are inspectable through `ledger_status` and reproducible on replay. Individual ceilings stay overridable; a profile is a starting point, not a lock.

| Ceiling | `frugal` | `balanced` (default) | `full` |
|---|---|---|---|
| `maxIdentityBytes` (whole block) | 512 | 2048 | 8192 |
| `maxIndexEntries` | 4 | 16 | 48 |
| `maxIndexBytes` (headlines alone) | 512 | 2048 | 8192 |
| `maxIndexEntryBytes` (headline ceiling) | 96 | 160 | 320 |
| `maxEntryBytes` | 4096 | 16384 | 65536 |
| `maxSearchResults` | 5 | 10 | 25 |
| `maxExcerptChars` | 120 | 240 | 480 |
| `maxArchiveRows` | 3 | 10 | 25 |
| `maxArchivedPaths` | 10 | 20 | 40 |
| `maxBriefBytes` | 2048 | 4096 | 8192 |
| `maxConventionFileBytes` | 4096 | 16384 | 65536 |
| `maxConventionSessionBytes` | 8192 | 32768 | 131072 |

Zero is a usable ceiling meaning "none". It is how the adaptive floor expresses "no headlines", and how a deployment turns one path off without changing profile.

**The ceilings are bytes, not tokens.** A token-denominated ceiling would need a tokenizer the plugin does not have, and reporting a byte count as a token count would overstate what is known. Byte ceilings are exact and cheap to enforce. `ledger_status` reports the session's real token usage separately and labels it as session-wide rather than as the ledger's own share, because attributing a share of a measured session total to one contributor is not something the available interfaces support.

`full` raises every ceiling and keeps them. It does not remove the ceiling: an always-on injection with no upper bound is the failure this mechanism exists to prevent, so a deployment that genuinely wants one states it through an override, where it is visible in configuration review rather than implied by a preset whose name suggests safety.

A profile tunes size only. No profile changes a scope's lifetime or admits an unconfirmed entry to the index. Those are invariants of the design, not settings.

#### Adaptive

`adaptive` is the dynamic mode, and it is built. It deliberately does not compute a size per request: a payload that changes on every step invalidates the prompt cache and costs more than the knowledge it carries.

Instead it selects a rung from the free window:

```
rung = the widest profile whose maxIdentityBytes fits within
       (contextWindow - usedTokens) * adaptiveUtilizationRatio
```

The ladder is the three profiles above, plus one floor below `frugal` at which the ledger contributes the identity block and the catalog only. That floor is the honest answer for a window that is nearly gone: the correct behavior is to stop adding, not to keep a headline. It is not a selectable profile, because a deployment should not be able to ask for it directly and then wonder why its memory is empty.

The rung is chosen only at checkpoints: session start, a turn boundary, and the end of a compaction. Between checkpoints the block is byte-stable, so Layer 1's cache property holds. The compaction checkpoint carries the same platform guarantee as the archive's compaction count — the bracket is mandatory, so a replacement engine cannot silently leave the rung un-remeasured while the window fills. When the window cannot be measured — no token meter, no routed model, or a route that does not declare a window — the plugin uses the default profile rather than guessing, because a wrong guess is either a silently empty ledger or a silently oversized one.

Because a shrinking payload is indistinguishable from a broken one, `ledger_status` reports the configured profile, the rung in force, the ratio, the measurement behind it, and the reason the measurement was or was not available. At the floor it also says so in words, since that is the case an operator is most likely to mistake for a failure.

`adaptiveUtilizationRatio` defaults to `0.05`.

#### Discovery instead of eviction

Profiles decide what is pushed. They do not answer what happens to knowledge that is not pushed, and a model that cannot see an entry will not miss it. Two mechanisms close that gap, and both are built.

**A catalog line.** The block always reports how many facts are recorded and how many earned a headline, broken down by kind — for example `Memory: 12 recorded, 2 shown (build 4, decision 5, pitfall 3)`. It is omitted only when nothing is recorded, so a project whose facts are all unconfirmed still advertises that they exist. The count it reports is what is actually on screen, never what was merely eligible: a catalog claiming a headline that was shed would misstate what the model can see.

**`ledger_search`.** A tool that queries titles and bodies and returns bounded matches. This is the structural fix: retrieval is cheaper than injection, scales without a ceiling, and lets the model ask for what the task needs instead of receiving a headline dump it did not request.

Together they change the shape of the problem. Under a bare ceiling the risk is that the model never learns the knowledge exists; with a catalog line and a search tool the worst case is one extra tool call, and the ceiling becomes a choice about cost rather than about what the model is allowed to know.

### Constraint placement

The source design this note derives from proposes a three-tier immutable / high-priority / evictable projection priority to defend injected constraints against compaction, citing evidence that current compactors retain only about 17% of injected side constraints. That fight is unnecessary in DSH, and the ledger avoids it by placement rather than by priority:

| Constraint class | Where it lives | Lost to compaction? |
|---|---|---|
| System, safety, compliance | `ctx.systemPrompt.section()` | No — re-rendered per request, never materialized as history |
| Task-level: current goal, active constraints | `ctx.systemPrompt.context()` | Compacted with history, then re-emitted: the projection forgets a snapshot in the same step it is removed |
| Project identity and memory index | `ctx.systemPrompt.context()` | Same |
| Conversation history | Session log projection | Yes |

The precise claim matters, and it is now verified rather than asserted. A runtime-context snapshot *is* a durable user-role message and *is* therefore inside the compactable region; an earlier draft of this note said otherwise and was corrected. What replaced it raised a sharper worry: the projection emits only when its text differs from what it retained, so a snapshot compacted away while the projection still believed it was retained would drop the block permanently.

That cannot happen, and the reason is an invariant rather than a coincidence. The projection invalidates its retained snapshot whenever a replacement surface event cites that snapshot's seq in `sourceEventSeqs` (`packages/core/agent-loop/src/runtime-context.ts:134-142`). The session surface refuses to remove a node that is not listed in the replacement's `sourceEventSeqs` (`packages/core/session/src/surface.ts:367-370`). So "the snapshot was compacted away" and "the projection forgot it" are the same condition, and the block is re-emitted at the next assembly whether or not its text changed.

Two consequences follow. Byte-stability still matters, but for a different reason than the earlier draft gave: it prevents a message per step, not a permanent loss. And what exists is a bounded gap rather than a hole — `project()` runs before the pre-step waterfall where pressure compaction happens, so the step on which a compaction removes the snapshot omits it and the next assembly restores it. Overflow recovery behaves the same way, where the retry can miss it for one request.

Anything that must never be lost is never placed where it can only be recovered from history. Retention for the compactable region is therefore handled by re-emission rather than by a priority scheme inside the compactor, and the placement is what makes the cost predictable: everything outside the conversation accumulates at a size the configuration controls rather than with conversation length.

### No plugin-owned session events

An earlier draft specified seven `ledger/*` session event types carrying `ignorable: true`. None of them is implementable by a third-party plugin, and the reason is worth recording.

`Session.append()` builds the envelope from `type`, `seq`, `time`, and `data` plus surface metadata. `ignorable` is an envelope field with no append argument that sets it. The read path refuses any type outside the generated known-type set unless that marker is present. First-party packages join that set because they are in the repository; a plugin installed into a profile cannot. The authoring guidance states the rule directly: do not append session events with a new type; derive state from existing events, or keep plugin-owned data in a store found through inspection.

Consequences, all of them already reflected above:

| The earlier draft stored | It now lives |
|---|---|
| Per-session enable toggle | A deployment-level `enabled` field |
| Per-session budget override | A deployment-level `budgetProfile` |
| Memory proposals, commits, retirements | Files under `$DSH_HOME`, with the tier in the entry header |
| Archive rows | Not built; would be plugin-owned files |
| Handoff records | Not built |
| Message projections for those events | Nothing to project; the block is a runtime-context snapshot |

The property the event design was meant to buy — replayable plugin state — is genuinely lost, and is recorded as a risk rather than papered over. What is not lost is *Model-visible ⟺ logged*, because the block is carried by a first-party mechanism that logs.

### Storage layout

```
$DSH_HOME/context-ledger/
  projects/<name>-<hash12>/
    memory/<entry-id>.md
```

Nothing is written under the project tree. `<name>-<hash12>` pairs a readable directory name with a hash of the resolved project root, which is what actually identifies the project: two checkouts sharing a directory name do not collide, and moving a checkout to a new path starts a distinct project. Entry ids are validated against a strict pattern before being joined onto a path, so a model-supplied id cannot address a file outside the memory directory.

There is no derived artifact. The entry files are the content and the only authority over it.

### Configuration

Every deployment-varying choice is a validated `Config` field; no constant is hardcoded.

| Field | Default | Meaning | Built |
|---|---|---|---|
| `enabled` | `true` | Contribute anything at all | Yes |
| `archiveEnabled` | `true` | Archive a session when it is disposed | Yes |
| `contextOrder` | `100` | Placement among runtime contexts, ahead of `SANDBOX_POLICY` (110) | Yes |
| `projectRootMarkers` | `['.git']` | Markers used to resolve the project root | Yes |
| `stackManifestNames` | `['package.json']` | Manifests reported on the stack line | Yes |
| `includeProjectName` | `true` | Include the project name line | Yes |
| `budgetProfile` | `'balanced'` | Named bundle of ceilings | Yes |
| `budgetOverrides` | `{}` | Per-ceiling overrides over the profile | Yes |
| `ledgerHome` | `$DSH_HOME` | Ledger root; nothing is written outside it | Yes |
| `conventionFileNames` | `['CONTEXT.md']` | Directory-scoped convention files; must not overlap the instruction-file candidates | Yes |
| `adaptiveUtilizationRatio` | `0.05` | Free-window fraction the adaptive mode may spend | Yes |

Misconfiguration that is self-contained fails at load. A non-finite `contextOrder`, an empty marker or manifest list, an unknown budget profile, an unknown override key, a ceiling that is not a non-negative integer, and a non-positive `adaptiveUtilizationRatio` all fail activation rather than silently changing behavior. A `conventionFileNames` value colliding with `dsh-agent-instructions`' candidates must fail loudly rather than producing two owners for one directory.

`budgetProfile` accepts the adaptive mode as well as the three ceiling profiles, and `budgetOverrides` is validated even under the adaptive mode, so a bad override fails activation rather than the first assembly.

The injection ceilings are deliberately absent from this table. They have exactly one owner, the budget profiles, so `maxIdentityBytes` and its siblings cannot acquire a second default.

### Trust gradient

| Tier | Written by | Has a slot |
|---|---|---|
| `auto` | Model proposal | No |
| `confirmed` | Human approval | Yes, if the headline fits |
| `curated` | Human approval | Yes |

The model can only write `auto`. Promotion goes through the harness approval surface, which reuses the existing `approval/asked` and `approval/decided` events, and happens only on an `allowed-once` outcome. Where no approval surface is composed the request resolves to `unavailable` and the fact stays unconfirmed: injection is a standing cost, so it is never granted without a human, and failing closed is the correct behavior rather than an error to work around.

Because only confirmed knowledge is ever carried into a new session, the permanently injected payload is exactly the set a human agreed to pay for.

### Packaging and loading

The plugin ships as an unscoped ESM package named `dsh-context-ledger`, plain ESM with JSDoc types and no build step, which is the form the authoring reference gives for a Host-only bundle. Its entry exports `name`, `inject`, `apply`, and `Config`.

`inject` names only what the plugin cannot function without: `systemPrompt` and `tools`. The filesystem provider, token meter, model router, and approval surface are read through `ctx.get`, so a deployment missing one loses only that capability instead of failing to load, and a plugin that declares a service it does not need is inactive in profiles that lack it.

It declares `dsh.bundle` in its manifest so installation is `dsh plugin --profile <name> add <spec>` and the profile bundle wiring is generated. Hand-writing a loader entry is not supported: a duplicate entry id fails startup, which is the documented failure mode of one of the plugins that occupies this name. Pinning a commit or tag is required for reproducible installs.

Because the plugin writes only under `$DSH_HOME`, a deployment running `SandboxMode` `read-only` loses memory persistence and says so, rather than failing to start. It does not fall back to `node:fs` for reads: reaching around an absent filesystem provider would work on the developer's machine and silently bypass the sandbox and any remote filesystem.

### Implementation status

All four phases are closed: 0 to 3 built and tested, 4 closed by declining its stated engine and delivering the observability the phase actually needed.

Built: the identity block, the budget profiles and the adaptive mode, the file-backed project memory, the mechanical session archive, directory conventions delivered on touch, and seven model-facing tools (`ledger_write`, `ledger_read`, `ledger_search`, `ledger_promote`, `ledger_status`, `ledger_history`, `ledger_handoff`). 196 unit tests cover the budget resolver and the rung ladder, the entry model and its stored format, the archive row and its stored format, the store over real temporary directories, the renderer's byte stability and shedding order, the brief's shedding ladder, convention candidate resolution and the once-per-file ledger, the tools, and the plugin wiring including capture ordering, convention delivery, rung movement at checkpoints but not on tool results, and `ledger_status` reporting the rung a session actually took. Loader-side verification shows the module importing and all ten `Config` fields collected with no diagnostics.

Verified by reading code rather than by running it: the retention mechanism above, and the mandatory `compaction/*` bracket. Both are cited to the lines that establish them.

Not verifiable here: that the block reaches a running model request, that a confirmed fact survives compaction in practice, that byte-stability suppresses snapshot churn end to end, that a brief helps a fresh session, and that a delivered convention arrives before it is needed. All of those need a live model, which this checkout has no key for. Archive derivation is likewise exercised only against synthetic event lists, not a real session log.

What reconnaissance changed, beyond the event table: the per-session gate became a deployment field; the ceilings became bytes; the derived index file was dropped in favour of scanning; the digest-based cache key was replaced by comparing rendered text; the injection ceilings moved out of `Config` into the profiles so they have one owner; the automatic continuation and cross-session snapshot were dropped for want of a reachable seam; convention delivery moved from an `agent/pre-step` waterfall to the inbox alone; aging was declined; the global scope was deferred; and the replacement compaction engine was declined in favour of making the adaptive mode observable.

### Delivery phases

| Phase | Delivers | Exit criterion | Status |
|---|---|---|---|
| 0 | Layer 1 identity | A new session in a git checkout shows a `<project_context>` block; the block is byte-identical across steps whose inputs did not change | Done |
| 1 | Layer 3 project memory, the four memory tools plus `ledger_status`, static budget profiles with explicit resolution | A confirmed fact survives compaction and appears in a later session without re-reading the old transcript; a term present only in a fact without a slot is still reachable through `ledger_search`; a directory without a marker contributes nothing | Done |
| 2 | Layer 4 mechanical archive, `ledger_history`, `ledger_handoff` | An archive row is a pure function of the session's events and is reproducible from the log alone; capture flushes before reading so the row cannot miss the tail; the brief carries the recent sessions and the injected facts within its byte ceiling | Done |
| 3 | Layer 2 conventions, the adaptive mode with checkpoint switching | A directory `CONTEXT.md` is delivered on touch and not before, once per file per session, nearest first; a convention over the per-file ceiling is reported rather than dropped; a rung moves only at a checkpoint and never on a tool result; an unmeasurable window falls back to the default profile | Done |
| 4 | Adaptive observability; the replacement compaction engine Phase 4 originally named was declined | An adaptive deployment can explain from `ledger_status` which rung it is on and why; a deployment that replaces `ctx.compaction` changes retention behavior without the ledger needing a change, because the `compaction/*` bracket it folds is enforced by the platform | Done |

Phase 4 as written asked for an opt-in replacement compaction engine. That is declined, for the reasons under Alternatives considered, and its exit criterion turned out to be already satisfied: the ledger needs no change to survive a replacement engine, and the `compaction/*` bracket it depends on is enforced by the compaction invariant and the session format rather than by convention. The work the phase actually needed was the opposite of a new engine — the adaptive mode was unobservable, so a deployment whose block shrank to the floor had nothing to look at but an empty ledger. That is what Phase 4 delivered.

Phase 3 originally also carried `indexAgingSessions` and a global scope. Aging was declined and the global scope deferred; both are recorded under Alternatives considered, and neither is silently missing.

Phase 2's original exit criterion — that a handoff continuation answers a question about work done before the handoff — was written assuming the plugin could open a continuation. It cannot (see Layer 4), so the criterion became the one above: verifiable properties of the archive row and the brief instead of a behavior that needs a live model and a seam that does not exist.

## Alternatives considered

**Open a continuation session automatically and seed it with the brief.** This was the design and it has been dropped, because the seam does not accept a caller's seed. `ctx.subagents.startContinuable` creates a new session but takes its seed from the provider, so the brief could not be placed at the start of it; `ctx.agents.create({ seed })` accepts a seed but is agent-loop factory infrastructure rather than a published plugin seam, and its seed is a raw event prefix rather than a brief; and a subagent is a delegated task rather than a continuation of the main thread. Composing those primitives anyway would mean depending on an internal seam that can change without notice. The brief is returned instead, and the layer's value rests on the fact that a new session in the same project already receives the project block and the confirmed facts.

**Have the archive store model-written summaries.** Rejected because the plugin's whole claim is that it never contradicts the log. A summary derived from a session is a second, lossier account of something that already exists, and the failure mode is quiet: it drifts from the log and nobody can tell which is right. A row of counts and names cannot drift, and `ledger_read` plus the session log are there for anything the counts do not answer.

**Build the cross-session snapshot on `ctx.sessionReferenceResolver`.** Deferred, not rejected. The service is the sanctioned way to build a bounded read-only view of another session and it is callable from a plugin, but it is not mounted by the shipped bundle, so the code would be unreachable in a default deployment — the same reasoning that keeps `session-stats` out of the capture path. It belongs with a deployment that mounts the service.

**Age an index slot out after N unreferenced sessions.** This was in the design and it has been declined. The entry-count and byte ceilings already bound the always-on payload, so aging cannot tighten that bound — it only decides which facts hold the slots, and its effect is to evict a rarely-touched fact in favour of a recently-touched one. That is precisely the harm the design's own risk list named, and a rarely-touched fact is often the load-bearing one: a quarterly release procedure is touched rarely and is exactly what must still be there. The mechanism that protects such a fact already exists and is stronger than aging, because it is a deliberate act rather than a timer: promoting it to `curated` outranks everything and is never displaced by recency. Aging would have added a second, weaker lever whose failure mode is silent removal.

**Give the global scope its own injection path now.** Deferred, not rejected. A global fact would be injected into every project's every session, which is a larger standing tax than any project fact and is paid by projects the fact may have nothing to do with. The restraint principle this design is built on — nothing is carried that is not earned — applies with more force, not less, at that scope. Adding it should decide two things first: whether a global fact belongs in every project's block at all or only in the ones that ask for it, and what separate ceiling bounds it, since letting it compete with project headlines for one budget would let a global fact crowd out the project's own knowledge. Those are design questions worth answering explicitly, not defaults to assume.

**Route convention delivery through an `agent/pre-step` waterfall.** Built the other way, and the waterfall was dropped. `dsh-agent-instructions` needs a waterfall because it reconciles instruction sets: it rewrites the messages a step will admit, and it defers mutations while a step is open. This plugin only adds context for the next step and never rewrites a decision, so the waterfall, its `next()` delegation obligation, and its step-open bookkeeping would all have been machinery with nothing to decide. The inbox records what was actually delivered, and the Harness logs the splice either way.

**Ship an opt-in replacement compaction engine.** Declined, and the seam is not the reason. Replacing `ctx.compaction` is genuinely supported: `packages/compaction/compaction/README.md` documents extending the base class and loading it as a plugin, and `docs/subsystems/compaction.md` describes a backend as a sibling package implementing the same interface. The reason to decline is that it is a different product. A compaction engine owns summarization, region selection, token accounting, checkpoint semantics, and the concurrency lock; this plugin would have to reimplement all of it in order to change retention behavior that it has already designed away by placement. A design whose central claim is "that fight is unnecessary in DSH" should not then enter the fight. A deployment that wants different retention behavior can take the seam itself, and the ledger keeps working across the swap because its only coupling is the `compaction/*` bracket, whose presence the platform enforces.

**Re-assert the block by injecting it after every compaction.** Rejected. It would close the one-request gap, but it would do so by appending a fresh durable message on every compaction, forever — trading a bounded, self-healing one-request gap for unbounded log growth. The inbox is a one-shot delivery channel, not a re-materialization primitive, and using it as one duplicates the snapshot mechanism with a worse cost profile.

**Fork `P02-1010751281/dsh-project-context`.** It is the only existing implementation whose feature list matches the requirement. It fails L5 runtime verification on both recent dsh versions, so the first task would be diagnosing a startup failure rather than building a capability. Its memory model also contradicts *Model-visible ⟺ logged*, which is the property the whole design exists to preserve. Reusing its architecture means inheriting both problems.

**Fork `buhuikongpan/dsh-project-context`.** It runs, and its mechanism — dynamic context evaluated per step — is the right foundation, which is why Layer 1 reuses that shape. Its codebase has no memory, archive, or handoff to extend, so keeping it as a base buys nothing beyond the pattern already documented as a first-party extension point.

**Store project memory in the project tree and commit it.** This was the earlier position and it has been dropped. Committing machine-written memory publishes model-authored content into a shared repository and makes every teammate inherit one user's inferences, while adding a review burden to files nobody asked to review. Local-only keeps a project's memory a per-user artifact and makes deletion meaningful: removing the ledger directory forgets everything, completely and without residue. The cost, accepted knowingly, is that memory does not travel with the repository and a teammate does not inherit it.

**Store memory in `ctx.storageDomain` rather than as files.** The domain form is the sanctioned plugin-owned store, and it would add schema validation at open and change events on write. Files won because the bodies are prose a person is expected to read and edit, and because deleting a directory is a complete and self-evident way to forget everything — a domain has no equally obvious erase. The cost is that the plugin does schema-validate its own records and owns atomicity itself.

**Key the injected-block cache by a digest of its inputs.** Built this way first, and replaced. A digest is a proxy for the rendered text, so any input it omits serves a stale block; as Phase 1 grew the renderer's inputs from four to eight, keeping the two in step became the risk. Comparing the rendered text cannot disagree with what is injected, and rendering is a few string joins against a filesystem scan the plugin must do anyway.

**Denominate the ceilings in tokens.** Rejected because the plugin has no tokenizer, and any byte-to-token conversion would be a guess presented as a measurement. Bytes are exact, and the honest token figure — the session total — is already available and is reported where it belongs, labelled as session-wide.

**Let session-scope knowledge accumulate into project scope automatically when it proves useful.** Rejected because "useful" has no mechanical test, and the failure mode is silent: the permanently injected payload grows in proportion to how much the model has run, until every new session starts already carrying a budget it did not choose. Requiring a human approval event to cross the boundary keeps that growth a decision rather than a drift.

**Offer a mode with no ceiling at all.** Rejected because an always-on injection with no upper bound is the failure the ceiling exists to prevent, and its symptom — a prompt that grows until every request is slow and expensive — appears long after the setting was chosen. `full` raises the ceilings while keeping the number inspectable, and a deployment that truly wants no bound states one explicitly through an override, where it is visible in configuration review rather than implied by a preset name.

**Let the model choose its own budget.** Rejected because the model is the party whose context the budget is spent on, and nothing in a single turn's information distinguishes "I need more memory" from "more memory would be pleasant". A deployment chooses the profile, and `adaptive` covers the case where the right answer changes as the window fills without anyone deciding.

**Build inside the repository as `packages/context/project-context`.** This is the eventual destination if the plugin proves out. It is slower to first demo because it accepts the full in-repo bar — per-file 100% coverage, keyless recorded-session snapshots, bilingual docs, JSDoc gates, duplication detection. For an unvalidated design, that bar is paid before the design is known to be worth it.

**Adopt Scroll or RationaleVault for the model-visible surface.** The capability they contribute — run a program against session state and admit only what it prints — already exists locally as `dsh-ptc-runtime`, whose contract is to run one program against host-provided bindings and report what it printed and returned. Adding an external projection engine duplicates a first-party seam and widens the trust boundary.

**Adopt ContextDB or NeuSymMS for multi-graph memory.** No DSH equivalent exists, so this is a genuine capability gap rather than a duplicate. It is deferred rather than rejected: a mechanical store over capped, confirmed entries answers most continuity questions without a new storage engine, network dependency, or retrieval cost the byte ceilings do not govern. Multi-graph retrieval becomes worth its cost only after mechanical listing is measured as insufficient.

**Rely on `AGENTS.md` alone.** Instruction files are a human-authored static contract. They cannot record what a session learned and cannot be written by the model, because the model has no durable vocabulary for it — which is what the entry store is.

**Name the plugin `dsh-project-context`.** Rejected because two incompatible community plugins already hold that name, and the documented install path for one of them fails startup when a second loader entry with the same id exists. A distinct name keeps the loader entry ids and the failure mode unambiguous.

## Acceptance criteria

A session in a project directory shows a `<project_context>` block derived from the resolved project root, and the same block is reproduced on replay of that session's log.

A directory carrying no marker contributes nothing, and neither does a session without a working directory or a deployment without a filesystem provider.

The block is byte-identical across consecutive steps whose inputs did not change, and rendering is a deterministic function of its inputs — asserted directly against the renderer.

With every layer enabled, the resolved ceilings are enforced and reported: `ledger_status` returns the active profile and the exact ceilings in force, and `budgetOverrides` beats the profile.

Adding a fact never raises the per-request cost beyond the ceilings: once the entry-count or headline-byte ceiling binds, a further fact gets no slot and the block does not grow.

The catalog reports what is on screen, not what was eligible, and it is recomputed for whatever was actually rendered.

A fact that has no slot is still reachable: `ledger_search` returns it for a term it contains, within the tool result bound.

Content sheds in a fixed order — headlines, then the catalog, then the stack line, then the project name — and if even the root line cannot fit, nothing is contributed. Nothing is ever truncated mid-value.

No file is written under the project tree at any point; `git status` in the project stays clean across a full session.

A model-written fact is stored at `auto` and never appears in the block. Promotion happens only on an `allowed-once` approval, and where no approval surface exists the attempt reports `unavailable` and the tier is unchanged.

Rewriting a confirmed fact preserves its tier, so an edit cannot silently demote a human decision.

Deleting the ledger directory removes all memory: a subsequent session shows no facts, reports zero recorded, and produces no error.

A malformed or unreadable entry file is reported with its reason and skipped, and never fails a listing or a session.

An id that would escape the memory directory is refused before it is joined onto a path.

Every threshold in the Configuration table is changeable from `cordis.yml` and validated at load; an unknown profile, an unknown override key, or an unusable value fails activation rather than changing behavior silently.

With `SandboxMode` set to `read-only`, the plugin loads and contributes the block rather than failing to start.

Installing a second plugin declaring the same name, or hand-writing a duplicate loader entry, fails loudly at load with a message naming the collision.

An archive row is a pure function of a session's events, asserted directly against the deriver; a session with no events archives nothing.

Capture flushes the session before reading it, asserted on the call order, so a row cannot silently miss the log's tail.

A capture failure is logged and never surfaces as a teardown error, and it leaves no partial row.

A session outside any project is not archived, and with `archiveEnabled` false nothing is archived while the block is still contributed.

Re-archiving a resumed session replaces its row rather than adding one, because the later row covers a longer log.

A malformed or unreadable archive file is reported with its reason and skipped, and never fails a listing.

A brief carries the recent sessions and the injected facts within its byte ceiling, sheds in the documented order — facts, then path lists, then every row but the most recent, then the rows entirely — and never truncates a value mid-way.

A convention is delivered only after its directory is touched, never before, and only once per file per session; candidates run nearest-first from the touched file's directory up to the project root, and a file outside the project has none.

A convention over the per-file ceiling is reported in the delivered message rather than dropped, and one that cannot fit the session ceiling contributes nothing rather than a fragment.

A convention read failure is contained and logged, and the plugin never surfaces it as a tool failure.

The adaptive rung is the widest one whose whole-block ceiling fits the configured fraction of the free window, asserted across window sizes; a window with no room yields the identity-only floor; and an unmeasurable window falls back to the default profile rather than guessing.

An adaptive rung moves only at a checkpoint — session start, a turn boundary, or the end of a compaction — and never on a tool result, asserted by freeing the window and observing that a tool result does not widen the block while a turn boundary does.

A ceiling override of zero is accepted and means none, so a deployment can disable one path without changing profile, and the identity-only floor is expressible without a special case in the renderer.

`ledger_status` reports the configured profile, the rung in force, the ratio, and the measurement that chose the rung, asserted both against a stub and through the real wiring, so an adaptive deployment whose block shrank can see why instead of finding an unexplained empty ledger.

A session whose rung has not been measured yet reports that rather than reporting the default as if it had been measured, and a static profile reports itself as static rather than inventing a measurement.

## Risks

**A brief is not a handoff.** Nothing carries it anywhere: the model has to choose to produce one, and whoever continues the work has to act on it. A brief that is generated and ignored costs a tool call and changes nothing. The mitigation is that the brief ends with the instruction to start a fresh session, and that the new session is useful even if the brief is dropped — it receives the project block and the confirmed facts regardless.

**Archiving fails silently by design.** Capture happens on a disposal emit, so nothing awaits it and nothing reports its failure to anyone who is not reading logs. A deployment that expects an archive should check `ledger_history` rather than assume it. This is the correct trade — an archive is not worth a teardown error — but it means the archive's absence is indistinguishable from a project with no history.

**One request can go without the block after a compaction.** `project()` runs before the pre-step waterfall where pressure compaction happens, so the step on which a compaction removes the snapshot omits it, and overflow recovery can miss it for one retried request. The next assembly restores it, so this is a gap rather than a loss — but a model that answers inside that request is answering without the project block, and nothing reports that it happened. Closing it by injecting a fresh copy after every compaction was rejected as trading a bounded gap for unbounded log growth.

**Local-only memory does not travel, and cannot be recovered.** A teammate who clones the repository inherits no memory, and losing the machine loses the ledger. This is the accepted price of the local-only decision, and it makes onboarding and backup the user's concern rather than something the plugin can solve.

**Plugin state no longer replays with its session.** Dropping the event design cost a real property: the enable flag, the budget choice, and every entry's history are host-side state that a session export does not carry. Export and replay show the *effect* — the block as it was, because it is a logged message — but not the plugin state that produced it. Recovering the flag would need an upstream seam for third-party ignorable events, which does not exist.

**The ceilings are enforced in bytes while the cost is paid in tokens.** Bytes bound the plugin's own contribution exactly, but a headline's byte count and its token count are not the same number, so a project whose facts are byte-dense in a token-cheap script could sit closer to a token budget than the reported figure suggests. The mitigation is that the numbers are small relative to a context window; the risk is that they are treated as a token guarantee.

**A ceiling still decides what the model sees without asking it.** Profiles move that decision to the deployment and the catalog line makes omission visible, but neither makes the model search. A model that never calls `ledger_search` is bounded by the profile in force, and the residual cost is a task that proceeds without a fact the ledger holds. The countermeasure is measurement: record how often a session's answer depends on a fact without a slot, and let that figure — not the ceiling — justify a wider profile.

**Slots are held by trust and recency, and recency can still be wrong.** With aging declined (see Alternatives considered), a rarely-touched but load-bearing fact is protected only by being promoted to `curated`. Nothing enforces that a project does that, and nothing warns when a `confirmed` fact drops out of the block because newer ones crowded it. `ledger_status` reports how many facts are retrievable-only, so the shape of the problem is visible, but the only lever is a human deciding to promote.

**A global scope is missing, and its absence will be felt.** A fact that is true of the machine or the person rather than the project — which test flag this checkout needs, which package manager they prefer — has no home, so it is either re-recorded per project or lost. The deferral is deliberate and the reasoning is in Alternatives considered, but it means the plugin's knowledge is per-project by construction.

**A fact worth confirming may never be proposed.** The trust gradient depends on the model offering to promote what it recorded, and on a human being present to approve it. In a headless deployment nothing is ever confirmed, so the block stays empty and the plugin's value collapses to identity alone. This is fail-closed by design, but the failure is quiet.

**Injected context can go stale within a session.** The snapshot mechanism makes a change visible at the next assembly, but a project mutated by a tool call in the same turn is described by the previous snapshot until then. Re-resolving on every tool result was rejected as costing more than the freshness is worth. A parent agent also catches up on a subagent's writes only at its next turn boundary.

**Progressive disclosure can under-deliver.** A convention file that is never touched is never injected, which is the intent, but a task needing a convention before touching its directory receives it late. Delivery now runs, so the remaining question is measurement: record how often a convention arrives after the moment it was needed before the delivery rule is treated as settled.

**A convention's one-off cost can still be paid repeatedly.** Each file is delivered once per session, but a long session that touches many directories pays for each of them, and a project with a `CONTEXT.md` in every directory pays for all of them over its lifetime. The session byte ceiling bounds how much text that is; nothing bounds how many separate injections it takes.

**Adoption depends on the plugin working first.** The requirement is explicitly a standalone plugin, so it must run against an installed dsh without source changes. If a needed extension point exists in-repo but is not reachable from a profile-installed plugin, that gap blocks the layer rather than being fixed in place, and must be reported as a finding rather than patched by forking DSH.

**Deferred multi-graph retrieval may turn out to be load-bearing.** If capped mechanical listing proves insufficient for realistic project sizes, the deferral above converts into unplanned work with an external dependency whose retrieval cost the byte ceilings do not govern. The Phase 2 exit criterion is where that becomes measurable.
