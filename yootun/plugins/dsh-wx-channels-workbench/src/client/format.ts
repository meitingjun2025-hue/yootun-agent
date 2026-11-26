/**
 * 页面展示格式化与稳定 reason → 文案映射。映射表对稳定码全集类型穷尽：新增
 * 稳定码而未提供文案时本包 `build` 编译报错。reason 只显示稳定码文案：已知码
 * 出可行动文案并附原码，未知码走通用失败文案并附原码（不透传内部信息）。
 * @module
 */
import type { StableErrorCode } from '../errors.ts'
import type { RouteRefusalReason } from '@yootun/dsh-workbench-host-kit'
import type { WxLocaleKey } from './locales.ts'

/** 页面翻译函数（词典键集见 locales.ts）。 */
export type Translate = (key: WxLocaleKey, values?: Record<string, string | number>) => string

/**
 * 稳定 reason → 文案键（全集穷尽，`satisfies` 缺键即编译报错）。既有文案沿用
 * 原词典键；新增码统一 `reason.<CODE>`。`UNAUTHORIZED` 为连接器鉴权投影的
 * 本地稳定码（分册 08 §5.2）。
 */
const REASON_KEYS: Readonly<Record<StableErrorCode, WxLocaleKey>> = {
  ACCOUNT_NOT_ACCESSIBLE: 'reason.ACCOUNT_NOT_ACCESSIBLE',
  ACCOUNT_NOT_FOUND: 'collect.reason.ACCOUNT_NOT_FOUND',
  CONFIRMATION_REQUIRED: 'reason.CONFIRMATION_REQUIRED',
  DELETE_CLEANUP_FAILED: 'reason.DELETE_CLEANUP_FAILED',
  FIELD_LENGTH_MISMATCH: 'reason.FIELD_LENGTH_MISMATCH',
  GOOGLE_CHROME_MISSING: 'error.CHROME',
  HEARTBEAT_SEQ_REGRESSED: 'reason.HEARTBEAT_SEQ_REGRESSED',
  IDEMPOTENCY_CONFLICT: 'reason.IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'reason.IDEMPOTENCY_IN_PROGRESS',
  IDEMPOTENCY_KEY_REQUIRED: 'reason.IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_OUTCOME_UNKNOWN: 'reason.IDEMPOTENCY_OUTCOME_UNKNOWN',
  INVALID_DAY_RANGE: 'reason.INVALID_DAY_RANGE',
  INVALID_IDEMPOTENCY_KEY: 'reason.INVALID_IDEMPOTENCY_KEY',
  INVALID_SORT: 'reason.INVALID_SORT',
  INVALID_TIME_WINDOW: 'collect.reason.INVALID_TIME_WINDOW',
  LIST_INCOMPLETE: 'reason.LIST_INCOMPLETE',
  LOCAL_CLEARED_REQUIRED: 'reason.LOCAL_CLEARED_REQUIRED',
  PAYLOAD_TOO_LARGE: 'reason.PAYLOAD_TOO_LARGE',
  PLAYWRIGHT_DRIVER_MISSING: 'error.CHROME_DRIVER',
  RUN_ACCOUNT_MISMATCH: 'reason.RUN_ACCOUNT_MISMATCH',
  RUN_COUNT_MISMATCH: 'reason.RUN_COUNT_MISMATCH',
  RUN_LIST_META_REQUIRED: 'reason.RUN_LIST_META_REQUIRED',
  RUN_NOT_FOUND: 'reason.RUN_NOT_FOUND',
  RUN_NOT_RUNNING: 'reason.RUN_NOT_RUNNING',
  RUN_STILL_ACTIVE: 'reason.RUN_STILL_ACTIVE',
  TIME_SERIES_LENGTH_MISMATCH: 'reason.TIME_SERIES_LENGTH_MISMATCH',
  TOO_MANY_ACCOUNTS: 'reason.TOO_MANY_ACCOUNTS',
  UNAUTHORIZED: 'reason.UNAUTHORIZED',
  VALIDATION_ERROR: 'reason.VALIDATION_ERROR',
  WORK_NOT_FOUND: 'reason.WORK_NOT_FOUND',
  WX_ROUTE_INVALID_REQUEST: 'reason.WX_ROUTE_INVALID_REQUEST',
  WX_ROUTE_PAYLOAD_TOO_LARGE: 'reason.WX_ROUTE_PAYLOAD_TOO_LARGE',
  WX_ROUTE_REFUSED: 'reason.WX_ROUTE_REFUSED',
  WX_ROUTE_UNKNOWN_ACTION: 'reason.WX_ROUTE_UNKNOWN_ACTION',
  WX_RUN_INTERRUPTED: 'reason.WX_RUN_INTERRUPTED',
  WX_SESSION_INVALID: 'error.WX_SESSION_INVALID',
  WX_TOOL_UNAVAILABLE: 'error.WX_TOOL_UNAVAILABLE',
  account_id_required: 'reason.account_id_required',
  account_mismatch: 'collect.reason.account_mismatch',
  auth_data_unavailable: 'collect.reason.auth_data_unavailable',
  browser_launch_timeout: 'reason.browser_launch_timeout',
  collect_busy: 'collect.reason.collect_busy',
  collect_cancelled: 'reason.collect_cancelled',
  host_unreachable: 'reason.host_unreachable',
  login_failed: 'reason.login_failed',
  login_timeout: 'reason.login_timeout',
  no_session_cookie: 'collect.reason.no_session_cookie',
  pending_account: 'collect.reason.pending_account',
  plugin_disposing: 'collect.reason.plugin_disposing',
  probe_failed: 'collect.reason.probe_failed',
  risk_paused: 'reason.risk_paused',
  run_state_corrupt: 'reason.run_state_corrupt',
  session_required: 'collect.reason.session_required',
  storage_state_missing: 'collect.reason.storage_state_missing',
} satisfies Readonly<Record<StableErrorCode, WxLocaleKey>>

