# dsh-execution-viewer 完整目标规格

本规格描述 `dsh-execution-viewer` capability 归档后必须存在的完整行为。它是后续实现 change 的唯一设计依据，实现不需要重新做设计判断。

## 1. 能力与边界

capability 交付一个仓库内的 Web 客户端插件包 `packages/client/ui-execution-viewer/`（包名 `@deepseek-ai/dsh-client-ui-execution-viewer`），为 DeepSeek Harness 的浏览器界面提供 Codex 风格的"执行过程查看"能力。

插件注册自己的 Conversation View target `'execution'`，在会话头部贡献一个视图页签。该视图展示一次执行的扁平步骤列表：每行一步，含类型、标题、状态与耗时；点击行展开完整详情；推理文本在执行期间实时流式展示；执行结束后整体收口为可查阅的记录。

插件是纯增量：不修改任何既有包的行为，不改变 agent loop 与工具执行，不新增会话事件类型。

## 2. 平台前提

实现必须建立在下列已核实的事实基线上。这些是实现前提，不是可选项。

- Assistant 输出分两层：瞬态层是 Host 进程内的 `agent/assistant-stream`，在浏览器侧折为客户端事件 `assistant/live-chunk`；持久层是 `assistant/message` 与 `assistant/attempt`，内嵌 `stream: AssistantStreamRecord[]`。
- 实时推理文本在流块的 `reasoning-delta.text`；工具参数增量在 `tool-call-delta.argumentsDelta`（原始 JSON 字符串片段）；工具调用身份是 `ToolCallId`（`index` 只用于块间定位，不可作身份）。`reasoning-chunks` 是**持久化** `AssistantStreamRecord` 的判别式，不是实时帧。
- 持久记录按时序还原：打包记录携带 `time0` 与 `dt[]`，第 i 个成员的时间等于 `time0 + prefix(dt)` 之和。
- 工具事件载荷：`tool/call` 为 `{ turn, step, callId, name, arguments }`（`arguments` 是原始 JSON 字符串）；`tool/result` 为 `{ turn, step, message, error?, meta? }`。**不存在 `stepId`**；字段是 `turn` 与 `step`。
- 失败信息来自 `message.isError` 与 `error?: { name, code, reason? }`。**没有一等退出码字段**，界面不得声称展示退出码。
- `assistant/message` 的 `interrupted?: true` 是"回合中途取消、把已交付的文本与推理前缀定稿"的权威标记。
- 每个会话事件信封带 `seq` 与 `time`（Unix epoch 毫秒），因此排序与耗时都可以纯从日志推出。
- 当前 `SESSION_FORMAT_VERSION` 为 4；本 capability 不改动它。
- Conversation 有三个注册面：`ctx.uiConversation.events.register(definition)` 注册事件折叠 Definition；`ctx.uiConversation.views.register(definition)` 注册每个 target 的 View Definition；`ctx.uiConversation.groups.register(...)` 注册可选的分组 Definition。渲染组件通过 `ctx.slots.register` 注册到槽。
- `ConversationNodeDefinition` 的字段是 `kind`、`target?`、`match`、`start`、`update`、`publication?`、`buildLocationData?`、`buildViewNode?`。`match(event)` 只读当前事件、只做身份提取；`target` 与 `buildViewNode` 必须同时出现。
- `ConversationViewDefinition` 的字段是 `target: string`、`toolCallFocus?(callId)`、`create(): ConversationViewBuilder`、`isActive?(snapshot)`。Builder 提供 `empty`、`replace({nodes, timeline, changedTurns?})`、`apply({upserts, timeline, changedTurns?})`。`target` 是开放字符串，注册新 target 不需要改任何外部文件。
- 视图挂载点是 `conversation.view` 槽（`kind: 'list'`、`scope: 'session'`），由 `ui-conversation` 声明并由会话壳渲染。页签只在注册了多于一个视图时显示。首次订阅才激活 target 并执行一次 `replace()`。
- 浏览器侧通过 `ctx.uiSession.provide({ hooks: ['<name>'], resolve })` 获得标准 hook `use<Name>`。
- 步骤边界事件是 `turn/start`、`turn/end`、`step/start`、`step/end`；`TurnLocation` 提供 `turn`、`start?`、`end?`、`status: 'open' | 'closed' | 'unknown'`、`steps`。

## 3. 架构决策

