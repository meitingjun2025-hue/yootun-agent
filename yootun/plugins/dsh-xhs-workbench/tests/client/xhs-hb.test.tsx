/**
 * 车衣爆款看板 client 测试（jsdom）：四子区导航与总数角标、KPI 行、规则页
 * 只读（R3：无编辑入口）、筛选草稿跨子页保留、写确认弹层。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, type XhsLocaleKey } from '../../src/client/locales.ts'

const apiMock = vi.hoisted(() => ({
  hostAction: vi.fn(),
  startUploadSession: vi.fn(),
  sendUploadBytes: vi.fn(),
  pollUploadStatus: vi.fn(),
}))
vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(cleanup)

beforeEach(() => {
  apiMock.hostAction.mockReset()
  apiMock.startUploadSession.mockReset()
  apiMock.sendUploadBytes.mockReset()
  apiMock.pollUploadStatus.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string) => {
    if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
    if (action === 'hotboard.overview') {
      return {
        status: 'ready',
        data: {
          kpis: { totalCases: 12, coverageRate: 0.8, aiTaggedRate: 0.5, duplicateGroupCount: 2, lowQualityCount: 1, failedKeywordCount: 0, lastCollectedAt: '2026-11-20T10:00:00Z', nextRun: { scheduleEnabled: true, cron: '30 1 * * 1' } },
          filterOptions: { keywords: [{ keyword: '车衣', category: 'product' }], styles: [], colors: [], noteWords: [], commentWords: [] },
          runStatus: null,
          notes: [],
          pagination: { page: 1, pageSize: 20, total: 12 },
        },
        meta: { total: 12, pageSize: 20 },
      }
    }
    if (action === 'hotboard.candidates') return { status: 'ready', data: { candidates: [] }, meta: { total: 7, pageSize: 1 } }
    if (action === 'hotboard.labels') return { status: 'ready', data: { labels: [], proposals: [] }, meta: { total: 3, pageSize: 1 } }
    if (action === 'hotboard.keywords') return { status: 'ready', data: { keywords: [] }, meta: { total: 40, pageSize: 20 } }
    if (action === 'hotboard.settings') {
      return {
        status: 'ready',
        data: {
          scheduleEnabled: true, fullScheduleCron: '30 1 * * 1', publishWindowDays: 30, perKeywordLimit: 5,
          commentTopN: 50, commentMaxPerNote: 20, minInteractionTotal: 200, dedupHammingThreshold: 6,
          minValidSample: 20, searchMaxCallsPerDay: 800, commentMaxCallsPerDay: 400, detailMaxCallsPerRun: 300,
          ruleVersion: 'r7',
        },
        meta: null,
      }
    }
    throw new Error(`unexpected action ${action}`)
  })
})

const t = (key: XhsLocaleKey): string => en[key] ?? key

async function renderHotboard(): Promise<void> {
  render(<WorkbenchPage t={t} />)
  fireEvent.click(screen.getByRole('tab', { name: en['tab.hotboard'] }))
  await waitFor(() => expect(screen.getByRole('tablist', { name: en['hb.title'] })).not.toBeNull())
}

describe('看板子导航（12 册 §5：四子区 + 总数角标）', () => {
  it('子区为 4 个（案例看板/关键词与扩词/标签与 AI 标记/采集与规则），默认案例看板', async () => {
    await renderHotboard()
    const subTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en['hb.title'])
    expect(subTabs.map(tab => tab.textContent?.replace(/\d+$/u, ''))).toEqual([en['hb.subBoard'], en['hb.subKeywords'], en['hb.subTags'], en['hb.subRules']])
    expect(subTabs[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('关键词与标签总数角标来自 pageSize=1 的 meta.total（对齐旧版口径）', async () => {
    await renderHotboard()
    await waitFor(() => {
      const kwTab = screen.getAllByRole('tab').find(tab => tab.textContent?.startsWith(en['hb.subKeywords']))
      expect(kwTab?.textContent).toContain('40')
      const tagsTab = screen.getAllByRole('tab').find(tab => tab.textContent?.startsWith(en['hb.subTags']))
      expect(tagsTab?.textContent).toContain('3')
    })
  })
})

describe('案例看板（12 册 §5.1）', () => {
  it('KPI 行 8 卡（含覆盖率/AI 标记率百分比与最近采集时间）', async () => {
    await renderHotboard()
    await waitFor(() => expect(screen.getByText(en['hb.kpiCases'])).not.toBeNull())
    expect(screen.getByText('12')).not.toBeNull()
    expect(screen.getByText('80.0%')).not.toBeNull()
    expect(screen.getByText('50.0%')).not.toBeNull()
    expect(screen.getAllByText(en['hb.kpiCoverage']).length).toBeGreaterThan(0)
  })

  it('筛选行含时间窗/关键词/排序/仅主记录与清空全部筛选', async () => {
    await renderHotboard()
    await gotoSub('board')
    // 改一个筛选让 chips 出现（偏离默认值即一枚）。
    fireEvent.change(screen.getByLabelText(en['hb.window']), { target: { value: '30d' } })
    await waitFor(() => expect(screen.getAllByText(en['hb.window30d']).length).toBeGreaterThan(1))
    expect(screen.getByText(en['hb.clearFilters'])).not.toBeNull()
    expect(screen.getByText(en['hb.filterKeyword'])).not.toBeNull()
    expect(screen.getByText(en['hb.sort'])).not.toBeNull()
    expect(screen.getByLabelText(en['hb.scoreMin'])).not.toBeNull()
  })
})

async function gotoSub(id: 'board' | 'keywords' | 'tags' | 'rules'): Promise<void> {
  const labels: Record<string, string> = { board: en['hb.subBoard'], keywords: en['hb.subKeywords'], tags: en['hb.subTags'], rules: en['hb.subRules'] }
  const tab = (await screen.findAllByRole('tab')).find(tab => tab.textContent?.startsWith(labels[id]))
  if (tab !== undefined && tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab)
}

describe('采集与规则（12 册 §5.4 R3：配置只读，无编辑入口）', () => {
  it('规则面板只读行齐全且无任何可编辑输入', async () => {
    await renderHotboard()
    await gotoSub('rules')
    await waitFor(() => expect(screen.getByText(en['hb.settingsReadonlyHint'])).not.toBeNull())
    expect(screen.getByText(en['hb.setScheduleEnabled'])).not.toBeNull()
    expect(screen.getByText(en['hb.setPublishWindowDays'])).not.toBeNull()
    expect(screen.getByText(en['hb.setSearchBudget'])).not.toBeNull()
    expect(screen.getByText('Every Mon 1:30')).not.toBeNull()
    // 只读：无 number/textbox 编辑入口（KPI 值/阈值全为文本）。
    expect(screen.queryByRole('spinbutton')).toBeNull()
    // 采集操作：手动增量采集 + 运行历史两个按钮。
    expect(screen.getByRole('button', { name: en['hb.startIncrement'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['hb.runHistory'] })).not.toBeNull()
  })

  it('手动增量采集先确认（确认 + 幂等键由 machine 生成）；取消不发起', async () => {
    await renderHotboard()
    await gotoSub('rules')
    await waitFor(() => expect(screen.getByRole('button', { name: en['hb.startIncrement'] })).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: en['hb.startIncrement'] }))
    expect(await screen.findByText(en['hb.confirmRunStart'])).not.toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: en['action.confirmNo'] })[0] as HTMLButtonElement)
    await waitFor(() => expect(screen.queryByText(en['hb.confirmRunStart'])).toBeNull())
    const runStarts = apiMock.hostAction.mock.calls.filter(([action]) => action === 'hotboard.runStart')
    expect(runStarts.length).toBe(0)
  })
})

describe('筛选草稿跨子页保留（旧 §13.3 UI 状态要求）', () => {
  it('board 改时间窗 7d → 切走再切回，草稿仍在且请求带 window=7d', async () => {
    await renderHotboard()
    await gotoSub('board')
    await waitFor(() => expect(screen.getByText(en['hb.window'])).not.toBeNull())
    fireEvent.change(screen.getByLabelText(en['hb.window']), { target: { value: '7d' } })
    await waitFor(() => {
      const calls = apiMock.hostAction.mock.calls.filter(([action, args]) => action === 'hotboard.overview' && (args as Record<string, unknown>).window === '7d')
      expect(calls.length).toBeGreaterThan(0)
    })
    // chips 出现（偏离默认值即一枚）。
    expect(screen.getAllByText(en['hb.window7d']).length).toBeGreaterThan(1)
    // 切走再切回：草稿保留，chip 仍在。
    await gotoSub('rules')
    await waitFor(() => expect(screen.getByText(en['hb.settingsReadonlyHint'])).not.toBeNull())
    await gotoSub('board')
    await waitFor(() => {
      const chips = screen.getAllByText(en['hb.window7d']).filter(el => el.className.includes('ChipFilter'))
      expect(chips.length).toBeGreaterThan(0)
    })
  })
})

describe('写操作路由契约（真实 e2e 回归：action→op 映射）', () => {
  it('keywordSave 经确认后发出 op=create，不携带 action 键', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'hotboard.overview') return { status: 'ready', data: { kpis: {}, filterOptions: {}, notes: [], pagination: { page: 1, pageSize: 20, total: 0 } }, meta: { total: 0, pageSize: 20 } }
      if (action === 'hotboard.candidates') return { status: 'ready', data: { candidates: [] }, meta: { total: 0, pageSize: 1 } }
      if (action === 'hotboard.labels') return { status: 'ready', data: { labels: [], proposals: [] }, meta: { total: 0, pageSize: 1 } }
      if (action === 'hotboard.keywords') return { status: 'ready', data: { keywords: [] }, meta: { total: 0, pageSize: 20 } }
      if (action === 'hotboard.settings') return { status: 'ready', data: {}, meta: null }
      if (action === 'hotboard.keywordSave') return { status: 'ready', ok: true, updatedCount: 1, idempotentReplay: false }
      throw new Error(`unexpected action ${action}`)
    })
    await renderHotboard()
    await gotoSub('keywords')
    await waitFor(() => expect(screen.getByLabelText(en['hb.keywordPlaceholder'])).not.toBeNull(), { timeout: 4000 })
    fireEvent.change(screen.getByLabelText(en['hb.keywordPlaceholder']), { target: { value: 'contract-check' } })
    fireEvent.click(screen.getByRole('button', { name: en['hb.createKeyword'] }))
    expect(await screen.findByText(/contract-check/)).not.toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: en['action.confirmYes'] })[0] as HTMLButtonElement)
    await waitFor(() => {
      const call = apiMock.hostAction.mock.calls.find(([name]: [string]) => name === 'hotboard.keywordSave')
      expect(call).toBeDefined()
      const args = call?.[1] as Record<string, unknown>
      expect(args.op).toBe('create')
      expect(args.keyword).toBe('contract-check')
      expect('action' in args).toBe(false)
      expect(args.confirm).toBe(true)
      expect(typeof args.idempotencyKey).toBe('string')
    }, { timeout: 5000 })
  })
})
