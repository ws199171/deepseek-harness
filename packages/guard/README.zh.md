---
description: "循环卫生 guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略与编排哨兵，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组通过监视三种失败模式来保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 会在模型重复同一个工具调用时提醒它改变方法或结束任务，让卡住的循环不再浪费时间和 token。`timeout-policy` 为声明了限时的工具调用设置时间上限，让挂起的调用向模型返回清晰的超时错误，而不是拖住整个会话。`orchestration-sentinel` 会在并发安全的调用被逐步拆开发出、或某个工具被反复调用时，请模型改为合批或改用 `run_code`。三者都在 `dsh-base` 中默认启用，组合可以调优或移除其中任何一个。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

三个小插件分别覆盖三种模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复完全相同的工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`orchestration-sentinel/`](orchestration-sentinel/README.zh.md) | 提醒模型把并发安全的独立调用合批，并对重复工作建议使用 `run_code` |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看两个 guard 的配置与策略背后的超时库决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——三者共同依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。
- [编排哨兵 README](orchestration-sentinel/README.zh.md)——合批提醒何时触发、花多少 token，以及它为何让位于循环卫生守卫。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
