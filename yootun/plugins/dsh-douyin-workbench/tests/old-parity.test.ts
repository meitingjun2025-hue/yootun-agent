/**
 * 旧插件逐字段对齐护栏（node --test）：同一批真机脱敏 fixture、同构假页面，
 * 同时喂给旧 dsh-yootun-douyin-operation collector.js 与本插件 collector.ts，
 * 逐字段比对最终入库产物（works[] 每个载荷、daily 合并行、fansProfile、账号
 * 资料、listComplete/listReason、每个缺口的 reason），覆盖 12 个采集场景
 * （低播放/10005/通道失败/会话失效部分成果保留/Web 模式列表/画像排序/搜索词
 * 别名/危险协议头像）+ dashboard 六形态与 metrics_trend 真机抓包的解析层补充。
 * 通过标准：合计差异 0。旧仓库或 fixture 不存在时 skip（长期防漂移护栏）。
 * 运行：`node --test tests/old-parity.test.ts`。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { CollectorFetchOutcome, DouyinCollectPage } from '../src/collector.ts'
import { collectAccountWorksOn, mergeDailyRows } from '../src/collector.ts'
import { parseDashboardMetrics, parseItemMetricsTrend, parseRealtimeTrend, parseWordCloud } from '../src/parse.ts'

type AnyRec = Record<string, unknown>

const OLD = '/home/ubuntu/projects/docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation'
const DOCS = '/home/ubuntu/projects/docker-helm.dofe.ai/docs/1015/douyin/fixtures'

/** 键排序规范化 + 入库键 data_gap ≡ dataGap（服务端两者都接受，唯一允许的归一化）。 */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon)
  if (value && typeof value === 'object') {
    const out: AnyRec = {}
    for (const key of Object.keys(value as AnyRec).sort()) {
      out[key === 'data_gap' ? 'dataGap' : key] = canon((value as AnyRec)[key])
    }
    return out
  }
  return value
}

/** 递归字段差集（读路径与旧 diff.mts 一致：对象逐键，原始值直接比对）。 */
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  a = canon(a)
  b = canon(b)
  if (a === b) return
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    out.push(`${path}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`)
    return
  }
  for (const key of new Set([...Object.keys(a as AnyRec), ...Object.keys(b as AnyRec)])) {
    diff((a as AnyRec)[key], (b as AnyRec)[key], path === '' ? key : `${path}.${key}`, out)
  }
}

/** 资料四字段投影（昵称/头像差异不参与逐稿对齐，diff.mts pick 同口径）。 */
function pick(profile: AnyRec | null): AnyRec | null {
  return profile === null ? null : { accountId: profile.accountId, nickname: profile.nickname, avatar: profile.avatar, fanCount: profile.fanCount }
}

/** 旧 collector 的宽松页面类型（JS 侧，无结构化约束）。 */
interface LooseCollectPage {
  goto: (url?: string, options?: Record<string, unknown>) => Promise<unknown>
  waitForTimeout: (ms?: number) => Promise<void>
  waitForLoadState: (state?: string, options?: Record<string, unknown>) => Promise<unknown>
  click: (selector?: string, options?: Record<string, unknown>) => Promise<void>
  $: () => Promise<null>
  $$: () => Promise<Array<{ textContent(): Promise<string | null>; click(options?: Record<string, unknown>): Promise<void> }>>
  on: (...args: unknown[]) => unknown
  off: (...args: unknown[]) => unknown
  evaluate: (script: unknown, arg: unknown) => Promise<CollectorFetchOutcome | boolean>
  evaluateDom: (script: (arg: string) => boolean, arg: string) => Promise<boolean>
}

const send = (body: unknown): CollectorFetchOutcome => ({ status: 200, text: JSON.stringify(body) })

/** 旧 collector 用假页面：字符串参数（clickByText）返回 false，URL 对象走路由。 */
function makeOldPage(sc: Record<string, unknown>): LooseCollectPage {
  const router = makeRouter(sc)
  return {
    goto: async () => null,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    click: async () => undefined,
    $: async () => null,
    $$: async () => [],
    on: () => undefined,
    off: () => undefined,
    evaluate: async (_script, arg) => {
      if (arg !== null && typeof arg === 'object' && typeof (arg as { url?: unknown }).url === 'string') {
        return router(String((arg as { url: string }).url)) ?? { status: 404, text: '' }
      }
      return false
    },
    evaluateDom: async () => false,
  }
}