/**
 * 运行时 reason → 文案键：进 run reason 槽但不在稳定码全集的旧取值（不在
 * 路由 reason 白名单内，本表只服务页面展示）。
 */
const RUNTIME_REASON_KEYS: Readonly<Record<string, WxLocaleKey>> = {
  identity_check_failed: 'collect.reason.identity_check_failed',
  identity_not_stable: 'collect.reason.identity_not_stable',
  partial: 'collect.reason.partial',
  session_expired: 'collect.reason.session_expired',
}

/** 身份稳定类前缀（`identity_check_failed:<detail>`）共用同一文案键。 */
const IDENTITY_PREFIX = 'identity_check_failed'

/**
 * 路由层拒绝 reason → 文案键（kit 路由字面量，不进稳定码白名单；对
 * `ROUTE_REFUSAL_REASONS` 类型穷尽的显式分支，运行时防御口径同
 * connector-status-and-error-copy §2.7）。
 */
const ROUTE_REASON_KEYS: Readonly<Record<RouteRefusalReason, WxLocaleKey>> = {
  forbidden: 'reason.forbidden',
  unknown_action: 'reason.unknown_action',
  method_not_allowed: 'reason.method_not_allowed',
}

/**
 * 稳定 reason → 单行文案；已知码给可行动文案并保留原码，`identity_check_failed:*`
 * 前缀码归并到同一文案，未知码给通用文案并保留原码。
 * @param reason - Host 响应中的稳定 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function reasonText(reason: string, t: Translate): string {
  const normalized = reason.startsWith(`${IDENTITY_PREFIX}:`) || reason.startsWith(`${IDENTITY_PREFIX}_`)
    ? IDENTITY_PREFIX
    : reason
  const key = (Object.hasOwn(REASON_KEYS, normalized) ? REASON_KEYS[normalized as StableErrorCode] : undefined)
    ?? (Object.hasOwn(ROUTE_REASON_KEYS, normalized) ? ROUTE_REASON_KEYS[normalized as RouteRefusalReason] : undefined)
    ?? RUNTIME_REASON_KEYS[normalized]
  if (key !== undefined) return `${t(key)}（${reason}）`
  return t('error.unknownWithCode', { code: reason })
}

/**
 * ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；null/不可解析返回 null（不虚构）。
 * @param iso - ISO 8601 时间或 null。
 * @returns 展示时间。
 */
