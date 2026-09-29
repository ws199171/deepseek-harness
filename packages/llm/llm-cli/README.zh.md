---
description: "委托式 LLM（大语言模型）适配器：每次模型调用都通过运行一个自带认证与智能体循环的 CLI（命令行界面）子进程（默认 CodeBuddy）来作答。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-cli

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-cli` 注册一条 LLM 路由 `codebuddy-cli`，其答案来自 CLI 子进程而非提供方端点。所配置的 CLI 自带认证，并用自己的工具运行自己的智能体（agent）循环，因此 harness 只转发对话文本、再把最终答案流式收回：无需 API 密钥、无需端点，线路上也没有 harness 的工具词汇。每次调用都经共享的子进程接缝启动一个子进程并消费其 `stream-json` 输出，而 `llm-cli` 设置分节可在下一个请求上改动命令、参数、目录与权限策略。

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

当某个部署必须在没有 API 密钥的情况下进行对话，或应当通过一个已经带有用户本人登录态的 CLI 触达模型时，挂载本插件。路由就是它唯一新增的东西：会话、工具、智能体循环与 Models 页面都属于它周围的组合。

本包的单提供方孪生是[打包的 CLI profile](../../bundle/llm-cli/README.zh.md)，它挂载这条路由并关闭 HTTP 提供方行。要替换 API 源就选该 bundle；要在某条已有路由旁再加一条就选本插件。

### 角色

| 角色 | 位置 |
|---|---|
| 服务定义 | [`@deepseek-ai/dsh-llm`](../llm/README.zh.md)（`LlmAdapter`） |
| 服务提供方 | 本包（`CliAdapter`，路由 `codebuddy-cli`） |
| 消费方 | `@deepseek-ai/dsh-agent-loop` 与辅助 LLM 调用方 |
| 依赖 | [`@deepseek-ai/dsh-subprocess`](../../subprocess/subprocess/README.zh.md) |

### 一次调用如何工作

1. 适配器通过插件自己持有的、按操作求值的 thunk，解析可执行事实——命令、参数、工作目录、环境与权限策略。
2. 它经共享子进程接缝启动一个子进程，从而继承进程树终止与环境清洗。
3. 提示词被追加为子进程的最后一个位置参数，因为打印模式的 CLI 从那里读取提示词，而不是从 stdin 读取。
4. 子进程 `stream-json` 的 stdout 行被逐行解析：`assistant` 事件携带累积消息文本，因此增量是相对上一次观察到的文本计算的；终止 `result` 事件则为这次运行定局。
5. 适配器发出 `block-start`、文本增量、`block-end`、任何被报告的用量，以及一个终止 `finish`。

### 配置该路由

每个字段在 YAML 中都可省略，并默认采用 CodeBuddy。缺失分节仍会注册一条可服务的路由。

```yaml
- id: llm-cli
  name: '@deepseek-ai/dsh-llm-cli'
  config:
    command: codebuddy
    args: ['--print', '--output-format', 'stream-json', '--include-partial-messages']
    acpArgs: ['--acp']
    modelDiscoveryArgs: ['--help']
    models: []
    transport: print
    permissionMode: bypassPermissions
    sessionIdArg: --session-id
    disposeGraceMs: 3000
