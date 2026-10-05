---
description: "context 组概览：为每次请求添加持久且模型可见上下文的插件，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# context/ — 请求上下文插件

[English](README.md) | 中文

## 概述

context 组提供为每次请求添加持久、模型可见上下文的插件。其中多数不定义任何工具：工作区指令文件成为指引，`@file` 提及提供路径补全，其他会话可以作为有界快照被引用，模型还能看到当前时间与 tmux 位置。`context-ledger` 是本组中唯一同时注册工具的成员，因为它的上下文是一份指向记录的索引，而模型必须能把那些记录读回来。`agent-instructions` 与 `time-context` 默认挂载；其余全部需主动启用。上下文是持久的：注入的指令与引用以用户角色消息的形式进入会话历史，因此持久保留、可回放、可压缩。本页概述本组。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`agent-instructions/`](agent-instructions/README.zh.md) | 将 `AGENTS.md`、`CLAUDE.md` 工作区指令加载到上下文，并在文件编辑后刷新 | — |
| [`session-reference/`](session-reference/README.zh.md) | 引用其他会话：提及一个会话，其有界只读快照即成为上下文 | `ctx.sessionReferenceResolver` |
| [`file-reference/`](file-reference/README.zh.md) | 发现 `@file` 提及，并提供由宿主支持的 UI 共用的提及语法 | `ctx.fileReferences` |
| [`file-reference-local/`](file-reference-local/README.zh.md) | `@file` 提及的本地工作区补全提供方 | — |
| [`time-context/`](time-context/README.zh.md) | 每个步骤的当前时间、浏览器时区与经过时长 | — |
| [`tmux-context/`](tmux-context/README.zh.md) | agent 所在的 tmux 会话、窗口与窗格位置 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [会话引用子系统](../../docs/subsystems/session-reference.zh.md)——规范的提及 URI、快照语义与稳定的错误分类体系。
- [工作区上下文决策记录](../../.agents/notes/archived/feature/2026-06-24-workspace-context.md)——指令上下文为何按 agent 和会话两个维度隔离并持久记录。
- [生成的配置目录](../../docs/config-catalog.zh.md)——本组各包接受的全部配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
