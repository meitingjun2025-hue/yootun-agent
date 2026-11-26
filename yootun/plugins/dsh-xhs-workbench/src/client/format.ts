/**
 * 页面展示格式化与稳定 reason → 文案映射。reason 只显示稳定码文案：已知码出
 * 可行动文案并附原码，未知码走通用失败文案并附原码（不透传内部信息）。
 * REASON_KEYS 对 Host STABLE_ERROR_CODES 全集类型穷尽（含 not_found 在内的
 * 上传/路由/任务/看板稳定码）：新增稳定码而词典缺 `reason.<CODE>` 文案时本包
 * `build` 编译报错。
 * @module
 */
import type { StableErrorCode } from '../errors.ts'
import type { RouteRefusalReason } from '@yootun/dsh-workbench-host-kit'
import type { XhsLocaleKey } from './locales.ts'

/** 页面翻译函数（词典键集见 locales.ts）。 */
export type Translate = (key: XhsLocaleKey, values?: Record<string, string | number>) => string

/**
 * 稳定 reason → 文案键：逐码 `reason.<CODE>` 词典键（全集穷尽，`satisfies`
 * 缺键即编译报错）。
 */
const REASON_KEYS: Readonly<Record<StableErrorCode, XhsLocaleKey>> = {
  'TASK_NOT_FOUND': 'reason.TASK_NOT_FOUND',
  'TASK_STATE_CONFLICT': 'reason.TASK_STATE_CONFLICT',
  'RESULT_NOT_READY': 'reason.RESULT_NOT_READY',
  'CONFIRMATION_REQUIRED': 'reason.CONFIRMATION_REQUIRED',
  'VALIDATION_ERROR': 'reason.VALIDATION_ERROR',
  'STEP_INPUT_TOO_LARGE': 'reason.STEP_INPUT_TOO_LARGE',
  'ASSET_NOT_FOUND': 'reason.ASSET_NOT_FOUND',
  'PROVIDER_ERROR': 'reason.PROVIDER_ERROR',
  'IDEMPOTENCY_CONFLICT': 'reason.IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS': 'reason.IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN': 'reason.IDEMPOTENCY_OUTCOME_UNKNOWN',
  'XHS_HOTBOARD_INVALID_ARGUMENT': 'reason.XHS_HOTBOARD_INVALID_ARGUMENT',
  'XHS_HOTBOARD_NOT_FOUND': 'reason.XHS_HOTBOARD_NOT_FOUND',
  'XHS_HOTBOARD_ACTIVE_RUN_EXISTS': 'reason.XHS_HOTBOARD_ACTIVE_RUN_EXISTS',
  'XHS_HOTBOARD_BUDGET_EXHAUSTED': 'reason.XHS_HOTBOARD_BUDGET_EXHAUSTED',
  'XHS_HOTBOARD_KEYWORD_EMPTY': 'reason.XHS_HOTBOARD_KEYWORD_EMPTY',
  'XHS_HOTBOARD_KEYWORD_CONFLICT': 'reason.XHS_HOTBOARD_KEYWORD_CONFLICT',
  'XHS_HOTBOARD_EVIDENCE_INSUFFICIENT': 'reason.XHS_HOTBOARD_EVIDENCE_INSUFFICIENT',
  'XHS_HOTBOARD_LABEL_CONFLICT': 'reason.XHS_HOTBOARD_LABEL_CONFLICT',
  'XHS_HOTBOARD_AI_SCHEMA_INVALID': 'reason.XHS_HOTBOARD_AI_SCHEMA_INVALID',
  'XHS_HOTBOARD_PROVIDER_FAILED': 'reason.XHS_HOTBOARD_PROVIDER_FAILED',
  'XHS_HOTBOARD_SETTING_TOML_MANAGED': 'reason.XHS_HOTBOARD_SETTING_TOML_MANAGED',
  'XHS_HOTBOARD_INTERNAL_ERROR': 'reason.XHS_HOTBOARD_INTERNAL_ERROR',
  'GOOGLE_CHROME_MISSING': 'reason.GOOGLE_CHROME_MISSING',
  'PLAYWRIGHT_DRIVER_MISSING': 'reason.PLAYWRIGHT_DRIVER_MISSING',
  'browser_launch_timeout': 'reason.browser_launch_timeout',
  'SESSION_EXPIRED': 'reason.SESSION_EXPIRED',
  'LOGIN_TIMEOUT': 'reason.LOGIN_TIMEOUT',
  'CAPTCHA_DETECTED': 'reason.CAPTCHA_DETECTED',
  'COLLECT_FAILED': 'reason.COLLECT_FAILED',
  'PROFILE_BUSY': 'reason.PROFILE_BUSY',
  'PUBLISH_FAILED': 'reason.PUBLISH_FAILED',
  'IDEMPOTENCY_KEY_REQUIRED': 'reason.IDEMPOTENCY_KEY_REQUIRED',
  'PROBE_FAILED': 'reason.PROBE_FAILED',
  'LOGIN_FAILED': 'reason.LOGIN_FAILED',
  'XHS_ROUTE_UNKNOWN_ACTION': 'reason.XHS_ROUTE_UNKNOWN_ACTION',
  'XHS_ROUTE_INVALID_REQUEST': 'reason.XHS_ROUTE_INVALID_REQUEST',
  'XHS_ROUTE_PAYLOAD_TOO_LARGE': 'reason.XHS_ROUTE_PAYLOAD_TOO_LARGE',
  'XHS_ROUTE_REFUSED': 'reason.XHS_ROUTE_REFUSED',
  'UNAUTHORIZED': 'reason.UNAUTHORIZED',
  'host_unreachable': 'reason.host_unreachable',
  'login_aborted': 'reason.login_aborted',
  'collect_cancelled': 'reason.collect_cancelled',
  'plugin_disposing': 'reason.plugin_disposing',
  'xhs_operation_request_failed': 'reason.xhs_operation_request_failed',
  'storage_state_missing': 'reason.storage_state_missing',
  'login_page_detected': 'reason.login_page_detected',
  'user_info_unavailable': 'reason.user_info_unavailable',
  'session_error': 'reason.session_error',
  'account_id_required': 'reason.account_id_required',
  'collect_id_required': 'reason.collect_id_required',
  'idempotency_key_required': 'reason.idempotency_key_required',
  'confirmation_required': 'reason.confirmation_required',
  'invalid_media_type': 'reason.invalid_media_type',
  'image_urls_required': 'reason.image_urls_required',
  'video_url_required': 'reason.video_url_required',
  'task_id_required': 'reason.task_id_required',
  'versions_unavailable': 'reason.versions_unavailable',
  'create_failed_no_task': 'reason.create_failed_no_task',
  'invalid_target': 'reason.invalid_target',
  'publish_id_required': 'reason.publish_id_required',
} satisfies Readonly<Record<StableErrorCode, XhsLocaleKey>>

