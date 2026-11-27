/**
 * 报表页组件测试（jsdom，附录 B P1–P9 与 P16）：直接渲染 ReportPage 并注入
 * mock 的 request；mock 返回的服务端行字段参照抖音既有用例的 Host 投影形态。
 * 断言覆盖：空态与状态五态、详情各状态与轮询、缺采口径、作品卡 work 配置与
 * 扩展区、负责人列随数据有无、重新生成确认与幂等键、HTML 导出、语言切换、
 * 错误文案全部来自 errorText、导出失败走本包词典。
 * @module
 */
// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ReportPage, type ReportPageProps, type ReportWorkLayout } from '../src/report-page.tsx'
import { zh, en, type ReportLocaleKey } from '../src/locales.ts'
import type { ReportWork } from '../src/schema.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 报表页翻译（zh 词典直取；测试默认 zh 口径）。 */
const t = (key: ReportLocaleKey, values?: Record<string, string | number>): string => {
  const text = zh[key]
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

/** 注入的 errorText 假件（文案可区分空码/码入参）。 */
const errorText = vi.fn((code: string | null): string => code === null ? `默认:${t('report.error.default')}` : `错误:${code}`)

/** 报表列表行（Host 投影形态，与抖音既有用例同构）。 */
const listRow = (reportId: string, status: string, version: number, coreAvailable: boolean | null = null) => ({
  reportId, reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
  status, version, coreAvailable,
  coverageSummary: { coveredAccounts: 1, totalAccounts: 2 },
  finishedAt: '2026-11-21T11:30:00Z', createdAt: null, summary: null,
  errorCode: status === 'failed' ? 'REPORT_MODEL_FAILED' : null, isCurrent: true,
})

/** 详情正文（succeeded 形态；缺采账号与爆款作品卡供 P3/P4 复用）。 */
const detailBody = {
  generatedAt: '2026-11-21T11:30:00Z',
  coverage: {
    totalAccounts: 2, coveredAccounts: 1, lastCollectedAt: '2026-11-21T09:00:00Z',
    missingAccounts: [{ accountId: 'acc-2', nickname: '账号二', reason: 'session_expired' }],
    signals: { dailyRows: 2, workSnapshotRows: 5, fansProfileRows: 1, periodWorks: 1 },
    insufficientReason: null,
  },
  coreMetrics: [
    { key: 'plays', label: '播放增量', value: 12000, available: true, changePct: 8.5, prevValue: 11000, note: null },
    { key: 'publishes', label: '发布', value: null, available: false, changePct: null, prevValue: null, note: null },
  ],
  trendSeries: { days: ['11-19', '11-20'], bars: [100, null], line: [5, null] },
  accounts: [
    { accountId: 'acc-1', nickname: '账号一', ownerName: '张三', sessionStatus: 'expired', fanCount: 12000, eachAvailable: true, marks: ['3 天未发布'], metrics: { plays: 12000, netFans: 30, publishes: 1, likes: 10, comments: 2, shares: 3 } },
  ],
  works: [
    { workId: 'w-1', title: '新作品', nickname: '账号一', accountId: 'acc-1', isHot: true, metrics: { plays: 100, likes: 5, comments: 1, fansGain: 2, collects: 3, shares: 4, completion5s: 66.6, bounce2s: 20, avgWatchSeconds: 8 } },
  ],
  worksOmittedCount: 0,
  anomalies: [{ type: 'data_gap', message: '账号二缺采' }],
}

/** 详情载荷（覆盖指定字段）。 */
const detailPayload = (overrides: Record<string, unknown> = {}, body: Record<string, unknown> | null = detailBody): Record<string, unknown> => ({
  status: 'ready',
  data: {
    report: {
      reportId: 'r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
      status: 'succeeded', outputSchemaVersion: 'daily-v1', errorCode: null, finishedAt: '2026-11-21T11:30:00Z',
      resultJson: body === null ? null : { data: body, ai: { summary: '整体稳定', facts: [{ title: '事实一', detail: '细节', evidence: '依据' }], inferences: [{ title: '推断一', detail: null, evidence: null, confidence: 'high' }], recommendations: [], limitations: [] } },
      ...overrides,
    },
  },
})

/** 作品卡指标布局（与抖音侧传参同构：主行 4 计数、次要 5 项、5s 完播进度条）。 */
const douyinWork: ReportWorkLayout = {
  primary: [
    { key: 'plays', label: zh['report.col.plays'] },
    { key: 'likes', label: zh['report.col.likes'] },
    { key: 'comments', label: zh['report.col.comments'] },
    { key: 'fansGain', label: zh['report.col.netFans'] },
  ],
  secondary: [
    { key: 'collects', label: zh['report.work.collect'], kind: 'count' },
    { key: 'shares', label: zh['report.work.share'], kind: 'count' },
    { key: 'completion5s', label: zh['report.work.completion5s'], kind: 'percent' },
    { key: 'bounce2s', label: zh['report.work.bounce2s'], kind: 'percent' },
    { key: 'avgWatchSeconds', label: zh['report.work.avgWatch'], kind: 'seconds' },
  ],
  progress: { key: 'completion5s', kind: 'percent', label: zh['report.work.completion5s'] },
}

/** 组装 ReportPage props。 */
function pageProps(request: Mock, overrides: Partial<ReportPageProps> = {}, locale: 'zh' | 'en' = 'zh'): ReportPageProps {
  return {
    request: request as ReportPageProps['request'],
    locale,
    errorText,
    onNotice: vi.fn(),
    filePrefix: '测试运营',
    regenerateKeyPrefix: 'test:report_regenerate',
    work: douyinWork,
    ...overrides,
  }
}

/** 打开详情（列表 1 行 + 详情载荷），等待到指定的详情态锚点文本出现。 */
async function openDetail(request: Mock, detail: Record<string, unknown>, overrides: Partial<ReportPageProps> = {}, waitText: string = t('report.header.base')) {
  request.mockImplementation(async (action: string) => {
    if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-1', 'succeeded', 1)], nextCursor: null } }
    if (action === 'report.get') return detail
    throw new Error(`unexpected action ${action}`)
  })
  const view = render(<ReportPage {...pageProps(request, overrides)} />)
  fireEvent.click(await screen.findByRole('button', { name: t('report.view') }))
  await screen.findByText(waitText)
  return view
}

describe('P1 列表空态与状态五态', () => {
  it('列表为空时显示空态文案', async () => {
    const request = vi.fn(async (action: string) => {
      if (action === 'report.list') return { status: 'ready', data: { items: [], nextCursor: null } }
      throw new Error(`unexpected action ${action}`)
    })
    render(<ReportPage {...pageProps(request)} />)
    expect(await screen.findByText(t('report.empty'))).not.toBeNull()
    expect(request).toHaveBeenCalledWith('report.list', { reportType: 'daily', limit: 20 })
  })

  it('状态为数据不足的条目显示「数据不足」；切周报后按 reportType=weekly 重查', async () => {
    const request = vi.fn(async (action: string) => {
      if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-ins', 'insufficient', 1)], nextCursor: null } }
      throw new Error(`unexpected action ${action}`)
    })
    render(<ReportPage {...pageProps(request)} />)
    expect(await screen.findByText(t('report.status.insufficient'))).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: t('report.weekly') }))
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('report.list', { reportType: 'weekly', limit: 20 }))
  })
})

