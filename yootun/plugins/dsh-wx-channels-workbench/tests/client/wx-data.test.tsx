/**
 * client 数据页 mock Host 测试（布局回正骨架）：每个数据视图都有 mock response
 * 内容断言（works.list 真实 schema 含服务端分页与聚合字段、account.overview
 * 固定 last_7d 摘要、started:false reason、删除两步确认与失败短路、browser
 * 五态不阻断页面、批量面板、服务端排序与翻页、tab / 键盘 / aria）。
 */
// @vitest-environment jsdom
import { strict as assert } from 'node:assert'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { en as kitEn, type YtKitLocaleKey } from '@yootun/dsh-client-ui-kit'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { readAccountsOverview, readOverview } from '../../src/client/schema.ts'
import { formatCount, formatDelta } from '../../src/client/format.ts'
import { fansTrendSlots } from '../../src/client/works-format.ts'
import { en, zh, type WxLocaleKey } from '../../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

type Payload = Record<string, unknown>
type Handler = (args: Payload) => Payload | Promise<Payload>

/** en 词典翻译（与 inject 同口径的 {token} 插值）。 */
const t = (key: WxLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key]
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = values[token]
    return value === undefined ? match : String(value)
  })
}

/** kit en 词典翻译（Pager 文案断言用；同一 {token} 插值口径）。 */
const kitT = (key: YtKitLocaleKey, values?: Record<string, string | number>): string => {
  const text = kitEn[key]
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = values[token]
    return value === undefined ? match : String(value)
  })
}

interface RecordedCall { action: string; args: Payload }

/**
 * 把全局 fetch 替换为按 action 分发的 mock Host；handlers 未覆盖的 action
 * 直接 reject（暴露未预期的调用面）。返回调用记录供断言。
 */
function mockHost(handlers: Record<string, Handler>): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
    const body = JSON.parse(init?.body ?? '{}') as Payload
    const action = String(body.action)
    const handler = handlers[action]
    if (handler === undefined) throw new Error(`unmocked action ${action}`)
    calls.push({ action, args: body })
    const payload = await handler(body)
    return { json: async () => payload }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls }
}


/** locale 座位假件：快照对象只建一次（引用稳定）；与用例的 en kit 文案口径一致。 */
const localeSnapshot = { active: 'en' }
const locale = {
  subscribe: () => () => undefined,
  getSnapshot: () => localeSnapshot,
}

const OK = { status: 'ok' }

/** 上海最近 N 个已完成日（测试夹具；与 works-format.recentDays 同口径）。 */
function recentDaysForTest(count = 1): string {
  const shifted = new Date(Date.now() + 8 * 3600 * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - count)
  return shifted.toISOString().slice(0, 10)
}

const ACCOUNT = {
  accountId: 'finder-a',
  nickname: '演示账号',
  avatar: null,
  feedCount: 12,
  followerTotalCount: 66,
  sessionStatus: 'ok',
  sessionCheckedAt: '2026-11-18T10:00:00.000Z',
  lastCollectedAt: null,
  deleteState: 'none',
  isPending: false,
  hasStorageState: true,
  localCredentialsMissing: false,
}

const WORKS = {
  // 服务端分页与聚合出参（tools 真实 schema：total / gap_count /
  // latest_collected_at / completion_rate_pct 在载荷顶层）。
  total: 2,
  gap_count: 1,
  latest_collected_at: '2026-11-18T16:04:00.000Z',
  completion_rate_pct: 41.2,
  works: [
    {
      work_id: 'w-100',
      title: '第一条作品',
      description: null,
      cover_url: 'https://example.invalid/cover-100.jpg',
      duration_s: 65,
      play_count: 1000,
      like_count: 50,
      favorite_count: 8,
      comment_count: 4,
      share_count: 2,
      forward_count: 3,
      follow_count: 1,
      completion_rate_pct: 8.37,
      avg_play_duration_s: 6.95,
      wecom_link_click_count: 5,
      wecom_link_click_uv: 4,
      wecom_contact_add_count: 2,
      wecom_contact_add_uv: 1,
      publish_time: '2026-11-17T08:00:00.000Z',
      latest_collected_at: '2026-11-18T16:04:00.000Z',
      data_gap: { traffic_source: { reason: 'not_exposed' } },
    },
    { work_id: 'w-101', title: '第二条', play_count: 7, like_count: null, publish_time: null, data_gap: null },
  ],
}

/** work.get 的真实详情包装（{ work, traffic_source, retention_trend, daily_metrics, data_gap }）。 */
function workGetPayload(workId: string): Payload {
  return {
    ...OK,
    work: { ...WORKS.works[0], work_id: workId },
    traffic_source: {
      rows: [
        { sourceType: 1, sourceKey: 'follow', name: '关注', playCount: 0 },
        { sourceType: 2, sourceKey: 'recommend', name: '推荐', playCount: 173 },
        { sourceType: 999, sourceKey: 'all', name: '全部', playCount: 500 },
        { sourceType: 3, sourceKey: 'share', name: '分享', playCount: null },
      ],
    },
    retention_trend: { points: [{ second: 0, rate_pct: 100 }, { second: 3, rate_pct: 22.4 }, { second: 9, ratePct: 14 }] },
    // 日期必须落在 recentDays(7) 窗口内（dailyTrendRows 按最近 7 个上海已完成日
    // 对齐）：写死过去日期会随时间推移腐化为空态（本用例曾因此失败）。
    daily_metrics: [
      { day: recentDaysForTest(3), daily_play_count: 100, daily_like_count: 5 },
      { day: recentDaysForTest(1), daily_play_count: 140, daily_like_count: 9, daily_follow_count: 2 },
    ],
    data_gap: { traffic_source: { reason: 'not_exposed' } },
  }
}

/** 基础 handler 集：browser available + 单账号 + 空总览；各测试按需覆盖。 */
function baseHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'browser.status': () => ({ ...OK, chrome: 'available', driver: 'available' }),
    'accounts.list': () => ({ ...OK, accounts: [ACCOUNT], remoteOk: true }),
    'collect.status': () => ({ ...OK, busy: false, collect: null, runningAccountIds: [], lastRun: null }),
    'collect.running': () => ({ ...OK, collect: null, batchRunning: false }),
    'collectAll.status': () => ({ ...OK, ready: true, phase: 'ready', total: 0, currentAccountIndex: -1, currentAccountId: null, runningAccountIds: [], concurrency: 0, error: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] }),
    'works.list': () => ({ ...OK, ...WORKS }),
    'account.overview': () => ({
      ...OK,
      metrics: { totals: { daily_play_count: 1234, daily_like_count: 56, work_count: 12 } },
      fans_trend: { totals: { follower_net_count: 7 }, daily: [] },
      availability: { account_metrics: 'ok', fans_trend: 'ok', fans_profile: 'no_data' },
    }),
    ...overrides,
  }
}

async function renderPage(handlers: Record<string, Handler>): Promise<{ calls: RecordedCall[] }> {
  const host = mockHost(handlers)
  render(<WorkbenchPage t={t} locale={locale} />)
  // 等账号列表就绪（默认作品数据 tab 自动拉 works.list + 固定 last_7d 摘要）。
  await waitFor(() => expect(host.calls.some(call => call.action === 'accounts.list')).toBe(true))
  return host
}

describe('browser 五态（不阻断页面）', () => {
  it('available：头部状态显示浏览器就绪', async () => {
    await renderPage(baseHandlers())
    expect(await screen.findByText(t('header.status.browserReady'))).not.toBeNull()
    expect(screen.getByRole('tab', { name: en['tab.works'] })).not.toBeNull()
  })

  it('chrome missing：页面不阻断，侧栏提示采集不可用，采集与添加账号禁用', async () => {
    await renderPage(baseHandlers({
      'browser.status': () => ({ ...OK, chrome: 'missing', driver: 'missing' }),
    }))
    expect(await screen.findByText(t('browser.blockedHint'))).not.toBeNull()
    expect(screen.getByText(t('header.status.browserBlocked'))).not.toBeNull()
    // 采集入口禁用（按钮保留在文档中，disabled 语义可查询）。
    expect(screen.getByRole('button', { name: t('works.collect') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('account.add') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('account.collectAll') }).hasAttribute('disabled')).toBe(true)
  })

  it('driver missing：同样提示采集不可用，不伪装成 chrome 缺失专用文案', async () => {
    await renderPage(baseHandlers({
      'browser.status': () => ({ ...OK, chrome: 'available', driver: 'missing' }),
    }))
    expect(await screen.findByText(t('browser.blockedHint'))).not.toBeNull()
    expect(screen.getByText(t('header.status.browserBlocked'))).not.toBeNull()
  })

  it('Host API error：头部降级标注，不伪成就绪', async () => {
    await renderPage(baseHandlers({
      'browser.status': () => { throw new Error('host api down') },
    }))
    expect(await screen.findByText(t('header.status.serviceDegraded'))).not.toBeNull()
    expect(screen.queryByText(t('header.status.browserReady'))).toBeNull()
  })
})