### D1 注册独立 View target

插件注册 `target: 'execution'` 的 View Definition，并通过 `conversation.view` 槽贡献一个 `id: 'execution'` 的页签。插件不注册任何 `target: 'chat'` 的节点。

理由：`ui-chat` 的过程折叠已经提供等价能力，往 chat 里追加第二份过程列表会让两份过程列表同时可见。独立 target 是平台明文支持的第三方扩展方式。代价是用户需要切换视图才能看到执行过程，此代价在 §11 记为已知限制。

### D2 折叠全部在客户端

插件包的 Host 面是最小空 `apply`，不含服务、配置或业务逻辑。所有折叠在浏览器侧完成，数据来自客户端已持有的会话事件窗口。

理由：折叠所需的数据已在客户端。Host 侧重算会产生第二份真相源，并且需要新增跨进程通道。

### D3 步骤分类自带一份

工具名到步骤类型的映射在本包内实现，运行期不导入其他 feature 插件的值。参照语义与 `ui-chat` 的 process-activity 分类同源。

理由：仓库禁止客户端 feature 插件之间运行期导入彼此的运行时值；把该映射提升为共享静态归属需要用户签字，当前只有两处消费者，收益不足。

### D4 接入方式参照 `dsh-llm`，架构参照 client 插件族

`dsh-llm` 只提供"仓库内包接入方式"这一层参照：包自身不声明 bundle、cordis 行与包依赖由 bundle 包拥有、`peerDependencies` 只放 Cordis、依赖按面分区、按面做薄子路径导出。`dsh-llm` 是 Host 服务包，本 capability 是浏览器 UI 功能包，两者的架构与构建路径不可比，不作为参照。

UI 结构与注册面参照 client 插件族，模板是 `ui-tool`（最接近：单面 client 包加空 Host 半）与 `ui-trajectory`（同形：注册自己的 view target）。

### D5 不声明 Cordis Config

版本一不声明 Cordis 配置。候选可变项（展开状态、过滤、推理预览行数）都是用户级偏好而非部署级选择，走浏览器本地状态。若日后确认某项属于部署级配置，必须照 `ui-theme` 的 Host 配置加启动注入形状补做，并补 `docs/config-catalog.md` 条目。

## 4. 数据模型

### 4.1 步骤类型与分类

步骤类型是闭合联合，取值如下：

```
thinking
read | readImage
search | list
write | edit
run
code
webSearch | webFetch
subagent
plan
questions
tool
```

工具名到类型的映射，逐条固定：

| 工具名 | 类型 |
| --- | --- |
| `read` | `read` |
| `read_image` | `readImage` |
| `glob` | `list` |
| `grep`，以及任何以 `_inspect` 结尾的名字 | `search` |
| `write` | `write` |
| `edit`、`apply_patch` | `edit` |
| `bash`、`pwsh`、`exec_command`、`write_stdin`，以及任何以 `terminal_` 开头的名字 | `run` |
| `run_code` | `code` |
| `web_search` | `webSearch` |
| `web_fetch` | `webFetch` |
| `subagent`，以及任何以 `subagent_` 开头的名字 | `subagent` |
| `todo_write`、`create_goal`、`update_goal`、`get_goal` | `plan` |
| `ask_user_question`、`request_user_input` | `questions` |
| 其他任何名字（含 MCP 与动态工具名） | `tool`，行标题回落为原始工具名 |

`thinking` 不由工具名映射产生，它由推理折叠产生。工具名是开放字符串，未知名字必须安全回落到 `tool` 并且原样显示。

### 4.2 状态机

步骤状态取值与判定：

- `preparing`：只见到 `tool-call-delta`，尚未提交 `tool/call`。此状态只存在于实时阶段。
- `running`：已提交 `tool/call`，尚未见到 `tool/result`。
- `succeeded`：`tool/result` 到达且未报错。
- `failed`：`tool/result` 到达且 `message.isError === true`，或 `error` 存在。展示的错误码取 `error.code`。
- `unfinished`：该轮 `turn/end` 之后仍没有 `tool/result` 的调用。这是派生呈现，只依赖持久事件，界面上要能读出它不是被记录的结局。

推理步骤的状态是 `running`、`succeeded` 或 `interrupted`。`interrupted` 由该 `(turn, step)` 结算的 `interrupted: true` 决定，不得从 `turn/end` 反推。

