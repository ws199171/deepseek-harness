# Agent Note: CodeBuddy CLI adapter

Status: implemented

English | [中文](2026-08-17-codebuddy-cli-adapter.zh.md)

## Problem

The product needs a model provider that can use a person's existing CodeBuddy CLI authentication instead of requiring a DeepSeek API key. A generic executable setting cannot provide that capability safely because CLI argument conventions, session behavior, and streaming protocols differ by program.

## Decision

`@deepseek-ai/dsh-llm-cli` registers the `codebuddy-cli` route in the base bundle. For each model request it starts one CodeBuddy child through `ctx.subprocess`, appends the prompt as the final positional argument, and converts CodeBuddy `stream-json` output into `StreamChunk` values.

Each request appends the assembled Harness system prompt through `--append-system-prompt` when present. Session requests append `--session-id <id>`, run in the session's selected workspace unless `llm-cli.cwd` overrides it, and forward only their latest human-authored user text because CodeBuddy owns that conversation history. Plugin context uses the same user role but does not replace the human input. Stateless callers flatten the complete Harness conversation without duplicating the system prompt. The adapter emits text as each complete `assistant` line arrives, and closes the block only after a terminal `result` line or a reported failure.

Every delegated run passes the configured CodeBuddy `--permission-mode`; it defaults to `bypassPermissions` because print mode cannot complete interactive approval. This policy applies inside CodeBuddy. Harness permission presets and tool sandboxes do not mediate the delegated CLI's internal file or shell operations.

The Models page discovers and probes CodeBuddy before writing its executable and `--model` help listing into the `llm-cli` settings section. The conversation model picker selects one of those IDs per session, and the adapter forwards it as `--model <id>`. The discovery list contains only CLI programs whose invocation and output protocol the adapter implements. Adding another CLI requires an adapter extension that owns its distinct protocol.

## Alternatives considered

**Treat every detected CLI as compatible.** Rejected because common CLI names do not establish equivalent prompt, session, or `stream-json` semantics, and a successful executable probe would not make a later model request reliable.

**Pass prompts through stdin.** Rejected because CodeBuddy's print mode consumes the prompt as a positional argument.

**Buffer stdout until the process ends.** Rejected because a model stream must publish completed assistant text before the terminal event; buffering makes a long-running CLI response appear stalled.

## Consequences

Existing CodeBuddy credentials can supply a selected session model without a DeepSeek API key, while model discovery keeps the model picker limited to CodeBuddy IDs the adapter can invoke.

CodeBuddy owns its tool execution and session storage, so Harness records only the final text and cannot replay its internal tool activity. The default `bypassPermissions` mode also grants those internal tools the desktop process's OS access rather than the session's Harness permission preset. The provider depends on CodeBuddy's current print and `stream-json` behavior; a vendor protocol change causes a failed request or probe rather than a compatible fallback.