/** 路由层拒绝 reason → 文案键（kit 路由字面量，不进稳定码白名单；对 ROUTE_REFUSAL_REASONS 类型穷尽的显式分支）。 */
const ROUTE_REASON_KEYS: Readonly<Record<RouteRefusalReason, XhsLocaleKey>> = {
  forbidden: 'reason.forbidden',
  unknown_action: 'reason.unknown_action',
  method_not_allowed: 'reason.method_not_allowed',
}

/**
 * 稳定 reason → 单行文案；已知码给可行动文案并保留原码，未知码给通用文案并保留
 * 原码。上传 machine 的 not_found/done 等状态不经本函数（machine 已归一为
 * `uploadFailed` 文案键）。
 * @param reason - Host 响应中的稳定 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function reasonText(reason: string, t: Translate): string {
  const key = (Object.hasOwn(REASON_KEYS, reason) ? REASON_KEYS[reason as StableErrorCode] : undefined)
    ?? (Object.hasOwn(ROUTE_REASON_KEYS, reason) ? ROUTE_REASON_KEYS[reason as RouteRefusalReason] : undefined)
  if (key !== undefined) return `${t(key)}（${reason}）`
  return t('error.unknownWithCode', { code: reason })
}

/** 工作流步骤标识 → 文案键（未登记步骤回退服务端原文；旧 STEP_LABEL_KEYS 同表）。 */
const STEP_LABEL_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  ingest: 'step.ingest',
  probe: 'step.probe',
  asr: 'step.asr',
  correct_transcript: 'step.correct_transcript',
  frames: 'step.frames',
  vision: 'step.vision',
  images_vision: 'step.images_vision',
  fact_card: 'step.fact_card',
  style_portrait: 'step.style_portrait',
  copywriting: 'step.copywriting',
  quality: 'step.quality',
  finalize: 'step.finalize',
}