### 4.3 时长

| 对象 | 起点 | 终点 |
| --- | --- | --- |
| 工具步骤 | `tool/call` 信封 `time`（实时阶段用首个参数增量的 `time`） | `tool/result` 信封 `time` |
| 推理步骤 | 首个推理增量或打包记录首成员的时间 | 末个推理成员的时间，或该 step 结算的 `time` |
| 未结束步骤 | 起点 | 当前墙钟，仅在界面层 |

差值取非负。实时阶段的时长是呈现，不写入任何快照或日志。

### 4.4 快照

快照结构：

```
ExecutionSnapshot {
  turns: readonly ExecutionTurn[]
  stepCount: number
  runningCount: number
}

ExecutionTurn {
  turn: number
  status: 'open' | 'closed' | 'unknown'
  steps: readonly ExecutionStep[]
}

ExecutionStep {
  key: string                 // 引擎 NodeKey，React 身份
  kind: ExecutionStepKind
  status: ExecutionStepStatus
  anchorSeq: number           // 排序依据
  turn: number
  step: number
  startedAt: number
  endedAt?: number
  title: StepTitle            // 结构化，不预渲染文案
  summary: string             // 折叠行摘要，按字素截断
  detail: StepDetail
  error?: { name: string; code: string; reason?: string }
}
```

标题是结构化取值，不是文案：

```
StepTitle =
  | { kind: 'tool'; name: string }
  | { kind: 'path'; path: string; verb: 'read' | 'write' | 'edit' }
  | { kind: 'query'; query: string }
  | { kind: 'command'; command: string }
  | { kind: 'url'; url: string }
  | { kind: 'thinking'; chars: number }
```

详情按类型取所需字段：

```
StepDetail =
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; argumentsRaw: string; content?: string; isError?: boolean }
```

视图节点扩展 `ConversationViewNode`，带 `key`、`kind`（`execution-step` 或 `execution-thinking`）、`id`、`target: 'execution'` 与 `data`。节点必须携带 `anchorSeq`，因为引擎不保证 `replace()` 传入节点的顺序。

完整结果内容保留在快照中，与 `ui-chat` 的 `ToolResultNode` 取舍一致；折叠行只渲染截断后的摘要。

### 4.5 本地化

`StepTitle` 与步骤类型是结构化数据，不是文案。所有面向用户的字符串（页签名、状态词、单位、字段标签、空态文案）都来自本包的 locale 字典。模型、工具与线上数据（工具名、路径、命令、查询、URL、错误码）原样显示，不翻译、不改写。

## 5. 事件折叠

插件注册两个事件折叠 Definition，`target` 都是 `'execution'`。

### 5.1 `execution-step`：一次工具调用一步

| 项 | 规则 |
| --- | --- |
| kind | `execution-step` |
| target | `execution` |
| match | `assistant/live-chunk` 且 `chunk.type === 'tool-call-delta'` 时以 `chunk.id` 作身份、角色为 start；`tool/call` 以 `callId` 作身份、角色为 start；`tool/result` 以 `callId` 作身份、角色为 update；其余返回 null |
| start | 由首个 `tool-call-delta` 建立 State：调用 id、turn、step、可选名字、空参数、状态 `preparing`、起始时间 |
| update | 累积参数增量（只保留有界前缀用于摘要）；`tool/call` 覆盖名字与完整原始参数并转 `running`，记录调用时间；`tool/result` 按 §4.2 判据转终态，记录内容、错误与结果时间 |
| publication | 参数增量用 `animation-frame`；其余用 `immediate` |
| buildViewNode | 产出 `execution-step` 节点，`anchorSeq` 取最早匹配事件的 `seq` |
| buildLocationData | 版本一不发布 |

身份用 `ToolCallId`，因为参数增量与持久调用携带同一个值，天然把实时与持久证据缝进同一个 Context。

### 5.2 `execution-thinking`：每个 step 一段推理

