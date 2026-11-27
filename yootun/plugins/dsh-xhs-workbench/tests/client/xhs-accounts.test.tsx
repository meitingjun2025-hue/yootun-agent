/**
 * 账号管理页 + 发布面板 client 测试（jsdom；12 册 §4/§3.3 行为锁定）：
 * Chrome 阻断、账号列表与禁用规则、基本数据缺口提示、移除确认弹层、发布面板
 * 账号选择与轮询。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { PublishPanel } from '../../src/client/PublishPanel.tsx'
import { en, type XhsLocaleKey } from '../../src/client/locales.ts'

const apiMock = vi.hoisted(() => ({
  hostAction: vi.fn(),
  startUploadSession: vi.fn(),
  sendUploadBytes: vi.fn(),
  pollUploadStatus: vi.fn(),
}))
vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(cleanup)

const ACCOUNT_A = { accountId: 'acc-a', nickname: '甲', avatar: null, sessionStatus: 'ok', sessionCheckedAt: null, lastCollectedAt: '2026-11-20T10:00:00.000Z' }
const ACCOUNT_B = { accountId: 'acc-b', nickname: '乙', avatar: null, sessionStatus: 'unknown', sessionCheckedAt: null, lastCollectedAt: null }

beforeEach(() => {
  apiMock.hostAction.mockReset()
  apiMock.startUploadSession.mockReset()
  apiMock.sendUploadBytes.mockReset()
  apiMock.pollUploadStatus.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
    if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
    if (action === 'accounts.list') {
      return { status: 'ready', accounts: [ACCOUNT_A, ACCOUNT_B] }
    }
    if (action === 'account.probe') return { status: 'ready', accountId: args?.accountId, sessionStatus: 'ok' }
    if (action === 'collect.start') {
      return { status: 'started', collectId: 'col-1', collect: { collectId: 'col-1', accountId: args?.accountId, collectStatus: 'completed', pagesDone: 2, notesTotal: 9, truncated: true, error: null } }
    }
    if (action === 'account.removeLocal') return { status: 'ready', removed: { profile: true, storageState: true } }
    throw new Error(`unexpected action ${action}`)
  })
})

const t = (key: XhsLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key] ?? key
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

async function renderAccounts(): Promise<void> {
  render(<WorkbenchPage t={t} locale={locale} />)
  fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
  await waitFor(() => expect(screen.getByRole('button', { name: en['accounts.add'] })).not.toBeNull())
}

/** locale 座位假件：快照对象只建一次（引用稳定）；active 与用例 kit 文案口径一致（en）。 */
const localeSnapshot = { active: 'en' }
const locale = {
  subscribe: () => () => undefined,
  getSnapshot: () => localeSnapshot,
}

