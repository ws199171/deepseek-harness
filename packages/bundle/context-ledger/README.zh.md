---
description: "dsh-base 之上的项目上下文账本：以单个可选 bundle 挂载项目身份、持久项目记忆、机械式会话归档、目录约定与自适应注入预算。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-context-ledger-bundle

[English](README.md) | 中文

## 概述

一层作用于 `dsh-base` 之上的 patch，挂载 `@deepseek-ai/dsh-context-ledger`，不改动其他任何东西。部署在 `dsh.profile.bundles` 中选中它即可加入账本，取消选中即可彻底移除。本 bundle 不要求账本所读取的任何能力，因此缺少文件系统 provider、会话存储、会话查询、token 计量器、模型路由或审批面板的 profile 只会失去那一项能力，而不会加载失败。

## 目录

- [使用本包](#use-this-package) - [实现说明](#understand-the-implementation) - [进一步探索](#further-exploration) - [开发备注](#dev-note) - [模型体验](#model-experience) - [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把 bundle 加入 profile，让插件自身的默认值生效：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-context-ledger-bundle"]
    }
  }
}
```

要调节它，就在 profile 自己的 patch 层里覆盖该行——该层在每个 bundle 层之后应用：

```markdown
- id: dsh-context-ledger
  config:
    budgetProfile: adaptive
    archiveEnabled: false
```

<a id="understand-the-implementation"></a>
## 实现说明

本包的实质是 `cordis.patch.yml`，由 `dsh.bundle.patch` 清单字段声明，并由 profile 组合器通过该字段解析。它唯一的 `insert` 项挂载插件行且不带 `config`，因此插件的默认值成立，而这一层唯一决定的事情是账本到底在不在。`src/index.ts` 处的模块不承载任何运行时 API；它之所以存在，是因为清单的 `main` 与 `files` 指着一个构建入口。

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-context-ledger`](../../context/context-ledger/README.zh.md) —— 本 bundle 所挂载的插件，也是每一个模型可见字节的归属方。 - [`@deepseek-ai/dsh-base`](../base/README.zh.md) —— 本 patch 所作用的层。

<a id="dev-note"></a>
## 开发备注

本 bundle 以它所挂载的**能力**命名，而不是以它的 `context-ledger` 目录命名，这就是 `tsconfig.base.json` 为它保留了一条手写别名的原因：生成器只覆盖名字恰为 `dsh-<dir>` 的包。

<a id="model-experience"></a>
## 模型体验

### 组合出的账本行

#### 模型看到什么

本 bundle 自身不贡献任何东西：它只决定账本行是否被挂载。每一个模型可见字节都属于 `@deepseek-ai/dsh-context-ledger`——它在可解析到项目的会话里贡献一个运行时上下文块，在触碰时以一条 `user/message` 投递目录约定，并注册七个 `ledger_*` 工具。取消选中本 bundle 的部署这些全都看不到。

##### 组合出的账本行

```markdown
- id: dsh-context-ledger
  name: '@deepseek-ai/dsh-context-ledger'
```

#### token 影响

该 patch 不添加任何 token，也不添加任何提示词片段。它以一个不带配置的行挂载，因此注入体积恰好是插件档位所允许的，不多不少。

#### KV Cache 影响

该 patch 不贡献任何请求前缀，因此既不破坏也不延长 provider 侧复用。缓存行为完全属于它所挂载的插件。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限可选启用。** 没有任何随附 profile 选中本 bundle，因此账本在部署指名它之前是关闭的。把它加进随附 profile 将需要一份 keyless 录制会话快照，因为顶层快照树只覆盖通过随附 profile 启动的进程。
- **插件以无配置方式挂载。** 想要特定档位的部署必须自己加一条覆盖行；本 bundle 刻意只决定存在与否。
- **不发布运行时不变量的伴随包。** 本 bundle 不拥有任何状态，也不断言任何关系；插件为何同样不发布，记录在插件的 README 里。
