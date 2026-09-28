---
description: "以 CodeBuddy CLI 为后端的模型源，叠加在 dsh-base 之上：把委托式 CLI 适配器挂载为对话路由并关闭 HTTP 提供方行，使部署无需 API 密钥即可运行。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-llm-cli-bundle

[English](README.md) | 中文

## 概述

`dsh-llm-cli-bundle` 让 CLI 成为 `dsh-base` 部署的模型源。它的 patch 把委托式 CLI 适配器挂载为 `codebuddy-cli` 路由、关闭 HTTP 提供方行，并把新 Agent 的默认模型指向该路由——因此既不需要 API 密钥，也不需要提供方端点。其余一切保持不变：会话、工具、智能体循环与 Models 页面。后续 patch 与用户自己的 `cordis.patch.yml` 仍按 id 寻址这些行，逐行以最后写入者为准。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当某个部署必须通过一个已经带有用户本人登录态的 CLI 触达模型时，安装本 bundle——无需 API 密钥、无需端点，也无需分发密钥。它像浏览器表层与一次性任务表层那样叠加在 [dsh-base](../base/README.zh.md) 之上，因此会话、工具、智能体循环与 Models 页面全都保持挂载；改变的只是哪条路由来回答模型调用。

### 挂载 profile

```sh
dsh plugin --profile work add @deepseek-ai/dsh-llm-cli-bundle
```

安装该包即把它激活为一个 bundle 层：profile 会把它记录在 `dsh.profile.bundles` 中 `dsh-base` 之后，启动器按该顺序把各 patch 列表叠加在一个空白条目列表之上。profile 中其余内容不变，而后来的 bundle 或 profile 自己的 patch 仍逐行胜出。

### patch 改了什么

| 行 | 改动 | 效果 |
|---|---|---|
| `llm-cli` | 插入，挂载 `@deepseek-ai/dsh-llm-cli` | 以 CodeBuddy 默认值新增 `codebuddy-cli` 路由 |
| `llm-deepseek` | `disabled: true` | `deepseek-official` 路由不再作答并退出选择器 |
| `llm-deepseek-account` | `disabled: true` | 账号授权服务于上一行，因此随之关闭 |
| `llm-pi-ai` | `disabled: true` | CLI 是一条路由，不是一个提供方目录 |
| `agent-default-model` | `provider: codebuddy-cli` | 新 Agent 落在 CLI 上，而非 base 默认值 |

### 配置

插入的行携带 CodeBuddy 所需的东西：`command: codebuddy`、`args: ['--print', '--output-format', 'stream-json']` 与 `permissionMode: bypassPermissions`。profile 自己的 patch 按行 id 覆盖它们，因此无需 fork 本包就能指向另一份检出、另一套提示词协议或更严格的权限模式。

```yaml
- id: llm-cli
  config:
    command: /opt/acme/codebuddy
    permissionMode: default
```

默认模型行经 base 自己的 [`agent-default-model`](../../core/agent-default-model/README.zh.md) 选择来指名 CLI 路由，因此 Models 页面继续可用：把所选 id 变成 `--model <id>` 的正是该适配器。`DSH_CLI_MODEL` 指名一个 CLI 接受的 id；不设置它则交由 CLI 自己的默认选择接管。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 一份叠加，三处改动

本 bundle 不含任何运行时代码。它的全部产物就是 [`cordis.patch.yml`](cordis.patch.yml)：插入一行、禁用三行、重述一行。这正是本包唯一的依赖就是它所挂载的适配器的原因，也是安装它不可能新增服务、工具或客户端面的原因。

### 行 id 保持可寻址

无论禁用还是重述默认模型，都按 `id` 指名行而不重新声明它们，因此后续层无需了解本文件即可反转其中任意一项。例如，在 CLI 旁重新启用 `llm-pi-ai` 只需在 profile 自己的 patch 中加一行——CLI 路由与提供方路由随后共存，选择器会同时提供两者。

### 不变式归属

不发布不变式伴生入口，因为本 bundle 不含任何运行时代码：它的全部产物就是一份 patch 列表，它所组合出的行集合由一个读取 [`cordis.patch.yml`](cordis.patch.yml) 的测试断言，而不是由任何已注册的关系断言。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [组合包索引](../README.zh.md)——profile 可叠加的其他 patch 层。
- [dsh-llm-cli](../../llm/llm-cli/README.zh.md)——本 bundle 所挂载的适配器及其自己的配置面。
- [dsh-base](../base/README.zh.md)——本 patch 所叠加的共享核心。
- [dsh app](../../../apps/cli/README.zh.md)——把 bundle 叠加成 profile 的启动器。

-----

<a id="model-experience"></a>
## 模型体验

### 组合后的 CLI 路由

#### 模型看到什么

本 bundle 自己不转发任何内容；它决定由哪一行接收组装好的请求。新 Agent 的默认模型解析为 `provider: codebuddy-cli` 与 `model: process.env.DSH_CLI_MODEL ?? 'default'`，因此请求组装到达已挂载的 CLI 适配器，而该包拥有所有模型可见的字节。由于 `llm-deepseek`、`llm-deepseek-account` 与 `llm-pi-ai` 已关闭，它们的路由无法作答，也不会出现在选择器中。

#### Token 影响

该 patch 不添加任何 token，也不添加任何提示词分节。提示词长度完全取决于 CLI 适配器放进位置提示词与 `--append-system-prompt` 参数的内容；默认模型行只决定由哪个适配器接收请求。

#### KV Cache 影响

该 patch 不贡献任何请求前缀，因此既不破坏也不延长提供方侧复用。缓存行为属于 CLI 路由，以及其背后 CodeBuddy 自己的会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **它替换 API 源，而不是在其旁新增**——安装本 bundle 会禁用 `llm-deepseek`、`llm-deepseek-account` 与 `llm-pi-ai`，因此仍需要某个 HTTP 提供方的部署必须在后续层重新启用这些行。
- **CLI 必须已安装并已登录**——本 bundle 只配置命令名，完全不涉及认证；缺少或未登录的 `codebuddy` 会在第一轮失败，而不是在启动时失败。
- **`DSH_CLI_MODEL` 在应用 patch 时读取**——默认模型行在树组合期间解析该变量，因此改动它需要重启，而不是一次设置编辑。
- **`bypassPermissions` 是随包默认值**——子进程继承启动进程的 OS 访问权，因此需要隔离的部署必须在自己的 patch 中把 `permissionMode` 调低。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

尽管只交付一条路由，本 bundle 仍刻意保留 Models 页面挂载：日后重新启用某个提供方行的部署，不应该还要顺带恢复该页面。被禁用的集合就是 `dsh-base` 挂载的、否则会解析密钥并触达端点的三行；日后向 base 新增的 HTTP 提供方需要手工加入该列表，这也是测试钉住整个集合而不是计数它的原因。

</details>