/** 新 collector 用假页面（结构化满足 DouyinCollectPage；同一路由表）。 */
function makeNewPage(sc: Record<string, unknown>): DouyinCollectPage {
  const router = makeRouter(sc)
  return {
    goto: async () => null,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    click: async () => undefined,
    $: async () => null,
    $$: async () => [],
    on: () => undefined,
    off: () => undefined,
    evaluate: async (_script, arg) => router(arg.url) ?? { status: 404, text: '' },
    evaluateDom: async () => false,
  }
}

/** 按 URL 路由到真机 fixture；详情页不触发拦截，强制走同源 fetch 兜底。 */
function makeRouter(sc: Record<string, unknown>): (url: string) => CollectorFetchOutcome | undefined {
  const fx = (path: string): unknown => JSON.parse(readFileSync(`${OLD}/test/fixtures/${path}`, 'utf8'))
  const listPages = sc.list === 'web'
    ? [(fx('1015/work_list.cover.sample.json') as { data: unknown }).data, (fx('1015/work_list.private_item.sample.json') as { data: unknown }).data]
    : [fx('work_list.page1.sample.json'), fx('work_list.lastpage.sample.json')]
  const trend = { status_code: 0, trend_map: { view_count: { '0': Array.from({ length: 10 }, (_, i) => ({ date_time: `2026-11-${String(i + 1).padStart(2, '0')} 00:00:00`, value: `${String(1000 * (i + 1))}.000000` })) } } }
  const portraitMany = {
    status_code: 0,
    gender: { ratio_list: [{ key: 'female', value: 0.6 }, { key: 'male', value: 0.4 }] },
    age: { ratio_list: [{ key: '31-40', value: 0.5 }] },
    province: { ratio_list: Array.from({ length: 10 }, (_, i) => ({ key: `省${String(i)}`, value: (10 - i) / 100 })) },
    city_level: { ratio_list: [{ key: '一线', value: 0.3 }] },
  }
  const searchMany = { status_code: 0, show_from: [{ keyword: 'a', percent: 30 }, { word: 'b', percent: 90 }, { keyword: 'c' }, { keyword: 'd', percent: null }] }
  return (url: string): CollectorFetchOutcome | undefined => {
    const query = new URL(url, 'https://creator.douyin.com')
    const expireAt = sc.expireAt as string | undefined
    if (expireAt === 'list:2' && url.includes('/pc/work_list') && query.searchParams.get('max_cursor') !== '0') return send(fx('work_list.status_code_8.sample.json'))
    if (expireAt === 'profile' && url.includes('/web/api/media/user/info')) return send({ status_code: 8 })
    if (expireAt === 'performance' && url.includes('/item_analysis/item_performance')) return send({ status_code: 8 })
    if (expireAt === 'dashboard' && url.includes('/data/overview/dashboard') && !url.includes('/fans')) return send(fx('1015/dashboard.session_code_8.sample.json'))
    if (url.includes('/pc/work_list')) return send(query.searchParams.get('max_cursor') === '0' ? listPages[0] : listPages[1])
    if (url.includes('/item_analysis/involved_vertical')) return send({ status_code: 0, primary_verticals: ['汽车'] })
    if (url.includes('/item_analysis/item_performance')) return send(fx('item_analysis.sample.json'))
    if (url.includes('/item_analysis/overview')) return send({ status_code: 0, overview: { play_cnt: 1 } })
    if (url.includes('/web/api/media/user/info')) {
      return send({
        status_code: 0,
        user: {
          sec_uid: 'MS4wLjABAAAA-test-account',
          nickname: '示例账号',
          avatar_uri: sc.avatarUnsafe ? 'javascript:alert(1)' : { uri: 'tos-cn-i-avt-001/example', url_list: ['https://example.invalid/avatar.jpeg'] },
          follower_count: 1234,
        },
      })
    }
    if (url.includes('/data/diagnose/item_compare')) {
      return send(sc.compare === 'low' ? fx('item_compare.low.sample.json')
        : sc.compare === '10005' ? { status_code: 10005, status_msg: 'past item count less than min count', item: { metrics: { view_count: 100, completion_rate: 0.2 } } }
        : sc.compare === 'http500' ? { __raw: true } : fx('item_compare.high.sample.json'))
    }
    if (url.includes('/data/item/play/source')) return send(fx('play_source.sample.json'))
    if (url.includes('/bff/data/progress/analysis/v2')) return send(fx('progress_analysis.sample.json'))
    if (url.includes('/item_analysis/search/keyword')) return send(sc.searchMany ? searchMany : fx('search_keywords.sample.json'))
    if (url.includes('/data/fans/item/portrait')) return send(sc.portraitMany ? portraitMany : fx('portrait.sample.json'))
    if (url.includes('/web/api/creator/item/mget')) {
      const id = query.searchParams.get('ids')
      return send({ status_code: 0, items: [{ id, metrics: { danmaku_count: '7', view_count: 7000, avg_view_second: 12.78, completion_rate: 0.1209, completion_rate_5s: 0.45, bounce_rate_2s: 0.29, avg_view_proportion: 0.66, cover_click_rate: 0.05, fan_view_proportion: 0.01 } }] })
    }
    if (url.includes('/web/api/creator/data/item/summarize')) {
      const id = query.searchParams.get('item_id')
      const summary = fx('1015/item_summarize.sample.json') as { item_list: Array<Record<string, unknown>> }
      const row = summary.item_list[0]
      if (row === undefined) throw new Error('fixture 1015/item_summarize.sample.json 缺少 item_list[0]')
      row.aweme_id = id
      return send(summary)
    }
    if (url.includes('/item_analysis/metrics_trend')) return send(trend)
    if (url.includes('/realtime/analysis/data_center')) return send(fx('retention_play.sample.json'))
    if (url.includes('/wordCloud')) return send(fx('wordCloud.sample.json'))
    if (url.includes('/data/overview/dashboard/fans')) return send(fx('1015/dashboard_fans.sample.json'))
    if (url.includes('/data/overview/dashboard')) return send(fx('1015/dashboard.sample.json'))
    if (url.includes('/bff/data/fans/summary')) return send(fx('1015/fans_summary.sample.json'))
    return { status: 404, text: '' }
  }
}