```

`cwd` 为每个请求钉住子进程的工作区；省略它则让持久会话运行在会话存储所记录的工作区中，并回退到进程目录。把 `sessionIdArg` 设为空字符串会关闭 CLI 侧会话，从而让每次调用都无状态。`env` 叠加在接缝清洗后的基底之上。

### 传输方式

`transport` 决定一次调用如何抵达 CLI，两种模式在"每次调用付出什么"上不同：

- `print`（默认）：为这一次调用按 `args` 启动子进程并读取其 `stream-json` 输出。`--include-partial-messages` 让答案在 CLI 仍在生成时就逐段到达；不带它，调用方要等整轮跑完才拿到一整条消息。
- `acp`：每条路由只按 `acpArgs` 启动一个常驻子进程，并在其上按会话发提示。这样 CLI 的冷启动只付一次而非每次调用都付；对话历史由该会话持有，CLI 自己的思考过程也以独立内容块到达，而不是留在子进程里。

### 约束被委托的循环

`tools`、`maxTurns`、`effort` 直达 CLI 自身的 agent loop——在本包能管的范围内，它默认是不设上限的。`tools` 置空会关掉全部内置工具，这是本路由最接近"裸模型调用"的形态：CLI 不运行任何工具直接作答。`maxTurns` 限制它的 agentic 轮数，`effort` 指定它转发给模型的推理档位。三者都省略时由 CLI 自己的默认值决定——除非部署方确有理由，否则这就是正确的选择。

### 模型标识

本插件提供 CLI 自己的目录，而不是自带一份目录：它经子进程接缝运行 `modelDiscoveryArgs`，并解析 CLI 为其 `--model` 选项列出的标识。`models` 列表是为无法询问 CLI 的部署准备的参考目录；已发现的标识在前，CLI 未报告的已配置标识随后，各自只出现一次。

### 会话

携带 `sessionId` 的请求只转发最新一条由人撰写的用户文本，并由 `sessionIdArg` 指名那个已经持有历史的 CLI 自有会话。插件注入的 user 角色上下文同样使用 user 角色，因此决定哪段文本属于人的是消息来源，而非角色本身。会话标题与压缩这类无状态调用方则改为展平整段对话，因为它们没有可续接的 CLI 侧历史。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：设置、路由注册、模型发现 |
| [`src/adapter.ts`](src/adapter.ts) | `CliAdapter`：argv 构造、stdout 泵、分片发射 |
| [`src/wire.ts`](src/wire.ts) | 线路协议解析与累积增量计算 |
| [`src/translate.ts`](src/translate.ts) | harness 消息到 CLI 提示词文本，以及系统提示词切分 |
| [`src/config.ts`](src/config.ts) | 易变配置字段与通向可执行事实的那一步解析 |
| [`src/discovery.ts`](src/discovery.ts) | CLI 自己的列表命令，经子进程接缝运行 |
| [`tests/`](tests/) | 单元、fixture 子进程与真实组合测试套件 |

### 只有两处接缝

插件注入 `llm` 与 `subprocess`，并以无类型方式查找 `sessions`。因此它可以挂载在没有会话存储的组合中，并且不注册任何 Remote 面、任何客户端包或任何 base bundle 行——挂载它不会改动任何其他包。

### 为什么提示词是参数

CodeBuddy 的打印模式从末尾的位置参数读取提示词；stdin 不是它消费的通道。适配器因此让每次解析后的 `argv` 保持恒定，并把提示词追加在最后，这也解释了为什么 `args` 中的空条目会被拒绝：它会挪动 CLI 自己对提示词的读取。

### 为什么系统提示词会移动

由循环构建的请求会让 `GenerateOptions.system` 保持未定义，并把提示词作为开头那条 system 角色消息携带。适配器同时读取二者，优先采用显式字段，并把结果经 `--append-system-prompt` 传入。展平后的对话随后只包含 user 与 assistant 文本，因此提示词绝不会被重复塞进位置参数。

### 不变式归属

不发布运行时不变式伴生入口，因为适配器的可观察约定——每次调用一个子进程、增量相对上一次看到的文本计算、一个终止 `finish`——由其自身测试套件在真实子进程接缝上断言；本包不注册任何内容，树内也没有可变关系可审计。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 服务与适配器注册表](../llm/README.zh.md)——本包为其提供一条路由的接缝。
- [进程接缝](../../subprocess/subprocess/README.zh.md)——子进程生命周期、stdio 处置与受管区间终止。
- [打包的 CLI profile](../../bundle/llm-cli/README.zh.md)——这条路由作为模型源挂在 `dsh-base` 之上的形态。
- [设置](../../settings/settings/README.zh.md)——`llm-cli` 分节如何被存储、校验与报告。

-----

<a id="model-experience"></a>
## 模型体验

### CodeBuddy CLI 模型请求

#### 模型看到什么

每个请求都是一个全新的 `codebuddy --print --output-format stream-json` 子进程。持久会话请求只把最新一条由人撰写的用户文本作为末尾位置提示词，旁边是 `--session-id <harness session id>`；无状态请求则改为携带展平后的对话。组装好的 harness 系统提示词在存在时经 `--append-system-prompt` 追加，所选标识以 `--model <id>` 到达。harness 的工具声明、`temperature`、`maxTokens` 与 `stop` 都不会被转发，因为 CLI 拥有自己的循环。

#### Token 影响

每次调用一个位置提示词加一个系统提示词参数。提示词长度在持久会话下跟随最新人写文本，在无状态调用下跟随整段对话。CLI 自己的历史、其内部工具活动及其提供方侧计量都绝不进入 harness 请求。

#### KV Cache 影响

harness 不发送任何按请求的提供方载荷，因此它不贡献可复用前缀，也观察不到提供方侧的缓存状态。任何提供方侧复用与淘汰都归 CodeBuddy 在其自有的会话背后掌管。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有最终答案穿过边界**——CLI 内部的工具步骤与中间文件对 harness 会话日志不可见，因此记录为每次调用一个文本块，无法重放 CLI 做过什么。
- **工具批准由 CLI 自己的策略决定**——`permissionMode` 管的是 CodeBuddy 的工具；harness 权限预设、文件系统沙箱与 shell 沙箱都不介入它们。因此默认的 `bypassPermissions` 会把桌面进程的 OS 访问权授予该子进程。
- **只理解 CodeBuddy 形状的输出**——`stream-json` 词表与位置参数式调用都出自 CodeBuddy。换成别的 CLI 需要它自己的适配器，而不是一次配置改动。
- **缺少可执行文件时没有模型**——路由仍会挂载并服务其已配置目录，但对话选择器此后不会提供任何 CLI 本可发现的条目。
- **工具次数上限会报告为一个文本块**——轮次上限或错误结果会以目前已产出的文本终止运行；部分输出被保留而不是丢弃。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

子进程的 stdout 逐行读取，并在第一个终止事件处定局；同一个数据块中更靠后的行是尾部输出，会被丢弃。取消也以同样的方式让泵定局，因此垂死子进程在调用方取消之后写入的文本绝不会进入答案。而在子进程已经报告其终止事件之后才到达的取消会被拒绝：结果就是 CLI 所说的那个，迟到的取消无法撤回一个已经完成的答案。

</details>
