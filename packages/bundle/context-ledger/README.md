--- description: "The project context ledger over dsh-base: mounts project identity, durable project memory, a mechanical session archive, directory conventions, and an adaptive injection budget, as one opt-in bundle." kind: "package-reference"
---

# @deepseek-ai/dsh-context-ledger-bundle

English | [中文](README.zh.md)

## Summary

One patch layer over `dsh-base` that mounts `@deepseek-ai/dsh-context-ledger` and changes nothing else. A deployment selects it in `dsh.profile.bundles` to add the ledger and deselects it to remove it completely. The bundle requires no capability the ledger reads, so a profile missing a filesystem provider, session store, session query, token meter, model router, or approval surface loses only that capability rather than failing to load.

## Table of Contents

- [Use this package](#use-this-package) - [Understand the implementation](#understand-the-implementation) - [Further Exploration](#further-exploration) - [Dev Note](#dev-note) - [Model Experience](#model-experience) - [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle to a profile and let the plugin's own defaults apply:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-context-ledger-bundle"]
    }
  }
}
```

Tune it by overriding the row in the profile's own patch layer, which is applied after every bundle layer:

```markdown
- id: dsh-context-ledger
  config:
    budgetProfile: adaptive
    archiveEnabled: false
```

<a id="understand-the-implementation"></a>
## Understand the implementation

The package's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch` manifest field and resolved by the profile composer through that field. Its single `insert` entry mounts the plugin row with no `config`, so the plugin's own defaults hold and the only thing this layer decides is whether the ledger is present at all. The module at `src/index.ts` carries no runtime API; it exists because the manifest's `main` and `files` name a build entry.

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-context-ledger`](../../context/context-ledger/README.md) — the plugin this bundle mounts, and the owner of every model-visible byte. - [`@deepseek-ai/dsh-base`](../base/README.md) — the layer this patch is applied over.

<a id="dev-note"></a>
## Dev Note

The bundle is named for the capability it mounts rather than for its `context-ledger` directory, which is why `tsconfig.base.json` carries a hand-written alias for it: the generated aliases cover packages whose name is exactly `dsh-<dir>`.

<a id="model-experience"></a>
## Model Experience

### The composed ledger row

#### What the model sees

This bundle contributes nothing itself: it decides only whether the ledger row is mounted. Every model-visible byte belongs to `@deepseek-ai/dsh-context-ledger`, which contributes one runtime-context block per session in a detected project, delivers directory conventions as one `user/message` on touch, and registers seven `ledger_*` tools. A deployment that deselects this bundle sees none of them.

##### Composed ledger row

```markdown
- id: dsh-context-ledger
  name: '@deepseek-ai/dsh-context-ledger'
```

#### Token effect

The patch adds no tokens and no prompt section. It mounts one row with no configuration, so the injected size is exactly what the plugin's budget profile allows and nothing more.

#### KV Cache effect

The patch contributes no request prefix, so it neither breaks nor extends provider-side reuse. Cache behavior belongs entirely to the plugin it mounts.

## Known Limitations and Deferred Work

- **Opt-in only.** No shipped profile selects this bundle, so the ledger is off until a deployment names it. Adding it to a shipped profile would require a keyless recorded-session snapshot, because the top-level snapshot tree covers processes started through a shipped profile.
- **The plugin is mounted without configuration.** A deployment that wants a specific profile must add its own override row; the bundle deliberately decides only presence.
- No runtime invariant companion is published: the bundle owns no state and asserts no relationship, and the plugin's README records why the plugin publishes none either.