| 项 | 规则 |
| --- | --- |
| kind | `execution-thinking` |
| target | `execution` |
| 身份 | `turn` 与 `step` 的组合。**不使用 `attemptId`**，因为持久结算 `assistant/message` 的载荷不含它，用它会使其在重连或翻页后无法缝回同一个 Context |
| match | `assistant/live-chunk` 且 `chunk.type === 'reasoning-delta'` 时为 start；`assistant/message` 或 `assistant/attempt` 且 `data.stream` 含 `reasoning-chunks` 时为 start；其余返回 null |
| start 与 update | 瞬态证据追加文本，`anchorSeq` 取首个增量的 `seq`；持久证据以 `reasoning-chunks` 的文本拼接为权威文本，覆盖瞬态累积，并按记录还原起止时间 |
| publication | 推理增量用 `animation-frame`；结算用 `immediate` |
| 中断 | 结算带 `interrupted: true` 时状态转 `interrupted`；`assistant/attempt` 只贡献文本，不决定状态 |
| 重试 | 同一 `(turn, step)` 的第二次结算以最新持久证据为准（覆盖而非追加） |

### 5.3 不变量

- I1：`match` 与 `update` 是常数时间操作。禁止遍历事件窗口、其他 Context、`context.matches` 全量或已完成节点。累积放进 State。
- I2：移除全部 `assistant/live-chunk` 证据后，State 必须能仅由持久事件重建出等价结果（实时是增量预览，持久是权威）。
- I3：State 是匹配事件按 `seq` 升序的确定性纯函数，不得依赖实时内存。
- I4：同一 `(kind, id)` 只有一个 start；React 身份使用引擎的 Context key 并保持不变。
- I5：可展示的事实必须来自持久事件；实时只做预览，实时专有状态不得泄漏进任何持久结论。

### 5.4 实时性来源

高频可见增量（推理增量与工具参数增量）使用 `publication: 'animation-frame'`，避免每个 token 触发一次 React 提交。

## 6. 视图构建

Builder 实现 `ConversationViewBuilder`：

- `empty` 是空快照。
- `replace` 全量重建：按 `anchorSeq` 升序排列节点，按 turn 分组，用 `timeline.turns` 补每轮状态，计算步骤数与运行中计数。
- `apply` 只处理入参中的 upsert：同 key 替换，新 key 按 `anchorSeq` 插入正确位置，分组与计数增量维护。
- `runningCount` 等于状态属于 `preparing` 或 `running` 的步骤数。

不注册 Group Definition：本视图本身就是扁平列表，轮次只作为分隔标题，分组机制在此没有成员归属要表达。

View Definition：

```
target: 'execution'
create: 返回新的 Builder
isActive: 快照步骤数大于 0 时为真
```

不声明 `toolCallFocus`：声明它意味着本视图支持 Inspect 的工具聚焦，版本一不做。这是"已考虑并推迟"，不是遗漏。

## 7. 渲染

### 7.1 组件

```
ExecutionView          目标快照 → 轮次分隔 + 步骤列表
├─ ExecutionTurnHeader 轮次号、状态、总耗时
└─ ExecutionStepRow    一行一步
   ├─ StepGlyph        类型到图标
   ├─ StepTitleLine    结构化标题到本地化文案
   ├─ StepStatusLabel  状态词
   ├─ StepDurationLabel 耗时，含运行时走秒
   └─ StepDetailPanel  展开后：完整命令、参数、结果、错误、推理文本
      └─ ReasoningText 推理文本容器
```

组件只接收框架派生的 props 与注入面，不接触 `ctx`。

### 7.2 注册与数据通道

客户端插件体按下列顺序注册：

1. locale 字典（`ctx.effect` 包裹，随插件卸载回收）。
2. 两个事件折叠 Definition。
3. View Definition。
4. `ctx.uiSession.provide({ hooks: ['execution'], resolve })`，把每个绑定映射为可观察的本视图快照。
5. `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'execution', order: 20, locale, label: () => t('view.execution'), children, inject }, ExecutionView))`。

`inject` 声明必需服务：`slots`、`sessions`、`uiSession`、`uiConversation`、`locale`。`label` 必须是读取当前 locale 的 thunk，注册期不固化文案。用 `slots.inject` 而非裸 `register`，以便在声明出现前等待、在声明塌陷时撤除。

### 7.3 展开状态

每行的展开与折叠是组件本地状态。它不被其他组件读取，也不订阅外部事实。

若日后列表虚拟化导致行重挂载丢状态，届时的正解是注册一个共享 store 并走 store 通道，而不是现在预建。不做"全部展开"与"全部折叠"的聚合开关，因为那会迫使状态离开本地。

### 7.4 样式与本地化