describe('P2 详情各状态', () => {
  it('已生成：渲染报表头与 KPI（1.2万 + ▲8.5% + 不可用指标 —）', async () => {
    const request = vi.fn()
    await openDetail(request, detailPayload())
    expect(screen.getAllByText('播放增量').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1.2万').length).toBeGreaterThan(0)
    expect(screen.getByText(/▲8\.5%/u)).not.toBeNull()
    // 不可用指标显示「—」不造 0。
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('数据不足：指引文案 + 信号清单 + 重新生成按钮', async () => {
    const request = vi.fn()
    await openDetail(request, detailPayload({
      status: 'insufficient',
      errorCode: 'REPORT_INSUFFICIENT_DATA',
      resultJson: { data: null, ai: null },
    }), {}, t('report.insufficient.all'))
    expect(screen.getByText(new RegExp(t('report.insufficient.dailyRows')), 'u')).not.toBeNull()
    // 指引按钮与详情工具栏的「重新生成」并存。
    expect(screen.getAllByRole('button', { name: t('report.regenerate') }).length).toBeGreaterThanOrEqual(2)
  })

  it('生成失败：错误码文案来自 errorText', async () => {
    errorText.mockClear()
    const request = vi.fn()
    await openDetail(request, detailPayload({ status: 'failed', errorCode: 'REPORT_TIMEOUT' }, null), {}, '错误:REPORT_TIMEOUT')
    expect(errorText).toHaveBeenCalledWith('REPORT_TIMEOUT')
  })

  it('生成中：等待文案 + 5s 轮询直至完成；卸载后停止', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let status = 'running'
      const request = vi.fn(async (action: string) => {
        if (action === 'report.get') return status === 'succeeded' ? detailPayload({ status }) : detailPayload({ status }, null)
        if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-1', 'succeeded', 1)], nextCursor: null } }
        throw new Error(`unexpected action ${action}`)
      })
      const view = render(<ReportPage {...pageProps(request)} />)
      fireEvent.click(await screen.findByRole('button', { name: t('report.view') }))
      await vi.waitFor(() => expect(screen.getByText(t('report.waitingTitle'))).not.toBeNull())
      const getCalls = (): number => request.mock.calls.filter(([action]) => action === 'report.get').length
      await vi.waitFor(() => expect(getCalls()).toBe(1))
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(getCalls()).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(getCalls()).toBe(3)
      status = 'succeeded'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      await vi.waitFor(() => expect(screen.getAllByText(t('report.header.base')).length).toBeGreaterThan(0))
      const settled = getCalls()
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(getCalls()).toBe(settled)
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(getCalls()).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('连续 5 次轮询失败后停轮并显示错误（文案经 errorText）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    errorText.mockClear()
    try {
      let getCalls = 0
      const request = vi.fn(async (action: string) => {
        if (action === 'report.get') {
          getCalls += 1
          // 首次加载返回 running 进入轮询；之后的轮询 tick 连续失败。
          if (getCalls === 1) return detailPayload({ status: 'running' }, null)
          throw new Error('workbench_unavailable')
        }
        if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-1', 'running', 1)], nextCursor: null } }
        throw new Error(`unexpected action ${action}`)
      })
      render(<ReportPage {...pageProps(request)} />)
      fireEvent.click(await screen.findByRole('button', { name: t('report.view') }))
      await vi.waitFor(() => expect(request.mock.calls.filter(([action]) => action === 'report.get').length).toBe(1))
      // 前 4 次失败静默；第 5 次失败停轮并进入错误态（与迁移前同构：请求级失败
      // 由 DataState 的错误态呈现「加载失败 + 重试」，错误详情段不随 error 态渲染）。
      for (let round = 0; round < 5; round += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      }
      await vi.waitFor(() => expect(screen.getByText('加载失败')).not.toBeNull())
      expect(errorText).not.toHaveBeenCalled()
      const settled = request.mock.calls.filter(([action]) => action === 'report.get').length
      await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
      expect(request.mock.calls.filter(([action]) => action === 'report.get').length).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('注入 requestFailedCode 时：轮询 5 连败后 errorText 收到该兜底码', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    errorText.mockClear()
    try {
      let getCalls = 0
      const request = vi.fn(async (action: string) => {
        if (action === 'report.get') {
          getCalls += 1
          // 首次加载返回 running 进入轮询；之后的轮询 tick 抛非 Error 值。
          if (getCalls === 1) return detailPayload({ status: 'running' }, null)
          throw 'boom'
        }
        if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-1', 'running', 1)], nextCursor: null } }
        throw new Error(`unexpected action ${action}`)
      })
      render(<ReportPage {...pageProps(request, { requestFailedCode: 'douyin_operation_request_failed' })} />)
      fireEvent.click(await screen.findByRole('button', { name: t('report.view') }))
      await vi.waitFor(() => expect(request.mock.calls.filter(([action]) => action === 'report.get').length).toBe(1))
      for (let round = 0; round < 5; round += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      }
      await vi.waitFor(() => expect(errorText).toHaveBeenCalledWith('douyin_operation_request_failed'))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P3 缺采口径', () => {
  it('缺采账号显示「—*」，覆盖摘要列出缺采账号', async () => {
    const request = vi.fn()
    const body = {
      ...detailBody,
      accounts: [{ accountId: 'acc-1', nickname: '账号一', ownerName: null, sessionStatus: 'ok', fanCount: 12000, eachAvailable: false, marks: [], metrics: { plays: null, netFans: null, publishes: null, likes: null, comments: null, shares: null } }],
    }
    await openDetail(request, detailPayload({}, body))
    expect(screen.getAllByText(/—\*/u).length).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(`${t('report.quality.missing').replace('{list}', '')}`, 'u'))).not.toBeNull()
    expect(screen.getAllByText(/账号二/u).length).toBeGreaterThan(0)
    expect(screen.getAllByText(new RegExp(t('report.missing.session_expired')), 'u').length).toBeGreaterThan(0)
  })
})

describe('P4 作品卡按 work 配置渲染', () => {
  it('主行、次要行与进度条按配置渲染；不传 renderWorkExtra 时不留空位', async () => {
    const request = vi.fn()
    await openDetail(request, detailPayload())
    // 主行（4 个计数指标：播放/点赞/评论/净增粉丝）。
    const card = screen.getByText('新作品').closest('article') as HTMLElement
    expect(card.querySelectorAll('dl dt')).toHaveLength(4)
    expect(card.textContent).toContain('播放增量')
    expect(card.textContent).toContain('净增粉丝')
    // 次要行：label + 空格 + 格式化值（与迁移前词典模板替换逐字一致）。
    expect(card.textContent).toContain('收藏 3')
    expect(card.textContent).toContain('分享 4')
    expect(card.textContent).toContain('5s 完播 66.6%')
    expect(card.textContent).toContain('2s 跳出 20%')
    expect(card.textContent).toContain('均观看 8s')
    // 进度条：aria 与宽度按 completion5s。
    const track = card.querySelector('[role="img"]') as HTMLElement
    expect(track.getAttribute('aria-label')).toBe('5s 完播 66.6%')
    const fill = track.firstElementChild as HTMLElement
    expect(fill.style.width).toBe('66.6%')
  })

  it('传入 renderWorkExtra 时渲染扩展内容，extra 承载数值之外的原键', async () => {
    const request = vi.fn()
    const body = {
      ...detailBody,
      works: [{
        workId: 'w-2', title: '视频号作品', nickname: '账号一', accountId: 'acc-1', isHot: false,
        metrics: { plays: 10, likes: 1, comments: 0, fansGain: 0, collects: 0, shares: 0, completionRate: 55, avgPlaySeconds: 12, trafficSource: [{ name: '推荐', plays: 6 }], retention: { durationSeconds: 30, maxLostSecond: 4, retentionAtMaxLostPct: 42 } },
      }],
    }
    const renderExtra = vi.fn((work: ReportWork) => <p>扩展:{Object.keys(work.extra).sort().join('/')}</p>)
    await openDetail(request, detailPayload({}, body), { renderWorkExtra: renderExtra })
    expect(await screen.findByText('扩展:retention/trafficSource')).not.toBeNull()
    expect(renderExtra).toHaveBeenCalled()
  })
})

describe('P5 负责人列随数据有无渲染', () => {
  it('账号行带 ownerName：渲染负责人列（9 列）', async () => {
    const request = vi.fn()
    await openDetail(request, detailPayload())
    const table = screen.getAllByRole('table').find(element => element.textContent.includes(t('report.col.fans'))) as HTMLElement
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toContain(t('report.col.owner'))
  })

  it('账号行都没有 ownerName：不渲染负责人列', async () => {
    const request = vi.fn()
    const body = {
      ...detailBody,
      accounts: [{ accountId: 'acc-1', nickname: '账号一', ownerName: null, sessionStatus: 'ok', fanCount: 100, eachAvailable: true, marks: [], metrics: { plays: 10, netFans: 1, publishes: 1, likes: 2, comments: 0, shares: 0 } }],
    }
    await openDetail(request, detailPayload({}, body))
    const table = screen.getAllByRole('table').find(element => element.textContent.includes(t('report.col.fans'))) as HTMLElement
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).not.toContain(t('report.col.owner'))
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(table.querySelectorAll('tbody td')).toHaveLength(headers.length)
  })
})

describe('P6 重新生成确认与幂等键', () => {
  it('需要确认；取消不发起请求；确认后幂等键符合模板', async () => {
    const request = vi.fn()
    const view = await openDetail(request, detailPayload())
    fireEvent.click(screen.getByRole('button', { name: t('report.regenerate') }))
    expect((await screen.findAllByText(t('report.regenerateBody', { version: 2 })))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('report.cancel') }))
    expect(request.mock.calls.filter(([action]) => action === 'report.regenerate')).toHaveLength(0)
    // 再次打开，勾选确认后提交；幂等键 = 前缀:reportId:32hex。
    fireEvent.click(screen.getByRole('button', { name: t('report.regenerate') }))
    const checkbox = await screen.findByRole('checkbox', { name: t('report.regenerateBody', { version: 2 }) }) as HTMLInputElement
    fireEvent.click(checkbox)
    await vi.waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: t('report.regenerateConfirm') }))
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('report.regenerate', {
      reportId: 'r-1',
      idempotencyKey: expect.stringMatching(/^test:report_regenerate:r-1:[0-9a-f]{32}$/u),
    }))
    view.unmount()
  })
})