describe('账号管理栏（作品数据页左侧）', () => {
  it('标题行「账号管理 + 采集全部」，账号卡片显示昵称 / 关注者 / 会话状态', async () => {
    await renderPage(baseHandlers())
    expect(screen.getByText(t('account.title'))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('account.collectAll') })).not.toBeNull()
    expect(screen.getByText('演示账号')).not.toBeNull()
    // 卡片 meta 行：关注者数 + 最近同步时间（同一行内拼接）。
    expect(screen.getByText(/66 followers/u)).not.toBeNull()
    expect(screen.getByText(/Last sync 2026-11-18 18:00/u)).not.toBeNull()
    expect(screen.getByText(t('account.state.ok'))).not.toBeNull()
    // 添加账号宽主按钮在侧栏底部。
    expect(screen.getByRole('button', { name: t('account.add') })).not.toBeNull()
  })

  it('会话过期账号显示重新扫码入口；pending 账号显示提升', async () => {
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [{ ...ACCOUNT, sessionStatus: 'expired' }, { ...ACCOUNT, accountId: 'pending-1', nickname: '待确认号', sessionStatus: 'unknown', isPending: true }], remoteOk: true }),
    }))
    expect(await screen.findByText(t('account.state.expired'))).not.toBeNull()
    expect(screen.getAllByRole('button', { name: t('account.relogin') }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: t('account.promote') })).not.toBeNull()
  })

  it('account.probe 结果以 toast 呈现并刷新账号列表', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.probe': () => ({ ...OK, sessionStatus: 'ok', reason: null, reported: true }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.probe') }))
    expect(await screen.findByText(t('account.probeOk'))).not.toBeNull()
    const probeCall = calls.find(call => call.action === 'account.probe')
    expect(probeCall?.args).toMatchObject({ accountId: 'finder-a' })
    expect(calls.filter(call => call.action === 'accounts.list').length).toBeGreaterThanOrEqual(2)
  })

  it('account.promote：pending 账号提升成功后刷新列表', async () => {
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [{ ...ACCOUNT, accountId: 'pending-1', sessionStatus: 'unknown', isPending: true, hasStorageState: true }], remoteOk: true }),
      'account.promote': () => ({ ...OK, promoted: true, accountId: 'finder-a' }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.promote') }))
    expect(await screen.findByText(t('account.promoted'))).not.toBeNull()
    const promoteCall = calls.find(call => call.action === 'account.promote')
    expect(promoteCall?.args).toMatchObject({ accountId: 'pending-1' })
    expect(calls.filter(call => call.action === 'accounts.list').length).toBeGreaterThanOrEqual(2)
  })

  it('删除两步：confirm → removeLocal 成功后才 removeRemote', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ ...OK, removed: true }),
      'account.removeRemote': () => ({ ...OK, removed: true }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    // 第一步确认出现（warning + confirm + cancel），尚未调用任何删除。
    expect(screen.getByText(en['account.removeWarning'])).not.toBeNull()
    expect(calls.some(call => call.action.startsWith('account.remove'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` }))
    await waitFor(() => expect(screen.getByText(t('account.removeSuccess'))).not.toBeNull())
    const localIndex = calls.findIndex(call => call.action === 'account.removeLocal')
    const remoteIndex = calls.findIndex(call => call.action === 'account.removeRemote')
    expect(localIndex).toBeGreaterThanOrEqual(0)
    expect(remoteIndex).toBeGreaterThan(localIndex)
    expect(calls.find(call => call.action === 'account.removeRemote')?.args).toMatchObject({ accountId: 'finder-a' })
  })

  it('删除短路：removeLocal removed:false（collect_busy）→ 不调 removeRemote，可重试', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ ...OK, removed: false, reason: 'collect_busy' }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` }))
    expect(await screen.findByText(`${t('collect.reason.collect_busy')}（collect_busy）`)).not.toBeNull()
    expect(calls.some(call => call.action === 'account.removeRemote')).toBe(false)
    // 重试回到确认步。
    fireEvent.click(screen.getByRole('button', { name: t('state.retry') }))
    expect(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` })).not.toBeNull()
    expect(calls.filter(call => call.action === 'account.removeLocal').length).toBe(1)
  })

  it('删除短路：removeLocal 失败 → localFailed 可重试，removeRemote 未调用', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ status: 'error', reason: 'WX_TOOL_UNAVAILABLE' }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` }))
    expect(await screen.findByText(en['account.delete.localFailed'], { exact: false })).not.toBeNull()
    expect(calls.some(call => call.action === 'account.removeRemote')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: t('account.delete.retryLocal') }))
    await waitFor(() => expect(calls.filter(call => call.action === 'account.removeLocal').length).toBe(2))
    expect(calls.some(call => call.action === 'account.removeRemote')).toBe(false)
  })

  it('删除短路：removeRemote 失败 → remoteFailed 单步重试只调 removeRemote', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ ...OK, removed: true }),
      'account.removeRemote': () => ({ status: 'error', reason: 'DELETE_CLEANUP_FAILED' }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` }))
    expect(await screen.findByText(en['account.delete.remoteFailed'], { exact: false })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('account.delete.retryRemote') }))
    await waitFor(() => expect(calls.filter(call => call.action === 'account.removeRemote').length).toBe(2))
    expect(calls.filter(call => call.action === 'account.removeLocal').length).toBe(1)
  })

  it('两步确认可取消：cancel 回到列表且不发生任何删除调用', async () => {
    const { calls } = await renderPage(baseHandlers())
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: t('account.delete.cancel') }))
    expect(screen.queryByText(en['account.removeWarning'])).toBeNull()
    expect(calls.some(call => call.action.startsWith('account.remove'))).toBe(false)
  })
})

describe('批量采集面板（账号管理栏标题行下方）', () => {
  it('采集全部点击即进入乐观运行态：总进度 + 取消入口，批量期间单账号采集禁用', async () => {
    let resolveStart: ((payload: Payload) => void) | undefined
    const { calls } = await renderPage(baseHandlers({
      'collectAll.start': () => new Promise<Payload>(resolve => { resolveStart = resolve }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    // 乐观投影立即可见（不等宿主返回）。
    expect(screen.getByRole('button', { name: t('account.collectAllRunning') })).not.toBeNull()
    expect(screen.getByText(t('batch.progress.fallback'))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('batch.cancel') })).not.toBeNull()
    // 单账号采集按钮随批量运行禁用（宿主互斥，提前禁用给稳定反馈）。
    expect(screen.getByRole('button', { name: t('works.collect') }).hasAttribute('disabled')).toBe(true)
    expect(calls.some(call => call.action === 'collectAll.start')).toBe(true)
    // 宿主返回后乐观态被真实投影覆盖（仍运行中）。
    resolveStart?.({ ...OK, started: true, batchId: 'batch-1' })
    await waitFor(() => expect(screen.getByText(t('batch.progress.fallback'))).not.toBeNull())
  })

  it('D3 运行中显示已完成进度、运行中账号列表与并发度；批量取消后回到终态面板', async () => {
    let cancelled = false
    let statusCalls = 0
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
      'collectAll.status': () => {
        statusCalls += 1
        // 首次为挂载恢复查询（无运行中批量）；点击发起后的轮询返回运行中 / 终态。
        if (cancelled) {
          return {
            ...OK, ready: true, phase: 'finished', total: 2, currentAccountIndex: 1, currentAccountId: null,
            runningAccountIds: [], concurrency: 2, error: null,
            completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 2,
            items: [
              { accountId: 'finder-a', status: 'skipped', reason: 'collect_cancelled' },
              { accountId: 'finder-b', status: 'skipped', reason: 'collect_cancelled' },
            ],
          }
        }
        if (statusCalls === 1) {
          return { ...OK, ready: true, phase: 'ready', total: 0, currentAccountIndex: -1, currentAccountId: null, runningAccountIds: [], concurrency: 0, error: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] }
        }
        return {
          ...OK, ready: false, phase: 'collecting', total: 2, currentAccountIndex: 1,
          currentAccountId: 'finder-a', runningAccountIds: ['finder-a', 'finder-b'], concurrency: 2, error: null,
          completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
          items: [
            { accountId: 'finder-a', status: 'running', reason: null },
            { accountId: 'finder-b', status: 'running', reason: null },
          ],
        }
      },
      'collectAll.start': () => ({ ...OK, started: true, batchId: 'batch-1' }),
      'collectAll.cancel': () => {
        cancelled = true
        return { ...OK, cancelled: true }
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    expect(await screen.findByText(t('batch.progress.concurrent', { done: 0, total: 2 }))).not.toBeNull()
    expect(screen.getByText(t('batch.currentList', { names: '演示账号、账号乙' }))).not.toBeNull()
    expect(screen.getByText(t('batch.concurrency', { count: 2 }))).not.toBeNull()
    expect(screen.getByText(t('batch.counts', { completed: 0, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('batch.cancel') })).not.toBeNull()
    // 取消后终态：跳过计数可见，按钮恢复「采集全部」。
    fireEvent.click(screen.getByRole('button', { name: t('batch.cancel') }))
    await waitFor(() => expect(screen.getByText(t('batch.summaryLine', { completed: 0, partial: 0, failed: 0, skipped: 2 }))).not.toBeNull())
    expect(screen.getByRole('button', { name: t('account.collectAll') })).not.toBeNull()
  })

  it('D4 熔断：面板显示暂停提示与剩余数；risk_paused 条目用批次暂停文案', async () => {
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
      'collectAll.status': () => ({
        ...OK, ready: true, phase: 'finished', total: 4, currentAccountIndex: 3, currentAccountId: null,
        runningAccountIds: [], concurrency: 3, error: 'risk_paused',
        completedCount: 1, partialCount: 0, failedCount: 2, skippedCount: 1,
        items: [
          { accountId: 'finder-a', status: 'completed', reason: null },
          { accountId: 'finder-b', status: 'failed', reason: 'session_expired' },
          { accountId: 'finder-c', status: 'failed', reason: 'probe_failed' },
          { accountId: 'finder-d', status: 'skipped', reason: 'risk_paused' },
        ],
      }),
    }))
    // 挂载恢复即显示已结束批次的汇总与熔断提示。
    expect(await screen.findByText(t('batch.paused', { remaining: 1 }))).not.toBeNull()
    expect(screen.getByText(t('batch.summaryLine', { completed: 1, partial: 0, failed: 2, skipped: 1 }))).not.toBeNull()
    expect(screen.getByText(t('batch.reason.riskPaused'))).not.toBeNull()
    // 未熔断账号的稳定原因照旧经 reasonText（可行动文案 + 原码）。
    expect(screen.getByText(`${t('collect.reason.session_expired')}（session_expired）`)).not.toBeNull()
  })

  it('终态：汇总四类计数完整，失败 / 跳过账号逐行稳定原因', async () => {
    await renderPage(baseHandlers({
      'collectAll.start': () => ({ ...OK, started: true, batchId: 'batch-1' }),
      'collectAll.status': () => ({
        ...OK, ready: true, phase: 'finished', total: 3, currentAccountIndex: 3,
        currentAccountId: null, completedCount: 1, partialCount: 1, failedCount: 1, skippedCount: 0,
        items: [
          { accountId: 'finder-a', status: 'completed', reason: null },
          { accountId: 'finder-b', status: 'partial', reason: 'partial' },
          { accountId: 'finder-c', status: 'failed', reason: 'account_mismatch' },
        ],
      }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    expect(await screen.findByText(t('batch.summaryLine', { completed: 1, partial: 1, failed: 1, skipped: 0 }))).not.toBeNull()
    // partial 也进未完成明细；稳定 reason 出可行动文案。
    expect(screen.getByText(`${t('collect.reason.partial')}（partial）`)).not.toBeNull()
    expect(screen.getByText(`${t('collect.reason.account_mismatch')}（account_mismatch）`)).not.toBeNull()
    // 账号名投影：无本地账号的 ID 原样显示。
    expect(screen.getByText('finder-c')).not.toBeNull()
  })

  it('批量未启动：started:false 清掉乐观态并显示稳定 reason', async () => {
    await renderPage(baseHandlers({
      'collectAll.start': () => ({ ...OK, started: false, reason: 'collect_busy' }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    expect(await screen.findByText(`${t('batch.startFailed')}：${t('collect.reason.collect_busy')}（collect_busy）`)).not.toBeNull()
    // 乐观运行态已清除：采集全部按钮恢复可用。
    expect(screen.getByRole('button', { name: t('account.collectAll') })).not.toBeNull()
    expect(screen.queryByRole('button', { name: t('account.collectAllRunning') })).toBeNull()
  })
})

describe('作品工具栏（单账号采集入口与就地进度）', () => {
  it('采集入口在作品工具栏：started:false 显示稳定 reason 且不进入 running', async () => {
    const { calls } = await renderPage(baseHandlers({
      'collect.start': () => ({ ...OK, started: false, reason: 'collect_busy' }),
    }))
    const start = screen.getByRole('button', { name: t('works.collect') })
    fireEvent.click(start)
    expect(await screen.findByText(t('collect.startFailedReason'))).not.toBeNull()
    expect(screen.getByText(`${t('collect.reason.collect_busy')}（collect_busy）`)).not.toBeNull()
    expect(calls.find(call => call.action === 'collect.start')?.args).toMatchObject({ accountId: 'finder-a' })
    // busy 保持 false：开始按钮可用、取消按钮不出现。
    expect(start.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByRole('button', { name: t('works.cancel') })).toBeNull()
  })

  it('D2 运行中：按钮进入采集中 + 工具栏下方进度行 + 取消入口（不进顶部通知条）', async () => {
    let statusCalls = 0
    const { calls } = await renderPage(baseHandlers({
      'collect.start': () => ({ ...OK, started: true, runId: 'run-1' }),
      'collect.status': () => {
        statusCalls += 1
        // 首次为挂载恢复查询（无运行中采集）；点击发起后的按账号轮询返回运行中。
        if (statusCalls === 1) return { ...OK, busy: false, collect: null, runningAccountIds: [], lastRun: null }
        return {
          ...OK,
          busy: true,
          collect: {
            accountId: 'finder-a', attemptId: 'finder-a-abc', status: 'running',
            startedAt: '2026-11-18T10:00:00.000Z', finishedAt: null, error: null,
            progress: { phase: 'ingest', batchNo: 2, totalBatches: 5, succeeded: 30, failed: 1, expected: 45 },
            result: null,
          },
          runningAccountIds: ['finder-a'],
          lastRun: null,
        }
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    expect(await screen.findByText(t('works.collecting'))).not.toBeNull()
    // 进度行在工具栏按钮下方：阶段文案 + 细粒度批次计数 + 取消。
    expect(screen.getByText(t('collect.progress.ingest', { batchNo: 2, totalBatches: 5, succeeded: 30, expected: 45 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('works.cancel') })).not.toBeNull()
    // 轮询按账号查询（挂载恢复查询之后都携带 accountId）。
    const pollCalls = calls.filter(call => call.action === 'collect.status').slice(1)
    expect(pollCalls.length).toBeGreaterThan(0)
    expect(pollCalls.every(call => call.args.accountId === 'finder-a')).toBe(true)
  })

  it('终态 failed：toast 给稳定 reason，并按采集账号刷新数据', async () => {
    const { calls } = await renderPage(baseHandlers({
      'collect.start': () => ({ ...OK, started: true, runId: 'run-1' }),
      'collect.status': () => ({
        ...OK,
        busy: false,
        collect: {
          accountId: 'finder-a', attemptId: 'finder-a-1', status: 'failed',
          startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:05:00.000Z',
          error: 'WX_SESSION_INVALID', progress: { phase: 'probing' }, result: null,
        },
        lastRun: null,
      }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    expect(await screen.findByText(`${t('works.collectFailed')}：${t('error.WX_SESSION_INVALID')}（WX_SESSION_INVALID）`)).not.toBeNull()
    // 终态后刷新：works / 摘要 / 账号列表再次调用。
    await waitFor(() => expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(2))
    expect(calls.filter(call => call.action === 'accounts.list').length).toBeGreaterThanOrEqual(2)
  })
})

describe('采集状态挂载恢复（页面卸载期间采集照常运行，重新挂载还原）', () => {
  /** 等待宏任务队列清空（负断言「不再有新查询」的前置）。 */
  const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 25) })

  it('D1 挂载时三路恢复查询各一次；无运行中采集时不进入运行态、不启动轮询', async () => {
    const { calls } = await renderPage(baseHandlers())
    await settle()
    expect(calls.filter(call => call.action === 'collect.running').length).toBe(1)
    expect(calls.filter(call => call.action === 'collect.status').length).toBe(1)
    expect(calls.filter(call => call.action === 'collectAll.status').length).toBe(1)
    expect(screen.queryByText(t('works.collecting'))).toBeNull()
    expect(screen.queryByText(t('batch.progress.fallback'))).toBeNull()
    expect(screen.queryByText(t('batch.summaryLine', { completed: 0, partial: 0, failed: 0, skipped: 0 }))).toBeNull()
    // 无运行中批量：采集全部入口保持可用。
    expect(screen.getByRole('button', { name: t('account.collectAll') }).hasAttribute('disabled')).toBe(false)
  })

  it('D2 单账号运行中恢复：按钮采集中、进度来自恢复记录、轮询继续到终态并刷新', async () => {
    let statusCalls = 0
    let finish = false
    const runningResponse = (): Payload => ({
      ...OK,
      busy: true,
      collect: {
        accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
        finishedAt: null, error: null,
        progress: { phase: 'ingest', batchNo: 3, totalBatches: 6, succeeded: 40, failed: 0, expected: 60 },
        result: null,
      },
      runningAccountIds: ['finder-a'],
      lastRun: null,
    })
    const { calls } = await renderPage(baseHandlers({
      'collect.running': () => ({ ...OK, collect: runningResponse().collect, batchRunning: false }),
      'collect.status': () => {
        statusCalls += 1
        // 首跳为挂载恢复查询；其后按账号轮询返回运行中；flip 后读到终态。
        if (!finish) return runningResponse()
        return {
          ...OK,
          busy: false,
          collect: {
            accountId: 'finder-a', status: 'completed', startedAt: '2026-11-18T10:00:00.000Z',
            finishedAt: '2026-11-18T10:05:00.000Z', error: null,
            progress: { phase: 'finishing' }, result: { runId: 'run-9', works: 60 },
          },
          runningAccountIds: [],
          lastRun: null,
        }
      },
    }))
    // 恢复态立即可见：按钮进入采集中，进度行来自恢复记录。
    expect(await screen.findByText(t('works.collecting'))).not.toBeNull()
    expect(screen.getByText(t('collect.progress.ingest', { batchNo: 3, totalBatches: 6, succeeded: 40, expected: 60 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('works.collecting') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('works.cancel') })).not.toBeNull()
    // 轮询到终态：按钮恢复，作品列表与账号列表按采集账号刷新。
    finish = true
    await waitFor(() => expect(screen.queryByText(t('works.collecting'))).toBeNull(), { timeout: 3000 })
    await waitFor(() => expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(2))
    expect(calls.filter(call => call.action === 'accounts.list').length).toBeGreaterThanOrEqual(2)
    // 恢复查询 + 首跳轮询（运行中）+ 终态轮询，此后停表；恢复查询携带选中账号。
    expect(statusCalls).toBe(3)
    expect(calls.find(call => call.action === 'collect.status')?.args).toMatchObject({ accountId: 'finder-a' })
  })

  it('恢复查询失败按无运行中采集处理：不进入运行态、不弹错误、不轮询', async () => {
    let statusCalls = 0
    await renderPage(baseHandlers({
      'collect.status': () => {
        statusCalls += 1
        if (statusCalls === 1) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, busy: false, collect: null, lastRun: null }
      },
    }))
    await screen.findByText('第一条作品')
    await settle()
    expect(statusCalls).toBe(1)
    expect(screen.queryByText(t('works.collecting'))).toBeNull()
    expect(screen.getByRole('button', { name: t('works.collect') }).hasAttribute('disabled')).toBe(false)
  })

  it('D3 批量运行中恢复（collecting）：多账号面板与并发度恢复、轮询继续到终态并刷新', async () => {
    let batchCalls = 0
    let finish = false
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
      'collectAll.status': () => {
        batchCalls += 1
        // 恢复查询与轮询都返回 collecting；flip 后轮询读到 finished 终态。
        if (!finish) {
          return {
            ...OK, ready: false, phase: 'collecting', total: 2, currentAccountIndex: 1, currentAccountId: 'finder-b',
            runningAccountIds: ['finder-b'], concurrency: 3, error: null,
            completedCount: 1, partialCount: 0, failedCount: 0, skippedCount: 0,
            items: [
              { accountId: 'finder-a', status: 'completed', reason: null },
              { accountId: 'finder-b', status: 'running', reason: null },
            ],
          }
        }
        return {
          ...OK, ready: true, phase: 'finished', total: 2, currentAccountIndex: 2, currentAccountId: null,
          runningAccountIds: [], concurrency: 3, error: null,
          completedCount: 2, partialCount: 0, failedCount: 0, skippedCount: 0,
          items: [
            { accountId: 'finder-a', status: 'completed', reason: null },
            { accountId: 'finder-b', status: 'completed', reason: null },
          ],
        }
      },
    }))
    expect(await screen.findByText(t('batch.progress.concurrent', { done: 1, total: 2 }))).not.toBeNull()
    expect(screen.getByText(t('batch.currentList', { names: '账号乙' }))).not.toBeNull()
    expect(screen.getByText(t('batch.concurrency', { count: 3 }))).not.toBeNull()
    expect(screen.getByText(t('batch.counts', { completed: 1, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('account.collectAllRunning') })).not.toBeNull()
    // 批量运行中账号的卡片显示采集中状态点。
    const cardB = screen.getByText('账号乙').closest('article')
    expect(within(cardB as HTMLElement).getByText(t('account.collecting'))).not.toBeNull()
    // 轮询到 finished：汇总显示，不再轮询；当前选中账号数据已刷新。
    finish = true
    await waitFor(() => expect(screen.getByText(t('batch.summaryLine', { completed: 2, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull(), { timeout: 3000 })
    await settle()
    // 恢复查询 + 首跳轮询（collecting）+ 终态轮询，此后停表。
    expect(batchCalls).toBe(3)
    expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(2)
  })

  it('批量探测阶段恢复：面板显示正在检查会话，采集全部入口进入运行态', async () => {
    await renderPage(baseHandlers({
      'collectAll.status': () => ({
        ...OK, ready: false, phase: 'probing', total: 1, currentAccountIndex: 0, currentAccountId: null,
        completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
        items: [{ accountId: 'finder-a', status: 'probing', reason: null }],
      }),
    }))
    expect(await screen.findByText(t('batch.progress.checking', { index: 1, total: 1 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('account.collectAllRunning') })).not.toBeNull()
    expect(screen.getByRole('button', { name: t('batch.cancel') })).not.toBeNull()
  })

  it('批量停止阶段恢复：面板仍在运行态且轮询继续', async () => {
    await renderPage(baseHandlers({
      'collectAll.status': () => ({
        ...OK, ready: false, phase: 'stopping', total: 1, currentAccountIndex: 0, currentAccountId: 'finder-a',
        runningAccountIds: ['finder-a'], concurrency: 3, error: null,
        completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
        items: [{ accountId: 'finder-a', status: 'running', reason: null }],
      }),
    }))
    expect(await screen.findByText(t('batch.progress.concurrent', { done: 0, total: 1 }))).not.toBeNull()
    expect(screen.getByText(t('batch.currentList', { names: '演示账号' }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('batch.cancel') })).not.toBeNull()
  })

  it('批量已结束恢复：只显示汇总，不再轮询', async () => {
    let batchCalls = 0
    await renderPage(baseHandlers({
      'collectAll.status': () => {
        batchCalls += 1
        return {
          ...OK, ready: true, phase: 'finished', total: 2, currentAccountIndex: 2, currentAccountId: null,
          completedCount: 1, partialCount: 1, failedCount: 0, skippedCount: 0,
          items: [
            { accountId: 'finder-a', status: 'completed', reason: null },
            { accountId: 'finder-b', status: 'partial', reason: 'partial' },
          ],
        }
      },
    }))
    expect(await screen.findByText(t('batch.summaryLine', { completed: 1, partial: 1, failed: 0, skipped: 0 }))).not.toBeNull()
    expect(screen.getByText(`${t('collect.reason.partial')}（partial）`)).not.toBeNull()
    expect(screen.queryByRole('button', { name: t('batch.cancel') })).toBeNull()
    await settle()
    expect(batchCalls).toBe(1)
  })

  it('批量未启动恢复（ready）：不显示批量面板', async () => {
    let batchCalls = 0
    await renderPage(baseHandlers({
      'collectAll.status': () => {
        batchCalls += 1
        return { ...OK, ready: true, phase: 'ready', total: 0, currentAccountIndex: -1, currentAccountId: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] }
      },
    }))
    await settle()
    expect(batchCalls).toBe(1)
    expect(screen.queryByText(t('batch.summaryLine', { completed: 0, partial: 0, failed: 0, skipped: 0 }))).toBeNull()
    expect(screen.queryByRole('button', { name: t('batch.cancel') })).toBeNull()
  })

  it('恢复响应迟到：用户已发起采集时恢复结果丢弃', async () => {
    let statusCalls = 0
    let resolveRestore: ((payload: Payload) => void) | undefined
    await renderPage(baseHandlers({
      'collect.status': () => {
        statusCalls += 1
        // 首跳为挂载恢复查询（挂起），点击发起后的轮询立即终态。
        if (statusCalls === 1) return new Promise<Payload>(resolve => { resolveRestore = resolve })
        return { ...OK, busy: false, collect: null, lastRun: null }
      },
      'collect.start': () => ({ ...OK, started: true, runId: 'run-1' }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    // 用户采集的轮询已收敛（busy:false 终态），页面回到空闲。
    await waitFor(() => expect(statusCalls).toBe(2))
    await waitFor(() => expect(screen.queryByText(t('works.collecting'))).toBeNull())
    expect(screen.getByRole('button', { name: t('works.collect') }).hasAttribute('disabled')).toBe(false)
    // 迟到的恢复响应（busy:true）不得覆盖用户操作后的状态，也不得重启轮询。
    resolveRestore?.({
      ...OK,
      busy: true,
      collect: { accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z', finishedAt: null, error: null, progress: null, result: null },
      lastRun: null,
    })
    await settle()
    expect(screen.queryByText(t('works.collecting'))).toBeNull()
    expect(statusCalls).toBe(2)
  })

  it('D7 其他账号在采：对应账号卡片显示采集中，选中账号面板不显示其进度', async () => {
    const runningB = {
      accountId: 'finder-b', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'details', done: 3, total: 8 }, result: null,
    }
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
      'collect.running': () => ({ ...OK, collect: runningB, batchRunning: false }),
      'collect.status': () => ({
        ...OK,
        busy: true,
        collect: null,
        runningAccountIds: ['finder-b'],
        lastRun: null,
      }),
    }))
    // 账号乙卡片显示采集中状态点；账号甲卡片没有。
    const cardB = screen.getByText('账号乙').closest('article')
    const cardA = screen.getByText('演示账号').closest('article')
    expect(within(cardB as HTMLElement).getByText(t('account.collecting'))).not.toBeNull()
    expect(within(cardA as HTMLElement).queryByText(t('account.collecting'))).toBeNull()
    // 选中账号（甲）的面板不显示乙的进度；宿主互斥（任一账号运行中）使采集按钮禁用。
    expect(screen.queryByText(t('collect.progress.details', { done: 3, total: 8 }))).toBeNull()
    expect(screen.getByRole('button', { name: t('works.collect') }).hasAttribute('disabled')).toBe(true)
    // 状态点不改变点击与选中：点乙卡片仍正常切换选中。
    fireEvent.click(screen.getByText('账号乙').closest('button') as HTMLButtonElement)
    expect(cardB?.getAttribute('aria-current')).toBe('true')
  })
})

describe('批量运行中的选中驱动轮询（R4：运行中账号的作品面板实时进度）', () => {
  /** 等待宏任务队列清空（负断言「不再有新查询」的前置）。 */
  const settle = (ms = 25): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

  it('D8 批量运行中切换选中到运行中账号：发起该账号的 collect.status 查询并进入轮询，作品面板显示其进度', async () => {
    const runningIds = ['finder-a', 'finder-b', 'finder-c']
    const runningA = {
      accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'details', done: 3, total: 8 }, result: null,
    }
    const { calls } = await renderPage(baseHandlers({
      // 账号丁排首位：默认选中丁（批量未取到的账号）。
      'accounts.list': () => ({ ...OK, accounts: [
        { ...ACCOUNT, accountId: 'finder-d', nickname: '账号丁' },
        ACCOUNT,
        { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' },
        { ...ACCOUNT, accountId: 'finder-c', nickname: '账号丙' },
        { ...ACCOUNT, accountId: 'finder-e', nickname: '账号戊' },
      ], remoteOk: true }),
      'collect.status': args => {
        // 恢复查询（账号丁）与切走的账号无运行记录；账号甲返回运行中记录。
        if (String(args.accountId ?? '') !== 'finder-a') {
          return { ...OK, busy: true, collect: null, runningAccountIds: runningIds, lastRun: null }
        }
        return { ...OK, busy: true, collect: runningA, runningAccountIds: runningIds, lastRun: null }
      },
      'collectAll.status': () => ({
        ...OK, ready: false, phase: 'collecting', total: 5, currentAccountIndex: 3, currentAccountId: 'finder-a',
        runningAccountIds: runningIds, concurrency: 3, error: null,
        completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
        items: runningIds.map(id => ({ accountId: id, status: 'running', reason: null })),
      }),
    }))
    // 批量恢复为 collecting：面板显示运行中账号；选中账号丁未在采，无进度。
    expect(await screen.findByText(t('batch.currentList', { names: '演示账号、账号乙、账号丙' }))).not.toBeNull()
    expect(screen.queryByText(t('collect.progress.details', { done: 3, total: 8 }))).toBeNull()
    // 点选运行中的账号甲：另起一路按账号轮询，面板出现甲的进度。
    const aStatusCalls = (): number => calls.filter(call => call.action === 'collect.status' && call.args.accountId === 'finder-a').length
    fireEvent.click(screen.getByText('演示账号').closest('button') as HTMLButtonElement)
    expect(await screen.findByText(t('collect.progress.details', { done: 3, total: 8 }))).not.toBeNull()
    expect(aStatusCalls()).toBeGreaterThanOrEqual(1)
    await waitFor(() => expect(aStatusCalls()).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    // 切到未开始的账号戊：停表；一个轮询周期后不再有甲的查询，戊不显示进度。
    fireEvent.click(screen.getByText('账号戊').closest('button') as HTMLButtonElement)
    const countAtSwitch = aStatusCalls()
    await settle(1500)
    expect(aStatusCalls()).toBe(countAtSwitch)
    expect(screen.queryByText(t('collect.progress.details', { done: 3, total: 8 }))).toBeNull()
    // 点回账号甲：查询恢复。
    fireEvent.click(screen.getByText('演示账号').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(aStatusCalls()).toBeGreaterThan(countAtSwitch), { timeout: 3000 })
    expect(await screen.findByText(t('collect.progress.details', { done: 3, total: 8 }))).not.toBeNull()
  })

  it('D9 切换选中不影响发起/恢复账号的终态提示：失败 toast 恰好一次、数据刷新一次', async () => {
    // 页面卸载期间批量取了甲乙两个账号：挂载恢复选中甲（发起/恢复路轮询甲），
    // 切换选中到乙（选中驱动路）后甲落终态，甲的 toast 与刷新仍恰好各一次。
    let aFailed = false
    const runningA = {
      accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'probing' }, result: null,
    }
    const failedA = {
      accountId: 'finder-a', status: 'failed', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: '2026-11-18T10:05:00.000Z', error: 'WX_SESSION_INVALID', progress: { phase: 'probing' }, result: null,
    }
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
      'collect.running': () => ({ ...OK, collect: runningA, batchRunning: true }),
      'collect.status': args => {
        if (String(args.accountId ?? '') === 'finder-b') {
          return {
            ...OK, busy: true,
            collect: { accountId: 'finder-b', status: 'running', startedAt: '2026-11-18T10:00:00.000Z', finishedAt: null, error: null, progress: { phase: 'details', done: 1, total: 4 }, result: null },
            runningAccountIds: ['finder-a', 'finder-b'],
            lastRun: null,
          }
        }
        return {
          ...OK, busy: true,
          collect: aFailed ? failedA : runningA,
          runningAccountIds: aFailed ? ['finder-b'] : ['finder-a', 'finder-b'],
          lastRun: null,
        }
      },
      'collectAll.status': () => ({
        ...OK, ready: false, phase: 'collecting', total: 2, currentAccountIndex: 1, currentAccountId: 'finder-a',
        runningAccountIds: ['finder-a', 'finder-b'], concurrency: 3, error: null,
        completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
        items: [
          { accountId: 'finder-a', status: 'running', reason: null },
          { accountId: 'finder-b', status: 'running', reason: null },
        ],
      }),
    }))
    // 挂载恢复：甲的运行记录上屏（发起/恢复路轮询甲）。
    expect(await screen.findByText(t('collect.progress.probing'))).not.toBeNull()
    // 切到运行中的账号乙：乙进入选中驱动轮询并显示进度。
    fireEvent.click(screen.getByText('账号乙').closest('button') as HTMLButtonElement)
    expect(await screen.findByText(t('collect.progress.details', { done: 1, total: 4 }))).not.toBeNull()
    // 账号甲落终态 failed：toast 恰好一次，数据刷新恰好一次（恢复路不因切换选中停止）。
    aFailed = true
    const toastText = `${t('works.collectFailed')}：${t('error.WX_SESSION_INVALID')}（WX_SESSION_INVALID）`
    // 终态 toast 在下一个轮询周期（1.2s）才到达：显式放宽等待。
    expect(await screen.findByText(toastText, undefined, { timeout: 3000 })).not.toBeNull()
    await settle(1600)
    expect(screen.getAllByText(toastText).length).toBe(1)
    // 甲的刷新（works / 摘要）恰好各一次：挂载 1 次 + 终态 1 次，多轮轮询不叠加。
    expect(calls.filter(call => call.action === 'works.list' && call.args.accountId === 'finder-a').length).toBe(2)
    expect(calls.filter(call => call.action === 'account.overview' && call.args.accountId === 'finder-a').length).toBe(2)
  })

  it('D8c 页面发起的采集终态后，批量再采到同一账号：选中驱动路恢复起表显示进度', async () => {
    let phase: 'idle' | 'pageRunning' | 'terminal' | 'batchRunning' = 'idle'
    const runningA = {
      accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'details', done: 2, total: 5 }, result: null,
    }
    const doneA = {
      accountId: 'finder-a', status: 'completed', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: '2026-11-18T10:03:00.000Z', error: null, progress: {}, result: null,
    }
    const batchCollecting = {
      ...OK, ready: false, phase: 'collecting', total: 1, currentAccountIndex: 0, currentAccountId: 'finder-a',
      runningAccountIds: ['finder-a'], concurrency: 3, error: null,
      completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
      items: [{ accountId: 'finder-a', status: 'running', reason: null }],
    }
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT], remoteOk: true }),
      'collect.running': () => ({ ...OK, collect: null, batchRunning: false }),
      'collect.status': args => {
        if (String(args.accountId ?? '') !== 'finder-a') {
          return { ...OK, busy: false, collect: null, runningAccountIds: [], lastRun: null }
        }
        if (phase === 'pageRunning' || phase === 'batchRunning') {
          return { ...OK, busy: true, collect: runningA, runningAccountIds: ['finder-a'], lastRun: null }
        }
        if (phase === 'terminal') {
          return { ...OK, busy: false, collect: doneA, runningAccountIds: [], lastRun: null }
        }
        return { ...OK, busy: false, collect: null, runningAccountIds: [], lastRun: null }
      },
      'collect.start': () => ({ ...OK, started: true }),
      'collectAll.start': () => ({ ...OK, started: true, batchId: 'batch-1' }),
      'collectAll.status': () => phase === 'batchRunning'
        ? batchCollecting
        : { ...OK, ready: true, phase: 'finished', total: 0, currentAccountIndex: 0, currentAccountId: null, runningAccountIds: [], concurrency: 3, error: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] },
    }))
    void calls
    // 页面发起甲：发起路轮询，进度上屏（phase 先置，覆盖 start 回执后的首拍）。
    phase = 'pageRunning'
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    expect(await screen.findByText(t('collect.progress.details', { done: 2, total: 5 }))).not.toBeNull()
    // 甲落终态：发起路停表（machine pollers 随终态删除，选中让位随之解除）。
    phase = 'terminal'
    await waitFor(() => expect(screen.queryByText(t('collect.progress.details', { done: 2, total: 5 }))).toBeNull(), { timeout: 3000 })
    // 批量再采到甲：甲回到运行集合，选中驱动路另起一路显示进度。
    phase = 'batchRunning'
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    expect(await screen.findByText(t('batch.currentList', { names: '演示账号' }))).not.toBeNull()
    expect(await screen.findByText(t('collect.progress.details', { done: 2, total: 5 }))).not.toBeNull()
  })

  it('D8b 切换选中后到达的过期响应被丢弃：不停止新选中账号的轮询、不清它的进度', async () => {
    const runningIds = ['finder-a', 'finder-b']
    const runningA = {
      accountId: 'finder-a', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'details', done: 3, total: 8 }, result: null,
    }
    const runningB = {
      accountId: 'finder-b', status: 'running', startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null, error: null, progress: { phase: 'details', done: 1, total: 4 }, result: null,
    }
    // 账号甲的首次查询悬挂：用户切到乙之后才以「甲已完成」返回（过期响应）。
    const firstA = Promise.withResolvers<Payload>()
    let aCalls = 0
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [
        { ...ACCOUNT, accountId: 'finder-d', nickname: '账号丁' },
        ACCOUNT,
        { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' },
      ], remoteOk: true }),
      'collect.status': args => {
        const accountId = String(args.accountId ?? '')
        if (accountId === 'finder-a') {
          aCalls += 1
          return aCalls === 1
            ? firstA.promise
            : { ...OK, busy: true, collect: runningA, runningAccountIds: runningIds, lastRun: null }
        }
        if (accountId === 'finder-b') return { ...OK, busy: true, collect: runningB, runningAccountIds: runningIds, lastRun: null }
        return { ...OK, busy: true, collect: null, runningAccountIds: runningIds, lastRun: null }
      },
      'collectAll.status': () => ({
        ...OK, ready: false, phase: 'collecting', total: 2, currentAccountIndex: 1, currentAccountId: 'finder-a',
        runningAccountIds: runningIds, concurrency: 2, error: null,
        completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
        items: runningIds.map(id => ({ accountId: id, status: 'running', reason: null })),
      }),
    }))
    expect(await screen.findByText(t('batch.currentList', { names: '演示账号、账号乙' }))).not.toBeNull()
    // 点选运行中的账号甲：选中驱动路的首跳查询悬挂。
    fireEvent.click(screen.getByText('演示账号').closest('button') as HTMLButtonElement)
    await waitFor(() => expect(aCalls).toBe(1))
    // 切到另一个运行中的账号乙：选中路改目标，乙的进度上屏。
    fireEvent.click(screen.getByText('账号乙').closest('button') as HTMLButtonElement)
    expect(await screen.findByText(t('collect.progress.details', { done: 1, total: 4 }))).not.toBeNull()
    const bStatusCalls = (): number => calls.filter(call => call.action === 'collect.status' && call.args.accountId === 'finder-b').length
    const bBase = bStatusCalls()
    // 甲的过期响应此时到达：甲已终态。它不得停掉乙的轮询、不得清掉乙的进度。
    firstA.resolve({
      ...OK, busy: true, collect: { ...runningA, status: 'completed', finishedAt: '2026-11-18T10:05:00.000Z' },
      runningAccountIds: ['finder-b'], lastRun: null,
    })
    await settle(100)
    expect(screen.getByText(t('collect.progress.details', { done: 1, total: 4 }))).not.toBeNull()
    // 乙的轮询继续：下一个周期仍有乙的查询，进度持续上屏。
    await waitFor(() => expect(bStatusCalls()).toBeGreaterThan(bBase), { timeout: 3000 })
    expect(screen.getByText(t('collect.progress.details', { done: 1, total: 4 }))).not.toBeNull()
  })
})

describe('作品页（工具栏 / 摘要卡 / 高密度表格 / 详情 Modal）', () => {
  it('真实 schema 渲染：13 列表头、snake_case 字段、null 计数显示占位', async () => {
    const { calls } = await renderPage(baseHandlers())
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    // 表头 13 列：作品 / 发布时间 / 完播率 / 平均播放时长 / 播放 / 喜欢 / 收藏 /
    // 评论 / 分享 / 转发聊天和朋友圈 / 关注量 / 企微链接点击 / 添加通讯录。
    const table = screen.getByRole('table', { name: t('works.table.label') })
    expect(table.getAttribute('aria-label')).toBe(t('works.table.label'))
    const headers = within(table as HTMLElement).getAllByRole('columnheader')
    // 默认态：发布时间降序箭头，其余可排序列为 ↕，不可排序列无箭头。
    expect(headers.map(header => header.textContent)).toEqual([
      t('col.work'),
      `${t('col.publishTime')}↓`,
      `${t('col.completion')}↕`,
      `${t('col.avgDuration')}↕`,
      `${t('col.play')}↕`,
      `${t('col.like')}↕`,
      `${t('col.favorite')}↕`,
      `${t('col.comment')}↕`,
      `${t('col.share')}↕`,
      `${t('col.forward')}↕`,
      `${t('col.follow')}↕`,
      t('col.wecomClick'),
      t('col.contactAdd'),
    ])
    // 数值列：真实值与缺失占位（不补 0）。
    const firstRow = screen.getByText('第一条作品').closest('tr')
    expect(within(firstRow as HTMLElement).getByText('8.37%')).not.toBeNull()
    expect(within(firstRow as HTMLElement).getByText('6.95 s')).not.toBeNull()
    expect(within(firstRow as HTMLElement).getByText('5 / 4')).not.toBeNull()
    const secondRow = screen.getByText('第二条').closest('tr')
    expect(within(secondRow as HTMLElement).getAllByText('—').length).toBeGreaterThanOrEqual(8)
    // 封面列渲染 img（http s 源）；缺失封面行渲染占位文本。
    expect(firstRow?.querySelector('img')).not.toBeNull()
    const listCall = calls.find(call => call.action === 'works.list')
    // 默认查询：发布时间降序第 1 页，页大小固定 10。
    expect(listCall?.args).toMatchObject({ accountId: 'finder-a', sort: 'publish_time', order: 'desc', limit: 10, offset: 0 })
  })

  it('固定 4 张作品摘要卡；完播率 / 最近采集时间取自列表响应，无缺口作品卡', async () => {
    await renderPage(baseHandlers())
    expect(await screen.findByText(t('summary.worksTotal'))).not.toBeNull()
    for (const key of ['summary.worksTotal', 'summary.play7d', 'summary.follow7d', 'summary.completion'] as const) {
      expect(screen.getByText(t(key))).not.toBeNull()
    }
    // 数量契约：摘要卡固定 4 张（缺口作品卡已删）。
    const summaryGrid = screen.getByText(t('summary.worksTotal')).closest('div')
    expect(summaryGrid?.children.length).toBe(4)
    // 口径：作品总数取账号 feedCount（12），近7日取固定 last_7d 摘要（1234）。
    expect(screen.getByText('12')).not.toBeNull()
    await screen.findByText('1234')
    // 完播率取列表响应的 completion_rate_pct（41.2），不基于当页行计算
    // （当页行 w-100 是 8.37%）：限定摘要卡作用域断言。
    const summaryCard = screen.getByText(t('summary.completion')).closest('section')
    expect(within(summaryCard as HTMLElement).getByText('41.20%')).not.toBeNull()
    // 工具栏最近采集时间取列表响应的 latest_collected_at（不基于当页行取最大值）。
    expect(screen.getByText(t('works.latestCollectedAt', { time: '2026-11-19 00:04' }))).not.toBeNull()
  })

  it('表头排序三态循环改为服务端排序：点击即发新查询并回第 1 页', async () => {
    const { calls } = await renderPage(baseHandlers())
    await screen.findByText('第一条作品')
    const lastWorksArgs = (): Payload => {
      const last = [...calls].reverse().find(call => call.action === 'works.list')
      return last?.args ?? {}
    }
    const rows = (): NodeListOf<HTMLElement> =>
      screen.getByRole('table', { name: t('works.table.label') }).querySelectorAll('tbody tr')
    // 初始默认态：发布时间降序。
    expect(rows()[0]?.textContent).toContain('第一条作品')
    // 新列 → desc：发起播放降序查询，回第 1 页；aria-sort 在 th 上。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.default') }) }))
    await waitFor(() => expect(lastWorksArgs()).toMatchObject({ sort: 'play_count', order: 'desc', limit: 10, offset: 0 }))
    expect(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.desc') }) }).closest('th')?.getAttribute('aria-sort')).toBe('descending')
    // 同列 → asc：再次发起新查询，仍是第 1 页。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.desc') }) }))
    await waitFor(() => expect(lastWorksArgs()).toMatchObject({ sort: 'play_count', order: 'asc', offset: 0 }))
    expect(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.asc') }) }).closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    // 再点 → 回默认态（发布时间降序）。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.asc') }) }))
    await waitFor(() => expect(lastWorksArgs()).toMatchObject({ sort: 'publish_time', order: 'desc', offset: 0 }))
    // 三次排序查询全部落在第 1 页（offset 均为 0）。
    const sortCalls = calls.filter(call => call.action === 'works.list').slice(1)
    expect(sortCalls.length).toBe(3)
    for (const call of sortCalls) expect(call.args['offset']).toBe(0)
  })

  it('翻页只变 offset，排序不变；请求在途保留当前行并标记 aria-busy', async () => {
    const pagePayload = (offset: number): Payload => ({
      ...OK,
      total: 23,
      gap_count: 1,
      latest_collected_at: '2026-11-18T16:04:00.000Z',
      completion_rate_pct: 41.2,
      works: [offset === 0
        ? { work_id: 'w-100', title: '第一条作品', play_count: 1000, like_count: 50, publish_time: '2026-11-17T08:00:00.000Z', data_gap: null }
        : { work_id: `w-p${offset}`, title: `第 ${offset / 10 + 1} 页作品`, play_count: 5, like_count: 1, publish_time: null, data_gap: null }],
    })
    let resolvePage3: ((payload: Payload) => void) | undefined
    const { calls } = await renderPage(baseHandlers({
      // 第 3 页（offset 20）挂起，用于断言在途状态。
      'works.list': args => {
        const offset = Number(args.offset ?? 0)
        if (offset === 20) return new Promise<Payload>(resolve => { resolvePage3 = resolve })
        return pagePayload(offset)
      },
    }))
    await screen.findByText('第一条作品')
    const pager = screen.getByRole('navigation', { name: kitT('pager.label') })
    expect(within(pager as HTMLElement).getByText(kitT('pager.info', { total: 23, page: 1, pages: 3 }))).not.toBeNull()
    // 下一页：只变 offset，sort / order / limit 不变。
    fireEvent.click(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }))
    expect(await screen.findByText('第 2 页作品')).not.toBeNull()
    expect([...calls].reverse().find(call => call.action === 'works.list')?.args).toMatchObject({ accountId: 'finder-a', sort: 'publish_time', order: 'desc', limit: 10, offset: 10 })
    expect(within(pager as HTMLElement).getByText(kitT('pager.info', { total: 23, page: 2, pages: 3 }))).not.toBeNull()
    // 再下一页（挂起）：旧行保留、表格 aria-busy、Pager 两枚按钮禁用。
    fireEvent.click(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }))
    await waitFor(() => expect(screen.getByRole('table', { name: t('works.table.label') }).getAttribute('aria-busy')).toBe('true'))
    expect(screen.getByText('第 2 页作品')).not.toBeNull()
    expect(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.prev') }).hasAttribute('disabled')).toBe(true)
    expect(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }).hasAttribute('disabled')).toBe(true)
    // 第 3 页到达：整体替换，末页「下一页」禁用。
    resolvePage3?.(pagePayload(20))
    expect(await screen.findByText('第 3 页作品')).not.toBeNull()
    await waitFor(() => expect(screen.getByRole('table', { name: t('works.table.label') }).getAttribute('aria-busy')).toBeNull())
    expect(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }).hasAttribute('disabled')).toBe(true)
    expect(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.prev') }).hasAttribute('disabled')).toBe(false)
    // 上一页回到第 2 页：仍只变 offset（命中缓存的页也只重发同参数）。
    fireEvent.click(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.prev') }))
    expect(await screen.findByText('第 2 页作品')).not.toBeNull()
    expect([...calls].reverse().find(call => call.action === 'works.list')?.args).toMatchObject({ sort: 'publish_time', order: 'desc', limit: 10, offset: 10 })
  })

  it('过期响应丢弃：翻页请求在途时换排序，旧页迟到响应不覆盖新查询结果', async () => {
    let resolvePage2: ((payload: Payload) => void) | undefined
    await renderPage(baseHandlers({
      'works.list': args => {
        if (Number(args.offset) === 10) return new Promise<Payload>(resolve => { resolvePage2 = resolve })
        return {
          ...OK, total: 23, gap_count: 1, latest_collected_at: null, completion_rate_pct: null,
          works: [{ work_id: 'w-sorted', title: '排序后的行', play_count: 9, like_count: 1, publish_time: null, data_gap: null }],
        }
      },
    }))
    await screen.findByText('排序后的行')
    const pager = screen.getByRole('navigation', { name: kitT('pager.label') })
    // 翻到第 2 页（挂起），随后点播放表头发起排序查询（立即返回并回第 1 页）。
    fireEvent.click(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }))
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.default') }) }))
    expect(await screen.findByText('排序后的行')).not.toBeNull()
    // 第 2 页的旧响应此刻才到：序号与查询键均已失守，整体丢弃。
    resolvePage2?.({
      ...OK, total: 23, gap_count: 1, latest_collected_at: null, completion_rate_pct: null,
      works: [{ work_id: 'w-stale', title: '过期页数据', play_count: 1, like_count: 1, publish_time: null, data_gap: null }],
    })
    await waitFor(() => expect(screen.queryByText('过期页数据')).toBeNull())
    expect(screen.getByText('排序后的行')).not.toBeNull()
  })

  it('采集完成刷新当前页：翻页后 offset 保持，不回到第 1 页', async () => {
    const pagePayload = (offset: number): Payload => ({
      ...OK, total: 23, gap_count: 1, latest_collected_at: null, completion_rate_pct: null,
      works: [offset === 0
        ? { work_id: 'w-100', title: '第一条作品', play_count: 1000, like_count: 50, publish_time: '2026-11-17T08:00:00.000Z', data_gap: null }
        : { work_id: 'w-p2', title: '第 2 页作品', play_count: 5, like_count: 1, publish_time: null, data_gap: null }],
    })
    const { calls } = await renderPage(baseHandlers({
      'works.list': args => pagePayload(Number(args.offset ?? 0)),
      'collect.start': () => ({ ...OK, started: true, runId: 'run-1' }),
      'collect.status': () => ({
        ...OK, busy: false,
        collect: {
          accountId: 'finder-a', attemptId: 'finder-a-1', status: 'completed',
          startedAt: '2026-11-18T10:00:00.000Z', finishedAt: '2026-11-18T10:05:00.000Z',
          error: null, progress: null, result: null,
        },
        lastRun: null,
      }),
    }))
    await screen.findByText('第一条作品')
    const pager = screen.getByRole('navigation', { name: kitT('pager.label') })
    fireEvent.click(within(pager as HTMLElement).getByRole('button', { name: kitT('pager.next') }))
    expect(await screen.findByText('第 2 页作品')).not.toBeNull()
    // 采集终态后重拉当前页：offset 仍是 10。
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    await waitFor(() => {
      const pageCalls = calls.filter(call => call.action === 'works.list')
      expect(pageCalls.length).toBeGreaterThanOrEqual(3)
      expect(pageCalls.at(-1)?.args).toMatchObject({ accountId: 'finder-a', sort: 'publish_time', order: 'desc', limit: 10, offset: 10 })
    })
    expect(screen.getByText('第 2 页作品')).not.toBeNull()
  })

  it('鼠标双击作品行打开详情 Modal：完整四段（基础信息 / 核心指标 / 来源+留存 / 按日趋势 / 缺口）', async () => {
    // 按日趋势窗口是「相对系统时间」的最近 7 个上海语义日：固定系统时间，
    // 使夹具发布日 2026-11-15 / 2026-11-17 恒在窗口内（否则真实时间漂移会把整窗推成断线）。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-23T12:00:00+08:00'))
    onTestFinished(() => { vi.useRealTimers() })
    const { calls } = await renderPage(baseHandlers({
      'work.get': args => workGetPayload(String(args.workId)),
      'work.trend': args => ({
        ...OK,
        account_id: 'finder-a',
        work_id: args.workId,
        snapshots: [{ day: '2026-11-16', daily_play_count: 120, daily_like_count: 6 }],
      }),
    }))
    await screen.findByText('第一条作品')
    const row = screen.getByText('第一条作品').closest('tr')
    // 行契约：tabIndex=0 + aria-label 说明双击或 Enter 查看详情。
    expect(row?.getAttribute('tabindex')).toBe('0')
    expect(row?.getAttribute('aria-label')).toBe(t('row.detailAria', { title: '第一条作品' }))
    fireEvent.doubleClick(row as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '第一条作品' })
    expect(within(dialog as HTMLElement).getByText(t('detail.workId', { id: 'w-100' }))).not.toBeNull()
    expect(within(dialog as HTMLElement).getByText(t('detail.publishTime', { time: '2026-11-17 16:00' }))).not.toBeNull()
    expect(within(dialog as HTMLElement).getByText(t('detail.latestCollected', { time: '2026-11-19 00:04' }))).not.toBeNull()
    // 核心指标 13 卡（指标名与图例同名时以多命中计数）。
    for (const key of ['col.completion', 'col.avgDuration', 'col.play', 'col.like', 'col.favorite', 'col.comment', 'col.share', 'col.forward', 'col.follow', 'detail.metric.wecomClickCount', 'detail.metric.wecomClickUv', 'detail.metric.contactAddCount', 'detail.metric.contactAddUv'] as const) {
      expect(within(dialog as HTMLElement).getAllByText(t(key)).length).toBeGreaterThanOrEqual(1)
    }
    // 来源分布：排除 999「全部」、按数值降序、缺失保留占位。
    const trafficSection = within(dialog as HTMLElement).getByRole('region', { name: t('detail.traffic') })
    const trafficRows = within(trafficSection as HTMLElement).getAllByRole('listitem')
    expect(trafficRows[0]?.textContent).toContain('推荐')
    expect(trafficRows.at(-1)?.textContent).toContain('分享')
    expect(trafficRows.at(-1)?.textContent).toContain('—')
    // 留存：rate_pct / ratePct 双键兼容，整数百分比。
    const retentionSection = within(dialog as HTMLElement).getByRole('region', { name: t('detail.retention') })
    expect(within(retentionSection as HTMLElement).getByText('100%')).not.toBeNull()
    expect(within(retentionSection as HTMLElement).getByText('22%')).not.toBeNull()
    expect(within(retentionSection as HTMLElement).getByText('14%')).not.toBeNull()
    // 按日数据近 7 天：七系列图例 + 日期点（发布日前补 0 由纯函数测试覆盖）。
    const dailySection = within(dialog as HTMLElement).getByRole('region', { name: t('detail.daily') })
    expect(within(dailySection as HTMLElement).getByText(t('col.forward'))).not.toBeNull()
    // 缺口：核心缺口徽标 + 稳定 reason。
    const gapSection = within(dialog as HTMLElement).getByRole('region', { name: t('detail.gaps') })
    expect(within(gapSection as HTMLElement).getByText(`${t('gap.traffic_source')} · ${t('gap.reason.not_exposed')}`)).not.toBeNull()
    expect(calls.find(call => call.action === 'work.get')?.args).toMatchObject({ accountId: 'finder-a', workId: 'w-100' })
    expect(calls.find(call => call.action === 'work.trend')?.args).toMatchObject({ accountId: 'finder-a', workId: 'w-100' })
  })

  it('行内 Enter 打开同一详情（键盘等价路径）；Escape 关闭后焦点回到触发行', async () => {
    await renderPage(baseHandlers({
      'work.get': args => workGetPayload(String(args.workId)),
      'work.trend': () => ({ ...OK, account_id: 'finder-a', work_id: 'w-100', snapshots: [] }),
    }))
    await screen.findByText('第一条作品')
    const row = screen.getByText('第一条作品').closest('tr') as HTMLElement
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: '第一条作品' })).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog', { name: '第一条作品' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '第一条作品' })).toBeNull())
    expect(document.activeElement).toBe(row)
  })

  it('work.get 无 {work} 包装的载荷：保留行数据渲染（旧客户端兜底语义），区块按空态呈现', async () => {
    await renderPage(baseHandlers({
      'work.get': () => ({ ...OK, work_id: 'w-flat', title: '平铺残片', play_count: 1, like_count: 1, publish_time: null }),
      'work.trend': () => ({ ...OK, account_id: 'finder-a', work_id: 'w-100', snapshots: [] }),
    }))
    await screen.findByText('第一条作品')
    fireEvent.doubleClick(screen.getByText('第一条作品').closest('tr') as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: '第一条作品' })
    // 到达但无有效 work：标题与核心指标兜底为列表行数据，不渲染平铺残片。
    expect(within(dialog as HTMLElement).getByText(t('detail.workId', { id: 'w-100' }))).not.toBeNull()
    expect(within(dialog as HTMLElement).queryByText('平铺残片')).toBeNull()
    // 来源 / 留存区块到达但无数据 → 空态文案，不是加载中。
    expect(within(dialog as HTMLElement).getByText(t('detail.trafficEmpty'))).not.toBeNull()
    expect(within(dialog as HTMLElement).getByText(t('detail.retentionEmpty'))).not.toBeNull()
  })

  it('详情查询失败保留行数据乐观展示，分区呈现失败态并可重试', async () => {
    let failNext = true
    await renderPage(baseHandlers({
      'work.get': () => {
        if (failNext) throw new Error('WX_TOOL_UNAVAILABLE')
        return workGetPayload('w-100')
      },
      'work.trend': () => ({ ...OK, account_id: 'finder-a', work_id: 'w-100', snapshots: [] }),
    }))
    await screen.findByText('第一条作品')
    fireEvent.doubleClick(screen.getByText('第一条作品').closest('tr') as HTMLElement)
    // 失败：行数据保留（乐观展示，不整页报错），补充分区呈现失败 + 重试。
    const dialog = await screen.findByRole('dialog', { name: '第一条作品' })
    await waitFor(() => expect(within(dialog as HTMLElement).getAllByText('Failed to load').length).toBeGreaterThanOrEqual(1))
    expect(within(dialog as HTMLElement).getByText(t('detail.workId', { id: 'w-100' }))).not.toBeNull()
    failNext = false
    fireEvent.click(within(dialog as HTMLElement).getAllByRole('button', { name: t('state.retry') })[0] as HTMLElement)
    await waitFor(() => expect(within(dialog as HTMLElement).queryByText('Failed to load')).toBeNull())
    expect(within(dialog as HTMLElement).getByText(t('detail.workId', { id: 'w-100' }))).not.toBeNull()
  })

  it('详情乐观打开：work.get 在途时行数据立即上屏，到达后补充分区替换', async () => {    let resolveGet: ((payload: Payload) => void) | undefined
    await renderPage(baseHandlers({
      'work.get': () => new Promise<Payload>(resolve => { resolveGet = resolve }),
      'work.trend': () => new Promise<Payload>(() => undefined),
    }))
    await screen.findByText('第一条作品')
    fireEvent.doubleClick(screen.getByText('第一条作品').closest('tr') as HTMLElement)
    // 在途即渲染：标题、ID 与核心指标来自列表行数据，无整页骨架等待。
    const dialog = await screen.findByRole('dialog', { name: '第一条作品' })
    expect(within(dialog as HTMLElement).getByText(t('detail.workId', { id: 'w-100' }))).not.toBeNull()
    expect(within(dialog as HTMLElement).getByText('8.37%')).not.toBeNull()
    // 补充分区呈现在途态（srOnly 加载文案）；来源数据到达后替换为完整内容。
    expect(within(dialog as HTMLElement).getAllByText('Loading…').length).toBeGreaterThanOrEqual(1)
    resolveGet?.(workGetPayload('w-100'))
    await waitFor(() => expect(within(dialog as HTMLElement).getByText('推荐')).not.toBeNull())
    expect(within(dialog as HTMLElement).queryByText('Loading…')).toBeNull()
  })

  it('快速换行 A→B：行 A 的按日趋势不得串进行 B 的弹层', async () => {
    await renderPage(baseHandlers({
      'work.get': args => {
        // 行 A 详情慢（挂起）；行 B 详情先到且无按日数据 → 走 trend 兜底路径。
        if (String(args.workId) === 'w-100') {
          return new Promise<Payload>(() => undefined)
        }
        return {
          ...OK,
          work: { work_id: 'w-101', title: '第二条', play_count: 5, like_count: 1, publish_time: null, data_gap: null },
          traffic_source: { rows: [] },
          retention_trend: { points: [] },
          daily_metrics: [],
        }
      },
      'work.trend': args => {
        // 行 A 的趋势已返回（会被记入兜底数据）；行 B 的趋势挂起不干扰断言。
        if (String(args.workId) === 'w-100') {
          return { ...OK, account_id: 'finder-a', work_id: 'w-100', snapshots: [{ day: '2026-11-16', daily_play_count: 777, daily_like_count: 1 }] }
        }
        return new Promise<Payload>(() => undefined)
      },
    }))
    await screen.findByText('第一条作品')
    // 双击 A：详情挂起，但 trend(A) 已把 A 的曲线写入兜底数据。
    fireEvent.doubleClick(screen.getByText('第一条作品').closest('tr') as HTMLElement)
    await waitFor(() => expect(screen.getByRole('dialog', { name: '第一条作品' })).not.toBeNull())
    // 快速换行到 B：兜底趋势必须换行清空，B（无按日数据）呈现空态而非 A 的曲线。
    fireEvent.doubleClick(screen.getByText('第二条').closest('tr') as HTMLElement)
    const dialogB = await screen.findByRole('dialog', { name: '第二条' })
    expect(within(dialogB as HTMLElement).getByText(t('detail.dailyEmpty'))).not.toBeNull()
    expect(within(dialogB as HTMLElement).queryByRole('img')).toBeNull()
  })

  it('works 刷新失败保留已加载数据（不再清空），卡片与列表区域都不出现「部分数据」提示条', async () => {
    let failNext = false
    const { calls } = await renderPage(baseHandlers({
      'works.list': () => {
        if (failNext) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, ...WORKS }
      },
    }))
    await screen.findByText('第一条作品')
    // 刷新按钮触发一次会失败的刷新。
    failNext = true
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    // partial：已加载行保留；失败提示不在卡片和列表区域重复出现。
    await waitFor(() => expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('第一条作品')).not.toBeNull()
    expect(screen.queryByText(kitEn['state.partial'])).toBeNull()
    expect(screen.queryByText(kitEn['state.error'])).toBeNull()
    // 再次刷新成功。
    failNext = false
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    await waitFor(() => expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(3))
    expect(screen.getByText('第一条作品')).not.toBeNull()
  })

  it('空列表：表格区域保留并在正中显示「暂无数据」（en：No data），不渲染 Pager', async () => {
    await renderPage(baseHandlers({
      'works.list': () => ({ ...OK, ...WORKS, works: [], total: 0, gap_count: 0 }),
    }))
    const region = screen.getByRole('region', { name: t('works.table.scrollLabel') })
    await waitFor(() => expect(within(region).getByText(kitEn['state.empty'])).not.toBeNull())
    expect(region.getAttribute('data-state')).toBe('blank')
    expect(screen.queryByRole('button', { name: kitEn['pager.next'] })).toBeNull()
    expect(screen.queryByRole('button', { name: kitEn['pager.prev'] })).toBeNull()
  })

  it('stale-write 守卫：切 tab 后旧账号响应不覆盖新账号数据', async () => {
    let resolveSlow: ((payload: Payload) => void) | undefined
    const otherAccount = { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, otherAccount], remoteOk: true }),
      'works.list': args => {
        if (args.accountId === 'finder-b') {
          return new Promise<Payload>(resolve => { resolveSlow = resolve })
        }
        return { ...OK, works: [{ work_id: 'w-a', title: '账号甲作品', play_count: 1, like_count: 1, publish_time: null }] }
      },
    }))
    expect(await screen.findByText('账号甲作品')).not.toBeNull()
    // 卡片主体按钮的可访问名是整卡文本：经文本节点定位再取按钮。
    const cardButton = (name: string): HTMLButtonElement | null =>
      screen.getByText(name).closest('button') as HTMLButtonElement | null
    // 切到账号乙（works 挂起），再切回账号甲（立即返回）。
    fireEvent.click(cardButton('账号乙') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('演示账号')).not.toBeNull())
    fireEvent.click(cardButton('演示账号') as HTMLButtonElement)
    await waitFor(() => expect(screen.getByText('账号甲作品')).not.toBeNull())
    // 账号乙的旧响应现在才返回：不得覆盖账号甲的数据。
    resolveSlow?.({ ...OK, works: [{ work_id: 'w-stale', title: '过期数据', play_count: 1, like_count: 1, publish_time: null }] })
    await waitFor(() => {
      expect(screen.queryByText('过期数据')).toBeNull()
      expect(screen.getByText('账号甲作品')).not.toBeNull()
    })
  })

  it('切回已看过的账号：缓存即时渲染，无需等待新的远端往返', async () => {
    let resolveB: ((payload: Payload) => void) | undefined
    const otherAccount = { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, otherAccount], remoteOk: true }),
      'works.list': args => {
        if (args.accountId === 'finder-b') {
          return new Promise<Payload>(resolve => { resolveB = resolve })
        }
        return { ...OK, ...WORKS }
      },
    }))
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    const cardButton = (name: string): HTMLButtonElement | null =>
      screen.getByText(name).closest('button') as HTMLButtonElement | null
    // 切到账号乙：无缓存 → 清空进 loading，甲的行不再展示。
    fireEvent.click(cardButton('账号乙') as HTMLButtonElement)
    await waitFor(() => expect(screen.queryByText('第一条作品')).toBeNull())
    // 切回账号甲：缓存即时渲染上次真实响应（乙仍挂起、无任何新 works 响应）。
    fireEvent.click(cardButton('演示账号') as HTMLButtonElement)
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    // 迟到的乙响应不得覆盖甲（代次 + 账号双守卫）。
    resolveB?.({ ...OK, works: [{ work_id: 'w-stale', title: '过期数据', play_count: 1, like_count: 1, publish_time: null }] })
    await waitFor(() => {
      expect(screen.queryByText('过期数据')).toBeNull()
      expect(screen.getByText('第一条作品')).not.toBeNull()
    })
  })

  it('同账号手动刷新：摘要卡进入 refreshing 淡化，数据更新后恢复', async () => {
    let overviewCalls = 0
    let resolveSlow: ((payload: Payload) => void) | undefined
    await renderPage(baseHandlers({
      'account.overview': () => {
        overviewCalls += 1
        if (overviewCalls === 1) {
          return { ...OK, metrics: { totals: { daily_play_count: 1234 } }, fans_trend: { totals: {} }, availability: { account_metrics: 'ok', fans_trend: 'ok', fans_profile: 'no_data' } }
        }
        return new Promise<Payload>(resolve => { resolveSlow = resolve })
      },
    }))
    await screen.findByText('1234')
    // 同账号刷新：摘要卡容器带 data-refreshing（保留已渲染值，不整块换骨架）。
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    await waitFor(() => {
      const grid = screen.getByText(t('summary.play7d')).closest('div')
      expect(grid?.getAttribute('data-refreshing')).toBe('true')
    })
    // 刷新响应到达：新值替换 + 淡化解除。
    resolveSlow?.({ ...OK, metrics: { totals: { daily_play_count: 4321 } }, fans_trend: { totals: {} }, availability: { account_metrics: 'ok', fans_trend: 'ok', fans_profile: 'no_data' } })
    await waitFor(() => {
      expect(screen.getByText('4321')).not.toBeNull()
      const grid = screen.getByText(t('summary.play7d')).closest('div')
      expect(grid?.getAttribute('data-refreshing')).toBeNull()
    })
  })
})

describe('账号总览页（多账号汇总：筛选器 / 10 卡 / 账号表现表 / 趋势 / 画像）', () => {
  /** 画像五维 fixture（单账号模式消费）：省市给 7 行验证 Top 5 截断。 */
  const PROFILE = {
    day: '2026-11-17',
    gender: [
      { key: '1', label: null, count: 70 },
      { key: '2', label: null, count: 30 },
    ],
    device: [
      { key: '1', label: null, count: 36 },
      { key: '2', label: null, count: 60 },
      { key: 'unknow', label: null, count: 4 },
    ],
    age: [
      { key: 'fage_01_17', label: null, count: 10 },
      { key: 'fage_18_24', label: null, count: 20 },
      { key: 'fage_50_+', label: null, count: 5 },
    ],
    province: [
      { key: 'gd', label: '广东', count: 30 },
      { key: 'js', label: '江苏', count: 22 },
      { key: 'zj', label: '浙江', count: 18 },
      { key: 'sd', label: '山东', count: 12 },
      { key: 'sc', label: '四川', count: 9 },
      { key: 'fj', label: '福建', count: 17 },
      { key: 'hn', label: '河南', count: 12 },
    ],
    city: [{ key: 'sz', label: '深圳', count: 20 }],
  }

  const ROW_A = {
    account_id: 'finder-a', nickname: '演示账号', avatar: null, session_status: 'ok',
    last_collected_at: '2026-11-23T10:00:00+08:00', feed_count: 12, follower_total_count: 66,
    metrics: { totals: { daily_play_count: 100, daily_like_count: 10, work_count: 12 }, rowAvailability: 'ok' },
    fans_trend: { totals: { follower_net_count: 6, follower_add_count: 7, follower_reduce_count: 1 }, rowAvailability: 'ok' },
  }
  const ROW_B = {
    account_id: 'finder-b', nickname: '账号乙', avatar: null, session_status: 'expired',
    last_collected_at: null, feed_count: 8, follower_total_count: 101,
    metrics: { totals: { daily_play_count: 1134, work_count: 188 }, rowAvailability: 'ok' },
    fans_trend: { totals: { follower_net_count: -3, follower_add_count: 0, follower_reduce_count: 3 }, rowAvailability: 'ok' },
  }

  /** 日期算术（fixture 专用）：ISO 日 + N 天。 */
  function dayOffset(start: string, offset: number): string {
    return new Date(Date.UTC(2026, 10, 17 + offset)).toISOString().slice(0, 10)
  }

  function accountsOverviewPayload(overrides: Record<string, unknown> = {}, trendDays = 7): Payload {
    return {
      status: 'ok',
      window: 'last_7d',
      summary: {
        accountCount: 2, accountTotal: 3,
        window: { startDay: '2026-11-17', endDay: '2026-11-23' },
        totals: { daily_play_count: 1234, daily_like_count: 37, work_count: 200 },
        fans_totals: { follower_net_count: 3, follower_add_count: 7, follower_reduce_count: 1 },
        followerTotalCount: 167,
        trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
        trendDaily: Array.from({ length: trendDays }, (_, index) => ({
          day: dayOffset('2026-11-17', index), follower_total_count: 160 + index,
        })),
        daysObserved: { account_metrics: 7, fans_trend: 7 },
        availability: { account_metrics: 'ok', fans_trend: 'ok' },
      },
      accounts: [ROW_A, ROW_B],
      availability: { account_metrics: 'ok', fans_trend: 'ok' },
      ...overrides,
    }
  }

  function overviewAccountsHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
    return baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙', sessionStatus: 'expired' }], remoteOk: true }),
      'overview.accounts': () => accountsOverviewPayload(),
      'fans.profile.get': () => ({ ...OK, fans_profile: PROFILE }),
      ...overrides,
    })
  }

  async function openOverview(handlers: Record<string, Handler>): Promise<{ calls: RecordedCall[] }> {
    const page = await renderPage(handlers)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.overview'] }))
    await screen.findByText(t('overview.section.accounts'))
    return page
  }

  it('全部账号模式：筛选器 4 个、10 卡按 summary.totals、表格行数 = rows、画像空态', async () => {
    await openOverview(overviewAccountsHandlers())
    // 4 个 FilterMenu 触发按钮（aria-label 为筛选名）。
    for (const name of ['Account', 'Window', 'Sort', 'Session']) {
      expect(screen.getByRole('button', { name })).not.toBeNull()
    }
    // 10 卡：全部视频指标标签（10 个 labelKey 全部命中）。
    for (const key of ['col.play', 'col.like', 'col.favorite', 'col.comment', 'col.share', 'col.forward', 'col.follow', 'metric.ringset', 'metric.statusRef', 'metric.statusCover'] as const) {
      expect(screen.getAllByText(t(key)).length).toBeGreaterThanOrEqual(1)
    }
    expect(screen.getAllByText('1234').length).toBeGreaterThanOrEqual(1)
    // 表格行数 = rows.length（2），表头与账号名可见。
    const table = screen.getByRole('table', { name: t('overview.section.accounts') })
    expect(table.querySelectorAll('tbody tr').length).toBe(2)
    expect(screen.getByText('账号乙')).not.toBeNull()
    // 画像：全部账号模式为选择提示空态，不发 fans.profile.get。
    expect(screen.getByText(t('overview.portrait.pickAccount'))).not.toBeNull()
  })

  it('账号表现表：首列表头「No.」，账号列只有昵称与状态标签（无首字占位）', async () => {
    await openOverview(overviewAccountsHandlers())
    const table = screen.getByRole('table', { name: t('overview.section.accounts') })
    const headers = within(table as HTMLElement).getAllByRole('columnheader')
    expect(headers[0]?.textContent).toBe(t('overview.col.rank'))
    // 账号列不再渲染昵称首字占位。
    const row = screen.getByText('演示账号').closest('tr')
    expect(within(row as HTMLElement).queryByText('演')).toBeNull()
    expect(within(row as HTMLElement).getByText(t('overview.tag.sessionOk'))).not.toBeNull()
  })

  it('空态与口径文案：指标卡空态「Not collected」、无数据行标签、页脚口径', async () => {
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 2, accountTotal: 3,
          window: { startDay: '2026-11-17', endDay: '2026-11-23' },
          totals: {}, fans_totals: {}, followerTotalCount: null,
          trendDaily: [], daysObserved: { account_metrics: 0, fans_trend: 0 },
          availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
        },
        accounts: [
          { account_id: 'finder-a', metrics: { totals: {}, rowAvailability: 'no_data' }, fans_trend: { totals: {}, rowAvailability: 'no_data' } },
          { account_id: 'finder-b', metrics: { totals: {}, rowAvailability: 'no_data' }, fans_trend: { totals: {}, rowAvailability: 'no_data' } },
        ],
        availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
      }),
    }))
    expect(await screen.findByText(t('overview.metricsNoData'))).not.toBeNull()
    // 指标卡与增长卡空态不再是 kit 的「No data」，而是「Not collected」。
    expect(screen.getAllByText(t('overview.notCollected')).length).toBeGreaterThanOrEqual(1)
    // 两份数据都没有的账号行带「Not collected」标签；页脚口径文案换新。
    expect(screen.getAllByText(t('overview.row.noData')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(t('overview.dataSource')).length).toBeGreaterThanOrEqual(1)
  })

  it('单日窗口：趋势只在最后一位画点并旁注数值，标题为单日', async () => {
    const day = recentDaysForTest()
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 1, accountTotal: 1,
          window: { startDay: day, endDay: day },
          totals: { daily_play_count: 100 }, fans_totals: {}, followerTotalCount: 4321,
          trendDaily: [{ day, follower_total_count: 4321 }],
          daysObserved: { account_metrics: 1, fans_trend: 1 },
          availability: { account_metrics: 'ok', fans_trend: 'ok' },
        },
        accounts: [ROW_A],
      }),
    }))
    // 标题：单日为「关注者总数趋势（11-24）」形式，不再写「近 7 天」。
    expect(screen.getByText(t('chart.fansTrendRange', { range: day.slice(5) }))).not.toBeNull()
    // 横轴固定 7 位：只有最后一位有日期标签，左侧 6 个空位无标签。
    const labels = document.querySelectorAll('svg text[y="202"]')
    expect([...labels].map(label => label.textContent)).toEqual([day.slice(5)])
    // 单点标注：系列色实心圆点 + 点旁数值（en 千分位 4,321）；空位无聚焦热区按钮。
    expect(document.querySelector('svg circle[style*="--yt-chart-1"]')).not.toBeNull()
    const dotLabel = document.querySelector('svg text[style*="--yt-chart-1"]')
    expect(dotLabel?.textContent).toBe('4,321')
    expect(document.querySelectorAll('[class*="plotColumn"]').length).toBe(1)
  })

  it('availability no_data → 真实空态文案；accountCount=0 → 无匹配账号', async () => {
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 2, accountTotal: 3,
          window: { startDay: '2026-11-17', endDay: '2026-11-23' },
          totals: {}, fans_totals: {}, followerTotalCount: null,
          trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
          trendDaily: [], daysObserved: { account_metrics: 0, fans_trend: 0 },
          availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
        },
        accounts: [
          { account_id: 'finder-a', metrics: { totals: {}, rowAvailability: 'no_data' }, fans_trend: { totals: {}, rowAvailability: 'no_data' } },
          { account_id: 'finder-b', metrics: { totals: {}, rowAvailability: 'no_data' }, fans_trend: { totals: {}, rowAvailability: 'no_data' } },
        ],
        availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
      }),
    }))
    expect(await screen.findByText(t('overview.metricsNoData'))).not.toBeNull()
  })

  it('accountCount=0（筛选后空集）→ 无匹配账号文案', async () => {
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 0, accountTotal: 3,
          window: { startDay: '2026-11-17', endDay: '2026-11-23' },
          totals: {}, fans_totals: {}, followerTotalCount: null,
          trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
          trendDaily: [], daysObserved: { account_metrics: 0, fans_trend: 0 },
          availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
        },
        accounts: [],
        availability: { account_metrics: 'no_data', fans_trend: 'no_data' },
      }),
    }))
    expect(await screen.findByText(t('overview.empty.noAccounts'))).not.toBeNull()
  })

  it('单账号模式：选账号后 4 卡为该账号值、画像五维渲染、fans.profile.get 发出', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args).toMatchObject({ accountId: 'finder-b' })
    })
    // 4 卡为该账号（finder-b）值：净增 -3、新增 0、取消 3、总数 101。
    expect((await screen.findAllByText('-3')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('101').length).toBeGreaterThanOrEqual(1)
    // 画像五维同屏（fans.profile.get 已发出并渲染 PROFILE）。
    expect(await screen.findByText(t('portrait.gender'))).not.toBeNull()
    for (const key of ['portrait.gender', 'portrait.device', 'portrait.age', 'portrait.province', 'portrait.city'] as const) {
      expect(screen.getByText(t(key))).not.toBeNull()
    }
    expect(screen.getByText(/Male 70 · 70%/u)).not.toBeNull()
    // 省份 Top 5 截断 + 明示 5 / 7。
    const provinceRows = screen.getAllByText(/广东|江苏|浙江|山东|四川|福建|河南/u)
    expect(provinceRows.length).toBe(5)
    expect(screen.getByText(t('portrait.topNote', { top: 5, total: 7 }))).not.toBeNull()
  })

  it('表格行 Enter 选中账号：accountIds 进入请求（键盘等价路径）', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    const row = screen.getByText('账号乙').closest('tr') as HTMLElement
    fireEvent.keyDown(row, { key: 'Enter' })
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args).toMatchObject({ accountId: 'finder-b' })
    })
  })

  it('会话状态筛选与账号联动：expired 与选中账号不符 → 账号重置为全部（单次请求）', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    // 先选账号乙，再把会话状态切到 expired（与账号乙 expired 相符 → 不重置）。
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args).toMatchObject({ accountId: 'finder-b' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.tag.sessionOk') }))
    // ok 与账号乙（expired）不符 → accountIds 撤下、状态保留。
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args).toMatchObject({ sessionStatus: 'ok' })
      expect(last?.args.accountId).toBeUndefined()
    })
  })

  it('时间窗切 custom：出现两个 date 输入、max 为昨日、初值为昨日；custom 参数透传', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    fireEvent.click(screen.getByRole('button', { name: 'Window' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.window.custom') }))
    const inputs = document.querySelectorAll('input[type="date"]')
    expect(inputs.length).toBe(2)
    const yesterday = recentDaysForTest()
    expect(inputs[0]?.getAttribute('max')).toBe(yesterday)
    expect(inputs[1]?.getAttribute('max')).toBe(yesterday)
    expect((inputs[0] as HTMLInputElement).value).toBe(yesterday)
    expect((inputs[1] as HTMLInputElement).value).toBe(yesterday)
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args).toMatchObject({ window: 'custom', fromDay: yesterday, toDay: yesterday })
    })
  })

  it('自定义越界纠偏：起始改到截止之后 → 截止跟随为同值（单次请求）；清空任一端 → 不发请求', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    fireEvent.click(screen.getByRole('button', { name: 'Window' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.window.custom') }))
    const inputs = document.querySelectorAll('input[type="date"]')
    const countAtCustom = calls.filter(call => call.action === 'overview.accounts').length
    // 清空起始：不发请求（受控值保留为空串）。
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '' } })
    expect(calls.filter(call => call.action === 'overview.accounts').length).toBe(countAtCustom)
    expect((inputs[0] as HTMLInputElement).value).toBe('')
    // 起始晚于截止：截止跟随（同一次 change 只发一次请求）。
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: '2026-12-01' } })
    expect((inputs[1] as HTMLInputElement).value).toBe('2026-12-01')
    expect(calls.filter(call => call.action === 'overview.accounts').length).toBe(countAtCustom + 1)
  })

  it('清除时间窗 chip → 回 last_7d 且自定义日期清空；请求不再携带日期', async () => {
    const { calls } = await openOverview(overviewAccountsHandlers())
    fireEvent.click(screen.getByRole('button', { name: 'Window' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.window.custom') }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args.window).toBe('custom')
    })
    // 时间窗 chip 恒显示；点清除按钮。
    const chipClear = screen.getAllByRole('button', { name: new RegExp(t('overview.chip.window', { value: '' }).split('{value}')[0] ?? 'Window:') }).at(-1)
    if (chipClear === undefined) throw new Error('chip clear button missing')
    fireEvent.click(chipClear)
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'overview.accounts')
      expect(last?.args.window).toBe('last_7d')
      expect(last?.args.fromDay).toBeUndefined()
    })
    expect(document.querySelectorAll('input[type="date"]').length).toBe(0)
  })

  it('趋势横轴固定 7 位：30 天窗口等间隔取 7 点，首尾必选', async () => {
    const start = '2026-10-25'
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 2, accountTotal: 3,
          window: { startDay: start, endDay: '2026-11-23' },
          totals: { daily_play_count: 1234 }, fans_totals: {}, followerTotalCount: 167,
          trendDaily: Array.from({ length: 30 }, (_, index) => ({
            day: new Date(Date.UTC(2026, 9, 25 + index)).toISOString().slice(0, 10),
            follower_total_count: 160 + index,
          })),
          daysObserved: { account_metrics: 30, fans_trend: 30 },
          availability: { account_metrics: 'ok', fans_trend: 'ok' },
        },
      }),
    }))
    // 横轴固定 7 位（count ≤ 7 → 全部带日期标签，y=202 = height 210 − 8）。
    const labels = document.querySelectorAll('svg text[y="202"]')
    expect(labels.length).toBe(7)
    // N = 30：第 k 位取起日后第 round(k × 29 / 6) 天 → 偏移 0/5/10/15/19/24/29，首尾必选。
    expect([...labels].map(label => label.textContent)).toEqual([
      '10-25', '10-30', '11-04', '11-09', '11-13', '11-18', '11-23',
    ])
    // 标题随所选时间窗，不再写死「近 7 天」；en 标题括号进词典后为半角（上一轮真机缺陷）。
    const trendTitle = screen.getByText(t('chart.fansTrendRange', { range: '10-25 – 11-23' }))
    expect(trendTitle.textContent).toContain('(10-25 – 11-23)')
    expect(trendTitle.textContent).not.toContain('（')
  })

  it('筛选切换无缓存时旧值撤下：B 挂起期间不显示 A 的指标值，B 到达后显示 B 值', async () => {
    const resolvers: Array<(payload: Payload) => void> = []
    const { calls } = await openOverview(overviewAccountsHandlers({
      'overview.accounts': args => {
        if (args.window === 'last_30d') {
          return new Promise<Payload>(resolve => { resolvers.push(resolve) })
        }
        return accountsOverviewPayload()
      },
    }))
    expect(await screen.findByText('1234')).not.toBeNull()
    // 切 last_30d（B 挂起）：A 的值立即撤下。
    fireEvent.click(screen.getByRole('button', { name: 'Window' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.window.last_30d') }))
    await waitFor(() => expect(screen.queryByText('1234')).toBeNull())
    // B 到达后展示 B 值。
    for (const resolve of resolvers) {
      resolve(accountsOverviewPayload({ summary: {
        ...accountsOverviewPayload().summary as Record<string, unknown>,
        totals: { daily_play_count: 8888 },
      } }))
    }
    expect(await screen.findByText('8888')).not.toBeNull()
    void calls
  })

  it('缓存命中即时渲染 + refreshing 淡化：同筛选键二次进入渲染缓存值并挂 data-refreshing', async () => {
    let finderBRequests = 0
    let secondCallResolve: ((payload: Payload) => void) | undefined
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': args => {
        // 账号乙的第二次请求（缓存命中后的后台刷新）挂起，撑住 refreshing 窗口。
        if (args.accountId === 'finder-b') {
          finderBRequests += 1
          if (finderBRequests >= 2) {
            return new Promise<Payload>(resolve => { secondCallResolve = resolve })
          }
        }
        return accountsOverviewPayload()
      },
    }))
    // 第一段：选账号乙（首次请求，立即返回，写缓存）。
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    expect((await screen.findAllByText('1134')).length).toBeGreaterThanOrEqual(1)
    // 第二段：切回全部再切回账号乙 → 缓存命中即时渲染 + refreshing 淡化。
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: t('overview.filter.account.all') }))
    await waitFor(() => expect(screen.getByText('1234')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    // 缓存值立即在屏（1134 是账号乙 totals 值，与全部账号的 1234 区分）。
    expect((await screen.findAllByText('1134')).length).toBeGreaterThanOrEqual(1)
    const dim = document.querySelector('[data-refreshing="true"]')
    expect(dim).not.toBeNull()
    secondCallResolve?.(accountsOverviewPayload())
  })
})

describe('tab / keyboard / aria 基础', () => {
  it('panel region 与 tabpanel 可访问', async () => {
    await renderPage(baseHandlers())
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
    expect(screen.getByRole('tabpanel', { name: en.panel })).not.toBeNull()
  })

  it('作品数据页两列布局：账号管理栏 + 作品面板并区存在；总览页隐藏账号栏', async () => {
    await renderPage(baseHandlers())
    // 作品数据页：账号管理栏（aside）+ 作品面板（section）。
    expect(screen.getByRole('complementary', { name: t('account.title') })).not.toBeNull()
    expect(screen.getByRole('region', { name: en['tab.works'] })).not.toBeNull()
    // 切到账号总览：账号管理栏不再渲染（隐藏侧栏 = 不渲染，不是 CSS 藏）。
    fireEvent.click(screen.getByRole('tab', { name: en['tab.overview'] }))
    await waitFor(() => expect(screen.queryByRole('complementary', { name: t('account.title') })).toBeNull())
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
  })

})

describe('复审修复回归', () => {
  it('P1 跨账号 stale 隔离：切账号后旧账号行不复用，B 拉取失败呈现 error 不显示 A 作品', async () => {
    const otherAccount = { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, otherAccount], remoteOk: true }),
      'works.list': args => {
        if (args.accountId === 'finder-b') throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, works: [{ work_id: 'w-a', title: '账号甲作品', play_count: 1, like_count: 1, publish_time: null }] }
      },
    }))
    expect(await screen.findByText('账号甲作品')).not.toBeNull()
    // 切到账号乙：works.list reject → 同账号 partial 保留不成立（上一账号的行
    // 不属于 finder-b），必须 error 态且不渲染 A 的作品。
    const cardButton = (name: string): HTMLButtonElement =>
      screen.getByText(name).closest('button') as HTMLButtonElement
    fireEvent.click(cardButton('账号乙'))
    // 失败态出现在作品表与 partial 相关摘要卡（≥1 处命中）。
    await waitFor(() => expect(screen.getAllByText('Failed to load').length).toBeGreaterThanOrEqual(1))
    expect(screen.queryByText('账号甲作品')).toBeNull()
    // 修复回切：A 重新拉取成功恢复 ready。
    fireEvent.click(cardButton('演示账号'))
    await waitFor(() => expect(screen.getByText('账号甲作品')).not.toBeNull())
    expect(screen.queryByText('Failed to load')).toBeNull()
  })

  it('P1 趋势卡消费 summary.availability.fans_trend：partial + 有数据 = 源级说明与数据同屏（不逐卡插警告条）', async () => {
    // 趋势窗口取 summary.window（7 天窗口）；partial 说明走 footnote。
    await renderPage(baseHandlers({
      'overview.accounts': () => ({
        status: 'ok',
        window: 'last_7d',
        summary: {
          accountCount: 1, accountTotal: 1,
          window: { startDay: '2026-11-17', endDay: '2026-11-23' },
          totals: { daily_play_count: 100 },
          fans_totals: { follower_net_count: 7 },
          followerTotalCount: 160,
          trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
          trendDaily: [{ day: '2026-11-17', follower_total_count: 100 }],
          daysObserved: { account_metrics: 1, fans_trend: 7 },
          availability: { account_metrics: 'ok', fans_trend: 'partial' },
        },
        accounts: [{
          account_id: 'finder-a', nickname: '演示账号', metrics: { totals: { daily_play_count: 100 }, rowAvailability: 'ok' },
          fans_trend: { totals: { follower_net_count: 7 }, rowAvailability: 'partial' },
          availability: { accountMetrics: 'ok', fansTrend: 'partial' },
        }],
        availability: { account_metrics: 'ok', fans_trend: 'partial' },
      }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.overview'] }))
    // partial：数据不完整说明出现（趋势卡 footnote 通道，与数据来源拼接），不得隐藏。
    await waitFor(() => expect(screen.getAllByText(/Some days in this window have no collected data/u).length).toBeGreaterThanOrEqual(1))
    // 逐卡的 DataState 警告条不再出现（数值直排，说明收敛为区块级一次）。
    expect(screen.queryByText('Partial data shown; the rest failed to load')).toBeNull()
    // 数据同屏：趋势日点仍在（不得因 partial 清空数据）。
    expect(screen.getByRole('button', { name: '2026-11-17 Total followers 100' })).not.toBeNull()
  })

  it('P1 chrome missing：删除可用，依赖 Chrome 的 probe / promote / 重新扫码禁用', async () => {
    const { calls } = await renderPage(baseHandlers({
      'browser.status': () => ({ ...OK, chrome: 'missing', driver: 'missing' }),
      'accounts.list': () => ({ ...OK, accounts: [
        ACCOUNT,
        { ...ACCOUNT, accountId: 'finder-expired', nickname: '过期号', sessionStatus: 'expired' },
        { ...ACCOUNT, accountId: 'pending-1', nickname: '待确认号', sessionStatus: 'unknown', isPending: true },
      ], remoteOk: true }),
      'account.removeLocal': () => ({ ...OK, removed: true }),
      'account.removeRemote': () => ({ ...OK, removed: true }),
    }))
    expect(await screen.findByText(t('browser.blockedHint'))).not.toBeNull()
    // probe（account.probe → refreshSessionState / Chrome）与 promote
    // （account.promote → probeSession / Chrome）随 chromeLocked 禁用。
    expect(screen.getByRole('button', { name: t('account.probe') }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: t('account.promote') }).hasAttribute('disabled')).toBe(true)
    // 重新扫码（开扫码窗口）随 chromeLocked 禁用。
    expect(screen.getAllByRole('button', { name: t('account.relogin') })[0]?.hasAttribute('disabled')).toBe(true)
    // 删除不依赖 Chrome：保持可用并完成两步删除。
    const remove = screen.getAllByRole('button', { name: t('account.remove') })[0] as HTMLButtonElement
    expect(remove.hasAttribute('disabled')).toBe(false)
    fireEvent.click(remove)
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirmNamed', { name: '演示账号' })}` }))
    await waitFor(() => expect(screen.getByText(t('account.removeSuccess'))).not.toBeNull())
    const localIndex = calls.findIndex(call => call.action === 'account.removeLocal')
    const remoteIndex = calls.findIndex(call => call.action === 'account.removeRemote')
    expect(localIndex).toBeGreaterThanOrEqual(0)
    expect(remoteIndex).toBeGreaterThan(localIndex)
  })

  it('P2 刷新三路失败聚合：works / summary / accounts 各自失败路进入工具栏提示，恢复后清除', async () => {
    let worksFails = false
    let summaryFails = false
    let accountsFails = false
    const { calls } = await renderPage(baseHandlers({
      'works.list': () => {
        if (worksFails) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, ...WORKS }
      },
      'account.overview': () => {
        if (summaryFails) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, metrics: { totals: { daily_play_count: 1 } }, fans_trend: { totals: {} }, availability: {} }
      },
      'accounts.list': () => {
        if (accountsFails) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, accounts: [ACCOUNT], remoteOk: true }
      },
    }))
    await screen.findByText('第一条作品')
    // 三路全部失败：提示明确列出三条失败路，面板与数据保留（不整页替换）。
    worksFails = true
    summaryFails = true
    accountsFails = true
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    expect(await screen.findByText(t('works.refreshPartial', {
      parts: `${t('works.refreshPart.works')}、${t('works.refreshPart.overview')}、${t('works.refreshPart.accounts')}`,
    }))).not.toBeNull()
    expect(screen.getByText('第一条作品')).not.toBeNull()
    // 全部恢复：提示清除，三路重新调用。
    worksFails = false
    summaryFails = false
    accountsFails = false
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    await waitFor(() => expect(screen.queryByText(t('works.refreshPartial', {
      parts: `${t('works.refreshPart.works')}、${t('works.refreshPart.overview')}、${t('works.refreshPart.accounts')}`,
    }))).toBeNull())
    expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(3)
  })

  it('P2 单路失败聚合：只有 works 失败时提示只列 works 一路', async () => {
    let worksFails = false
    await renderPage(baseHandlers({
      'works.list': () => {
        if (worksFails) throw new Error('WX_TOOL_UNAVAILABLE')
        return { ...OK, ...WORKS }
      },
    }))
    await screen.findByText('第一条作品')
    worksFails = true
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    expect(await screen.findByText(t('works.refreshPartial', { parts: t('works.refreshPart.works') }))).not.toBeNull()
    // summary / accounts 未失败：不进入提示。
    expect(screen.queryByText(t('works.refreshPart.overview'))).toBeNull()
  })
})