test('旧插件逐字段对齐（差分护栏，合计差异必须为 0）', { skip: skipReason() }, async () => {
  const OldC = await import(`${OLD}/src/collector.js`) as {
    collectAccountWorks: (page: LooseCollectPage, options: Record<string, unknown>) => Promise<OldCollectResult>
  }
  const OldI = await import(`${OLD}/src/ingest.js`) as {
    mergeDashboardRows: (dashboard: unknown) => AnyRec[]
  }
  const OldP = await import(`${OLD}/src/parse.js`) as {
    parseDashboard: (json: unknown) => AnyRec[]
    parseWordCloud: (json: unknown) => unknown
    parseRealtimeTrend: (json: unknown) => unknown
    parseItemMetricsTrend: (json: unknown) => AnyRec[] | null
  }

  const MS = Date.parse('2026-11-23T04:00:00.000Z')
  const ISO = new Date(MS).toISOString()
  const TODAY = '2026-11-23'

  type ScenarioOutcome =
    | { ok: true; r: OldCollectResult }
    | { ok: false; name: string; partial: AnyRec | null }

  async function runOld(sc: Record<string, unknown>): Promise<ScenarioOutcome> {
    try {
      const r = await OldC.collectAccountWorks(makeOldPage(sc), { observedAt: ISO, workListOptions: { intervalMs: 0 } })
      return { ok: true, r }
    } catch (error) {
      const err = error as { name?: string; partialCollected?: AnyRec | null }
      return { ok: false, name: err.name ?? 'Error', partial: err.partialCollected ?? null }
    }
  }

  type NewOutcome =
    | { ok: true; r: Awaited<ReturnType<typeof collectAccountWorksOn>> }
    | { ok: false; name: string; partial: AnyRec | null }

  async function runNew(sc: Record<string, unknown>): Promise<NewOutcome> {
    try {
      const r = await collectAccountWorksOn(makeNewPage(sc), { now: () => MS })
      return { ok: true, r }
    } catch (error) {
      const err = error as { name?: string; partialCollected?: AnyRec | null }
      return { ok: false, name: err.name ?? 'Error', partial: err.partialCollected ?? null }
    }
  }

  const scenarios: Array<Record<string, unknown>> = [
    { name: 'L1 经典列表 + compare 成功', list: 'classic' },
    { name: 'L2 Web模式列表(Cover大写/顶层duration/item_id/私密作品) + compare 成功', list: 'web' },
    { name: 'L3 低播放 compare(10001) → mget/summarize/performance 兜底', list: 'classic', compare: 'low' },
    { name: 'L4 compare 10005 且带 metrics', list: 'classic', compare: '10005' },
    { name: 'L5 compare 通道 HTTP 500 → request_failed 缺口', list: 'classic', compare: 'http500' },
    { name: 'L7 compare 500 + mget 404 → compare 独有字段必须记 request_failed（不是 not_exposed）', list: 'classic', compare: 'http500', mgetDown: true },
    { name: 'L6 画像 10 省未排序 + 搜索词含 word 别名/缺 percent', list: 'classic', portraitMany: true, searchMany: true },
    { name: 'E1 会话失效@列表第2页 → 部分成果保留', list: 'classic', expireAt: 'list:2' },
    { name: 'E2 会话失效@账号资料 → 全部范围内作品以列表字段入库', list: 'classic', expireAt: 'profile' },
    { name: 'E3 会话失效@批量分析 → 同上', list: 'classic', expireAt: 'performance' },
    { name: 'E4 会话失效@账号大盘 → 已完成详情入库', list: 'classic', expireAt: 'dashboard' },
    { name: 'S1 头像为 javascript: 协议 → 必须被拒绝', list: 'classic', avatarUnsafe: true },
  ]

  const lines: string[] = []
  let total = 0
  for (const sc of scenarios) {
    const old = await runOld(sc)
    const nu = await runNew(sc)
    const out: string[] = []
    if (old.ok !== nu.ok) {
      out.push(`结果形态: old=${old.ok ? 'ok' : old.name} new=${nu.ok ? 'ok' : nu.name}`)
    } else if (old.ok && nu.ok) {
      const a = old.r
      const b = nu.r
      diff(a.listComplete, b.listComplete, 'listComplete', out)
      diff(a.listReason, b.listReason, 'listReason', out)
      diff(a.expectedWorkCount, b.expectedWorkCount, 'expectedWorkCount', out)
      diff(a.publishSince, b.publishSince, 'publishSince', out)
      diff(a.skippedBeforePublishSince, b.skippedBeforePublishSince, 'skippedBeforePublishSince', out)
      diff(a.publishTimeMissing, b.publishTimeMissing, 'publishTimeMissing', out)
      diff(a.pages.map(p => ({ ...p, cursor: String(p.cursor) })), b.pages.map(p => ({ ...p, cursor: String(p.cursor) })), 'pages', out)
      diff(a.failures, b.failures, 'failures', out)
      diff(pick(a.profile), pick(b.profile === null ? null : { ...b.profile }), 'profile', out)
      if (a.works.length !== b.works.length) out.push(`works.length: old=${String(a.works.length)} new=${String(b.works.length)}`)
      for (let i = 0; i < Math.min(a.works.length, b.works.length); i += 1) {
        diff(a.works[i], b.works[i], `works[${String(i)}](${String((a.works[i] as AnyRec).work_id)})`, out)
      }
      diff(a.dashboard.gaps, b.dashboard.gaps, 'dashboard.gaps', out)
      diff(OldI.mergeDashboardRows(a.dashboard), mergeDailyRows(b.dashboard), 'daily(mergeDashboardRows)', out)
      diff(a.dashboard.fansProfile, b.dashboard.fansProfile, 'fansProfile', out)
    } else if (!old.ok && !nu.ok) {
      diff(old.name, nu.name, 'error.name', out)
      const po = old.partial
      const pn = nu.partial
      if ((po === null) !== (pn === null)) {
        out.push(`partialCollected: old=${po === null ? 'null' : '存在'} new=${pn === null ? 'null' : '存在'}`)
      } else if (po !== null && pn !== null) {
        diff(po.listComplete, pn.listComplete, 'partial.listComplete', out)
        diff(po.expectedWorkCount, pn.expectedWorkCount, 'partial.expectedWorkCount', out)
        diff(po.publishSince, pn.publishSince, 'partial.publishSince', out)
        diff(po.works, pn.works, 'partial.works', out)
      }
    }
    total += out.length
    lines.push(`\n## ${String(sc.name)}  →  ${out.length === 0 ? '✓ 一致' : `✗ ${String(out.length)} 处差异`}`)
    for (const line of out.slice(0, 60)) lines.push(`  - ${line}`)
    if (out.length > 60) lines.push(`  - … 其余 ${String(out.length - 60)} 处省略`)
  }

  // ---------- 解析层补充：dashboard 各形态 / metrics_trend 真机抓包 / 会话码 8 ----------
  const parseOut: string[] = []
  const fxOld = (path: string): unknown => JSON.parse(readFileSync(`${OLD}/test/fixtures/${path}`, 'utf8'))
  const fxDocsMetrics = (name: string): unknown => JSON.parse(readFileSync(`${DOCS}/metrics_trend/${name}`, 'utf8'))
  for (const name of ['1015/dashboard.sample.json', '1015/dashboard.recent30.sample.json', '1015/dashboard.partial_metrics.sample.json', '1015/dashboard.recent90.degraded.sample.json', '1015/dashboard_fans.sample.json', '1015/dashboard_fans.recent90.error.sample.json']) {
    diff(OldP.parseDashboard(fxOld(name)), parseDashboardMetrics(fxOld(name)), `parseDashboard(${name})`, parseOut)
  }
  for (const name of ['cumulative_daily_view_group0.json', 'cumulative_daily_two_metrics.json', 'error_missing_metrics_group.json', 'new_hourly_subscribe.json', 'dashboard_recent30.json']) {
    const json = fxDocsMetrics(name)
    diff(OldP.parseItemMetricsTrend(json), parseItemMetricsTrend(json, TODAY), `parseItemMetricsTrend(${name})`, parseOut)
  }
  {
    const session8 = fxOld('1015/dashboard.session_code_8.sample.json')
    let oldThrown = 'no-throw'
    let newThrown = 'no-throw'
    try {
      OldP.parseDashboard(session8)
    } catch (error) {
      oldThrown = (error as { name: string }).name
    }
    try {
      parseDashboardMetrics(session8)
    } catch (error) {
      newThrown = (error as { name: string }).name
    }
    if (oldThrown !== newThrown) parseOut.push(`parseDashboard(session_code_8): old throws ${oldThrown} new ${newThrown}`)
  }
  const constructedTrend = { status_code: 0, trend_map: { view_count: { '0': Array.from({ length: 10 }, (_, i) => ({ date_time: `2026-11-${String(i + 1).padStart(2, '0')} 00:00:00`, value: `${String(1000 * (i + 1))}.000000` })) } } }
  const supplement: Array<[string, unknown, unknown]> = [
    ['parseWordCloud', OldP.parseWordCloud(fxOld('wordCloud.sample.json')), parseWordCloud(fxOld('wordCloud.sample.json'))],
    ['parseRealtimeTrend', OldP.parseRealtimeTrend(fxOld('retention_play.sample.json')), parseRealtimeTrend(fxOld('retention_play.sample.json'))],
    ['parseItemMetricsTrend(构造10点)', OldP.parseItemMetricsTrend(constructedTrend), parseItemMetricsTrend(constructedTrend, TODAY)],
  ]
  for (const [label, oldValue, newValue] of supplement) diff(oldValue, newValue, label, parseOut)
  total += parseOut.length
  lines.push(`\n## 解析层补充（dashboard 六形态 / metrics_trend 真机抓包 / 热词 / 留存）  →  ${parseOut.length === 0 ? '✓ 一致' : `✗ ${String(parseOut.length)} 处差异`}`)
  for (const line of parseOut) lines.push(`  - ${line}`)

  assert.equal(total, 0, `旧插件差分护栏失败（合计差异 ${String(total)}）：\n${lines.join('\n')}`)
})

/** 旧仓库与真机 fixture 是否可用（不可用时护栏 skip，不影响其余测试）。 */
function skipReason(): false | string {
  const gate = existsSync(`${OLD}/src/collector.js`) && existsSync(`${OLD}/test/fixtures/work_list.page1.sample.json`)
    && existsSync(`${DOCS}/metrics_trend`)
  return gate ? false : '旧插件仓库或真机 fixture 不存在（差分护栏仅在有源码的环境运行）'
}

/** 旧 collector 结果（JS 侧形状，逐字段比对所需的白名单投影）。 */
interface OldCollectResult {
  works: AnyRec[]
  listComplete: boolean
  listReason: string | null
  expectedWorkCount: number
  publishSince: string
  skippedBeforePublishSince: number
  publishTimeMissing: number
  pages: AnyRec[]
  failures: AnyRec[]
  profile: AnyRec | null
  dashboard: {
    gaps: AnyRec[]
    fansProfile: unknown
    dashboardRows: AnyRec[]
    dashboardFansRows: AnyRec[]
  }
}
