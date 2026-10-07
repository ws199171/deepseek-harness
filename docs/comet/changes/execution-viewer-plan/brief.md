# 目标

为 dsh-execution-viewer（Codex 风格"执行过程查看" Web UI 插件）产出并确认一份可执行的计划方案：把 `docs/deepseek_markdown_20261005_a6f00a_dev.md` 的完整技术设计固定为「完整目标规格 + 验收项 + 决策记录」，使后续实现可以按验收项逐条实现与验收，不需要重新做设计判断。

本次 change 的交付物就是这份计划本身。用户已明确决定本次不写插件代码，实现留到后续 change（决策 Q2：A）。

# 范围

本次交付：

- `specs/execution-viewer/spec.md`：插件的完整目标规格，描述归档后该 capability 必须存在的全部行为与约束。
- 本 brief 的验收项 `A1`–`A15`：规格中每一类需要实现的行为对应的可验证结论。
- 决策记录：架构决策 D1–D5 与用户决定 Q1–Q4。

本次不交付：插件代码、测试代码、包骨架文件、构建产物、任何既有包的改动。

## 覆盖边界

覆盖边界是源文档 `docs/deepseek_markdown_20261005_a6f00a_dev.md` 的整份内容（用户决定 Q3：A）。该文档 12 节、40 个小节，其中标注为"对源方案的更正"的内容同样属于边界内需求——它们是实现前提，不是背景。

边界外：上游方案文档 `docs/deepseek_markdown_20261005_a6f00a.md`。它的有效内容已被 dev 文档 §0.1 逐条更正并吸收，其余部分不再有效，因此不作为独立来源登记。

补充：源文档在主检出中以未跟踪文件存在，本 change 的 worktree 不包含该文件；下表按源文档的源位置（节号与行号）记录。

## 源文档覆盖

