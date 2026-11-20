/**
 * 看板展示格式化（旧 hotboard-ui.js 格式化半同口径）：缺失一律 —，绝不格式化
 * 成 0；枚举值经词典映射，白名单外原样返回兜底。
 * @module
 */
import type { XhsLocaleKey } from './locales.ts'
import type { Translate } from './format.ts'

/** 文本：null/undefined/空串 → —。 */
export function hbText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

/** 计数：非法/缺失 → —。 */
export function hbCount(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  return num.toLocaleString('en-US')
}

/** 比率（0..1）：缺失 → —。 */
export function hbPct(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  return `${(num * 100).toFixed(1)}%`
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；缺失/非法 → —。 */
export function hbTime(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 评分：缺失 → —。 */
export function hbScore(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = Number(value)
  if (!Number.isFinite(num)) return '—'
  return num.toFixed(1)
}

/** 带参文案（{n} 插值集中 helper）。 */
export function tf(t: Translate, key: XhsLocaleKey, params: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
  return text
}

/** 调度 cron 转业务可读描述（"30 1 * * 1" → 「每周一 凌晨 1:30」）；复杂形态原样兜底。 */
export function hotboardScheduleText(cron: unknown, t: Translate): string {
  const parts = typeof cron === 'string' ? cron.trim().split(/\s+/) : []
  if (parts.length !== 5) return hbText(cron)
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
  if (dom !== '*' || mon !== '*') return hbText(cron)
  if (!/^\d{1,2}$/u.test(min) || !/^\d{1,2}$/u.test(hour)) return hbText(cron)
  const hh = Number(hour)
  const mm = Number(min)
  if (hh > 23 || mm > 59) return hbText(cron)
  const dowNames = t('hb.schedDowNames').split('|')
  const periods = t('hb.schedPeriods').split('|')
  let freq: string
  if (dow === '*') freq = t('hb.schedDaily')
  else if (/^[0-7]$/u.test(dow)) freq = t('hb.schedWeekly') + (dowNames[Number(dow) % 7] ?? '')
  else return hbText(cron)
  const period = periods[hh <= 5 ? 0 : hh < 12 ? 1 : hh === 12 ? 2 : hh < 18 ? 3 : 4] ?? ''
  return [freq, period, `${hh}:${String(mm).padStart(2, '0')}`].filter(Boolean).join(' ')
}

/** 枚举值 → 词典文案；白名单外原样返回兜底，缺失一律 —。 */
export function hbEnumText(t: Translate, mapping: Readonly<Record<string, XhsLocaleKey>>, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const key = mapping[String(value)]
  return key !== undefined ? t(key) : String(value)
}

/** run 状态 → 文案键（tools HotboardRunStatus 同口径）。 */
export const RUN_STATUS_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  queued: 'hb.runQueued', collecting: 'hb.runCollecting', deduplicating: 'hb.runDedup', scoring: 'hb.runScoring',
  tagging: 'hb.runTagging', completed: 'hb.runCompleted', partial: 'hb.runPartial', failed: 'hb.runFailed', cancelled: 'hb.runCancelled',
}

/** run 活跃状态集合（与 machine 同口径，供徽标配色）。 */
export const ACTIVE_RUN_STATUSES = new Set(['queued', 'collecting', 'deduplicating', 'scoring', 'tagging'])

/** run 类型 → 文案键。 */
export const RUN_TYPE_KEYS: Readonly<Record<string, XhsLocaleKey>> = { full: 'hb.runTypeFull', incremental: 'hb.runTypeIncremental' }

/** run 内关键词执行状态 → 文案键。 */
export const KEYWORD_RUN_STATUS_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  pending: 'hb.kwPending', success: 'hb.kwSuccess', failed: 'hb.kwFailed',
  empty: 'hb.kwEmpty', skipped_budget: 'hb.kwSkippedBudget', skipped_active_run: 'hb.kwSkippedActive',
}

/** 关键词/标签来源 → 文案键。 */
export const SOURCE_KEYS: Readonly<Record<string, XhsLocaleKey>> = { built_in: 'hb.sourceBuiltIn', manual: 'hb.sourceManual', agent: 'hb.sourceAgent', business_seed: 'hb.sourceBusinessSeed' }

/** 扩词候选状态 → 文案键。 */
export const CANDIDATE_STATUS_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  pending: 'hb.pending', accepted: 'hb.accepted', rejected: 'hb.rejected', expired: 'hb.expired',
}

/** 标签提案状态 → 文案键。 */
export const PROPOSAL_STATUS_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  pending: 'hb.pending', auto_activated: 'hb.proposalAuto', accepted: 'hb.accepted', rejected: 'hb.rejected', merged: 'hb.proposalMerged', expired: 'hb.expired',
}

/** run 内部 errorCode → 文案键（tools HOTBOARD_RUN_ERROR_*）；未登记原样返回。 */
export function runErrorText(t: Translate, code: unknown): string {
  if (code === null || code === undefined || code === '') return '—'
  const keys: Readonly<Record<string, XhsLocaleKey>> = {
    DETAIL_BUDGET_EXHAUSTED: 'hb.runErrDetailBudget',
    DETAIL_DEADLINE_EXCEEDED: 'hb.runErrDetailDeadline',
    COMMENT_BUDGET_EXHAUSTED: 'hb.runErrCommentBudget',
    SOFT_DEADLINE_EXCEEDED: 'hb.runErrSoftDeadline',
    SCORE_UPDATE_FAILED: 'hb.runErrScoreFailed',
  }
  const key = keys[String(code)]
  return key !== undefined ? t(key) : String(code)
}

/** 时间窗值 → 文案键（综合分列小注与筛选 chips 复用）。 */
export const WINDOW_LABEL_KEYS: Readonly<Record<string, XhsLocaleKey>> = { '7d': 'hb.window7d', '30d': 'hb.window30d', '90d': 'hb.window90d' }

/** 排序值 → 文案键。 */
export const SORT_LABEL_KEYS: Readonly<Record<string, XhsLocaleKey>> = {
  score: 'hb.sortScore', publishTime: 'hb.sortPublishTime', collect: 'hb.sortCollect',
  like: 'hb.sortLike', comment: 'hb.sortComment', share: 'hb.sortShare',
}

/** 「清空全部」与单个 chip × 的默认值表（对齐 machine defaultFilters().board）。 */
export const BOARD_FILTER_DEFAULTS: Readonly<Record<string, string | boolean>> = {
  window: '90d', keyword: '', style: '', color: '', noteWord: '', commentWord: '', scoreMin: '', scoreMax: '', sort: 'score', onlyMain: true, onlyTagged: false,
}

/** 采集阈值只读行（settings 字段 → 文案键；R3 只读定案，无编辑入口）。 */
export const SETTING_THRESHOLD_FIELDS: ReadonlyArray<[field: keyof import('./hotboard-machine.ts').HotboardSettings, key: XhsLocaleKey]> = [
  ['publishWindowDays', 'hb.setPublishWindowDays'],
  ['perKeywordLimit', 'hb.setPerKeywordLimit'],
  ['commentTopN', 'hb.setCommentTopN'],
  ['commentMaxPerNote', 'hb.setCommentMaxPerNote'],
  ['minInteractionTotal', 'hb.setMinInteraction'],
  ['dedupHammingThreshold', 'hb.setDedupThreshold'],
  ['minValidSample', 'hb.setMinValidSample'],
  ['searchMaxCallsPerDay', 'hb.setSearchBudget'],
  ['commentMaxCallsPerDay', 'hb.setCommentBudget'],
  ['detailMaxCallsPerRun', 'hb.setDetailBudget'],
]