describe('账号管理页（12 册 §4）', () => {
  it('左侧账号管理栏（视频号同构）：按状态分流操作 + 红字移除；右栏工具栏与基本数据卡', async () => {
    await renderAccounts()
    // 卡操作按会话状态分流（视频号 AccountSidebar 同款）：ok=检测、unknown=重新登录。
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['accounts.probe'] }).length).toBe(1))
    expect(screen.getAllByRole('button', { name: en['accounts.relogin'] }).length).toBe(1)
    expect(screen.getAllByRole('button', { name: en['accounts.removeLocal'] }).length).toBe(2)
    expect(screen.getAllByText('甲').length).toBeGreaterThanOrEqual(1)
    // 账号 ID 不在任何界面展示（2026-11-21 真机反馈）。
    expect(screen.queryByText('acc-a')).toBeNull()
    expect(screen.getAllByText(en['accounts.statusOk']).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(en['accounts.statusUnknown']).length).toBeGreaterThanOrEqual(1)
    // 右栏工具栏（视频号 WorksPanel 同款）与基本数据卡。
    expect(screen.getByRole('button', { name: en['accounts.collectData'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['accounts.refreshData'] })).not.toBeNull()
    expect(screen.getByText(en['accounts.basicData'])).not.toBeNull()
  })

  it('采集数据运行 → truncated 警示通知条 + 列表刷新', async () => {
    await renderAccounts()
    await waitFor(() => expect(screen.getByRole('button', { name: en['accounts.collectData'] })).not.toBeNull())
    const listCallsBefore = apiMock.hostAction.mock.calls.filter(([action]) => action === 'accounts.list').length
    fireEvent.click(screen.getByRole('button', { name: en['accounts.collectData'] }))
    await waitFor(() => expect(screen.getByText(en['accounts.truncated'])).not.toBeNull(), { timeout: 4000 })
    // 完成后刷新列表（最近采集时间/基本数据随之更新）。
    await waitFor(() => {
      const listCallsAfter = apiMock.hostAction.mock.calls.filter(([action]) => action === 'accounts.list').length
      expect(listCallsAfter).toBeGreaterThan(listCallsBefore)
    }, { timeout: 4000 })
  })

  it('采集运行中按钮变「取消采集」，点击调用 collect.cancel，收到 cancelled 停止轮询并提示（XC1）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'accounts.list') return { status: 'ready', accounts: [ACCOUNT_A, ACCOUNT_B] }
      if (action === 'collect.start') {
        return { status: 'started', collectId: 'col-run', collect: { collectId: 'col-run', accountId: args?.accountId, collectStatus: 'running', pagesDone: 1, notesTotal: 3, truncated: false, error: null } }
      }
      if (action === 'collect.status' && (args as Record<string, unknown> | undefined)?.collectId !== undefined) {
        return { status: 'ready', collect: { collectId: 'col-run', accountId: 'acc-a', collectStatus: 'running', pagesDone: 2, notesTotal: 4, truncated: false, error: null } }
      }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collect.cancel') {
        return { status: 'ready', collect: { collectId: 'col-run', accountId: 'acc-a', collectStatus: 'cancelled', pagesDone: 2, notesTotal: 4, truncated: false, error: 'collect_cancelled' } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    await renderAccounts()
    fireEvent.click(screen.getByRole('button', { name: en['accounts.collectData'] }))
    const cancelBtn = await screen.findByRole('button', { name: en['collect.cancel'] })
    // 运行中的页数与笔记进度在工具栏内并排显示（按钮改为取消入口后不丢进度）。
    expect(screen.getByText(/Collecting… \(\d+ pages \/ \d+ notes\)/)).not.toBeNull()
    fireEvent.click(cancelBtn)
    // 终态提示「已取消，未保存本次采集」，按钮回「采集本账号全部」。
    await waitFor(() => expect(screen.getByText(en['collect.cancelled'])).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: en['accounts.collectData'] })).not.toBeNull())
    expect(screen.queryByText(/Collecting… \(\d+ pages \/ \d+ notes\)/)).toBeNull()
    const cancelCalls = apiMock.hostAction.mock.calls.filter(([action]) => action === 'collect.cancel')
    expect(cancelCalls).toHaveLength(1)
    expect((cancelCalls[0]?.[1] as Record<string, unknown>).collectId).toBe('col-run')
    // 停止轮询：取消后超过一个轮询周期不再发 collect.status。
    const pollsAtCancel = apiMock.hostAction.mock.calls.filter(([action]) => action === 'collect.status').length
    await new Promise(resolve => setTimeout(resolve, 2400))
    const pollsAfter = apiMock.hostAction.mock.calls.filter(([action]) => action === 'collect.status').length
    expect(pollsAfter).toBe(pollsAtCancel)
  })

  it('采集自然结束后按钮回「采集」，再点只发 collect.start、不发取消请求（XC1/X2）', async () => {
    let started = 0
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'accounts.list') return { status: 'ready', accounts: [ACCOUNT_A, ACCOUNT_B] }
      if (action === 'collect.start') {
        started += 1
        const collectId = `col-done-${started}`
        return { status: 'started', collectId, collect: { collectId, accountId: 'acc-a', collectStatus: 'completed', pagesDone: 1, notesTotal: 2, truncated: false, error: null } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    await renderAccounts()
    fireEvent.click(screen.getByRole('button', { name: en['accounts.collectData'] }))
    await waitFor(() => expect(screen.getByText(en['accounts.collectDone'])).not.toBeNull(), { timeout: 4000 })
    // 自然结束后没有「取消采集」按钮可点。
    expect(screen.queryByRole('button', { name: en['collect.cancel'] })).toBeNull()
    // 再次点击只发新的 collect.start，绝不发 collect.cancel。
    fireEvent.click(screen.getByRole('button', { name: en['accounts.collectData'] }))
    await waitFor(() => expect(started).toBe(2))
    const cancelCalls = apiMock.hostAction.mock.calls.filter(([action]) => action === 'collect.cancel')
    expect(cancelCalls).toHaveLength(0)
  })

  it('publishWindowOpen 账号卡显示「发布窗口打开中」标识与悬停说明（XC2）', async () => {
    let publishOpen = false
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'accounts.list') {
        return { status: 'ready', accounts: [{ ...ACCOUNT_A, publishWindowOpen: publishOpen }, ACCOUNT_B] }
      }
      if (action === 'collect.start') {
        return { status: 'started', collectId: 'col-refresh', collect: { collectId: 'col-refresh', accountId: 'acc-a', collectStatus: 'completed', pagesDone: 1, notesTotal: 1, truncated: false, error: null } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    await renderAccounts()
    expect(screen.queryByText(en['account.publishWindowOpen'])).toBeNull()
    // 采集终态刷新列表：新投影的 publishWindowOpen 进入账号卡。
    publishOpen = true
    fireEvent.click(screen.getByRole('button', { name: en['accounts.collectData'] }))
    await waitFor(() => expect(screen.getByText(en['account.publishWindowOpen'])).not.toBeNull(), { timeout: 4000 })
    {
      // 阶段 7（ui-accessibility）：title 改 Tooltip 承载——悬停气泡显示完整说明。
      const stateLine = screen.getByText(en['account.publishWindowOpen']).closest('span') as HTMLElement
      vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
      fireEvent.pointerEnter(stateLine)
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(en['account.publishWindowHint'])
      vi.unstubAllGlobals()
    }
  })

  it('移除账号走确认弹层，确认后调 removeLocal', async () => {
    await renderAccounts()
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['accounts.removeLocal'] }).length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: en['accounts.removeLocal'] })[0] as HTMLButtonElement)
    expect(await screen.findByText(en['accounts.removeConfirm'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['action.confirmYes'] }))
    await waitFor(() => {
      const calls = apiMock.hostAction.mock.calls.filter(([action]) => action === 'account.removeLocal')
      expect(calls.length).toBe(1)
      expect((calls[0]?.[1] as Record<string, unknown>).accountId).toBe('acc-a')
    })
  })

  it('Chrome 缺失阻断提示出现在页面顶部', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: false, driverAvailable: true, platform: 'linux' }
      if (action === 'accounts.list') return { status: 'ready', accounts: [] }
      throw new Error(`unexpected action ${action}`)
    })
    await renderAccounts()
    await waitFor(() => expect(screen.getByText(en['accounts.chromeBlock'])).not.toBeNull())
    // 阻断态下点击添加账号：不动浏览器，直接受控提示。
    fireEvent.click(screen.getByRole('button', { name: en['accounts.add'] }))
    expect((await screen.findAllByText(/System Google Chrome not found/)).length).toBeGreaterThanOrEqual(1)
  })

  it('X6 挂载恢复：Host 按账号返回 running → 进入运行态并按 collectId 轮询', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'accounts.list') return { status: 'ready', accounts: [ACCOUNT_A, ACCOUNT_B] }
      // 挂载恢复查询（只有 accountId 无 collectId）：返回运行中的 run。
      if (action === 'collect.status' && args?.accountId === 'acc-a') {
        return { status: 'ready', collect: { collectId: 'col-restore', accountId: 'acc-a', collectStatus: 'running', pagesDone: 1, notesTotal: 2, truncated: false, error: null } }
      }
      if (action === 'collect.status' && args?.collectId === 'col-restore') {
        return { status: 'ready', collect: { collectId: 'col-restore', accountId: 'acc-a', collectStatus: 'running', pagesDone: 2, notesTotal: 3, truncated: false, error: null } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    await renderAccounts()
    // 恢复进入运行态：取消按钮出现（进度条随之显示）。
    const cancelBtn = await screen.findByRole('button', { name: en['collect.cancel'] }, { timeout: 4000 })
    expect(cancelBtn).not.toBeNull()
    expect(screen.getByText(/Collecting… \(\d+ pages \/ \d+ notes\)/)).not.toBeNull()
    // 轮询按恢复到的 collectId 继续（后续 collect.status 带 collectId）。
    await waitFor(() => {
      const polls = apiMock.hostAction.mock.calls.filter(([action, args]) => action === 'collect.status' && (args as Record<string, unknown>).collectId === 'col-restore')
      expect(polls.length).toBeGreaterThan(0)
    }, { timeout: 4000 })
  })

  it('X7 恢复响应到达前用户已点「采集」→ 恢复结果丢弃（machine 级代次守卫）', async () => {
    const { createAccountsMachine } = await import('../../src/client/accounts-machine.ts')
    let restoreReleased: (() => void) | undefined
    let restoreCalled = false
    const restoreGate = new Promise<{ status: string; collect: CollectState | null }>(resolve => {
      restoreReleased = () => resolve({ status: 'ready', collect: { collectId: 'col-restore', accountId: 'acc-a', collectStatus: 'running', pagesDone: 9, notesTotal: 9, truncated: false, error: null } })
    })
    const accountRow = { accountId: 'acc-a', nickname: '甲', avatar: null, publishWindowOpen: false, sessionStatus: 'ok', lastCollectedAt: null, followers: 0 }
    const machine = createAccountsMachine({
      listAccounts: async () => ({ status: 'ready', accounts: [accountRow] }),
      beginLogin: async () => ({ login: { status: 'waiting', loginId: 'l1' } }),
      loginStatus: async () => ({ login: { status: 'idle' } }),
      probe: async () => ({ status: 'ready', accountId: 'acc-a', sessionStatus: 'ok' }),
      removeLocal: async () => ({ status: 'ready', removed: { profile: true, storageState: true } }),
      startCollect: async () => ({ status: 'started', collectId: 'col-mine', collect: { collectId: 'col-mine', accountId: 'acc-a', collectStatus: 'running', pagesDone: 0, notesTotal: 0, truncated: false, error: null } }),
      collectStatus: async (args: { collectId: string } | { accountId: string }) => {
        if ('accountId' in args) {
          // 挂载恢复查询：登记已发出后挂 gate（用户点击先发生，代次已 +1）。
          restoreCalled = true
          return await restoreGate
        }
        // 用户 run 的轮询。
        return { status: 'ready', collect: { collectId: 'col-mine', accountId: 'acc-a', collectStatus: 'running', pagesDone: 1, notesTotal: 1, truncated: false, error: null } }
      },
      cancelCollect: async () => ({ status: 'ready', collect: null }),
      browserStatus: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    })
    machine.init()
    await waitFor(() => expect(machine.get().loaded).toBe(true))
    // 等恢复查询已发出（挂在 gate 上，尚未完成）。
    await waitFor(() => expect(restoreCalled).toBe(true))
    // 用户点击：代次 +1；startCollect 的结果（col-mine）进入状态。
    await machine.startCollectFlow('acc-a')
    expect(machine.get().collect?.collectId).toBe('col-mine')
    // 释放挂起的恢复响应（col-restore running）：代次不匹配 → 丢弃，用户 run 保持权威。
    restoreReleased?.()
    await machine.tick()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(machine.get().collect?.collectId).toBe('col-mine')
    machine.stop()
  })
})