| 来源条目与位置 | 读取状态 | 需要保留的内容 | Spec 位置 | 验收 ID | 覆盖状态 | 理由或替代关系 |
| --- | --- | --- | --- | --- | --- | --- |
| S1：§0.1 事实更正表（第 14–26 行） | complete | 8 条实现前提：Definition 经 `uiConversation.events.register` 而非 `slots.register`；实时推理是 `reasoning-delta` 帧而非 `reasoning-chunks`；无 `stepId`（字段是 `turn`/`step`/`callId`）；无一等退出码；`SESSION_FORMAT_VERSION = 4`；响应区已具备等价能力；Host 与浏览器之间不能靠 slot 传数据；不 fork agent loop | §2 | A1、A3、A5、A6 | covered | 当前有效需求（实现前提） |
| S2：§0.2 一句话结论（第 28–32 行） | complete | 交付形态：仓库内新 client 包 `packages/client/ui-execution-viewer/`，注册独立 View target `'execution'`、两个事件折叠 Definition、一个 View Builder，不修改任何现有包 | §1、§8 | A1、A2、A15 | covered | 当前有效需求 |
| S3：§1.1 目标（第 36–42 行，5 条） | complete | 扁平步骤列表（类型/标题/状态/耗时）；点击展开完整详情；实时流式推理与走秒；回放与重连一致；与 chat 和 trajectory 共存 | §1、§7 | A3、A7、A8、A11 | covered | 当前有效需求 |
| S4：§1.2 非目标（第 44–52 行，6 条） | complete | 不改 agent loop 与工具执行；不加会话事件类型；不重写 chat 过程分组；不做 Host 业务服务；不引入额外持久化；不伪造思考文本 | §11 | A15 | covered | 当前有效需求（约束） |
| S5：§2.1 Assistant 输出的两层结构（第 56–83 行，含 `StreamChunk` 代码块与运行时帧联合） | complete | 瞬态层 `agent/assistant-stream` 折为客户端 `assistant/live-chunk`；持久层 `assistant/message` 与 `assistant/attempt` 内嵌 `AssistantStreamRecord[]`；实时推理在 `reasoning-delta.text`；工具参数增量在 `tool-call-delta.argumentsDelta`；工具身份是 `ToolCallId`；打包记录按 `time0 + prefix(dt)` 还原时序 | §2、§5.2 | A3、A6、A7 | covered | 当前有效需求（数据来源） |
| S6：§2.2 工具与步骤边界事件（第 85–98 行，含事件表） | complete | `tool/call`、`tool/result`、`turn/start`、`turn/end`、`step/start`、`step/end` 的字段；事件信封带 `seq` 与 `time`；`surfaceOp` 的取值与适用事件 | §2、§5.1 | A3、A5、A9 | covered | 当前有效需求 |
| S7：§2.3 Conversation 三个注册表与位置数据（第 100–114 行） | complete | `events`、`views`、`groups` 三个注册面；`ConversationNodeDefinition` 的字段与语义；`ConversationViewDefinition` 与 Builder 接口；`TurnLocation` 形状 | §2、§5、§6 | A2、A9、A10 | covered | 当前有效需求 |
| S8：§2.4 视图如何被选中与挂载（第 116–123 行） | complete | `conversation.view` 槽是挂载点；页签只在多于一个视图时显示；`selectView` 与 `activateView` 与每会话偏好；首次订阅才激活并执行一次 `replace()`；`uiSession.provide` 提供 `use<Name>` | §6、§7.2 | A2、A10 | covered | 当前有效需求 |
| S9：§2.5 现有 UI 资产与重叠矩阵（第 125–136 行） | complete | 既有能力归属：ui-chat 的 `turn-process` 与 `process-groups`、ui-tool 的 `tool.call.toolview`、ui-chat 的四档工作详情、ui-trajectory 的时长推导；本插件是平行的第二套呈现，不导入也不替换 | §3（D1、D3）、§11 | A15 | covered | 当前有效需求（设计依据与边界） |
| S10：§2.6 包边界规则（第 138–145 行） | complete | 禁止运行期导入另一 feature 插件的值；客户端插件导出面只有 `apply` 与 `inject`（加类型与 store 工厂）；业务数据属于 object 层；UI 域之间只共享 JSON 兼容数据；文案由 locale 字典拥有 | §3（D3）、§7.4、§8 | A1、A4、A12、A15 | covered | 当前有效需求（约束） |
| S11：§3 D1 独立 View target（第 149–160 行） | complete | 注册 `target: 'execution'`，不做 chat 内联节点；理由是避免与 chat 过程组同时可见；代价是用户需切换视图，如实记录为产品偏离 | §3（D1）、§7.2 | A2 | covered | 当前有效需求（已确认的关键决定） |
| S12：§3 D2 折叠全部在客户端（第 162–166 行） | complete | Host 半是最小空 `apply`；不新增 Remote；数据来自客户端已持有的 `SessionEventLike` 窗口 | §3（D2）、§8.2 | A1、A15 | covered | 当前有效需求 |
| S13：§3 D3 分类自带一份（第 168–172 行） | complete | 工具名到步骤类型的映射在本包内实现，运行期不导入 ui-chat 的 `process-activity`；晋升为共享归属需要用户签字，推迟 | §3（D3）、§4.1 | A4、A15 | covered | 当前有效需求 |
| S14：§3 D4 包形态与接入（第 174–200 行） | complete | `dsh-llm` 只提供"接入方式"这一层（包不自带 bundle、bundle 拥有接线、peerDependencies 只放 Cordis、依赖分区、按面薄导出）；UI 与注册面参照 client 插件族（ui-tool 与 ui-trajectory）；接入面四处 | §3（D4）、§8 | A1 | covered | 当前有效需求 |
| S15：§3 D5 v1 不做 Config（第 202–212 行） | complete | 不声明 Cordis `Config`；可变项都是用户级偏好；引入部署级配置必须照 ui-theme 的 Host Config 加启动注入形状，并补 config-catalog | §3（D5）、§8.2 | A15 | covered | 当前有效需求（约束） |
| S16：§4.1 步骤类型（第 216–253 行，含类型联合与映射表） | complete | `ExecutionStepKind` 取值；工具名映射表逐条（含 `glob` 到 `list`、`grep` 与 `*_inspect` 到 `search`、`bash`/`pwsh`/`exec_command`/`write_stdin`/`terminal_*` 到 `run`、`run_code` 到 `code`、`web_search` 与 `web_fetch`、`subagent*`、`todo_write`/`create_goal`/`update_goal`/`get_goal` 到 `plan`、`ask_user_question`/`request_user_input` 到 `questions`）；未知名字回落 `tool` 并原样显示 | §4.1 | A4 | covered | 当前有效需求 |
| S17：§4.2 状态机（第 255–270 行） | complete | `preparing`、`running`、`succeeded`、`failed`、`unfinished`；失败判据是 `message.isError === true` 或 `error` 存在；不展示退出码；`unfinished` 是派生呈现并在 README 说明 | §4.2 | A5 | covered | 当前有效需求 |
| S18：§4.3 时长（第 272–280 行，含表格） | complete | 工具步骤起止用 `tool/call.time` 与 `tool/result.time`；实时阶段用墙钟；推理时长由打包记录时序或结算时间；未结束步骤走秒且不落库；取非负差值 | §4.3 | A3、A6、A7 | covered | 当前有效需求 |
| S19：§4.4 快照（第 282–338 行，含 TypeScript 代码块） | complete | `ExecutionSnapshot`、`ExecutionTurn`、`ExecutionStep`、`StepTitle`、`StepDetail` 的完整结构；节点扩展 `ConversationViewNode` 并携带 `anchorSeq`；完整结果内容保留在快照，与 `ToolResultNode` 的取舍一致 | §4.4 | A10、A11 | covered | 当前有效需求（数据结构） |
| S20：§4.5 本地化纪律（第 340–344 行） | complete | `StepTitle` 与 `ExecutionStepKind` 是结构化数据不是文案；产品字符串走 locale 字典；模型、工具与线上数据原样显示 | §4.5、§7.4 | A12 | covered | 当前有效需求（约束） |
| S21：§5.1 `execution-step` 表（第 350–363 行） | complete | kind、target、match 规则（`tool-call-delta` 与 `tool/call` 作 start，`tool/result` 作 update）；id 用 `ToolCallId`；start 与 update 的 State 变迁；`publication` 取值；`buildViewNode` 的 `anchorSeq`；v1 不发布 Location 数据 | §5.1 | A3、A5、A9 | covered | 当前有效需求 |
| S22：§5.2 `execution-thinking` 表与说明（第 365–381 行） | complete | id 用 `turn` 与 `step` 组合而非 `attemptId`（持久结算不含 `attemptId`）；瞬态追加、持久覆盖为权威；`reasoning-delta` 走 animation-frame；`interrupted` 是权威中断标记；同一 step 重试用最新持久证据覆盖 | §5.2 | A6、A8、A9 | covered | 当前有效需求 |
| S23：§5.3 共同不变量 I1–I5（第 383–389 行） | complete | 不扫窗口（match 与 update 常数时间）；瞬态可丢失（State 可由持久事件重建）；确定性重放；身份稳定；只在持久层记录结论 | §5.3 | A8、A9 | covered | 当前有效需求（不变量） |
| S24：§5.4 实时性来源（第 391–393 行） | complete | 高频可见增量用 `publication: 'animation-frame'`，避免每 token 一次 React 提交 | §5.4 | A7 | covered | 当前有效需求 |
| S25：§6 View Builder（第 397–425 行） | complete | `empty`、`replace`、`apply` 语义；按 `anchorSeq` 排序、按 turn 分组、统计步骤数与运行中计数；不注册 Group Definition；`isActive` 在步骤数为零时为假；v1 不声明 `toolCallFocus` | §6 | A10 | covered | 当前有效需求 |
| S26：§7.1 组件树（第 431–445 行） | complete | `ExecutionView`、`ExecutionTurnHeader`、`ExecutionStepRow`、`StepGlyph`、`StepTitleLine`、`StepStatusLabel`、`StepDurationLabel`、`StepDetailPanel`、`ReasoningText` 的职责；组件不接触 `ctx` | §7.1 | A11 | covered | 当前有效需求 |
| S27：§7.2 注册配方（第 447–489 行，含代码块） | complete | `inject` 服务集合；locale 注册与 `ctx.locale.bind`；两个 Definition 注册；`views.register`；`uiSession.provide` 提供 `hooks: ['execution']`；`slots.inject('conversation.view', ...)` 的 `id`、`order`、`label` thunk、`children`、`inject`；`order: 20` 的含义 | §7.2 | A2 | covered | 当前有效需求 |
| S28：§7.3 展开状态（第 491–495 行） | complete | 行展开是组件本地状态；虚拟化导致重挂载会丢状态，届时才引入 store；不做全部展开与折叠的聚合开关 | §7.3 | A11 | covered | 当前有效需求 |
| S29：§7.4 样式与 i18n（第 497–501 行） | complete | CSS Modules 加 `--dsw-*` 语义别名；无字面色值、组件库与 Tailwind；等距字体与保留换行的容器；长内容在详情面板内自带滚动 | §7.4 | A12 | covered | 当前有效需求 |
| S30：§7.5 实时走秒（第 503–505 行） | complete | 存在 `preparing` 或 `running` 步骤时挂本地定时器，终态或卸载即清理；纯呈现，不写入快照或日志 | §7.5 | A7 | covered | 当前有效需求 |
| S31：§8.1 文件树（第 511–549 行） | complete | 包目录结构：`src/index.ts` 是空 `apply`；`src/client/apply.ts` 是唯一装配点；`contract/` 是唯一共享 API；`definitions/`、`view/`、`components/` 互不越级；测试目录布局 | §8.1 | A1 | covered | 当前有效需求 |
| S32：§8.2 `package.json` 关键字段（第 552–591 行，含 JSON 代码块） | complete | `name`、`type`、`main`、`types`、`exports`（`.`、`./client`、`./src/*`、`./package.json`）、`files`、`dsh.client`（`platform` 与完整作用域名的 `inject`）、`peerDependencies`；无 `dsh.client.external`；可以没有 `dependencies` 段 | §8.2 | A1 | covered | 当前有效需求 |
| S33：§8.3 四处接入面（第 593–606 行） | complete | 第一，`tsconfig.base.json` 手写裸别名（生成器跳过 `dsh-client-*`，`verify-tsconfig-paths` 强制）；第二，`tsconfig.client.json` references；第三，`packages/bundle/web-app/cordis.patch.yml` 行；第四，`packages/bundle/web-app/package.json` 依赖；并明确不需要改 `base`、`headless`、`sdk-minimal` | §8.3 | A1 | covered | 当前有效需求 |
| S34：§8.4 `dsh-llm` 只提供接入方式（第 607–630 行，含两张表） | complete | 取用的接入惯例五条；明确不作为参照的部分（架构、构建路径、`./invariant`、裸别名是否可生成）；结论是不同类包各按各自约定 | §3（D4）、§8.4 | A1、A15 | covered | 当前有效需求（边界约束） |
| S35：§9.1 折叠单测 T1–T10（第 634–649 行，含表格） | complete | 10 条断言：完整 replace；update-only 尾巴保持 pending；历史加实时等价；翻页不换 key；增量每帧最多发布一次；组件不扫窗口；标量与打包历史等价；瞬态移除后可重建；重试覆盖；未知工具名回落与未完成判定 | §9.1 | A7、A8、A9 | covered | 当前有效需求（验证要求） |
| S36：§9.2 组件测试（第 651–655 行） | complete | jsdom 首行 pragma；断言用户可见行为；覆盖标题本地化、失败行错误码、展开详情、推理渲染、终态停止走秒；`apply` 注入测试 | §9.2 | A11、A12 | covered | 当前有效需求（验证要求） |
| S37：§9.3 覆盖率与 gate 清单（第 657–663 行） | complete | 逐文件 100% 覆盖率与 `v8 ignore` 规则；列出的 gate 清单；不发布 `./invariant` 并在 README 说明理由；`typecheck` 两面；`test:gui` | §9.3 | A13 | covered | 当前有效需求（验证要求） |
| S38：§9.4 快照与端到端（第 665–669 行） | complete | human-visible 变更必须有 keyless recorded-session 场景；优先借用既有场景的会话；运行 `DSH_SNAPSHOT=replay pnpm run test:web`；现有 UI-only 期望输出可能一起变化，需逐条审查 | §9.4 | A14 | covered | 当前有效需求（验证要求） |
| S39：§10 实施阶段 S0–S7（第 677–692 行，含表格） | complete | 7 个阶段的内容与退出标准；S0 到 S3 是最小闭环；实时层放在持久层稳定之后，因为依赖不变量已成立 | §10 | A13、A14 | covered | 当前有效需求（实施顺序） |
| S40：§11 风险与未决问题（第 694–704 行） | complete | 与 ui-chat 的信息架构重叠是产品风险；断线时实时预览回落到持久结算；未完成判定是派生态的假设；本视图是只读账本；页签数量增加需视觉走查；包名与命名规则有张力；是否复用 `tool.call.toolview` 属于另一个特性 | §11、本 brief 决策 | A11、A15 | covered | 当前有效需求（风险与约束；包名已在本 brief 决策中定案） |
| S41：§12 替代方案记录（第 706–720 行） | complete | 6 条被否决的备选方案及其理由（chat 内联、仅升级 chat 槽、复用 trajectory target、提升分类为共享归属、用 `ctx.settings`、Host Remote 服务） | — | — | background | 否决理由，不产生需要实现的行为；保留以避免重复讨论 |

