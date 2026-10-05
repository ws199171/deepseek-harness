/** `execution` namespace dictionaries for the Execution view surface. */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'execution'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.execution': '执行过程',
  'view.aria': '执行过程步骤列表',
  'view.empty': '这一轮还没有可展示的执行步骤。',
  'turn.label': '第 {turn} 轮',
  'turn.open': '进行中',
  'turn.closed': '已结束',
  'turn.unknown': '状态未知',
  'status.preparing': '准备中',
  'status.running': '运行中',
  'status.succeeded': '已完成',
  'status.failed': '失败',
  'status.unfinished': '未完成',
  'status.interrupted': '已中断',
  'kind.thinking': '思考',
  'kind.read': '读取',
  'kind.readImage': '读图',
  'kind.search': '搜索',
  'kind.list': '列举',
  'kind.write': '写入',
  'kind.edit': '编辑',
  'kind.run': '运行',
  'kind.code': '代码',
  'kind.webSearch': '网页搜索',
  'kind.webFetch': '网页读取',
  'kind.subagent': '子代理',
  'kind.plan': '计划',
  'kind.questions': '提问',
  'kind.tool': '工具',
  'verb.read': '读取',
  'verb.write': '写入',
  'verb.edit': '编辑',
  'detail.command': '命令',
  'detail.arguments': '参数',
  'detail.result': '结果',
  'detail.error': '错误',
  'detail.reasoning': '思考',
  'detail.none': '没有更多细节。',
  'row.expand': '展开第 {index} 步的详情',
  'row.collapse': '收起第 {index} 步的详情',
  'reasoning.chars': '{chars} 字',
  'duration.milliseconds': '{milliseconds} 毫秒',
  'duration.seconds': '{seconds} 秒',
}

/** English dictionary. */
export const en: Record<keyof typeof zh, string> = {
  'view.execution': 'Execution',
  'view.aria': 'Execution step list',
  'view.empty': 'No execution steps to show for this turn.',
  'turn.label': 'Turn {turn}',
  'turn.open': 'Running',
  'turn.closed': 'Finished',
  'turn.unknown': 'Status unknown',
  'status.preparing': 'Preparing',
  'status.running': 'Running',
  'status.succeeded': 'Done',
  'status.failed': 'Failed',
  'status.unfinished': 'Unfinished',
  'status.interrupted': 'Interrupted',
  'kind.thinking': 'Thinking',
  'kind.read': 'Read',
  'kind.readImage': 'Read image',
  'kind.search': 'Search',
  'kind.list': 'List',
  'kind.write': 'Write',
  'kind.edit': 'Edit',
  'kind.run': 'Run',
  'kind.code': 'Code',
  'kind.webSearch': 'Web search',
  'kind.webFetch': 'Web fetch',
  'kind.subagent': 'Subagent',
  'kind.plan': 'Plan',
  'kind.questions': 'Questions',
  'kind.tool': 'Tool',
  'verb.read': 'Read',
  'verb.write': 'Write',
  'verb.edit': 'Edit',
  'detail.command': 'Command',
  'detail.arguments': 'Arguments',
  'detail.result': 'Result',
  'detail.error': 'Error',
  'detail.reasoning': 'Thinking',
  'detail.none': 'No further detail.',
  'row.expand': 'Expand details for step {index}',
  'row.collapse': 'Collapse details for step {index}',
  'reasoning.chars': '{chars} chars',
  'duration.milliseconds': '{milliseconds} ms',
  'duration.seconds': '{seconds} s',
}

/** Dictionary keys owned by this plugin. */
export type ExecutionKey = keyof typeof zh

/** Translate seat bound to this plugin's namespace. */
export type ExecutionTranslate = TranslateNS<typeof NS>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Execution view's copy. */
    execution: ExecutionKey
  }
}