/**
 * 服务端步骤标识 → 本地化步骤名。
 * @param step - 服务端步骤标识。
 * @param t - 页面翻译函数。
 * @returns 展示步骤名。
 */
export function stepLabel(step: string, t: Translate): string {
  const key = STEP_LABEL_KEYS[step]
  return key !== undefined ? t(key) : step
}

/** 失败原因受控短语 → 引导文案键（旧 FAILURE_HINT_RULES 同表，未登记返回空）。 */
const FAILURE_HINT_RULES: ReadonlyArray<{ code: string; message: string; key: XhsLocaleKey }> = [
  { code: 'copywriting_failed', message: 'no fact or reference basis for copywriting', key: 'failure.hintNoFactNoReference' },
]

/**
 * 失败原因受控短语 → 可操作引导文案；未登记组合返回空（界面只显示通用失败文案）。
 * @param errorCode - 服务端受控错误码。
 * @param errorMessage - 服务端受控原因短语。
 * @param t - 页面翻译函数。
 * @returns 引导文案，或空串。
 */
export function failureHint(errorCode: string, errorMessage: string, t: Translate): string {
  if (errorCode === '') return ''
  for (const rule of FAILURE_HINT_RULES) {
    if (rule.code === errorCode && rule.message === errorMessage) return t(rule.key)
  }
  return ''
}

/** quality issues（软性问题码）→ 文案键（旧 ISSUE_TEXT_KEYS 同表，未登记跳过不猜）。 */
const ISSUE_TEXT_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  'field_missing:coverCopy': 'issue.field_missing:coverCopy',
  'field_missing:leadGuide': 'issue.field_missing:leadGuide',
  similarity_high: 'issue.similarity_high',
  lead_guide_overpromise: 'issue.lead_guide_overpromise',
}

/**
 * 结果版本软性问题码 → 文案键列表。
 * @param issues - 服务端问题码数组。
 * @returns 已登记问题码的文案键（未登记码跳过，不猜语义）。
 */
export function issueKeys(issues: unknown): XhsLocaleKey[] {
  if (!Array.isArray(issues)) return []
  return issues
    .map(issue => typeof issue === 'string' ? ISSUE_TEXT_KEYS[issue] : undefined)
    .filter((key): key is XhsLocaleKey => key !== undefined)
}

/**
 * machine 错误键 → 文案键（createFailed/pollFailed 等 UI 级错误，非 Host 稳定码）。
 * @param error - machine 错误键。
 * @param t - 页面翻译函数。
 * @returns 展示文案；未知键返回空串。
 */
export function machineErrorText(error: string, t: Translate): string {
  const keys: Readonly<Record<string, XhsLocaleKey>> = {
    pollFailed: 'error.machine.pollFailed',
    resultFailed: 'error.machine.resultFailed',
    createFailed: 'error.machine.createFailed',
    failed: 'error.task.stateFailed',
    cancelled: 'error.task.stateCancelled',
    cancelFailed: 'error.machine.cancelFailed',
  }
  const key = keys[error]
  return key !== undefined ? t(key) : ''
}

/** 稳定码 → reason.* 词典键的覆盖集合（测试与诊断用）。 */
export const COVERED_REASON_KEYS = REASON_KEYS

/**
 * 字节量展示（旧 formatBytes 同口径）：0/非法为空串，B/KB/MB 两级换算。
 * @param value - 字节数。
 * @returns 展示文本。
 */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 小红书正文纯文本化（「复制全文」用；旧 toXhsPlainText 同规则）：剥离双星粗体/
 * 双下划线斜体/行首井号标题/行首短横列表（→ 「· 」）与正文尾部纯文本话题串。
 * @param body - markdown 正文。
 * @returns 纯文本正文。
 */
export function toXhsPlainText(body: string): string {
  let text = String(body ?? '').replace(/\r\n/g, '\n')
  text = text.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/__([^_]*)__/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^[-*]\s+/gm, '· ')
  text = text.replace(/^\s*#\S+(?:\s+#\S+)*\s*$/gm, '')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 复制全文文本化：标题 + 正文 + 标签（#前缀），空段跳过（旧 composeFullText 同规则）。
 * @param edited - 当前编辑态。
 * @returns 剪贴板文本。
 */
export function composeFullText(edited: { title: string; body: string; tags: string[] }): string {
  const tags = edited.tags.map(tag => `#${tag}`).join(' ')
  return [edited.title, edited.body, tags].map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n')
}