describe('发布面板（12 册 §3.3）', () => {
  it('无可用账号显示引导；有账号显示选择与打开按钮', () => {
    const { rerender } = render(<PublishPanel accounts={[]} target='image' t={t} />)
    expect(screen.getByText(en['publish.noAccount'])).not.toBeNull()
    rerender(<PublishPanel accounts={[{ accountId: 'acc-a', nickname: '甲' }]} target='image' t={t} />)
    expect(screen.getByText(en['publish.accountLabel'])).not.toBeNull()
    expect(screen.getByRole('button', { name: en['publish.start'] })).not.toBeNull()
    expect(screen.getByText(en['publish.hint'])).not.toBeNull()
  })

  it('打开后轮询 publish.status 至 completed', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'publish.start') {
        return { status: 'started', publishId: 'pub-1', publish: { publishId: 'pub-1', accountId: args?.accountId, publishStatus: 'running', step: 'prepare', error: null } }
      }
      if (action === 'publish.status') {
        return { status: 'ready', publish: { publishId: 'pub-1', accountId: 'acc-a', publishStatus: 'completed', step: 'done', error: null } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<PublishPanel accounts={[{ accountId: 'acc-a', nickname: '甲' }]} target='image' t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['publish.start'] }))
    await waitFor(() => expect(screen.getByText(en['publish.done'])).not.toBeNull(), { timeout: 4000 })
    const startCalls = apiMock.hostAction.mock.calls.filter(([action]) => action === 'publish.start')
    expect((startCalls[0]?.[1] as Record<string, unknown>).target).toBe('image')
  })
})