只用 CSS Modules 与共享 `--dsw-*` 语义别名，没有字面色值、组件库或 Tailwind。推理文本与命令、参数、结果使用等距字体与保留换行的容器；长内容在详情面板内自带滚动，不撑破外层滚动容器。

所有产品文案进本包 locale 字典。工具名、路径、命令、查询、URL、错误码等数据原样渲染。

### 7.5 走秒

当快照中存在 `preparing` 或 `running` 步骤时，视图挂一个本地定时器刷新耗时显示；全部结束或组件卸载时清理。走秒是纯呈现，不写入快照或日志，也不引入全局 tick。

## 8. 包骨架与接入

### 8.1 文件树

```
packages/client/ui-execution-viewer/
  package.json
  tsconfig.json
  tsdown.config.ts
  README.md / README.zh.md / README.i18n.yaml
  src/
    index.ts                     Host 面：最小空 apply
    client/
      apply.ts                   唯一的跨域装配点
      locales.ts                 NS 与中英文字典
      contract/                  唯一共享 API：数据类型、槽行、纯函数分类
        execution.ts
        slots.ts
        classify.ts
      definitions/               域一：事件折叠
        step-definition.ts
        thinking-definition.ts
      view/                      域二：Builder 与 View Definition
        builder.ts
        view-definition.ts
      components/                域三：React
        ExecutionView.tsx
        ExecutionTurnHeader.tsx
        ExecutionStepRow.tsx
        StepDetailPanel.tsx
        StepGlyph.tsx
        format.ts
  tests/
    step-definition.client.spec.ts
    thinking-definition.client.spec.ts
    builder.client.spec.ts
    step-row.client.spec.tsx
    execution-view.client.spec.tsx
    apply.client.spec.ts
```

`contract/` 是唯一共享 API；三个域目录之间不互相 import；`apply.ts` 是唯一装配点。

### 8.2 清单

`package.json` 必须具备：

- `type: "module"`、`main`、`types`。
- `exports`：`.`、`./client`、`./src/*`、`./package.json`。
- `files`：`lib/index.js`、`lib/client.js`、`lib/types/**/*.d.ts`。
- `dsh.client`：`platform: "web"`，`inject` 用完整作用域名列出依赖包。
- `peerDependencies`：只有 Cordis（`workspace:~`）。

不声明 `dsh.client.external`（只用基线模块）。不发布 `./invariant`，并在 README 说明理由。可以有也可以没有 `dependencies` 段。

`tsconfig.json` 继承 `tsconfig.base.client.json`，references 中 client 依赖指向对方的 `tsconfig.client.json`。`tsdown.config.ts` 调用 `clientBundle(包名, ['lib/types/index.js'])`。

### 8.3 四处接入面

缺任何一处都会在不同阶段失败：

1. `tsconfig.base.json` 的**手写**裸别名，映射包名到 `./packages/client/ui-execution-viewer/src`。必须手写：别名生成器只生成包名后缀与目录名相同的包，client 包的包名带 `client-` 前缀会被跳过，随后 `verify-tsconfig-paths` 会以"缺少手写条目"失败。
2. `tsconfig.client.json` 聚合 `references` 中加入本包的 `tsconfig.client.json`。
3. `packages/bundle/web-app/cordis.patch.yml` 中加插件行（`id` 与 `name`，不带 `config`）。
4. `packages/bundle/web-app/package.json` 中加 `workspace:*` 依赖。

不需要改 `packages/bundle/base`、`headless` 或 `sdk-minimal`；不需要新增 shell 配置或枚举。

### 8.4 与 `dsh-llm` 的边界

从 `dsh-llm` 取用的只有接入方式五条：包不自带 bundle；bundle 侧两处接线；`peerDependencies` 只放 Cordis；依赖按面分区；按面做薄子路径导出。

不作为参照：它的 Host 服务架构与 typert 面；它的根统一构建路径（client 包必须自带包内构建配置）；`./invariant` 是否发布（按本包自身判断）；裸别名是否可被生成器覆盖（取决于包名后缀是否等于目录名）。

## 9. 验收与检查要求

### 9.1 折叠单测

必须逐条覆盖下列断言：

