/**
 * client 数据页 mock Host 测试（布局回正骨架）：每个数据视图都有 mock response
 * 内容断言（works.list 真实 schema、account.overview 固定 last_7d 摘要、
 * started:false reason、删除两步确认与失败短路、browser 五态不阻断页面、批量
 * 面板、无刷新排序、tab / 键盘 / aria）。
 */
// @vitest-environment jsdom
import { strict as assert } from 'node:assert'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { readAccountsOverview, readOverview } from '../../src/client/schema.ts'
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
    daily_metrics: [
      { day: '2026-11-15', daily_play_count: 100, daily_like_count: 5 },
      { day: '2026-11-17', daily_play_count: 140, daily_like_count: 9, daily_follow_count: 2 },
    ],
    data_gap: { traffic_source: { reason: 'not_exposed' } },
  }
}

/** 基础 handler 集：browser available + 单账号 + 空总览；各测试按需覆盖。 */
function baseHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'browser.status': () => ({ ...OK, chrome: 'available', driver: 'available' }),
    'accounts.list': () => ({ ...OK, accounts: [ACCOUNT], remoteOk: true }),
    'collect.status': () => ({ ...OK, busy: false, collect: null, lastRun: null }),
    'collectAll.status': () => ({ ...OK, ready: true, phase: 'ready', total: 0, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] }),
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
  render(<WorkbenchPage t={t} />)
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

  it('运行中显示当前账号与计数；批量取消后回到终态面板', async () => {
    let cancelled = false
    await renderPage(baseHandlers({
      'collectAll.status': () => cancelled
        ? {
            ...OK, ready: true, phase: 'finished', total: 2, currentAccountIndex: 1, currentAccountId: null,
            completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 2,
            items: [
              { accountId: 'finder-a', status: 'skipped', reason: 'collect_busy' },
              { accountId: 'finder-b', status: 'skipped', reason: 'collect_busy' },
            ],
          }
        : {
            ...OK, ready: false, phase: 'collecting', total: 2, currentAccountIndex: 0,
            currentAccountId: 'finder-a', completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0,
            items: [{ accountId: 'finder-a', status: 'running', reason: null }],
          },
      'collectAll.start': () => ({ ...OK, started: true, batchId: 'batch-1' }),
      'collectAll.cancel': () => {
        cancelled = true
        return { ...OK, cancelled: true }
      },
    }))
    fireEvent.click(screen.getByRole('button', { name: t('account.collectAll') }))
    expect(await screen.findByText(t('batch.progress.collecting', { index: 1, total: 2 }))).not.toBeNull()
    expect(screen.getByText(t('batch.current', { name: '演示账号' }))).not.toBeNull()
    expect(screen.getByText(t('batch.counts', { completed: 0, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('batch.cancel') })).not.toBeNull()
    // 取消后终态：跳过计数可见，按钮恢复「采集全部」。
    fireEvent.click(screen.getByRole('button', { name: t('batch.cancel') }))
    await waitFor(() => expect(screen.getByText(t('batch.summaryLine', { completed: 0, partial: 0, failed: 0, skipped: 2 }))).not.toBeNull())
    expect(screen.getByRole('button', { name: t('account.collectAll') })).not.toBeNull()
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

  it('运行中：按钮进入采集中 + 工具栏下方进度行 + 取消入口（不进顶部通知条）', async () => {
    await renderPage(baseHandlers({
      'collect.start': () => ({ ...OK, started: true, runId: 'run-1' }),
      'collect.status': () => ({
        ...OK,
        busy: true,
        collect: {
          accountId: 'finder-a', attemptId: 'finder-a-abc', status: 'running',
          startedAt: '2026-11-18T10:00:00.000Z', finishedAt: null, error: null,
          progress: { phase: 'ingest', batchNo: 2, totalBatches: 5, succeeded: 30, failed: 1, expected: 45 },
          result: null,
        },
        lastRun: null,
      }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('works.collect') }))
    expect(await screen.findByText(t('works.collecting'))).not.toBeNull()
    // 进度行在工具栏按钮下方：阶段文案 + 细粒度批次计数 + 取消。
    expect(screen.getByText(t('collect.progress.ingest', { batchNo: 2, totalBatches: 5, succeeded: 30, expected: 45 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: t('works.cancel') })).not.toBeNull()
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
    // 查询只带账号：排序全在客户端完成，不向服务端传排序参数。
    expect(listCall?.args).toMatchObject({ accountId: 'finder-a' })
    expect(listCall?.args['sort']).toBeUndefined()
  })

  it('固定 5 张作品摘要卡（作品总数 / 近7日播放 / 近7日关注量 / 完播率 / 缺口作品）', async () => {
    await renderPage(baseHandlers())
    expect(await screen.findByText(t('summary.worksTotal'))).not.toBeNull()
    for (const key of ['summary.worksTotal', 'summary.play7d', 'summary.follow7d', 'summary.completion', 'summary.gapWorks'] as const) {
      expect(screen.getByText(t(key))).not.toBeNull()
    }
    // 数量契约：摘要卡固定 5 张。
    const summaryGrid = screen.getByText(t('summary.worksTotal')).closest('div')
    expect(summaryGrid?.children.length).toBe(5)
    // 口径：作品总数取账号 feedCount（12），近7日取固定 last_7d 摘要（1234），
    // 缺口作品数按核心缺口计数（w-100 有 traffic_source 缺口 → 1）。
    expect(screen.getByText('12')).not.toBeNull()
    await screen.findByText('1234')
    // 完播率同时出现在摘要卡与表格列：限定摘要卡作用域断言。
    const summaryCard = screen.getByText(t('summary.completion')).closest('section')
    expect(within(summaryCard as HTMLElement).getByText('8.37%')).not.toBeNull()
    const gapCard = screen.getByText(t('summary.gapWorks')).closest('section')
    expect(within(gapCard as HTMLElement).getByText('1')).not.toBeNull()
  })

  it('表头排序三态循环且无刷新：新列 desc → asc → 回默认；全程本地重排不重新查询', async () => {
    const { calls } = await renderPage(baseHandlers())
    await screen.findByText('第一条作品')
    const worksCalls = (): number => calls.filter(call => call.action === 'works.list').length
    const rows = (): NodeListOf<HTMLElement> =>
      screen.getByRole('table', { name: t('works.table.label') }).querySelectorAll('tbody tr')
    // 初始默认态：发布时间降序，w-100 在前。
    expect(rows()[0]?.textContent).toContain('第一条作品')
    const initialCalls = worksCalls()
    // 新列 → desc（播放降序 w-100 1000 在前）；aria-sort 在 th 上。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.default') }) }))
    expect(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.desc') }) }).closest('th')?.getAttribute('aria-sort')).toBe('descending')
    expect(rows()[0]?.textContent).toContain('第一条作品')
    // 同列 → asc：播放升序把 7 播放的「第二条」排到最前（本地重排即时生效）。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.desc') }) }))
    expect(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.asc') }) }).closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(rows()[0]?.textContent).toContain('第二条')
    // 再点 → 回默认态（发布时间降序）。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.play'), order: t('sort.asc') }) }))
    expect(rows()[0]?.textContent).toContain('第一条作品')
    // 比率列 desc：缺失值沉底（w-100 8.37% 在前，w-101 缺失在后）。
    fireEvent.click(screen.getByRole('button', { name: t('sort.aria', { label: t('col.completion'), order: t('sort.default') }) }))
    expect(rows()[0]?.textContent).toContain('第一条作品')
    expect(rows()[1]?.textContent).toContain('第二条')
    // 全程无新的 works.list 调用：排序不重新查询服务端。
    expect(worksCalls()).toBe(initialCalls)
  })

  it('鼠标双击作品行打开详情 Modal：完整四段（基础信息 / 核心指标 / 来源+留存 / 按日趋势 / 缺口）', async () => {
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

  it('works 刷新失败保留已加载数据（partial 警告条），不再清空', async () => {
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
    // partial：已加载行保留 + 警告条（kit 文案），数据不被清空。
    // partial 警告条出现在表格与 partial 状态的摘要卡（≥1 处）；已加载行保留。
    await waitFor(() => expect(screen.getAllByText('Partial data shown; the rest failed to load').length).toBeGreaterThanOrEqual(1))
    expect(screen.getByText('第一条作品')).not.toBeNull()
    // 再次刷新成功恢复 ready。
    failNext = false
    fireEvent.click(screen.getByRole('button', { name: t('works.refresh') }))
    await waitFor(() => expect(screen.queryByText('Partial data shown; the rest failed to load')).toBeNull())
    expect(screen.getByText('第一条作品')).not.toBeNull()
    expect(calls.filter(call => call.action === 'works.list').length).toBeGreaterThanOrEqual(3)
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
        trend_daily: Array.from({ length: trendDays }, (_, index) => ({
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

  it('availability no_data → 真实空态文案；accountCount=0 → 无匹配账号', async () => {
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 2, accountTotal: 3,
          window: { startDay: '2026-11-17', endDay: '2026-11-23' },
          totals: {}, fans_totals: {}, followerTotalCount: null,
          trendWindow: { startDay: '2026-11-17', endDay: '2026-11-23' },
          trend_daily: [], daysObserved: { account_metrics: 0, fans_trend: 0 },
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
          trend_daily: [], daysObserved: { account_metrics: 0, fans_trend: 0 },
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

  it('趋势 x 轴点数 = trendWindow 天数（30 天载荷渲染 30 个日期标签）', async () => {
    const start = '2026-10-25'
    await openOverview(overviewAccountsHandlers({
      'overview.accounts': () => accountsOverviewPayload({
        summary: {
          accountCount: 2, accountTotal: 3,
          window: { startDay: start, endDay: '2026-11-23' },
          totals: { daily_play_count: 1234 }, fans_totals: {}, followerTotalCount: 167,
          trendWindow: { startDay: start, endDay: '2026-11-23' },
          trend_daily: Array.from({ length: 30 }, (_, index) => ({
            day: new Date(Date.UTC(2026, 9, 25 + index)).toISOString().slice(0, 10),
            follower_total_count: 160 + index,
          })),
          daysObserved: { account_metrics: 30, fans_trend: 30 },
          availability: { account_metrics: 'ok', fans_trend: 'ok' },
        },
      }),
    }))
    // x 轴日期标签（axisText 类）数量 = 30（LineTrendChart 渲染稀疏标签后仍 30 个数据列）。
    // x 轴日期标签 y=202（height 210 - 8），稀疏规则（B.2 ③）：30 行 → 首 / 中点 / 尾 3 个。
    const labels = document.querySelectorAll('svg text[y="202"]')
    expect(labels.length).toBe(3)
    expect([...labels].map(label => label.textContent)).toEqual(['10-25', '11-08', '11-23'])
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
    // 趋势窗口来自服务端 trendWindow（末日锚 7 天）；partial 说明走 footnote。
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
          trend_daily: [{ day: '2026-11-17', follower_total_count: 100 }],
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
    trend_daily: [
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
    assert.deepEqual(data.summary.trendWindow, { startDay: '2026-11-17', endDay: '2026-11-23' })
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
      summary: { totals: totalsRecord, fans_totals: {}, trend_daily: [] },
      accounts: [{ account_id: 'x', metrics: { totals: totalsRecord }, fans_trend: {} }],
    })
    assert.deepEqual(viaOverview.totals, viaAccounts.summary.totals)
    assert.deepEqual(viaAccounts.rows[0]?.totals, viaAccounts.summary.totals)
  })
})