describe('词典键集（增量同步防护）', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

// ---------------------------------------------------------------------------
// readAccountsOverview（overview.accounts 投影；E.2 wx-data 行）
// ---------------------------------------------------------------------------

const ACCOUNTS_OVERVIEW_FULL = {
  window: 'last_7d',
  summary: {
    accountCount: 2,
    accountTotal: 3,
    window: { startDay: '2026-11-18', endDay: '2026-11-23' },
    totals: {
      daily_play_count: 456, daily_like_count: 23, work_count: 200,
    },
    fans_totals: { follower_net_count: 308, follower_add_count: 400 },
    followerTotalCount: 169,
    trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
    trendDaily: [
      { day: '2026-11-17', follower_total_count: 168 },
      { day: '2026-11-18', follower_total_count: 169 },
      { follower_total_count: 170 },
    ],
    daysObserved: { account_metrics: 3, fans_trend: 3 },
    availability: { account_metrics: 'partial', fans_trend: 'ok' },
  },
  accounts: [
    {
      account_id: 'wx-a', nickname: '账号A', avatar: 'https://example.invalid/a.png',
      session_status: 'ok', last_collected_at: '2026-11-23T10:00:00+08:00',
      feed_count: 120, follower_total_count: 123,
      metrics: { totals: { daily_play_count: 301, work_count: 100 }, rowAvailability: 'ok' },
      fans_trend: { totals: { follower_net_count: 32 }, rowAvailability: 'ok' },
    },
    {
      account_id: 'wx-b',
      metrics: { totals: {}, rowAvailability: 'no_data' },
      fans_trend: { totals: {}, rowAvailability: 'no_data' },
    },
  ],
  availability: { account_metrics: 'partial', fans_trend: 'ok' },
}

describe('readAccountsOverview', () => {
  it('完整载荷逐字段投影（snake_case → camelCase）', () => {
    const data = readAccountsOverview(ACCOUNTS_OVERVIEW_FULL)
    assert.equal(data.window, 'last_7d')
    assert.equal(data.summary.accountCount, 2)
    assert.equal(data.summary.accountTotal, 3)
    assert.deepEqual(data.summary.window, { startDay: '2026-11-18', endDay: '2026-11-23' })
    assert.equal(data.summary.totals.playCount, 456)
    assert.equal(data.summary.totals.workCount, 200)
    assert.equal(data.summary.fansTotals.netCount, 308)
    assert.equal(data.summary.followerTotalCount, 169)
    // trendWindow 是服务端仍下发的字段，客户端投影不再消费（趋势窗口取 summary.window）。
    assert.equal('trendWindow' in data.summary, false)
    assert.deepEqual(data.summary.daysObserved, { accountMetrics: 3, fansTrend: 3 })
    assert.deepEqual(data.summary.availability, { accountMetrics: 'partial', fansTrend: 'ok' })
    assert.equal(data.rows.length, 2)
    const first = data.rows[0] ?? assert.fail('rows[0] missing')
    assert.equal(first.accountId, 'wx-a')
    assert.equal(first.nickname, '账号A')
    assert.equal(first.totals.playCount, 301)
    assert.equal(first.totals.workCount, 100)
    assert.equal(first.fansTotals.netCount, 32)
    assert.deepEqual(first.availability, { accountMetrics: 'ok', fansTrend: 'ok' })
    // 缺失不补 0：wx-b 行的空 totals 全部为 null
    const second = data.rows[1] ?? assert.fail('rows[1] missing')
    assert.equal(second.totals.playCount, null)
    assert.equal(second.totals.workCount, null)
    assert.equal(second.followerTotalCount, null)
  })

  it('trendDaily 缺 day 的行丢弃；无 day 字段不崩', () => {
    const data = readAccountsOverview(ACCOUNTS_OVERVIEW_FULL)
    // 第三行无 day → 丢弃
    assert.deepEqual(data.summary.trendDaily.map(row => row.day), ['2026-11-17', '2026-11-18'])
    assert.equal(data.summary.trendDaily[0]?.followerTotalCount, 168)
  })

  it('缺失与非数值一律 null，不补 0', () => {
    const data = readAccountsOverview({})
    assert.equal(data.window, null)
    assert.equal(data.summary.accountCount, null)
    assert.equal(data.summary.totals.playCount, null)
    assert.equal(data.summary.followerTotalCount, null)
    assert.deepEqual(data.summary.window, { startDay: null, endDay: null })
    assert.deepEqual(data.summary.trendDaily, [])
    assert.deepEqual(data.rows, [])
  })

  it('readOverview 与 readAccountsOverview 对同一 totals 记录投影一致（共用映射）', () => {
    const totalsRecord = {
      daily_play_count: 10, daily_like_count: 2, daily_favorite_count: 3, daily_comment_count: 4,
      daily_share_count: 5, daily_forward_count: 6, daily_follow_count: 7, daily_ringset_count: 8,
      daily_status_ref_count: 9, daily_status_cover_count: 1, work_count: 99,
    }
    const viaOverview = readOverview({ metrics: { totals: totalsRecord }, fans_trend: {} })
    const viaAccounts = readAccountsOverview({
      summary: { totals: totalsRecord, fans_totals: {}, trendDaily: [] },
      accounts: [{ account_id: 'x', metrics: { totals: totalsRecord }, fans_trend: {} }],
    })
    assert.deepEqual(viaOverview.totals, viaAccounts.summary.totals)
    assert.deepEqual(viaAccounts.rows[0]?.totals, viaAccounts.summary.totals)
  })
})

describe('readAccountsOverview 键名防线（fixture 按契约文档 §4.4.1 服务端真实形态）', () => {
  it('trendDaily 键名漂移防护：camelCase trendDaily 读出非空且逐字段正确', () => {
    // 服务端真实返回：summary.trendDaily 为 camelCase 键（契约文档 §4.4.1）。
    // 曾因投影读 trend_daily（snake）整体漂移为空、趋势图永不渲染。
    const payload = {
      window: 'last_7d',
      summary: {
        accountCount: 1,
        accountTotal: 1,
        window: { startDay: '2026-11-18', endDay: '2026-11-24' },
        totals: { daily_play_count: 100, work_count: 3 },
        fans_totals: { follower_net_count: 4, follower_add_count: 5, follower_reduce_count: 1 },
        followerTotalCount: 99,
        trendWindow: { startDay: '2026-11-18', endDay: '2026-11-24' },
        trendDaily: [
          { day: '2026-11-18', follower_total_count: 97 },
          { day: '2026-11-19', follower_total_count: 98 },
          { day: '2026-11-20', follower_total_count: 99 },
        ],
        daysObserved: { account_metrics: 3, fans_trend: 3 },
        availability: { account_metrics: 'ok', fans_trend: 'ok' },
      },
      accounts: [{
        account_id: 'wx-guard', nickname: '防线账号', avatar: null, session_status: 'ok',
        last_collected_at: null, feed_count: 3, follower_total_count: 99,
        metrics: { totals: { daily_play_count: 100, work_count: 3 }, rowAvailability: 'ok' },
        fans_trend: { totals: { follower_net_count: 4 }, rowAvailability: 'ok' },
      }],
      availability: { account_metrics: 'ok', fans_trend: 'ok' },
    }
    const data = readAccountsOverview(payload)
    assert.equal(data.summary.trendDaily.length, 3)
    assert.equal(data.summary.trendDaily[0]?.day, '2026-11-18')
    assert.equal(data.summary.trendDaily[0]?.followerTotalCount, 97)
    assert.equal(data.summary.trendDaily[2]?.followerTotalCount, 99)
    assert.equal(data.summary.totals.playCount, 100)
    assert.equal(data.summary.totals.workCount, 3)
    assert.equal(data.summary.fansTotals.netCount, 4)
    assert.equal(data.summary.daysObserved.accountMetrics, 3)
    assert.equal(data.rows[0]?.followerTotalCount, 99)
  })
})

// ---------------------------------------------------------------------------
// formatCount / formatDelta（满 1 万转 locale 紧凑格式）
// ---------------------------------------------------------------------------

describe('计数格式（满 1 万转「万」）', () => {
  it('formatCount：缺失占位、不足 1 万整数直排、满 1 万 locale 紧凑', () => {
    assert.equal(formatCount(null), '—')
    assert.equal(formatCount(0), '0')
    assert.equal(formatCount(9999), '9999')
    assert.equal(formatCount(10000), '1万')
    assert.equal(formatCount(14128), '1.4万')
    assert.equal(formatCount(71473), '7.1万')
    assert.equal(formatCount(-123456), '-12.3万')
    // en 走 K / M 档；负数与万级同样适用。
    assert.equal(formatCount(10000, 'en'), '10K')
    assert.equal(formatCount(1250000, 'en'), '1.3M')
    assert.equal(formatCount(9999, 'en'), '9999')
  })

  it('formatDelta：符号保留、量级经 formatCount、0 与缺失占位', () => {
    assert.equal(formatDelta(null, 'zh').text, '—')
    assert.equal(formatDelta(0, 'zh').text, '—')
    assert.equal(formatDelta(17300, 'zh').text, '+1.7万')
    assert.equal(formatDelta(-17300, 'zh').text, '-1.7万')
    assert.equal(formatDelta(972, 'zh').text, '+972')
    assert.equal(formatDelta(17300, 'zh').tone, 'up')
    assert.equal(formatDelta(-17300, 'zh').tone, 'down')
  })
})

// ---------------------------------------------------------------------------
// fansTrendSlots（关注者趋势 7 位取点）
// ---------------------------------------------------------------------------

describe('fansTrendSlots（横轴固定 7 位）', () => {
  it('N = 1（单日窗口）：只在最后一位', () => {
    assert.deepEqual(fansTrendSlots('2026-11-24', '2026-11-24'), [
      null, null, null, null, null, null, '2026-11-24',
    ])
  })

  it('N = 3：窗口内的日子从最后一个位置往前排，左侧留空', () => {
    assert.deepEqual(fansTrendSlots('2026-11-22', '2026-11-24'), [
      null, null, null, null, '2026-11-22', '2026-11-23', '2026-11-24',
    ])
  })

  it('N = 7：7 个位置各一天', () => {
    assert.deepEqual(fansTrendSlots('2026-11-18', '2026-11-24'), [
      '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24',
    ])
  })

  it('N = 30：round(k × 29 / 6) 取点，首尾必选', () => {
    assert.deepEqual(fansTrendSlots('2026-10-26', '2026-11-24'), [
      '2026-10-26', '2026-10-31', '2026-11-05', '2026-11-10', '2026-11-14', '2026-11-19', '2026-11-24',
    ])
  })

  it('自定义 21 天窗口：等间隔 7 点', () => {
    assert.deepEqual(fansTrendSlots('2026-11-03', '2026-11-23'), [
      '2026-11-03', '2026-11-06', '2026-11-10', '2026-11-13', '2026-11-16', '2026-11-20', '2026-11-23',
    ])
  })

  it('非法输入（起日晚于止日 / 非日期）返回空数组', () => {
    assert.deepEqual(fansTrendSlots('2026-11-24', '2026-11-23'), [])
    assert.deepEqual(fansTrendSlots('not-a-day', '2026-11-24'), [])
  })
})


describe('P2：locale 座位判定（client-workbench-hooks 附录 B.2）', () => {
  it('语言切换：locale 快照 zh-CN → en，作品摘要卡数值口径由中文切为英文；panel 词典同值不影响判定', async () => {
    let snapshot = { active: 'zh-CN' }
    const listeners = new Set<() => void>()
    const liveLocale = {
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      getSnapshot: () => snapshot,
    }
    // 构造 panel 中英文同值的词典（旧 localeTagOf(t) 在此判错为 zh）。
    const samePanelT = ((key: WxLocaleKey, values?: Record<string, string | number>): string =>
      key === 'panel' ? zh.panel : en[key] ?? key) as typeof t
    const { calls } = mockHost(baseHandlers({
      'account.overview': () => ({ ...OK, metrics: { totals: { daily_play_count: 1250000 } }, fans_trend: { totals: {} }, availability: {} }),
    }))
    render(<WorkbenchPage t={samePanelT} locale={liveLocale} />)
    await waitFor(() => expect(calls.some(call => call.action === 'account.overview')).toBe(true))
    expect(screen.getByText(formatCount(1250000, 'zh'))).not.toBeNull()
    // 官方 publish 语义：语言切换新建冻结快照（引用必变）并通知订阅者。
    snapshot = { active: 'en' }
    act(() => { listeners.forEach(fn => fn()) })
    await waitFor(() => expect(screen.getByText(formatCount(1250000, 'en'))).not.toBeNull())
    expect(screen.queryByText(formatCount(1250000, 'zh'))).toBeNull()
  })
})