| 编号 | 断言 |
| --- | --- |
| T1 | 完整窗口走一次 `replace`，产出预期的最终 State、节点载荷、`anchorSeq`、`turn` 与 `step` |
| T2 | 只有 update 的尾巴保持 pending；补上 start 后与完整窗口结果相同 |
| T3 | 初始历史加实时追加与重放合并窗口结果相同 |
| T4 | 向上翻页插入更早的行，不替换数据未变的既有 keyed 节点 |
| T5 | 重复的可见增量保持 Context key，且按要求每帧最多发布一次 |
| T6 | 组件只消费快照与受限 hook，不扫会话窗口、Context 或 Chat 节点 |
| T7 | 标量历史与打包历史产出相同最终 State 与时间边界 |
| T8 | 实时证据全部移除后，State 与节点仍可由持久事件重建 |
| T9 | 同一 `(turn, step)` 的第二次持久结算覆盖而非追加；`interrupted` 转 `interrupted` 而非 `running` |
| T10 | 未知工具名安全回落 `tool`；结果缺失加上轮次结束判定为未完成 |

### 9.2 组件测试

用 jsdom 环境（spec 首行 pragma），给真实 props 或驱动式 fixture 渲染，断言用户可见行为，不断言类名、hook 内部或渲染次数。覆盖：行标题按结构化标题正确本地化；失败行显示错误码；展开显示完整命令与结果；推理文本按推理详情渲染；走秒在终态停止。`apply` 的注入测试覆盖视图条目注册成功、`useExecution` 可用、卸载后注册被回收。

### 9.3 覆盖率与检查

- `pnpm run test:coverage` 对本包 `src/**` 逐文件 100%（语句、分支、函数、行）。不可达的防御分支使用带真实理由的忽略注释，不使用裸忽略。
- 新包触及的检查：`verify-tsconfig-paths`、`verify-client-packages`、`verify-cordis-config`、`verify-package-dependencies`、`verify-client-ui-i18n`、`verify-client-domain-graph`、`verify-client-route-resolution`、`verify-client-catalog`、`verify-translation-pairing`（README 双语加 `README.i18n.yaml`）、`verify-export-jsdoc`、`verify-package-meta`、`verify-package-invariants`、`verify-package-readme-model-experience`、`verify-package-readme-limitations`。
- `pnpm run typecheck` 的 host 与 client 两面通过。
- `pnpm run test:gui` 通过。

### 9.4 快照与端到端

本 capability 是 human-visible 变更，必须在同一个实现 change 中新增或更新一个无密钥录制会话场景。归属 Web 录制；允许显式借用另一个场景的规范会话，只新增浏览器侧期望输出。因为页签条在多于一个视图时出现，现有 UI-only 期望输出可能一起变化：运行 `DSH_SNAPSHOT=replay pnpm run test:web`，逐条审查差异后再决定 refresh。

## 10. 实施顺序

| 阶段 | 内容 | 退出标准 |
| --- | --- | --- |
| S0 | 包骨架、四处接入面、最小空 apply、locale、视图页签（占位渲染） | 能看到新页签；相关检查全绿 |
| S1 | contract 层：类型、分类、格式化；Builder 与 View Definition 的空快照与激活语义 | 骨架单测通过；逐文件 100% |
| S2 | `execution-step` 折叠（仅持久事件） | T1 到 T4 与 T10 通过 |
| S3 | 视图组件与详情面板（结构、样式、本地化） | 组件测试通过；Web 回放通过 |
| S4 | `execution-thinking` 折叠（仅持久结算） | T7 与 T9 通过 |
| S5 | 实时层：参数增量与推理增量、走秒、帧发布 | T5 与 T8 通过；真实会话中不抖不重 |
| S6 | 交互收口：展开状态、未完成判定、长内容滚动与边界情形 | T10 完成；体验走查通过 |
| S7 | 文档与决策记录：README 双语、模型体验与已知限制节 | 文档检查全绿 |

S0 到 S3 是最小可用闭环。实时层必须在持久层稳定之后实现，因为它的正确性依赖 I2 不变量已经成立。

## 11. 风险与已知限制

