---
description: "The CodeBuddy-CLI-backed model source over dsh-base: mounts the delegating CLI adapter as the conversation route and turns the HTTP provider rows off, so a deployment runs with no API key."
kind: "package-bundle"
---

# @deepseek-ai/dsh-llm-cli-bundle

English | [中文](README.zh.md)

## Summary

`dsh-llm-cli-bundle` makes a CLI the model source for a `dsh-base` deployment. Its patch mounts the delegating CLI adapter as the `codebuddy-cli` route, turns off the HTTP provider rows, and points a new Agent's default model at that route — so no API key and no provider endpoint are needed. Everything else stays: sessions, tools, the agent loop, and the Models page. Later patches and the user's own `cordis.patch.yml` still address these rows by id, with the last write winning per row.

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

Install this bundle when a deployment must reach a model through a CLI that already carries the user's own sign-in — no API key, no endpoint, and no key distribution. It rides over [dsh-base](../base/README.md) exactly as the browser and one-shot surfaces do, so sessions, tools, the agent loop, and the Models page all stay mounted; only which route answers a model call changes.

### Mounting the profile

```sh
dsh plugin --profile work add @deepseek-ai/dsh-llm-cli-bundle
```

Installing the package activates it as a bundle layer: the profile records it in `dsh.profile.bundles` after `dsh-base`, and the launcher stacks the patch lists in that order over an empty entry list. Nothing else in the profile changes, and a later bundle or the profile's own patch still wins per row.

### What the patch changes

| Row | Change | Effect |
|---|---|---|
| `llm-cli` | inserted, mounting `@deepseek-ai/dsh-llm-cli` | adds the `codebuddy-cli` route with CodeBuddy defaults |
| `llm-deepseek` | `disabled: true` | the `deepseek-official` route stops answering and leaves the picker |
| `llm-deepseek-account` | `disabled: true` | account authorization serves the route above, so it goes with it |
| `llm-pi-ai` | `disabled: true` | the CLI is one route, not a provider catalog |
| `agent-default-model` | `provider: codebuddy-cli` | a new Agent lands on the CLI instead of the base default |

### Configuration

The inserted row carries what CodeBuddy needs: `command: codebuddy`, `args: ['--print', '--output-format', 'stream-json']`, and `permissionMode: bypassPermissions`. A profile's own patch overrides them by row id, so no fork of this package is needed to point at another checkout, another prompt protocol, or a stricter permission mode.

```yaml
- id: llm-cli
  config:
    command: /opt/acme/codebuddy
    permissionMode: default
```

The default model row names the CLI route through base's own [`agent-default-model`](../../core/agent-default-model/README.md) selection, so the Models page keeps working: it is the adapter that turns a chosen id into `--model <id>`. `DSH_CLI_MODEL` names an id the CLI accepts; leaving it unset leaves the CLI's own default selection in charge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One overlay, three edits

The bundle holds no runtime code. Its whole product is [`cordis.patch.yml`](cordis.patch.yml), which inserts one row, disables three, and restates one. That is why the package's only dependency is the adapter it mounts, and why installing it cannot add a service, a tool, or a client surface the rest of the tree does not already have.

### Row ids stay addressable

Both the disables and the default-model restatement name rows by `id` rather than re-declaring them, so a later layer can reverse any one of them without knowing this file. Re-enabling `llm-pi-ai` beside the CLI, for instance, is one row in the profile's own patch — the CLI route and the provider route then coexist and the picker offers both.

### Invariant ownership

No invariant companion is published because the bundle holds no runtime code: its entire product is a patch list, and the row set it composes is asserted by a test that reads [`cordis.patch.yml`](cordis.patch.yml) rather than by any registered relation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle package map](../README.md) — the other patch layers a profile can stack.
- [dsh-llm-cli](../../llm/llm-cli/README.md) — the adapter this bundle mounts, and its own configuration surface.
- [dsh-base](../base/README.md) — the shared core this patch overlays.
- [dsh app](../../../apps/cli/README.md) — the launcher that stacks bundles into a profile.

-----

<a id="model-experience"></a>
## Model Experience

### The composed CLI route

#### What the model sees

This bundle forwards nothing itself; it decides which row receives the assembled request. A new Agent's default model resolves to `provider: codebuddy-cli` with `model: process.env.DSH_CLI_MODEL ?? 'default'`, so request assembly reaches the mounted CLI adapter, and that package owns every model-visible byte. Because `llm-deepseek`, `llm-deepseek-account`, and `llm-pi-ai` are off, their routes cannot answer and do not appear in the picker.

#### Token effect

The patch adds no tokens and no prompt section. Prompt length is entirely what the CLI adapter puts in its positional prompt and its `--append-system-prompt` argument; the default-model row only selects which adapter receives the request.

#### KV Cache effect

The patch contributes no request prefix, so it neither breaks nor extends provider-side reuse. Cache behavior belongs to the CLI route and, behind it, to CodeBuddy's own session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **It replaces the API source rather than adding to it** — installing the bundle disables `llm-deepseek`, `llm-deepseek-account`, and `llm-pi-ai`, so a deployment that still needs an HTTP provider must re-enable those rows in a later layer.
- **The CLI must already be installed and signed in** — the bundle configures the command name and nothing about authentication; a missing or signed-out `codebuddy` fails at the first turn rather than at startup.
- **`DSH_CLI_MODEL` is read when the patch is applied** — the default-model row resolves the variable while the tree composes, so changing it needs a restart rather than a settings edit.
- **`bypassPermissions` is the shipped default** — the child inherits the launching process's OS access, so a deployment that needs confinement must set `permissionMode` down in its own patch.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle deliberately keeps the Models page mounted even though it ships a single route: a deployment that later re-enables a provider row should not also have to restore the page. The disabled set is the three rows `dsh-base` mounts that would otherwise resolve a key and reach an endpoint; a new HTTP provider added to base joins this list by hand, which is why the test pins the set rather than counting it.

</details>
