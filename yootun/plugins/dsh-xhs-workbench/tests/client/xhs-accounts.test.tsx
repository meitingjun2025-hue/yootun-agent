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
  render(<WorkbenchPage t={t} />)
  fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
  await waitFor(() => expect(screen.getByRole('button', { name: en['accounts.add'] })).not.toBeNull())
}

describe('账号管理页（12 册 §4）', () => {
  it('左栏列表：账号名/状态徽标/三个操作（账号 ID 不展示）；右栏工具栏与基本数据卡', async () => {
    await renderAccounts()
    await waitFor(() => expect(screen.getAllByRole('button', { name: en['accounts.probe'] }).length).toBeGreaterThanOrEqual(2))
    expect(screen.getAllByText('甲').length).toBeGreaterThanOrEqual(1)
    // 账号 ID 不在任何界面展示（2026-11-21 真机反馈）。
    expect(screen.queryByText('acc-a')).toBeNull()
    expect(screen.getAllByText(en['accounts.statusOk']).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(en['accounts.statusUnknown']).length).toBeGreaterThanOrEqual(1)
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