export function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null
  const moment = new Date(iso)
  if (Number.isNaN(moment.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}

/** locale 紧凑格式化缓存（zh 万/亿、en K/M；绝对值满 1 万的计数走这里）。 */
const COMPACT_FORMATS = new Map<string, Intl.NumberFormat>()

/**
 * 计数展示：缺失为占位符；绝对值满 1 万用 locale 紧凑格式（zh 万/亿、en K/M，
 * 最多 1 位小数），不足 1 万整数直排。
 * @param value - 计数或 null。
 * @param localeTag - 展示 locale（缺省 'zh'）。
 * @returns 展示计数。
 */
export function formatCount(value: number | null, localeTag: string = 'zh'): string {
  if (value === null) return '—'
  if (Math.abs(value) >= 10000) {
    let formatter = COMPACT_FORMATS.get(localeTag)
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 })
      COMPACT_FORMATS.set(localeTag, formatter)
    }
    return formatter.format(value)
  }
  return String(Math.round(value))
}

/**
 * 比率展示：0..100 → 两位小数百分比；缺失为占位符（不把缺失伪装成 0%）。
 * @param value - 百分比数值或 null。
 * @returns 展示百分比。
 */
export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`
}

/**
 * 时长展示：秒 → 两位小数 + 单位；缺失为占位符。
 * @param value - 秒数或 null。
 * @param t - 页面翻译函数（单位文案）。
 * @returns 展示时长。
 */
export function formatSeconds(value: number | null, t: Translate): string {
  return value === null ? '—' : `${value.toFixed(2)} ${t('unit.seconds')}`
}

/**
 * 次数/人数组合展示：uv 缺失只显示次数，双缺失占位符。
 * @param count - 次数。
 * @param uv - 人数。
 * @returns 组合展示文本。
 */
export function formatPair(count: number | null, uv: number | null): string {
  if (count === null) return '—'
  if (uv === null) return String(Math.round(count))
  return `${Math.round(count)} / ${Math.round(uv)}`
}

/**
 * 上海时区已完成自然日（YYYY-MM-DD）：offsetDays=1 是昨天（运行日不入窗），
 * 与 parse.ts 的上海日窗口口径一致。
 * @param offsetDays - 距今的天数（1 = 上海昨天）。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns YYYY-MM-DD。
 */
export function shanghaiCompletedDay(offsetDays: number, now: () => number = Date.now): string {
  const shifted = new Date(now() + 8 * 3600 * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - offsetDays)
  return shifted.toISOString().slice(0, 10)
}

/** 涨跌方向（净增卡与表格净增列共用）：up 红 / down 绿 / flat 无色。 */
export type DeltaTone = 'up' | 'down' | 'flat'

/**
 * 带符号增量展示：正数 `+N`（红）、负数 `-N`（绿）、`0` 与缺失「—」无色
 * （口径同抖音 fanDelta；量级经 formatCount，满 1 万转「万」并保留符号）。
 * @param value - 增量数值或 null。
 * @param localeTag - 展示 locale。
 * @returns 文本与方向。
 */
export function formatDelta(value: number | null, localeTag: string): { text: string; tone: DeltaTone } {
  if (value === null || !Number.isFinite(value) || value === 0) return { text: '—', tone: 'flat' }
  return value > 0
    ? { text: `+${formatCount(value, localeTag)}`, tone: 'up' }
    : { text: `-${formatCount(Math.abs(value), localeTag)}`, tone: 'down' }
}

/**
 * 上海语义日位移（YYYY-MM-DD → ±N 天；非法输入原样返回）。用于趋势窗口逐日
 * 枚举与自定义日期越界纠偏（原样迁自抖音工作台）。
 * @param dayText - 起始日。
 * @param deltaDays - 位移天数（可负）。
 * @returns 位移后的日文本。
 */
export function shiftDay(dayText: string, deltaDays: number): string {
  const date = new Date(`${dayText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return dayText
  date.setUTCDate(date.getUTCDate() + deltaDays)
  return date.toISOString().slice(0, 10)
}