describe('P7 HTML 导出', () => {
  it('自包含单文件；文件名由前缀、日报或周报、周期组成', async () => {
    const createObjectURL = vi.fn((blob: Blob) => `blob:mock-${blob.size}`)
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const onNotice = vi.fn()
    const request = vi.fn()
    await openDetail(request, detailPayload(), { onNotice })
    fireEvent.click(screen.getByRole('button', { name: t('report.exportHtml') }))
    expect(onNotice).toHaveBeenCalledWith(t('report.htmlDone'))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(expect.stringMatching(/^blob:mock-\d+$/u))
    expect(createObjectURL.mock.calls[0]?.[0]?.size).toBeGreaterThan(0)
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('测试运营日报_2026-11-20.html')
    clickSpy.mockRestore()
  })
})

describe('P8 语言切换', () => {
  it('词典与数值格式随 locale 切换（zh 1.2万 / en 12K）', async () => {
    const request = vi.fn(async (action: string) => {
      if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-1', 'succeeded', 1)], nextCursor: null } }
      if (action === 'report.get') return detailPayload()
      throw new Error(`unexpected action ${action}`)
    })
    const zhView = render(<ReportPage {...pageProps(request, {}, 'zh')} />)
    fireEvent.click(await screen.findByRole('button', { name: t('report.view') }))
    await vi.waitFor(() => expect(screen.getAllByText('1.2万').length).toBeGreaterThan(0))
    expect(screen.getByText(/较昨日 ▲8\.5%/u)).not.toBeNull()
    zhView.unmount()
    const enView = render(<ReportPage {...pageProps(request, {}, 'en')} />)
    fireEvent.click(await screen.findByRole('button', { name: en['report.view'] }))
    await vi.waitFor(() => expect(screen.getAllByText('12K').length).toBeGreaterThan(0))
    expect(screen.getByText(/vs yesterday ▲8\.5%/u)).not.toBeNull()
    enView.unmount()
  })
})

