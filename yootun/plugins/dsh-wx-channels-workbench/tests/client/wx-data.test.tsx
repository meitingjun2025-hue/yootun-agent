/**
 * client 数据页 mock Host 测试（布局回正骨架）：每个数据视图都有 mock response
 * 内容断言（works.list 真实 schema、account.overview 固定 last_7d 摘要、
 * run.get `{ run, batches }`、started:false reason、删除两步确认与失败短路、
 * browser 五态不阻断页面、批量面板、tab / 键盘 / aria）。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, zh, type WxLocaleKey } from '../../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
    { work_id: 'w-100', title: '第一条作品', play_count: 1000, like_count: 50, publish_time: '2026-11-17T08:00:00.000Z' },
    { work_id: 'w-101', title: '第二条', play_count: 7, like_count: null, publish_time: null },
  ],
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

describe('作品列表（骨架）', () => {
  it('真实 schema 渲染：snake_case 字段、null 计数显示占位', async () => {
    const { calls } = await renderPage(baseHandlers())
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    expect(screen.getByText('第二条')).not.toBeNull()
    expect(screen.getByText(`${t('col.play')} 1000 · 2026-11-17 16:00`)).not.toBeNull()
    const listCall = calls.find(call => call.action === 'works.list')
    expect(listCall?.args).toMatchObject({ accountId: 'finder-a', sort: 'publish_time', order: 'desc' })
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
    expect(await screen.findByText('Partial data shown; the rest failed to load')).not.toBeNull()
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
})

describe('run 查询 Dialog（作品工具栏次级操作）', () => {
  it('工具栏打开 Dialog：真实形状（run + batches）渲染运行字段与批次表', async () => {
    const { calls } = await renderPage(baseHandlers({
      'run.get': () => ({
        ...OK,
        run: {
          run_id: 'run-hit',
          account_id: 'finder-a',
          status: 'completed',
          expected_work_count: 45,
          succeeded_work_count: 40,
          failed_work_count: 3,
          started_at: '2026-11-18T08:00:00.000Z',
          finished_at: '2026-11-18T08:20:00.000Z',
        },
        batches: [
          { batch_no: 1, batch_type: 'works', batch_status: 'succeeded', item_count: 20, succeeded_objects: ['a', 'b'], failed_objects: ['d'] },
          { batch_no: 2, batch_type: 'account_metrics', batch_status: 'failed', item_count: 1, succeeded_objects: [], failed_objects: ['x'] },
          { batch_no: 3, batch_type: 'fans_trend', batch_status: 'pending', item_count: 30, succeeded_objects: [], failed_objects: [] },
          { batch_no: 4, batch_type: 'fans_profile', batch_status: 'pending', item_count: 1, succeeded_objects: [], failed_objects: [] },
        ],
      }),
    }))
    // 打开入口是工具栏次级按钮（不在顶级导航）。
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.title') }))
    const input = await screen.findByPlaceholderText(t('collect.runLookup.placeholder'))
    fireEvent.change(input, { target: { value: 'run-hit' } })
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText('run-hit')).not.toBeNull()
    expect(screen.getByText('finder-a')).not.toBeNull()
    expect(screen.getByText(t('collect.status.completed'))).not.toBeNull()
    expect(screen.getByText('45')).not.toBeNull()
    // 滚动容器键盘可达：tabIndex=0 + role=region + localized 可访问名。
    const wrap = screen.getByRole('region', { name: t('run.batchTable.label') })
    expect(wrap.getAttribute('tabindex')).toBe('0')
    const table = within(wrap as HTMLElement).getByText(t('run.batch.batchNo')).closest('table')
    expect(table).not.toBeNull()
    const batchTable = within(table as HTMLElement)
    expect(batchTable.getAllByText(t('run.batchType.works')).length).toBe(1)
    expect(batchTable.getByText(t('run.batchType.accountMetrics'))).not.toBeNull()
    expect(batchTable.getByText(t('run.batchType.fansTrend'))).not.toBeNull()
    expect(batchTable.getByText(t('run.batchType.fansProfile'))).not.toBeNull()
    expect(batchTable.getAllByText(t('run.batchStatus.pending')).length).toBe(2)
    const runCall = calls.find(call => call.action === 'run.get')
    expect(runCall?.args).toMatchObject({ runId: 'run-hit' })
  })

  it('Escape 关闭且焦点回到触发行；RUN_NOT_FOUND 与服务失败区分', async () => {
    let failNext = false
    await renderPage(baseHandlers({
      'run.get': () => {
        if (failNext) throw new Error('WX_TOOL_UNAVAILABLE')
        return { status: 'error', reason: 'RUN_NOT_FOUND' }
      },
    }))
    const opener = screen.getByRole('button', { name: t('collect.runLookup.title') })
    // 真实点击会移动焦点（fireEvent 不会）；焦点回归契约以打开前焦点为准。
    opener.focus()
    fireEvent.click(opener)
    const input = await screen.findByPlaceholderText(t('collect.runLookup.placeholder'))
    fireEvent.change(input, { target: { value: 'run-miss' } })
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText(t('collect.runLookup.empty'))).not.toBeNull()
    // 服务失败：失败态 + 稳定 reason，不得显示「未找到」。
    failNext = true
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText(t('collect.runLookup.failed'))).not.toBeNull()
    // Escape 关闭，焦点回到触发按钮。
    fireEvent.keyDown(screen.getByRole('dialog', { name: t('collect.runLookup.title') }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('collect.runLookup.title') })).toBeNull())
    expect(document.activeElement).toBe(opener)
  })

  it('批次行缺 batch_no（契约破坏）被丢弃，不渲染占位行', async () => {
    await renderPage(baseHandlers({
      'run.get': () => ({
        ...OK,
        run: { run_id: 'run-x', status: 'running' },
        batches: [
          { batch_type: 'works', batch_status: 'succeeded', item_count: 5, succeeded_objects: [] },
          { batch_no: 1, batch_type: 'works', batch_status: 'succeeded', item_count: 5, succeeded_objects: [] },
        ],
      }),
    }))
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.title') }))
    const input = await screen.findByPlaceholderText(t('collect.runLookup.placeholder'))
    fireEvent.change(input, { target: { value: 'run-x' } })
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText('run-x')).not.toBeNull()
    const table = screen.getByText(t('run.batch.batchNo')).closest('table')
    expect(table).not.toBeNull()
    expect(within(table as HTMLElement).getAllByRole('row').length).toBe(2)
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

  it('账号总览页：账号选择器保留，切账号后三段数据源重新拉取', async () => {
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }], remoteOk: true }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.overview'] }))
    // 当前账号选择器（官方 Menu）始终显示。
    fireEvent.click(await screen.findByRole('button', { name: `${t('overview.accountSwitch')}: 演示账号` }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'account.overview')
      expect(last?.args).toMatchObject({ accountId: 'finder-b' })
    })
  })

  it('总览时间窗参数进入服务端', async () => {
    const { calls } = await renderPage(baseHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.overview'] }))
    await screen.findByText(t('col.play'))
    fireEvent.click(screen.getByRole('tab', { name: t('overview.window.yesterday') }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'account.overview')
      expect(last?.args).toMatchObject({ window: 'yesterday' })
    })
  })
})

describe('词典键集（增量同步防护）', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
