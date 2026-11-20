/**
 * 小红书笔记基本数据采集（迁移旧 collector.js 全语义，设备端）：
 *
 * 无头复用该账号持久 Profile → 打开笔记管理页（页面加载签名 JS）→ 页面内调用
 * `window._webmsxyw` 生成 x-s/x-t → 签名 fetch posted 接口翻页（page 从 0 开始、
 * 响应 data.page 为下一页、notes 为空终止、翻页间隔 ≥1s）→ 采集结果落设备端
 * 本地快照文件（0600），不入库、不经 MCP 上报（Q10）。
 *
 * 采集实现契约（live 校准口径）：签名函数未暴露时 fail-loud（绝不静默当空列表）；
 * 字段映射 id→contentId、display_title→title、view_count→plays、likes→likes、
 * collected_count→collects、comments_count→comments、shared_count→shares、
 * visible_time（unix 秒）→publishedAt、type(normal|video)→noteType、sticky→置顶；
 * metrics 字段缺失记 dataGap 不补 0。
 * @module
 */
import { launchChrome, type ChromeFactory } from './chrome.ts'
import { detectCaptcha, type XhsBrowserContext, type XhsPage } from './session.ts'
import { ensureProfileDir, saveSnapshot, stateRoot, updateAccount, type SnapshotNote } from './state.ts'

/** 笔记管理页地址。 */
export const NOTE_MANAGER_URL = 'https://creator.xiaohongshu.com/new/note-manager'
/** posted 分页接口路径（页面内签名 fetch）。 */
export const POSTED_PATH = '/api/galaxy/v2/creator/note/user/posted'

/** 单次采集页数上限（触达且还有下一页时 truncated 置位，绝不静默截断）。 */
export const DEFAULT_MAX_PAGES = 30
/** 翻页间隔（≥1s，旧口径）。 */
export const PAGE_INTERVAL_MS = 1000
const SIGN_WAIT_TIMEOUT_MS = 20_000
const OPEN_TIMEOUT_MS = 60_000

/** 带 code 的采集失败（CollectError.code ∈ 稳定本地码）。 */
export class CollectError extends Error {
  /** 稳定错误码（COLLECT_FAILED / SESSION_EXPIRED / CAPTCHA_DETECTED）。 */
  readonly code: string