# 非目标

- 不实现插件代码：本次 change 只产出计划与验收项，实现走后续 change（用户决定 Q2：A）。
- 不修改任何既有包：包括 ui-chat、ui-tool、ui-trajectory、ui-conversation、ui-primitives 与 packages/bundle/base。
- 不新增 Host 服务、typert 描述符面或 Remote 客户端面。
- 不新增会话事件类型，不改 SESSION_FORMAT_VERSION。
- 不声明 Cordis Config。
- 不把步骤分类提升为跨包共享归属。
- 不在本 change 内合并、推送或创建 PR。

# 验收示例

- A1：新包 `packages/client/ui-execution-viewer/` 存在，`package.json` 含 `dsh.client`（`platform: 'web'`）与 `./client` 导出；四处接入面（`tsconfig.base.json` 手写裸别名、`tsconfig.client.json` references、`packages/bundle/web-app/cordis.patch.yml` 行、`packages/bundle/web-app/package.json` 依赖）全部就位；`verify-tsconfig-paths`、`verify-cordis-config`、`verify-client-packages`、`verify-package-dependencies` 通过。
- A2：默认部署打开会话时，会话头部出现新增视图页签且文案来自本包 locale 字典；`conversation.view` 注册成功且卸载后可回收；`useExecution` 由 `uiSession.provide` 提供并可读到本视图快照。
- A3：仅凭持久事件（`tool/call` 与 `tool/result`）即可重建每一步的类型、标题、状态与耗时，且工具步骤耗时等于两侧信封 `time` 之差。
- A4：工具名到步骤类型的映射与规格表逐条一致；未知或动态工具名回落为 `tool` 并原样显示工具名，不做改写。
- A5：终态判定符合规格——`message.isError === true` 或 `error` 存在即为失败并显示 `error.code`；`turn/end` 之后仍无 `tool/result` 的调用显示为未完成；界面不显示退出码。
- A6：推理步骤文本由 `assistant/message` 的 `reasoning-chunks` 还原为权威文本，时序由记录还原；结算带 `interrupted: true` 时显示为 interrupted 而不是运行中。
- A7：实时阶段按 `animation-frame` 发布——推理增量与工具参数增量实时可见，未结束步骤显示走秒；所有走秒在终态或卸载后停止，且不写入任何快照或日志。
- A8：把全部瞬态 `assistant/live-chunk` 证据移除后（模拟重连与向上翻页），快照与节点仍可由持久事件重建为等价结果。
- A9：完整 `replace`、update-only 尾巴补 start、初始历史加实时追加三条路径产出相同的最终 State 与节点载荷。
- A10：View Builder 按 `anchorSeq` 排序、按 turn 分组、正确统计步骤数与运行中计数，`isActive` 在无步骤时为假；未打开视图的会话不产生折叠工作。
- A11：视图每行一步并展示类型图标、结构化标题、状态与耗时；点击行展开详情面板，显示完整命令、完整参数、完整结果、错误与推理文本。
- A12：客户端源码不含字面产品文案，全部经 locale 字典并通过 `verify-client-ui-i18n`；工具名、路径、命令、查询、URL 与错误码原样显示，不被翻译或改写。
- A13：`pnpm run test:coverage` 对本包 `src/**` 逐文件 100%；规格列出的 gate 全部通过；`pnpm run typecheck` 的 host 与 client 两面通过。
- A14：`DSH_SNAPSHOT=replay pnpm run test:web` 通过，并存在至少一个 Web 场景断言执行过程视图的步骤行渲染；相关期望输出的差异经逐条审查后才 refresh。
- A15：实现不修改任何既有包的行为，不新增 Host 服务或 typert 与 Remote 面，不新增会话事件类型，不声明 Cordis Config；变更范围仅限新包与四处接入面。