describe('P9 错误文案全部来自 errorText', () => {
  it('报表码、连接失败码、空码各调用一次，传入的码正确', async () => {
    // 报表码：列表行 failed 的 errorCode。
    errorText.mockClear()
    const listRequest = vi.fn(async (action: string) => {
      if (action === 'report.list') return { status: 'ready', data: { items: [listRow('r-f', 'failed', 1)], nextCursor: null } }
      throw new Error(`unexpected action ${action}`)
    })
    render(<ReportPage {...pageProps(listRequest)} />)
    expect(await screen.findByText('错误:REPORT_MODEL_FAILED')).not.toBeNull()
    expect(errorText).toHaveBeenCalledWith('REPORT_MODEL_FAILED')
    cleanup()
    // 连接失败码：列表加载抛稳定码。
    errorText.mockClear()
    const failRequest = vi.fn(async () => { throw new Error('workbench_unavailable') })
    render(<ReportPage {...pageProps(failRequest)} />)
    expect(await screen.findByText('错误:workbench_unavailable')).not.toBeNull()
    expect(errorText).toHaveBeenCalledWith('workbench_unavailable')
    cleanup()
    // 空码：请求抛非 Error → errorText(null) → 域默认文案。
    errorText.mockClear()
    const nullRequest = vi.fn(async () => { throw 'boom' })
    render(<ReportPage {...pageProps(nullRequest)} />)
    expect(await screen.findByText(`默认:${t('report.error.default')}`)).not.toBeNull()
    expect(errorText).toHaveBeenCalledWith(null)
  })
})

describe('P16 导出失败', () => {
  it('提示本包词典 report.exportFailed，不调用 errorText', async () => {
    errorText.mockClear()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => { throw new Error('blob unavailable') }),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const onNotice = vi.fn()
    const request = vi.fn()
    await openDetail(request, detailPayload(), { onNotice })
    fireEvent.click(screen.getByRole('button', { name: t('report.exportHtml') }))
    expect(onNotice).toHaveBeenCalledWith(t('report.exportFailed'))
    expect(errorText).not.toHaveBeenCalled()
  })
})