  /**
   * @param code - stable public code.
   * @param message - diagnostic detail for logs.
   */
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'CollectError'
    this.code = code
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// 页面签名 fetch：调页面自身的 _webmsxyw 生成 x-s/x-t 后 fetch（同源带凭证）。
// live 实测：v2 posted 必须带签名头，裸 fetch 被拒（code=-1）；签名函数缺失返回
// __no_sign__，由宿主 fail-loud（绝不静默当空列表）。函数形式传给 page.evaluate
//（真机验收：源码字符串形式返回 undefined → 误报「响应非 JSON」）；函数体不得
// 引用 Node 侧变量（url 经参数传入）。
const signedFetchInPage = async (url: string): Promise<string> => {
  const signFn = (globalThis as { _webmsxyw?: unknown })['_webmsxyw']
  if (typeof signFn !== 'function') {
    return JSON.stringify({ __no_sign__: true })
  }
  const sign = (signFn as (target: string) => unknown)(url)
  const record = sign !== null && typeof sign === 'object' ? sign as Record<string, unknown> : {}
  const xs = record['X-s'] ?? record['x-s'] ?? record['xs']
  const xt = record['X-t'] ?? record['x-t'] ?? record['xt']
  if (typeof xs !== 'string' || xs === '') {
    return JSON.stringify({ __no_sign__: true })
  }
  const headers = { 'X-s': xs, 'X-t': String(typeof xt === 'number' ? xt : Math.floor(Date.now() / 1000)) }
  const r = await fetch(url, { credentials: 'same-origin', headers })
  return await r.text()
}

function businessCode(raw: Record<string, unknown>): unknown {
  if (raw.code !== undefined) return raw.code
  if (raw.errCode !== undefined) return raw.errCode
  return raw.retCode
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  const text = String(value).trim()
  if (text === '') return null
  if (text.endsWith('万')) {
    const scaled = Number.parseFloat(text.slice(0, -1))
    return Number.isFinite(scaled) ? Math.trunc(scaled * 10000) : null
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/**
 * 单条笔记 → 快照行（字段缺失不补值，绝不编造）。
 * @param item - one raw posted item.
 * @returns the snapshot row, or null when the item carries no usable id.
 */
export function mapNote(item: unknown): SnapshotNote | null {
  if (item === null || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const contentId = record.id !== undefined && record.id !== null ? String(record.id).trim() : ''
  if (contentId === '') return null
  const row: SnapshotNote = { contentId, title: typeof record.display_title === 'string' ? record.display_title : '' }
  // type: normal|video → noteType；未知值原样保留（不猜）
  const noteType = typeof record.type === 'string' && record.type !== '' ? record.type : null
  if (noteType !== null) row.noteType = noteType
  // visible_time（unix 秒）优先；缺失不补
  const visibleTime = toIntOrNull(record.visible_time)
  if (visibleTime !== null) row.publishedAt = new Date(visibleTime * 1000).toISOString()
  const metrics: NonNullable<SnapshotNote['metrics']> = {}
  const pairs: Array<[key: 'plays' | 'likes' | 'collects' | 'comments' | 'shares', source: string]> = [
    ['plays', 'view_count'],
    ['likes', 'likes'],
    ['collects', 'collected_count'],
    ['comments', 'comments_count'],
    ['shares', 'shared_count'],
  ]
  for (const [key, source] of pairs) {
    const value = toIntOrNull(record[source])
    if (value !== null) metrics[key] = value
  }
  if (Object.keys(metrics).length > 0) row.metrics = metrics
  const cover = Array.isArray(record.images_list)
    ? record.images_list.map(entry => entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).url : null)
      .find(url => typeof url === 'string' && url.startsWith('http'))
    : null
  if (typeof cover === 'string') row.coverUrl = cover
  if (record.sticky) row.sticky = true
  return row
}

/** parsePostedPage 的结果。 */
export interface PostedPage {
  notes: SnapshotNote[]
  nextPage: number | null
}

/**
 * posted 响应 → 快照行与下一页。
 * @param raw - the parsed posted response.
 * @returns notes batch + next page.
 * @throws {CollectError} 结构漂移（code=0 但 notes 非数组）显式失败：静默按空页
 *   completed 会伪装成空采。
 */
export function parsePostedPage(raw: unknown): PostedPage {
  if (raw === null || typeof raw !== 'object') throw new CollectError('COLLECT_FAILED', 'posted response is not an object')
  const record = raw as Record<string, unknown>
  const data = record.data !== null && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
  if (!Array.isArray(data.notes)) throw new CollectError('COLLECT_FAILED', 'posted data.notes is not an array')
  const notes = data.notes.map(item => mapNote(item)).filter((note): note is SnapshotNote => note !== null)
  const nextPage = Number.isInteger(data.page) ? data.page as number : null
  return { notes, nextPage }
}

/** 快照聚合（基本数据卡口径）：字段缺失不补 0，记缺口数 = 缺该指标的笔记条数。 */
export interface SnapshotSummary {
  notesCount: number
  totals: { plays: number; likes: number; collects: number; comments: number; shares: number }
  gaps: { plays: number; likes: number; collects: number; comments: number; shares: number }
  capturedAt: string | null
}

/**
 * 快照聚合（基本数据卡口径）：笔记数 = notes.length；观看/点赞/收藏/评论/分享 =
 * 对应 metrics 求和；字段缺失不补 0（记 dataGap）。
 * @param snapshot - the snapshot to aggregate.
 * @returns the summary projection.
 */
export function summarizeSnapshot(snapshot: { notes?: unknown; capturedAt?: unknown }): SnapshotSummary {
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes : []
  const totals = { plays: 0, likes: 0, collects: 0, comments: 0, shares: 0 }
  const gaps = { plays: 0, likes: 0, collects: 0, comments: 0, shares: 0 }
  for (const note of notes) {
    const metrics = note !== null && typeof note === 'object' ? (note as SnapshotNote).metrics : undefined
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      const value = metrics !== undefined && typeof metrics === 'object' ? metrics[key] : undefined
      if (Number.isFinite(value)) totals[key] += value as number
      else gaps[key] += 1
    }
  }
  return {
    notesCount: notes.length,
    totals,
    gaps,
    capturedAt: typeof snapshot.capturedAt === 'string' ? snapshot.capturedAt : null,
  }
}

/** 采集结果。 */
export interface CollectResult {
  pagesDone: number
  notesTotal: number
  truncated: boolean
  snapshotPath: string
  summary: SnapshotSummary
}

/**
 * 采集主流程：无头复用账号 Profile → 笔记管理页签名 fetch 翻页 → 快照落盘。
 * 会话失效（跳 /login 或登录框可见）→ SESSION_EXPIRED；验证码出现 →
 * CAPTCHA_DETECTED；签名函数缺失 → COLLECT_FAILED（fail-loud，不静默空采）。
 * Profile 互斥由调用方（handlers 层）持有。
 * @param options - accountId/root/chrome factory/页数上限/间隔/进度回调/signal。
 * @returns the collection result（含快照路径与聚合）。
 * @throws {CollectError} 采集链路上的稳定失败。
 */
export async function collectNotes(options: {
  accountId: string
  root?: string
  maxPages?: number
  pageIntervalMs?: number
  chromeFactory?: ChromeFactory | undefined
  sleepFn?: ((ms: number) => Promise<void>) | undefined
  onProgress?: ((progress: { pagesDone: number; notesTotal: number }) => void) | null
  signal?: AbortSignal | undefined
}): Promise<CollectResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const pageIntervalMs = options.pageIntervalMs ?? PAGE_INTERVAL_MS
  const sleepFn = options.sleepFn ?? sleep
  const signal = options.signal
  if (accountId === '') throw new CollectError('COLLECT_FAILED', 'accountId required')
  const profileDir = await ensureProfileDir(accountId, root)
  const chromeFactory = options.chromeFactory ?? launchChrome
  let context: XhsBrowserContext | null = null
  /** 每个 await 点检查 abort（控制流收窄不跨循环迭代，用函数包装）。 */
  const aborted = (): boolean => signal?.aborted === true
  try {
    if (aborted()) throw new CollectError('COLLECT_FAILED', 'collect_aborted')
    ;({ context } = await chromeFactory({ headless: true, profileDir }))
    const page: XhsPage = context.pages()[0] ?? await context.newPage()
    await page.goto(NOTE_MANAGER_URL, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    // 会话失效：跳 /login 或登录框可见
    const loginBoxVisible = await page.isVisible('div[class*="login-box"]').catch(() => false)
    if (String(page.url()).includes('/login') || loginBoxVisible) {
      throw new CollectError('SESSION_EXPIRED', 'login page detected')
    }
    // 签名函数依赖页面加载：超时 fail-loud（创作者中心改版即显式失败，不静默空采）
    try {
      await page.waitForFunction(() => typeof (globalThis as { _webmsxyw?: unknown })['_webmsxyw'] === 'function', { timeout: SIGN_WAIT_TIMEOUT_MS })
    } catch {
      if (await detectCaptcha(page)) throw new CollectError('CAPTCHA_DETECTED', 'captcha detected')
      throw new CollectError('COLLECT_FAILED', 'sign function _webmsxyw unavailable')
    }

    const notes: SnapshotNote[] = []
    let pagesDone = 0
    let pageNo = 0
    // 触达单次采集页数上限且还有下一页时置位：绝不静默截断（completed 也要可辨）。
    let truncated = false
    for (;;) {
      if (aborted()) throw new CollectError('COLLECT_FAILED', 'collect_aborted')
      if (pagesDone >= maxPages) {
        truncated = true
        break
      }
      const text = await page.evaluate(signedFetchInPage, `${POSTED_PATH}?tab=0&page=${pageNo}`)
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        throw new CollectError('SESSION_EXPIRED', 'posted response is not JSON')
      }
      if (raw === null || typeof raw !== 'object') throw new CollectError('COLLECT_FAILED', 'posted response is not an object')
      if ((raw as Record<string, unknown>)['__no_sign__'] === true) {
        throw new CollectError('COLLECT_FAILED', 'sign function _webmsxyw unavailable')
      }
      const code = businessCode(raw as Record<string, unknown>)
      if (code !== 0 && code !== '0') throw new CollectError('COLLECT_FAILED', `posted business code ${String(code).slice(0, 32)}`)
      const { notes: batch, nextPage } = parsePostedPage(raw)
      notes.push(...batch)
      pagesDone += 1
      options.onProgress?.({ pagesDone, notesTotal: notes.length })
      // 终止条件：本页为空，或响应未给下一页，或下一页不前进
      if (batch.length === 0 || nextPage === null || nextPage <= pageNo) break
      pageNo = nextPage
      await sleepFn(pageIntervalMs)
      if (await detectCaptcha(page)) throw new CollectError('CAPTCHA_DETECTED', 'captcha detected')
    }

    const snapshot = {
      schemaVersion: 1 as const,
      accountId,
      capturedAt: new Date().toISOString(),
      source: 'creator-web' as const,
      notes,
      ...(truncated ? { truncated: true as const } : {}),
    }
    const snapshotPath = await saveSnapshot(accountId, snapshot, root)
    await updateAccount(accountId, { lastCollectedAt: snapshot.capturedAt }, root)
    return { pagesDone, notesTotal: notes.length, truncated, snapshotPath, summary: summarizeSnapshot(snapshot) }
  } finally {
    if (context !== null) await context.close().catch(() => undefined)
  }
}