# 约束与不变量

- 本次 change 的产物是计划，不包含插件代码；验收项 A1–A15 是后续实现必须满足的契约，由后续实现 change 验收，不在本次验证。
- 源文档中的 8 条事实更正是实现前提：任何实现都不得使用 `stepId`、不得把 `reasoning-chunks` 当作实时帧、不得假设存在一等退出码、不得让第三方插件新增会话事件类型、不得让 Host 通过 slot 向浏览器传数据。
- 不变量 I1–I5（不扫窗口、瞬态可丢失、确定性重放、身份稳定、只在持久层记录结论）是回放与重连正确性的来源，不允许用实时内存绕过。
- 包边界：运行期不得导入 ui-chat、ui-tool、ui-trajectory、ui-conversation 的值，只允许 `import type`；分类表自带一份。
- 回放一致性优先于实时性能：任何实时优化都不得使瞬态证据被移除后结果改变。

# 决策

- Q1：工作区隔离用 worktree，分支 `comet/execution-viewer-plan`，基线 `codebudy_cli`。
- Q2：本次只到 Shape 确认为止——产出 brief、完整目标规格与验收项，不写插件代码。
- Q3：需求来源边界是 dev 文档整份；上游方案文档不单独登记。
- Q4：正式产物语言为中文，与源文档术语保持一致。
- D1：注册独立 View target `'execution'`，不做 chat 内联节点。理由：chat 的过程组已经提供等价能力，内联会让两份过程列表同时可见；独立 target 是平台明文支持的第三方扩展方式。代价（用户需切换视图）如实保留在规格的风险一节。
- D2：折叠全部在客户端，Host 半是最小空 `apply`。理由：所需数据已在客户端窗口；Host 侧重算会产生第二份真相源并需要新 Remote 通道。
- D3：工具名到步骤类型的分类表在本包内自带一份，参照但不导入 ui-chat 的 `process-activity`。理由：仓库禁止运行期导入另一 feature 插件的值；把分类提升为共享静态归属需要用户签字，当前只有两处消费者，推迟。
- D4：`dsh-llm` 只提供"仓库内包接入方式"这一层参照；架构与 UI 注册面参照 client 插件族。理由：`dsh-llm` 是 Host 服务包，本插件是浏览器 UI 功能包，两类包的架构与构建路径不可比。
- D5：v1 不声明 Cordis Config；可变项都是用户级偏好，走浏览器本地 store；若日后确需部署级配置，照 ui-theme 的 Host Config 加启动注入形状补做并补 config-catalog。
- 包名：沿用 `packages/client/ui-execution-viewer/` 与 `@deepseek-ai/dsh-client-ui-execution-viewer`。源文档 §11 记录过 viewer 与命名规则有张力，但用户给出的方案名即 execution-viewer，改名成本在 S0 之后上升，故定案沿用。
- 不拆分 Supervisor 子任务：本次交付是单一计划产物，不存在两个可独立实现并验收的结果；三个验证层级（折叠单测、组件测试、Web 快照）是同一实现流的证据层次而非独立交付物，且实现会反复修改同一核心区域（contract 目录与 apply.ts），拆分只会提高协调成本。

# 验证预期

- 本次 change 在 Shape 确认后按用户决定停止，不进入实现；因此 A1–A15 在本次不执行验收检查。
- 后续实现 change 的 Builder 提交候选实现后，必须由新的只读 Verifier 独立判断 A1–A15 全部验收项；失败、阻塞、未执行与超时都不算通过。
- 实现 change 至少需要运行：`pnpm run test:coverage`（本包逐文件 100%）、`pnpm run test:gui`、`pnpm run typecheck`、规格 §9.3 列出的 gate、`DSH_SNAPSHOT=replay pnpm run test:web`。
- 规格 §9.1 的 10 条折叠断言是 A7 到 A9 的直接证据来源，必须在实现 change 中逐条落地为测试。
