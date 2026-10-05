---
description: "按观测条件触发的编排引导：在并发安全的独立调用被拆散时提醒合批，在同一工具反复调用时提示 run_code，面向选择、配置或调试该插件的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-orchestration-sentinel

[English](README.md) | 中文

## 概述

本包观察模型正在以什么方式发出工具调用，并在两个时机向下一次请求追加一句简短提醒。当连续多个步骤各只发出一个并发安全的调用时，它指出互不依赖的工作可以在一条消息里发出——内核随后会并行执行；当某个工具被反复调用、且该 agent 确实能看到 PTC 传输时，它指出 `run_code` 可以一次完成这轮重复。两句提醒都只描述**已经观测到的事实**，并只附上一个条件式建议：它们既不断言依赖关系是否存在，也不会在事后宣称哪两个调用可以合并。提醒是建议性的且有预算上限——每个会话只用掉很少几次，而已经在合批的模型不会被提醒。

## 目录

- [使用本包](#use-this-package)
  - [何时选择](#when-to-choose-it)
  - [运行、调参、关闭](#running-it-tuning-it-turning-it-off)
  - [你会得到什么](#what-you-get)
- [理解实现](#understand-the-implementation)
  - [设计理念](#design-philosophy)
  - [两个机制](#the-two-mechanisms)
  - [决策发生的位置](#where-the-decision-is-made)
  - [为什么日志本身就能解释每一次发射](#why-the-log-alone-accounts-for-every-emission)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

本包是一个函数插件：`dsh` 基础组合包已默认启用它，部署方用下表字段调参——既可在自己的补丁层覆盖它的行，也可在设置页调整。它注入 `tools`、`systemPrompt`、`sessionProjections`；缺少其中任一服务的 profile 会**响亮地失败**，而不是部分运行。

<a id="when-to-choose-it"></a>

### 何时选择

当一个部署观察到模型每一步只发出一个独立的只读调用、并为每次调用都付一个往返时，或观察到它在反复调用同一个工具、而一小段程序就能完成时，选择本包。在模式真正出现之前，这些提醒不花任何代价。

当工作负载本身是串行的——依赖链产生的正是本包视为信号的"单调用步"——应跳过本包；当另一个插件已经在提供常驻的合批指令时也应跳过：两个插件在同一请求里说同一件事，token 由双方一起付。

<a id="what-you-get"></a>

### 你会得到什么

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否运行本插件。 |
| `observeOnly` | `false` | 只判定并记日志、不贡献任何内容：在注入任何引导之前，用这个模式度量"可干预窗口"出现的频率。 |
| `windowSteps` | `4` | 重复工具判据所检视的末尾步数。 |
| `singleCallStreak` | `3` | 触发合批提醒所需的连续单调用步数。 |
| `repeatedToolCalls` | `6` | 触发 `run_code` 建议所需的、窗口内同一工具的出现次数。 |
| `cooldownSteps` | `3` | 同一轮次内两次发射之间的最小步数间隔。 |
| `maxEmissions` | `3` | 每会话允许的发射次数；`0` 会连观测记录一起抑制。 |
| `enableSplit` | `true` | 合批机制是否可用。 |
| `enablePtcSuggestion` | `true` | `run_code` 机制是否可用；`run_code` 的可见性仍另行把关。 |

### 运行、调参、关闭

它默认开启，因为引导是**条件式**的：从不出现该模式的会话一分钱也不花。若想看到折叠但不要让模型看到任何引导——也就是在放行提醒之前先度量该模式是否常见的模式——覆盖这一行：

```yaml
- id: orchestration-sentinel
  config:
    observeOnly: true
```

模型什么也看不到，但**每一个机制本会触发的步骤都会记一条日志**：

```text
orchestration-sentinel: would advise "split" at turn 1 step 4 (observe-only, nothing contributed)
```

这条日志就是度量。因为贡献为空，不会记录快照，会话预算与轮次内冷却都不会推进，所以日志数到的是**窗口成立的每一个边界**，而不是它本会产生多少次发射。

若想彻底移除该行为，在补丁层把这一行禁用（`orchestration-sentinel` 上写 `disabled: true`）——插件、它的投影单元与预算一起消失；或者把它的 `enabled` 设为 `false`，保留行但让它不起作用。

<a id="understand-the-implementation"></a>

## 理解实现

<a id="design-philosophy"></a>

### 设计理念

本插件不持有权威状态，也不新增事件类型。它据以判定的一切都从会话日志折叠而来，它贡献的每一个字也都记录在那里，因此恢复或分叉的会话可以通过重放重建同样的决策。它也不向系统提示写入任何内容：会变化的系统提示段落会替换提示的第一个表层节点、使可缓存前缀失效——这恰好与一个以省 token 为目标的插件相悖。

<a id="the-two-mechanisms"></a>

### 两个机制

**合批提醒**在末尾 `singleCallStreak` 步各恰好发出一个调用、且这些调用经注册表判定全部并发安全时触发。某一步发出两个及以上调用即打断这一连击，因此模型一旦合规，提醒会自动沉默，无需额外簿记。

**`run_code` 建议**在末尾 `windowSteps` 步内某个工具出现次数达到 `repeatedToolCalls`、每次出现都并发安全、且该 agent 能看到 `run_code` 时触发——在工具呈现模式隐藏了 PTC 传输的部署里，这个建议不可执行，因此不发。该机制在本轮次内**一旦内置的循环卫生守卫已告诉模型它在重复，就保持沉默**：逐字重复同一个操作是那个守卫的发现，把它变成程序只会把循环固化，而不是缩短它。

<a id="where-the-decision-is-made"></a>

### 决策发生的位置

决策运行在本包**动态上下文的 text provider 内部**，而不是 `agent/pre-step` 监听器里。agent-loop 先装配提示、把动态上下文落库，**之后**才 dispatch pre-step waterfall，因此在监听器里决策会让提醒比预期晚一步到达；在装配期决策才能把提醒放进模型即将写入的那一步——那是它唯一还能影响的步骤。

<a id="why-the-log-alone-accounts-for-every-emission"></a>

### 为什么日志本身就能解释每一次发射

引导文案是被观测窗口的纯函数，窗口里包含轮次与覆盖的步区间。agent-loop 只在文本变化时记录 runtime-context 快照，因此未变的窗口不会二次计费；而被压缩移除后重新物化的快照重复同一文本，折叠能识别出来、不会把它算作第二次干预。会话预算因此**从日志推导**而非靠记忆，审计工具按同样规则数快照会得到与插件相同的数字。

<a id="further-exploration"></a>

## 进一步探索

- [循环卫生守卫](../repeat-tool-reminder/README.zh.md) —— 本包把 PTC 建议让位给它的同族包。
- [工具子系统](../../../docs/subsystems/tools.zh.md) —— 并发分类与执行流水线。
- [会话投影](../../../docs/subsystems/session-projection.zh.md) —— 本包注册的折叠单元。

<a id="model-experience"></a>

## 模型体验

### 合批提醒

#### 模型看到什么

当 `singleCallStreak` 步各发出一个并发安全的调用之后，下一次请求会以下面的内容作为动态 runtime-context 快照携带该贡献。`<turn>` 与步区间就是被观测的窗口，`<count>` 是配置的连击数。工具 schema 不变。

##### 合批提醒文本

```markdown
[orchestration] (turn <turn>, step <first>–<last>): these <count> steps each issued exactly one tool call. If the read-only work still ahead of you in this step does not depend on an earlier result, issue those calls together in one message; the harness schedules concurrency-safe calls in one message in parallel.
```

#### Token 影响

模式出现之前为零。每次发射都是保留历史，并受每会话 `maxEmissions` 与轮次内 `cooldownSteps` 约束。

#### KV Cache 影响

仅追加：快照跟在保留历史之后，因此它**延长**可复用前缀而不是替换它。后续文本不同的发射同样追加。

### run_code 建议

#### 模型看到什么

当某个并发安全的工具在窗口内反复出现、且该 agent 能看到 `run_code` 时，下一次请求携带下面这条贡献，而不再是合批提醒。`<tool>` 是重复的工具，`<count>` 是它的出现次数。

##### run_code 建议文本

```markdown
[orchestration] (turn <turn>, step <first>–<last>): <tool> has been called <count> times. If the work left is one operation repeated over a set of inputs, run_code can do it in a single call.
```

#### Token 影响

模式出现之前为零；之后与合批提醒共用同一会话预算与轮次内冷却。该建议绝不取代工具 schema：它是追加的上下文，不是配置变更。

#### KV Cache 影响

与合批提醒一样仅追加：新可见的内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明了本插件何时不合适。它们是当前的包约束，不是待办清单。

- **并发性按工具名判定** —— 探针以空参数、经该 agent 可见的定义做分类；对仓库内每个工具都精确（它们要么是 `() => true`，要么未声明分类器），但对依赖参数的第三方分类器偏乐观。由于两段文案都是条件式建议、不断言已执行调用的属性，这份乐观的代价是提醒时机偏差，而不是错误引导。
- **依赖链看起来就像信号** —— 真正串行的工作负载会逐步产生一个并发安全调用，那恰好就是合批窗口；`singleCallStreak` 与 `maxEmissions` 是压力阀。
- **第一次发射在构造上就是晚的** —— 必须先走完 `singleCallStreak` 步才有这个模式，因此最早的提醒落在下一步。
- **`run_code` 可见性逐步读取** —— 会话中途改变工具呈现模式的部署会改变该建议是否可执行；每次装配都会重新判定。
- **两处说同一件事** —— 若另一个插件提供常驻的合批指令，两段文本会同乘一个请求、一起花 token；系统提示段落之间没有优先级机制。
- **配置值按送达即信任** —— 导出的 schema 会拒绝越界值，但插件自身在运行期不重复校验，因此绕过 schema 应用的部署路径会把原始值直接交给它。

### Dev Note

<details>
<summary>维护者用的工作上下文——点击展开</summary>

- `src/state.ts` 就是本插件持久状态的全部：一个投影单元，折叠 `tool/call` 与它自己的 runtime-context 快照。字段或折叠语义变化时必须递增 `STATE_VERSION`，`BUFFER_STEPS` 必须随 `windowSteps`/`singleCallStreak` 的上限一起增长。
- `src/decide.ts` 是纯函数，并发分类以注入探针的形式传入——因为注册表会在活动会话下变化，而检查点绝不能记下一个后来的注册表会否定的结论。
- 观测模式的存在是为了证伪本插件自己的前提：如果可干预窗口在真实会话中很少出现，提醒就不可能起作用，本包也不应继续生长。
- `tests/sentinel.spec.ts` 用脚本化适配器驱动真实 agent loop，`tests/loader-composition.spec.ts` 通过真实 Loader 读取 test-only `cordis.yml` 来激活插件，`tests/context.spec.ts` 覆盖活动循环够不到的贡献契约。

</details>
