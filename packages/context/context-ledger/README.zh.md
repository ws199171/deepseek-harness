--- description: "项目上下文账本：项目身份、带信任梯度的持久项目记忆、机械式会话归档、触碰时投递的目录约定，以及自适应注入预算。" kind: "package-reference"
---

# @deepseek-ai/dsh-context-ledger

[English](README.md) | 中文

## Summary

一个项目作用域的账本，保存项目已经学到的东西。同一项目中的每个会话都收到一个运行时上下文块，其中承载项目身份与人工确认过的事实的标题行，因此后续会话一开始就已经知道它们。其余一切——正文、未确认的提案、已归档会话、目录约定——都不进入常驻载荷，而是通过七个 `ledger_*` 工具按需获取，或者在工具触碰到带有自己的 `CONTEXT.md` 的目录时投递一次。注入体积由档位上限约束，或根据会话剩余窗口自适应选择。

## Table of Contents

- [使用本包](#use-this-package) - [实现说明](#understand-the-implementation) - [进一步探索](#further-exploration) - [开发注记](#dev-note) - [模型体验](#model-experience) - [已知限制与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

挂载 `@deepseek-ai/dsh-context-ledger-bundle`，或者直接挂载插件行：

```yaml
- id: dsh-context-ledger
  name: '@deepseek-ai/dsh-context-ledger'
  config:
    budgetProfile: adaptive
```

插件只要求 `systemPrompt` 与 `tools`。文件系统 provider、会话存储、会话查询、token 计量器、模型路由与审批面板都通过 `ctx.get` 读取，因此缺少某项的部署只会失去那一项能力：没有文件系统 provider 就不贡献块，没有审批面板事实就无法被确认，没有会话查询就不归档。

<a id="understand-the-implementation"></a>
## 实现说明

**一个块，以文本比较。** `ctx.systemPrompt.context()` 注册一个 provider，其文本是渲染出的块；该 provider 只读一个每会话缓存，所有文件系统读取都被挡在该缓存之外——因此装配永远不会因 I/O 阻塞。缓存在检查点（会话开始、轮次边界、一次压缩结束）以及可能改变了项目的 `tools/result` 之后刷新。渲染是确定性的、字段顺序固定；缓存按**渲染文本**而非派生键比较，因此注入的内容与缓存所认为的内容不可能不一致。

**信任梯度，而非开关。** 模型写入的事实是 `auto`：在目录行里被计数，但绝不注入。只有被记录的人工审批才把它提升为 `confirmed`（注入）或 `curated`。这正是让常驻注入变得安全的原因：模型可以自由记录，而没有任何东西会在没人点头的情况下变成每次请求的永久成本。

**注入以字节为界，而不是 token。** 以 token 计的上限需要一个本插件没有的分词器，而把字节数报成 token 数会夸大已知信息。档位为 `frugal`、`balanced`、`full`，或 `adaptive`——后者选取整块上限能装进会话空闲窗口某个配置比例的**最宽**一级。让位是整个值、且有序的：先是标题行，然后是目录行，再是 stack 行，最后是项目名——因为被截断的标题行会断言假的东西，而缺失的可选行不会。

**归档是机械的。** 一行只从会话已提交的事件推导，不调用模型，因此它不可能与它来源的日志不一致：时长、轮次数、步数、工具调用数、压缩次数、目标变更次数、最后一轮的结束方式，以及触碰过的文件。没有摘要，因为摘要会是同一会话的第二份、且有损的记录。

**约定在一次触碰时投递一次。** `CONTEXT.md` 作用于它自己的目录及其子孙；当工具结果显示项目内的某个文件被触碰时，适用的文件按最近优先作为一条 `user/message` 经 inbox 投递，每个文件每会话最多投递一次。投递是刻意迟到的：约定的价值恰恰在工作到达它时最高，而成本否则就是一笔常驻税。

**不发布运行时不变量的伴随包。** 本包所做的每一项观察都是关于它并不拥有的状态——会话日志、文件系统、以及它自己的缓存——因此不存在两个独立观察者能看到分歧的、被拥有的关系。

<a id="further-exploration"></a>
## 进一步探索

- [`docs/subsystems/compaction.md`](../../../docs/subsystems/compaction.zh.md) —— 块所依赖的保留机制，以及账本为何无需改动即可跨越替换引擎。 - [`packages/context/agent-instructions/`](../agent-instructions/README.zh.md) —— 负责行为性指令文件的兄弟包，本包刻意不重复它。 - [cordis 组合参考](../../preset/agent-preset/skills/cordis-composition-reference/references/packages.md) —— 本包配置的出处。

<a id="dev-note"></a>
## 开发注记

记忆目录是带 JSON frontmatter 头的 markdown，一条事实一个文件，因为正文是人应当阅读和编辑的散文，也因为删掉目录就是完整且自明的遗忘方式。这里刻意没有派生索引文件：列举靠扫描目录，这保持了内容的单一真相来源，并消除了"缓存与来源不一致时该怎么办"这个问题。

<a id="model-experience"></a>
## 模型体验

### 项目上下文块

#### 模型看到什么

在一个工作目录可解析到某个项目的会话里，每次请求都携带一条持久的、user 角色的运行时上下文快照。它给出项目名、根路径、该根下存在的清单文件，以及——一旦有人确认过——记忆目录行与每个获得槽位的事实的标题行。

##### 项目上下文模板

```markdown
<project_context>
Project: demo
Root: /work/demo
Stack: package.json
Memory: 3 recorded, 1 shown (build 1, decision 2)
- [build] Run the suite with pnpm test
</project_context>
```

#### token 影响

整个块受档位的 `maxIdentityBytes` 约束，标题行单独受 `maxIndexBytes` 约束。只有当渲染文本变化时块才被重新物化，因此什么都没学到的新会话除了它本就持有的缓存之外不付任何成本。连根行都装不下的会话什么都不贡献。

#### KV Cache 影响

该快照是位于可压缩区域内的一条持久消息，因此在一次压缩替换掉包含它的区间之前，它一直占据前缀中的位置。届时拥有该快照的投影会在它被移除的**同一步**忘掉它，而下一次装配再次发出当前值——于是块出现在新的历史位置，而不是就地改写可复用前缀。在检查点之间文本不变，这正是让未变化的项目不会抖动前缀的原因。

### 目录约定

#### 模型看到什么

在项目内一次成功的 `read`、`write` 或 `edit` 之后，下一次请求包含一条带来源的 `user/message`，承载适用于被触碰目录的 `CONTEXT.md` 文件，最近优先。

##### 约定消息模板

```markdown
Conventions for directories this session has touched:

## src/CONTEXT.md

<src declarations>

## CONTEXT.md

<root declarations>
```

#### token 影响

每个被触碰的目录每会话投递一次其适用文件。消息受每文件 `maxConventionFileBytes`、每会话 `maxConventionSessionBytes` 约束；超过每文件上限的文件会以一条说明被报告而不是被丢弃，因为模型从未被告知的约定与不存在的约定无法区分。

#### KV Cache 影响

只追加，位于历史末尾，因此投递从不使可复用前缀失效。

### 账本工具结果

#### 模型看到什么

`ledger_write` 与 `ledger_promote` 报告记录了什么、以哪个层级；`ledger_read`、`ledger_search`、`ledger_history`、`ledger_handoff` 返回所请求的记录；`ledger_status` 报告当前级别、其上限、条目普查以及会话的 token 用量。

##### 账本状态渲染

```markdown
project: /work/demo
budget: rung balanced, configured balanced (static profile)
ceilings: {"profile":"balanced","maxIndexEntries":16,"maxIdentityBytes":2048}
recorded: 3 total {"build":1,"note":2} tiers {"confirmed":1,"auto":2}
injected: 1 · retrievable only: 2
injected block: 412 bytes
session usage: 1200 tokens used of 200000 (deepseek/demo)
```

#### token 影响

工具结果像任何其他结果一样进入历史，并受它们所读取的同一批上限约束：单个正文 `maxEntryBytes`，搜索 `maxSearchResults` 与 `maxExcerptChars`，历史与交接 `maxArchiveRows`，简报 `maxBriefBytes`。只有 `output.render` 会到达模型，因此规范值本身不会撑大记录。

#### KV Cache 影响

普通的工具结果追加。没有任何账本调用会改写更早的消息。

## 已知限制与推迟的工作

- **压缩之后可能有一次请求拿不到块。** 快照投影运行在压力压缩所在的 pre-step waterfall 之前，因此压缩移除该快照的那一步会省略它，而下一次装配会恢复。溢出恢复可能让重试的那一次请求漏掉它。用"每次压缩后注入一份新副本"来补上它已被否决，因为那是用无界日志增长换一个有界且能自愈的间隙。
- **只有仅限本地的记忆。** 条目存放在 Harness home 下、按项目根为键，因此在一个检出里记录的事实不会传播到另一个，而且一个项目路径就是一个账本。
- **项目从未被解析出来的会话不会被归档**，因为没有账本可供归档到它名下。
- **自适应级别只在检查点选择，不是每次请求。** 在轮次中途被填满的窗口会保持其级别直到下一个轮次边界，这是用一点准确性换取前缀稳定。
- **约定不会被刷新。** 投递之后被编辑的 `CONTEXT.md` 不会在同一会话里重新发送。
- **没有删除。** 目录行会统计每一条已存条目，因此让一条事实退役意味着手工编辑记忆目录。