- 与 ui-chat 的信息架构重叠是产品风险而非技术风险：两个视图都在讲"这一轮做了什么"。本视图靠"扁平、等权、可审计的步骤账本"与详情完整性形成差异。若用户反馈看不出区别，应重新评估是否保留。
- 断线时实时预览回落到持久结算，正在流式的推理文本会瞬间变短。这是平台语义，不是缺陷，必须在 README 的已知限制中写明。
- 未完成判定是派生态：轮次结束后没有结果的调用被判为未完成。若将来出现"结果延迟到下一轮"的合法情形，该判据会误报，需在代码注释与 README 标注该假设。
- 本视图是只读账本，不提供输入、审批或继续对话的交互面；用户要发消息必须切回 Chat。
- 页签数量增加是用户可见的变化，S0 需要一次视觉走查确认不拥挤。
- 包名 viewer 与命名规则存在张力，但已定案沿用。
- 是否复用 chat 的工具卡槽属于另一个特性，不在本 capability 内。

## 12. 场景

### Scenario: 包与四处接入面完整

在新包目录创建 `packages/client/ui-execution-viewer/`，其 `package.json` 声明 `dsh.client`（`platform` 为 `web`）与 `./client` 导出，并补齐四处接入面：`tsconfig.base.json` 的手写裸别名、`tsconfig.client.json` 的聚合引用、Web bundle 的插件行、Web bundle 的包依赖。

验收：A1

### Scenario: 视图页签与数据通道

默认部署打开一个会话时，会话头部出现新增视图页签，页签文案来自本包 locale 字典；`conversation.view` 注册成功并在插件卸载后可回收；`useExecution` 由 `uiSession.provide` 提供并能读到本视图快照。

验收：A2

### Scenario: 仅凭持久事件重建步骤

给定只包含 `tool/call` 与 `tool/result` 的持久事件窗口，视图能重建每一步的类型、标题、状态与耗时，且工具步骤的耗时等于两侧事件信封时间之差。

验收：A3

### Scenario: 工具名分类与回落

对分类表列出的每个工具名，步骤类型与表格一致；对未知或动态工具名，类型回落为 `tool` 且标题原样显示该名字。

验收：A4

### Scenario: 终态与未完成判定

`tool/result` 的 `message.isError` 为真或携带 `error` 时步骤显示为失败并显示 `error.code`；某个 `tool/call` 之后轮次结束仍无结果时步骤显示为未完成；界面不出现退出码。

验收：A5

### Scenario: 推理文本与时序由持久结算还原

一个 `assistant/message` 携带推理打包记录时，视图显示由该记录拼接的推理文本与由记录时序还原的时长；结算带 `interrupted` 时步骤显示为 interrupted 而不是运行中。

验收：A6

### Scenario: 实时增量与走秒

运行中的轮次里，推理增量与工具参数增量实时可见并按帧发布；未结束步骤显示走秒；全部步骤结束后走秒停止；走秒不写入快照或日志。

验收：A7

### Scenario: 瞬态证据移除后的等价重建

把窗口中全部 `assistant/live-chunk` 证据移除（模拟重连与向上翻页）后，快照与节点仍可由持久事件重建为等价结果。

验收：A8

### Scenario: 三条装配路径等价

完整 `replace`、只有 update 的尾巴补上 start、初始历史加实时追加，三条路径产出相同的最终 State 与节点载荷。

验收：A9

### Scenario: 快照排序、分组与激活

Builder 输出按 `anchorSeq` 排序、按轮次分组、步骤数与运行中计数正确；无步骤的会话 `isActive` 为假；未打开视图的会话不产生折叠工作。

验收：A10

### Scenario: 步骤行与详情面板

视图每行一步，展示类型图标、结构化标题、状态与耗时；点击行展开详情面板，显示完整命令、完整参数、完整结果、错误与推理文本。

验收：A11

### Scenario: 文案本地化与数据原样

客户端源码不含字面产品文案，全部经 locale 字典，`verify-client-ui-i18n` 通过；工具名、路径、命令、查询、URL 与错误码原样显示，不被翻译或改写。

验收：A12

### Scenario: 覆盖率与检查通过

`pnpm run test:coverage` 对本包 `src/**` 逐文件 100%；本规格列出的全部检查通过；`pnpm run typecheck` 两面通过。

验收：A13

### Scenario: Web 快照与端到端

`DSH_SNAPSHOT=replay pnpm run test:web` 通过，且至少一个 Web 场景断言执行过程视图的步骤行渲染；期望输出的差异经逐条审查后才刷新。

验收：A14

### Scenario: 不越界

实现不修改任何既有包的行为，不新增 Host 服务或 typert 与 Remote 面，不新增会话事件类型，不声明 Cordis 配置；变更范围仅限新包与四处接入面。

验收：A15
