/**
 * Agent 面 `ask` 决策的文案（分册 08 §4.3）。英文同时作为模型可见的
 * `reason`；`displayReason` 供审批卡片按界面语言显示，未提供的语言回退英文。
 * @module
 */
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { AgentToolClass } from './guard.ts'

/** The policy classes that ask for approval; each has one text per locale. */
export type AskTextKind = Exclude<AgentToolClass, 'read'>

/** English texts; each line is also the model-facing `reason`. */
const en = {
  'task-write': (tool: string): string => `yootun tool "${tool}" starts or changes a remote task and may incur model fees`,
  'schedule-write': (tool: string): string => `yootun tool "${tool}" writes a douyin publish schedule record on the server`,
  unknown: (tool: string): string => `yootun agent tool "${tool}" is not yet classified; confirm before use`,
} satisfies Record<AskTextKind, (tool: string) => string>

/** 中文文案；键与英文逐项对应，缺项即类型报错。 */
const zh = {
  'task-write': (tool: string): string => `yootun 工具「${tool}」会启动或变更远端任务，可能产生模型费用`,
  'schedule-write': (tool: string): string => `yootun 工具「${tool}」会在服务端写入一条抖音发布排期记录`,
  unknown: (tool: string): string => `yootun 工具「${tool}」尚未归类，使用前请确认`,
} satisfies typeof en

/**
 * Build one `ask` decision for a policy class: the model-facing English
 * reason plus the approval-card text of each supported locale.
 * @param kind - the asking policy class.
 * @param tool - the server-side tool name shown in every text.
 * @returns the pre-execute ask decision.
 */
export function askDecision(kind: AskTextKind, tool: string): PreToolDecision {
  return { kind: 'ask', reason: en[kind](tool), displayReason: { en: en[kind](tool), zh: zh[kind](tool) } }
}
