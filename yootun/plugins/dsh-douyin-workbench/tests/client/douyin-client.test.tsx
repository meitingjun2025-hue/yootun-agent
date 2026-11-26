/**
 * client 组件测试（jsdom）：7 Tab 布局契约、D6–D8 占位、各页结构（总览/作品/
 * 排期/报表）、状态态、按钮语义（primary vs ghost vs danger）、键盘路径（行
 * Enter 开详情、Esc 关弹层回归焦点）、词典键集、无硬编码 copy、CSS 红线
 * （无旧类名、无字面色值、token 映射、状态/斑马纹/focus/hover 规则存在）。
 * 与 wx/xhs 的 client 测试同款底盘。
 * @module
 */
// @vitest-environment jsdom
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en as kitEn } from '@yootun/dsh-client-ui-kit'
import { en, zh, type DouyinLocaleKey } from '../../src/client/locales.ts'
import { formatCount, formatPercent, reasonText, shanghaiToday, shiftDay } from '../../src/client/format.ts'

/** 字面色值红线：#hex 与 rgb()/rgba()/hsl()/hsla()/oklch()/oklab() 函数色。 */
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab)\(/u
/** 颜色类 style 属性键（几何键之外的着色面）。 */
const COLOR_PROP_RE = /(?:^|[^A-Za-z])(?:color|background|fill|stroke|border|outline)[A-Za-z]*\s*:/u

/** 去块注释与行注释（样式红线扫描不计注释）。 */
function stripSourceComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

const apiMock = vi.hoisted(() => ({ hostAction: vi.fn() }))

vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(cleanup)

const t = (key: DouyinLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key] ?? key
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

/** 概览载荷（排行 1 账号 + 爆款 1 条 + 分布 + 目录）。 */
const overviewPayload = {
  status: 'ready',
  overview: {
    summary: {
      accountCount: 2, workCount: 12, totalPlayCount: 123456, netFansCount: 321,
      completionRate5sPct: 41.2, hotWorkCount: 2, hotRatePct: 16.7,
    },
    accounts: [{
      accountId: 'acc-1', nickname: '账号一', ownerName: '张三', fanCount: 12000,
      windowNetFansCount: 45, windowPlayCount: 90000, workCount: 12, medianPlayCount: 5000,
      hotWorkCount: 2, hotRatePct: 16.7, engagementRatePct: 5.5, sessionStatus: 'ok',
      suspiciousEmptyCollect: false, lastCollectedAt: '2026-11-20T10:00:00Z',
    }, {
      accountId: 'acc-2', nickname: '账号二', ownerName: null, fanCount: 80,
      windowNetFansCount: null, windowPlayCount: null, workCount: 0, medianPlayCount: null,
      hotWorkCount: 0, hotRatePct: null, engagementRatePct: null, sessionStatus: 'expired',
      suspiciousEmptyCollect: true, lastCollectedAt: '2026-10-01T10:00:00Z',
    }],
    hotWorks: [{
      workId: 'w-1', accountId: 'acc-1', accountNickname: '账号一', title: '爆款视频',
      publishTime: '2026-11-18T08:00:00Z', playCount: 99999, engagementRatePct: 8.8,
      fansGainCount: 12, basis: '播放量进入前 1% · 高于中位数 5 倍', labels: ['absolute'],
      promoted: true, rank: null,
    }],
    hotAccountDistribution: [
      { accountId: 'acc-1', nickname: '账号一', hotWorkCount: 2 },
      { accountId: 'acc-2', nickname: '账号二', hotWorkCount: 1 },
    ],
    accountOptions: [
      { accountId: 'acc-1', nickname: '账号一', workCount: 12, ownerName: '张三' },
      { accountId: 'acc-2', nickname: '账号二', workCount: 0, ownerName: null },
    ],
    accountTotal: 2,
  },
}

const accountRow = {
  accountId: 'acc-1', nickname: '账号一', avatar: null, fanCount: 12000,
  sessionStatus: 'ok', sessionCheckedAt: null, lastCollectedAt: '2026-11-20T10:00:00Z',
  ownerName: '张三', deleteState: 'none', isPending: false,
}

/** 作品行（12 列真实 snake_case 字段）。 */
const workRow = {
  work_id: 'w-1', title: '第一条作品', url: 'https://www.douyin.com/video/w-1',
  cover_url: null, duration_s: 61, publish_time: '2026-11-18T08:00:00Z',
  latest_collected_at: '2026-11-20T10:00:00Z', play_count: 123456, collect_count: 100,
  like_count: 200, comment_count: 30, bounce_rate_2s_pct: 22.5, completion_rate_5s_pct: 55.5,
  completion_rate_pct: 33.3, fans_gain_count: -7, avg_watch_duration_s: 9.87,
  avg_view_proportion_pct: 44.4, promoted: false, visibility: null, data_gap: null,
}

/** works.list summary（整账号聚合值；与 workRow 单行数据同源）。 */
const worksSummary = { work_count: 1, play_count: 123456, fans_gain_count: -7, completion_rate_pct: 33.3, gap_count: 0 }
/** 空账号 summary（聚合列全 NULL → null，不造 0）。 */
const worksSummaryEmpty = { work_count: 0, play_count: null, fans_gain_count: null, completion_rate_pct: null, gap_count: 0 }

/** 排期行（服务端 snake_case）。 */
const scheduleRow = (id: number, published: boolean) => ({
  id, account_id: 'acc-1', shooting_date: '2026-11-20', video_content: `内容 ${id}`,
  shooting_status: true, published, asset_link: '', note: '', publish_date: '2026-11-25',
  publish_platforms: ['douyin'], shooting_owner: '张三', editing_owner: '李四', row_version: 1,
})

/** 报表列表行。 */
const reportItem = (reportId: string, status: string, version: number, coreAvailable: boolean | null = null) => ({
  reportId, reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
  status, version, coreAvailable,
  coverageSummary: { coveredAccounts: 1, totalAccounts: 2 },
  finishedAt: '2026-11-21T11:30:00Z', createdAt: null, summary: null,
  errorCode: status === 'failed' ? 'REPORT_MODEL_FAILED' : null, isCurrent: true,
})

beforeEach(() => {
  apiMock.hostAction.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
    if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
    if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
    if (action === 'overview.get') return overviewPayload
    if (action === 'works.list') return { status: 'ready', accountId: args.accountId, works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
    if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
    if (action === 'collect.status') return { status: 'ready', collect: null }
    if (action === 'collectAll.status') return { status: 'ready', batch: null }
    if (action === 'breakdown.rewriteRules') return { status: 'ready', rules: [], total: 0 }
    if (action === 'breakdown.history') return { status: 'ready', history: [], total: 0 }
    if (action === 'material.videos.list') return { status: 'ready', data: { candidates: [], total: 0, offset: 0, limit: 20 } }
    if (action === 'material.facets') return { status: 'ready', tags: [] }
    if (action === 'material.seeds.list') return { status: 'ready', data: { keywords: [], accounts: [], keywordByStatus: {}, accountByStatus: {} } }
    if (action === 'material.runs.list') return { status: 'ready', data: { runs: [], total: 0 } }
    if (action === 'gene.search') {
      return {
        status: 'ready',
        data: {
          results: [], total: 0, hasMore: false, facets: {}, facetsError: false,
          stats: { total: 0, last7d: 0, adoptedRatio: 0, failedCount: 0 }, statsError: false,
          dimensions: [{ id: 'category', name: '品类', maxLabels: 3 }], offset: 0, limit: 20,
        },
      }
    }
    throw new Error(`unexpected action ${action}`)
  })
})

describe('顶级导航（parity 矩阵 §0：7 Tab 固定顺序）', () => {
  it('tablist 顺序与文案恰好 7 项，默认账号总览', () => {
    render(<WorkbenchPage t={t} />)
    const navTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en.panel)
    expect(navTabs.length).toBe(7)
    expect(navTabs.map(tab => tab.textContent)).toEqual([
      en['tab.overview'], en['tab.works'], en['tab.schedule'], en['tab.material'],
      en['tab.breakdown'], en['tab.gene'], en['tab.report'],
    ])
    expect(navTabs[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('单账号分析不是顶级 Tab（总览账号行 Enter 下钻进入，返回保留筛选）', async () => {
    render(<WorkbenchPage t={t} />)
    const row = await screen.findByRole('row', { name: `${en['overview.col.account']} 账号一` })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByRole('button', { name: en['analysis.back'] })).not.toBeNull()
    // 趋势请求窗口固定最近 30 个自然日（今天-29 → 今天，旧插件同口径；展示窗口
    // 由 accountTrendRows 锚定最后一个有效数据日回推 30 天）。
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('account.trend', expect.objectContaining({
      accountId: 'acc-1', metric: 'play', fromDay: shiftDay(shanghaiToday(), -29), toDay: shanghaiToday(),
    })))
    // 下钻不新增顶级 tab。
    const navTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en.panel)
    expect(navTabs.length).toBe(7)
    // 返回总览：筛选区仍可达（筛选保留由页面级 filters 状态承担）。
    fireEvent.click(screen.getByRole('button', { name: en['analysis.back'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['overview.filter.account'] })).not.toBeNull())
  })

  it('单账号分析趋势：account.trend 的 {day, value} 点渲染为折线，不落空态', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'overview.get') return overviewPayload
      // 分析页主体以 account 非空为渲染前提（缺 account 整块不渲染，趋势断言会空转）。
      if (action === 'account.analysis') {
        return {
          status: 'ready',
          analysis: { account: { accountId: 'acc-1', nickname: '账号一', ownerName: null, fanCount: 12000, lastCollectedAt: null, sessionStatus: 'ok', suspiciousEmptyCollect: false } },
        }
      }
      if (action === 'account.trend') {
        // 真实响应形态：trend.points 为 {day, value}（窗口固定今天-29 → 今天）。
        const from = String(args.fromDay)
        return {
          status: 'ready',
          trend: {
            metric: args.metric, gapDays: 0,
            points: [0, 1, 2].map(offset => ({ day: shiftDay(from, offset), value: 416 + offset * 8, elapsedSeconds: 0, counterRevised: false })),
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    const row = await screen.findByRole('row', { name: `${en['overview.col.account']} 账号一` })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByRole('button', { name: en['analysis.back'] })).not.toBeNull()
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('account.trend', expect.objectContaining({ metric: 'play' })))
    // 3 个有效点 → 2 段折线（分段 path 的 d 形如 M x,yL x,y；页面图标 path 不计）；空态文案不出现。
    const lineSegments = (): number => [...document.querySelectorAll('svg path')]
      .filter(path => /^M[\d.]+,[\d.]+L[\d.]+,[\d.]+$/u.test(path.getAttribute('d') ?? '')).length
    await waitFor(() => expect(lineSegments()).toBe(2))
    expect(screen.queryByText(en['trend.empty'])).toBeNull()
    // 30 天窗口横轴只标 5 个日期刻度（旧 axisLabels 同构；逐日标注会互相重叠）。
    const dateLabels = [...document.querySelectorAll('svg text')]
      .filter(node => /^\d{2}-\d{2}$/u.test(node.textContent ?? ''))
    expect(dateLabels.length).toBe(5)
  })

  it('切任意 Tab 收起 AI 弹层（AnalysisPage 随总览面板卸载）', async () => {
    render(<WorkbenchPage t={t} />)
    const row = await screen.findByRole('row', { name: `${en['overview.col.account']} 账号一` })
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: en['analysis.aiEntry'] }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: en['ai.title'] })).not.toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['ai.title'] })).toBeNull())
  })
})

describe('D6/D7/D8 三 Tab 均为真实实现（占位全部消失）', () => {
  it('tab.notReady 文案不再出现于任何 Tab；爆款拆解面板加载 breakdown action', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    expect(await screen.findByRole('button', { name: en['bd.startButton'] })).not.toBeNull()
    expect(screen.queryByText(en['tab.notReady'])).toBeNull()
  })

  it('爆款拆解面板结构（新建区 + 历史列表）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    expect(await screen.findByRole('button', { name: en['bd.startButton'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['bd.downloadButton'] })).not.toBeNull()
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('breakdown.rewriteRules', expect.anything()))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('breakdown.history', expect.anything()))
  })

  it('爆款素材看板为真实实现（四子页 + KPI + 看板表加载 material action）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.videos.list', expect.objectContaining({ scope: 'material' })))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.facets', expect.anything()))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.seeds.list', expect.anything()))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.runs.list', expect.anything()))
    // 四子页 SegmentedControl（页内二级 tablist，aria-label 区别于顶级导航）。
    const sectionTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en['tab.material'])
    expect(sectionTabs.map(tab => tab.textContent?.replace(/ \d+$/u, ''))).toEqual([
      en['mat.section.board'], en['mat.section.keywords'], en['mat.section.accounts'], en['mat.section.runs'],
    ])
  })

  it('爆款基因库为真实实现（检索工具栏 + KPI + facets + 卡片墙加载 gene.search）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('gene.search', expect.objectContaining({ limit: 20 })))
    expect(screen.getByRole('button', { name: en['gene.reset'] })).not.toBeNull()
    for (const key of ['gene.kpi.total', 'gene.kpi.last7d', 'gene.kpi.adopted', 'gene.kpi.failed'] as const) {
      expect(screen.getAllByText(en[key]).length).toBeGreaterThan(0)
    }
    expect(screen.getByText(en['gene.facetsTitle'])).not.toBeNull()
    expect(screen.queryByText(en['tab.notReady'])).toBeNull()
  })
})

describe('账号总览页结构（parity 矩阵 §1）', () => {
  it('4 筛选 + KPI 6 卡 + 排行 11 列 + 爆款 6 列 + 分布 + 提醒 + 导出总览', async () => {
    render(<WorkbenchPage t={t} />)
    await waitFor(() => expect(screen.getByRole('button', { name: en['overview.filter.account'] })).not.toBeNull())
    expect(screen.getByRole('button', { name: en['overview.filter.window'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['overview.filter.sort'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['overview.filter.owner'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['overview.export'] })).not.toBeNull()
    for (const key of ['overview.kpi.accounts', 'overview.kpi.works', 'overview.kpi.totalPlay', 'overview.kpi.netFans', 'overview.kpi.completion5s', 'overview.kpi.hot'] as const) {
      expect(screen.getAllByText(en[key]).length).toBeGreaterThan(0)
    }
    const rankTable = screen.getByRole('table', { name: en['overview.rank.title'] })
    const rankHeaders = [...rankTable.querySelectorAll('thead th')].map(th => th.textContent)
    expect(rankHeaders).toHaveLength(11)
    const hotTable = screen.getByRole('table', { name: en['overview.hot.title'] })
    const hotHeaders = [...hotTable.querySelectorAll('thead th')].map(th => th.textContent)
    expect(hotHeaders).toEqual([
      en['overview.col.video'], en['overview.col.hotOwnerAccount'], en['overview.col.publishTime'],
      en['col.play'], en['overview.col.engagement'], en['overview.col.hotBasis'],
    ])
    expect(document.querySelector(`[aria-label="${en['overview.dist.title']}"]`)).not.toBeNull()
    expect(screen.getByText(en['overview.alerts.title'])).not.toBeNull()
    // 会话过期 / 可疑空采集旗标可见（状态不靠颜色单独承载）。
    expect(screen.getByText(en['overview.tag.expired'])).not.toBeNull()
    expect(screen.getByText(en['overview.tag.suspicious'])).not.toBeNull()
  })

  it('缺失指标整卡消失不造 0（播放增量/净增粉丝缺失 → 卡不渲染）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'overview.get') {
        return {
          status: 'ready',
          overview: {
            summary: { accountCount: 2, workCount: 12, totalPlayCount: null, netFansCount: null, completionRate5sPct: null, hotWorkCount: 1, hotRatePct: null },
            accounts: [], hotWorks: [], accountOptions: [], accountTotal: 0,
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    await waitFor(() => expect(screen.getByText(en['overview.kpi.accounts'])).not.toBeNull())
    expect(screen.queryByText(en['overview.kpi.totalPlay'])).toBeNull()
    expect(screen.queryByText(en['overview.kpi.netFans'])).toBeNull()
    expect(screen.queryByText(en['overview.kpi.completion5s'])).toBeNull()
  })

  it('总览加载失败：显式错误 + 重试（不伪装空数据）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'overview.get') throw new Error('ACCOUNT_NOT_ACCESSIBLE')
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.getByText(en['state.retry'])).not.toBeNull()
    expect(screen.queryByRole('table', { name: en['overview.rank.title'] })).toBeNull()
  })
})

describe('账号作品页（parity 矩阵 §3：唯一两列布局 + 12 列表格）', () => {
  it('左账号栏 + 右作品面板；12 列列序冻结', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByRole('complementary', { name: en['account.title'] })).not.toBeNull()
    const table = await screen.findByRole('table', { name: en['works.table.label'] })
    const headers = [...table.querySelectorAll('thead th')].map(th => {
      const sortText = th.querySelector('button span')
      return (sortText ?? th).textContent
    })
    expect(headers).toEqual([
      en['col.title'], en['col.url'], en['col.play'], en['col.collect'], en['col.like'],
      en['col.comment'], en['col.bounce2s'], en['col.completion5s'], en['col.completion'],
      en['col.fansGain'], en['col.duration'], en['col.proportion'],
    ])
    // 缺失值显示 —：未提供的 5s 完播率列行为 —（workRow 提供了全部值，改为断言排序 aria 存在）。
    expect(table.querySelector('th[aria-sort]')).not.toBeNull()
  })

  it('表头排序三态循环（default → desc → asc → default）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await screen.findByRole('table', { name: en['works.table.label'] })
    const playHeader = screen.getByRole('button', {
      name: t('sort.aria', { label: en['col.play'], order: en['sort.default'] }),
    })
    expect(playHeader.closest('th')?.getAttribute('aria-sort')).toBe('none')
    fireEvent.click(playHeader)
    const descHeader = screen.getByRole('button', {
      name: t('sort.aria', { label: en['col.play'], order: en['sort.desc'] }),
    })
    expect(descHeader.closest('th')?.getAttribute('aria-sort')).toBe('descending')
    fireEvent.click(descHeader)
    const ascHeader = screen.getByRole('button', {
      name: t('sort.aria', { label: en['col.play'], order: en['sort.asc'] }),
    })
    expect(ascHeader.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    fireEvent.click(ascHeader)
    expect(screen.getByRole('button', {
      name: t('sort.aria', { label: en['col.play'], order: en['sort.default'] }),
    }).closest('th')?.getAttribute('aria-sort')).toBe('none')
  })

  it('行 Enter 打开统一作品详情弹层，Esc 关闭并回归焦点', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
      if (action === 'work.get') return { status: 'ready', data: {} }
      if (action === 'work.trend') return { status: 'ready', data: { snapshots: [] } }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const row = await screen.findByRole('row', { name: t('row.detailAria', { title: '第一条作品' }) })
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('第一条作品')
    // 区块顺序冻结：核心指标 → 数据缺口。
    expect(screen.getByText(en['detail.section.core'])).not.toBeNull()
    expect(screen.getByText(en['detail.section.gaps'])).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // 焦点回归触发行（官方 Modal 承担回归）。
    await waitFor(() => expect(document.activeElement).toBe(row))
  })

  it('作品详情观看趋势：留存/跳出双视图渲染曲线、低谷徽标与图例（旧 RetentionTrend 同构）', async () => {
    const point = (key: string, value: number) => ({ key, value })
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
      if (action === 'work.trend') return { status: 'ready', data: { snapshots: [] } }
      if (action === 'work.get') {
        return {
          status: 'ready',
          data: {
            work: {
              ...workRow,
              retention_trend: {
                current: [point('00:00', 100), point('00:10', 46.59), point('00:20', 30.1)],
                similar: [point('00:00', 100), point('00:10', 30.23), point('00:20', 20)],
                valleys: [{ start: 2, end: 4 }, { start: 12, end: 15 }],
              },
              retention_bounce: { current: [point('00:00', 27.5), point('00:10', 5)], similar: [] },
            },
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const row = await screen.findByRole('row', { name: t('row.detailAria', { title: '第一条作品' }) })
    fireEvent.keyDown(row, { key: 'Enter' })
    // 留存视图：两条低谷徽标（轴下方红底白字）+ 低谷区间图例 + 双曲线。
    expect(await screen.findByText(`${en['detail.rt.valleyBadge']}1`)).not.toBeNull()
    expect(screen.getByText(`${en['detail.rt.valleyBadge']}2`)).not.toBeNull()
    expect(screen.getByText(en['detail.rt.legendValley'])).not.toBeNull()
    expect(screen.getByText(en['detail.rt.legendCurrent'])).not.toBeNull()
    expect(screen.getByText(en['detail.rt.legendSimilar'])).not.toBeNull()
    const retentionChart = screen.getByRole('img', { name: new RegExp(`^${en['detail.rt.aria'].split(' ')[0]}`) })
    expect(retentionChart.querySelectorAll('polyline')).toHaveLength(2)
    // 切到跳出视图：读 retention_bounce，图例换成跳出文案，同类曲线缺省不渲染图例。
    fireEvent.click(screen.getByRole('button', { name: en['detail.rt.tabBounce'] }))
    expect(await screen.findByText(en['detail.rt.legendBounce'])).not.toBeNull()
    expect(screen.queryByText(en['detail.rt.legendSimilar'])).toBeNull()
    expect(screen.getByRole('img', { name: new RegExp(`^${en['detail.rt.bounceAria'].split(' ')[0]}`) })).not.toBeNull()
  })

  it('观看趋势真实载荷（99 点曲线 + 3 段低谷）：坐标全部为有限数，无 NaN 元素', async () => {
    // 真机载荷形态：current/similar 各 99 点（00:00–01:38），valleys 三段秒区间。
    // rtSeconds 依赖 RT_MMSS 的捕获组取分钟与秒——正则缺捕获组会让所有按秒
    // 定位的坐标（虚线、低谷带、徽标）变成 NaN（真机 2026-11-23 缺陷）。
    const points = (decay: number): { key: string; value: number }[] =>
      Array.from({ length: 99 }, (_unused, second) => ({
        key: `${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`,
        value: Math.round(100 * Math.exp(-second / decay) * 100) / 100,
      }))
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
      if (action === 'work.trend') return { status: 'ready', data: { snapshots: [] } }
      if (action === 'work.get') {
        return {
          status: 'ready',
          data: {
            work: {
              ...workRow,
              retention_trend: {
                current: points(12),
                similar: points(6),
                valleys: [{ start: 16, end: 17 }, { start: 26, end: 27 }, { start: 43, end: 44 }],
              },
              retention_bounce: { current: points(12).map(point => ({ ...point, value: point.value / 10 })), similar: [], valleys: [] },
            },
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const row = await screen.findByRole('row', { name: t('row.detailAria', { title: '第一条作品' }) })
    fireEvent.keyDown(row, { key: 'Enter' })
    await screen.findByText(`${en['detail.rt.valleyBadge']}1`)
    const chart = screen.getByRole('img', { name: new RegExp(`^${en['detail.rt.aria'].split(' ')[0]}`) })
    // 实线 + 虚线两条曲线齐备。
    const polylines = [...chart.querySelectorAll('polyline')]
    expect(polylines).toHaveLength(2)
    // 全部坐标属性必须是有限数（NaN 会让 React 报 "Expected length, \"NaN\"" 并整条曲线消失）。
    for (const polyline of polylines) {
      for (const pair of (polyline.getAttribute('points') ?? '').split(' ')) {
        const [x, y] = pair.split(',')
        expect(Number.isFinite(Number(x))).toBe(true)
        expect(Number.isFinite(Number(y))).toBe(true)
      }
    }
    for (const rect of chart.querySelectorAll('rect')) {
      expect(Number.isFinite(Number(rect.getAttribute('x')))).toBe(true)
      expect(Number.isFinite(Number(rect.getAttribute('width')))).toBe(true)
    }
    // 三条低谷带按秒区间定位（x 递增且在绘图区内）。
    const bands = [...chart.querySelectorAll('rect')].filter(rect => rect.getAttribute('height') === '114')
    expect(bands).toHaveLength(3)
    const bandXs = bands.map(rect => Number(rect.getAttribute('x')))
    expect(bandXs[0]).toBeLessThan(bandXs[1] ?? 0)
    expect(bandXs[1]).toBeLessThan(bandXs[2] ?? 0)
    expect(bandXs.every(x => x >= 0)).toBe(true)
    // React 不应报告 NaN 属性。
    expect(consoleError.mock.calls.some(call => String(call[0]).includes('NaN'))).toBe(false)
    consoleError.mockRestore()
  })

  it('投流 stale 恢复失败：原始冲突错误与用户输入保留，saving 复位且不自动重发', async () => {
    let workGetCalls = 0
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
      if (action === 'work.get') {
        workGetCalls += 1
        // 第一次打开详情成功；stale-add 恢复重拉直接拒绝。
        if (workGetCalls === 1) return { status: 'ready', data: {} }
        throw new Error('DOUYIN_OPERATION_REQUEST_FAILED')
      }
      if (action === 'work.trend') return { status: 'ready', data: { snapshots: [] } }
      if (action === 'work.promotion.save') throw new Error('PROMOTION_ALREADY_EXISTS')
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const row = await screen.findByRole('row', { name: t('row.detailAria', { title: '第一条作品' }) })
    fireEvent.keyDown(row, { key: 'Enter' })
    await screen.findByRole('dialog', { name: '第一条作品' })
    // 打开投流弹层（详情无 promotion → add 模式）。
    fireEvent.click(await screen.findByRole('button', { name: en['detail.promotion.add'] }))
    expect(await screen.findByRole('dialog', { name: en['promotion.modalTitle'] })).not.toBeNull()
    // 填入用户值。
    fireEvent.change(screen.getByLabelText(en['promotion.field.play']), { target: { value: '5000' } })
    fireEvent.change(screen.getByLabelText(en['promotion.field.cost']), { target: { value: '123.45' } })
    fireEvent.change(screen.getByLabelText(en['promotion.field.fans']), { target: { value: '67' } })
    fireEvent.change(screen.getByLabelText(en['promotion.field.hours']), { target: { value: '8.5' } })
    fireEvent.click(screen.getByRole('button', { name: en['owner.save'] }))
    // 保存冲突 → 恢复重拉失败 → 原始 PROMOTION_ALREADY_EXISTS 文案就近呈现。
    expect(await screen.findByText(en['promotion.error.alreadyExists'])).not.toBeNull()
    // 弹层保持打开、用户输入未被清空。
    expect(screen.getByRole('dialog', { name: en['promotion.modalTitle'] })).not.toBeNull()
    expect((screen.getByLabelText(en['promotion.field.play']) as HTMLInputElement).value).toBe('5000')
    expect((screen.getByLabelText(en['promotion.field.cost']) as HTMLInputElement).value).toBe('123.45')
    expect((screen.getByLabelText(en['promotion.field.fans']) as HTMLInputElement).value).toBe('67')
    expect((screen.getByLabelText(en['promotion.field.hours']) as HTMLInputElement).value).toBe('8.5')
    // saving 复位：保存按钮可再点、无 aria-busy 挂死。
    const save = screen.getByRole('button', { name: en['owner.save'] })
    expect(save.getAttribute('disabled')).toBeNull()
    expect(save.getAttribute('aria-busy')).toBeNull()
    // 不自动重发：work.promotion.save 恰一次；恢复重拉恰一次后停。
    expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'work.promotion.save')).toHaveLength(1)
    expect(workGetCalls).toBe(2)
  })

  it('导出 Excel 按钮存在且为次操作（ghost）；采集按钮为主操作（primary）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const collect = await screen.findByRole('button', { name: en['works.collect'] })
    const refresh = screen.getByRole('button', { name: en['works.refresh'] })
    const exportButton = screen.getByRole('button', { name: en['works.exportExcel'] })
    expect(collect.className).toMatch(/primary/u)
    expect(refresh.className).toMatch(/ghost/u)
    expect(exportButton.className).toMatch(/ghost/u)
    // 相邻不同语义按钮不得同为白底：primary 与 ghost 相邻可辨。
    expect(collect.className).not.toBe(refresh.className)
  })

  it('删除账号入口为 danger 语义（error token 类）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const remove = await screen.findByRole('button', { name: en['account.remove'] })
    expect(remove.className).toMatch(/dangerButton/u)
    const probe = screen.getByRole('button', { name: en['account.probe'] })
    expect(probe.className).toMatch(/ghost/u)
    expect(remove.className).not.toBe(probe.className)
  })
})

describe('发布排期看板（parity 矩阵 §4）', () => {
  beforeEach(() => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'schedule.list') {
        return { status: 'ready', data: { rows: [scheduleRow(3, true), scheduleRow(1, false), scheduleRow(2, false)] } }
      }
      throw new Error(`unexpected action ${action}`)
    })
  })

  it('12 列表头 + 两处副标 + 底部账号栏 chip', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.schedule'] }))
    const table = await screen.findByRole('table', { name: en['tab.schedule'] })
    const headers = [...table.querySelectorAll('thead th')].map(th => th.querySelector('span')?.textContent)
    expect(headers).toEqual([
      en['schedule.col.index'], en['schedule.col.shootingDate'], en['schedule.col.videoContent'],
      en['schedule.col.shootingStatus'], en['schedule.col.published'], en['schedule.col.assetLink'],
      en['schedule.col.note'], en['schedule.col.publishDate'], en['schedule.col.platforms'],
      en['schedule.col.shootingOwner'], en['schedule.col.editingOwner'], en['schedule.col.actions'],
    ])
    expect(screen.getByText(en['schedule.col.shootingStatusSub'])).not.toBeNull()
    expect(screen.getByText(en['schedule.col.assetLinkSub'])).not.toBeNull()
    expect(screen.getByText(en['schedule.accounts'])).not.toBeNull()
    expect(screen.getByRole('button', { name: /账号一/u })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['schedule.add'] }).className).toMatch(/primary/u)
    expect(screen.getByRole('button', { name: en['schedule.refresh'] }).className).toMatch(/ghost/u)
  })

  it('已发布折叠（默认收起；展开后已发布行带 published 类；未发布斑马纹）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.schedule'] }))
    const toggle = await screen.findByRole('button', { name: t('schedule.fold.expand', { count: 1 }) })
    expect(toggle.getAttribute('aria-expanded')).toBeNull()
    fireEvent.click(toggle)
    const publishedRow = await waitFor(() => {
      const row = document.querySelector('tr[data-row-id="3"]')
      expect(row).not.toBeNull()
      return row as HTMLTableRowElement
    })
    expect(publishedRow.className).toMatch(/scheduleRowPublished/u)
    const second = document.querySelector('tr[data-row-id="2"]') as HTMLTableRowElement
    const first = document.querySelector('tr[data-row-id="1"]') as HTMLTableRowElement
    // 未发布按发布日期升序（rowId 1 → 2），第二行组内奇偶斑马纹。
    expect([...document.querySelectorAll('tbody tr')].indexOf(first))
      .toBeLessThan([...document.querySelectorAll('tbody tr')].indexOf(second))
    expect(second.className).toMatch(/scheduleRowStriped/u)
    expect(first.className).not.toMatch(/scheduleRowStriped/u)
  })

  it('底部账号条：chip 按钮选中态 aria-pressed（单行横向滚动容器）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.schedule'] }))
    const chip = await screen.findByRole('button', { name: /账号一/u })
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.className).toMatch(/scheduleAccountChip/u)
    expect(chip.closest('[class*="scheduleAccountBar"]')).not.toBeNull()
  })

  it('保存失败 → 行 error 底色 + 同键重试/放弃修改/刷新；no-op 失焦不发请求', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'schedule.list') return { status: 'ready', data: { rows: [scheduleRow(1, false)] } }
      if (action === 'schedule.rowUpdate') throw new Error('SCHEDULE_VALIDATION_ERROR')
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.schedule'] }))
    const ownerInput = await screen.findByLabelText(en['schedule.col.editingOwner'])
    // no-op：值不变时失焦不调用 rowUpdate。
    fireEvent.blur(ownerInput)
    await waitFor(() => expect(screen.getByText(en['schedule.col.editingOwner'])).not.toBeNull())
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('schedule.rowUpdate', expect.anything())
    // 修改后失焦保存 → 确定性失败（保留输入 + 同键重试 / 放弃修改）。
    fireEvent.change(ownerInput, { target: { value: '王五' } })
    fireEvent.blur(ownerInput)
    const failedRow = await waitFor(() => {
      const row = document.querySelector('tr[data-row-id="1"]') as HTMLTableRowElement
      expect(row.className).toMatch(/scheduleRowError/u)
      return row
    })
    const { within } = await import('@testing-library/react')
    expect(within(failedRow).getByRole('button', { name: en['schedule.row.retry'] })).not.toBeNull()
    expect(within(failedRow).getByRole('button', { name: en['schedule.row.discard'] })).not.toBeNull()
    expect(within(failedRow).getByRole('button', { name: en['schedule.row.refresh'] })).not.toBeNull()
    expect((screen.getByLabelText(en['schedule.col.editingOwner']) as HTMLInputElement).value).toBe('王五')
  })

  it('删除走确认弹层（带行内容），确认按钮为 danger primary', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'schedule.list') return { status: 'ready', data: { rows: [scheduleRow(1, false)] } }
      if (action === 'schedule.rowDelete') return { status: 'ready', data: {} }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.schedule'] }))
    const deleteButton = await screen.findByRole('button', { name: t('schedule.deleteAria', { id: '1' }) })
    fireEvent.click(deleteButton)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en['schedule.deleteBody'])
    const confirm = screen.getByRole('button', { name: en['schedule.deleteConfirm'] })
    expect(confirm.className).toMatch(/dangerButton/u)
    expect(confirm.className).toMatch(/primary/u)
  })
})

describe('AI 报表页（parity 矩阵 §5）', () => {
  beforeEach(() => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'report.list') {
        return {
          status: 'ready',
          data: {
            items: [
              reportItem('r-succ', 'succeeded', 2, true),
              reportItem('r-inc', 'succeeded', 1, false),
              reportItem('r-fail', 'failed', 1),
              reportItem('r-ins', 'insufficient', 1),
              reportItem('r-run', 'running', 1),
            ],
            nextCursor: null,
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
  })

  it('列表：日报/周报切换 + 7 列 + 状态五态 + 加载更多缺省 + 空态文案', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    const table = await screen.findByRole('table', { name: en['tab.report'] })
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent).filter(text => text !== '')
    expect(headers).toEqual([
      en['report.col.period'], en['report.col.status'], en['report.col.version'],
      en['report.col.coverage'], en['report.col.generatedAt'], en['report.col.note'],
    ])
    // 状态五态（已生成 / 数据不全 / 生成失败 / 数据不足 / 生成中）。
    for (const key of ['report.status.succeeded', 'report.status.incomplete', 'report.status.failed', 'report.status.insufficient', 'report.status.running'] as const) {
      expect(screen.getAllByText(en[key]).length).toBeGreaterThan(0)
    }
    // 无 nextCursor 时不渲染加载更多。
    expect(screen.queryByRole('button', { name: en['report.loadMore'] })).toBeNull()
    // 每行查看按钮为次操作。
    expect(screen.getAllByRole('button', { name: en['report.view'] })[0]?.className).toMatch(/ghost/u)
  })

  it('详情：工具栏 + 报表头口径 + KPI 涨红跌绿 + 账号表 —* + 重新生成确认文案', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'report.list') return { status: 'ready', data: { items: [reportItem('r-1', 'succeeded', 2)], nextCursor: null } }
      if (action === 'report.get') {
        return {
          status: 'ready',
          data: {
            report: {
              reportId: 'r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
              status: 'succeeded', outputSchemaVersion: 'daily-v1', errorCode: null, finishedAt: '2026-11-21T11:30:00Z',
              resultJson: {
                data: {
                  generatedAt: '2026-11-21T11:30:00Z',
                  coverage: { totalAccounts: 2, coveredAccounts: 1, lastCollectedAt: '2026-11-21T09:00:00Z', missingAccounts: [{ accountId: 'acc-2', nickname: '账号二', reason: 'session_expired' }], signals: { dailyRows: 2, workSnapshotRows: 5, fansProfileRows: 1, periodWorks: 1 }, insufficientReason: null },
                  coreMetrics: [
                    { key: 'plays', label: '播放增量', value: 12000, available: true, changePct: 8.5, prevValue: 11000, note: null },
                    { key: 'netFans', label: '净增粉丝', value: -40, available: true, changePct: -2.5, prevValue: 10, note: null },
                    { key: 'publishes', label: '发布', value: null, available: false, changePct: null, prevValue: null, note: null },
                  ],
                  trendSeries: { days: ['11-19', '11-20'], bars: [100, null], line: [5, null] },
                  accounts: [{ accountId: 'acc-1', nickname: '账号一', ownerName: '张三', sessionStatus: 'ok', fanCount: 12000, eachAvailable: true, marks: [], metrics: { plays: 12000, netFans: 30, publishes: 1, likes: 10, comments: 2, shares: 3 } }],
                  works: [{ workId: 'w-1', title: '新作品', nickname: '账号一', accountId: 'acc-1', isHot: true, metrics: { plays: 100, likes: 5, comments: 1, fansGain: 2, collects: 3, shares: 4, completion5s: 66.6, bounce2s: 20, avgWatchSeconds: 8 } }],
                  worksOmittedCount: 2,
                  anomalies: [{ type: 'data_gap', message: '账号二缺采' }],
                },
                ai: { summary: '整体稳定', facts: [{ title: '事实一', detail: '细节', evidence: '依据' }], inferences: [{ title: '推断一', detail: null, evidence: null, confidence: 'high' }], recommendations: [], limitations: [] },
              },
            },
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['report.view'] }))
    expect(await screen.findByRole('button', { name: en['report.back'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['report.regenerate'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['report.exportHtml'] }).className).toMatch(/ghost/u)
    expect(screen.getByRole('button', { name: en['report.exportPdf'] })).not.toBeNull()
    expect(screen.getByText(en['report.header.interaction'])).not.toBeNull()
    // KPI 环比：上涨 ▲ / 下跌 ▼ / 无基准 flat。
    expect(screen.getByText(/▲8\.5%/u)).not.toBeNull()
    expect(screen.getByText(/▼2\.5%/u)).not.toBeNull()
    expect(screen.getByText(new RegExp(`${en['report.change.daily']} ${en['report.change.noBase']}`, 'u'))).not.toBeNull()
    // 缺采账号 —* 口径 + QualityBar 缺采清单。
    expect(screen.getByText(/—\*/u)).not.toBeNull()
    expect(screen.getByText(new RegExp(en['report.quality.missing'].replace('{list}', '.*'), 'u'))).not.toBeNull()
    // 重新生成二次确认文案（v{next}）。
    fireEvent.click(screen.getByRole('button', { name: en['report.regenerate'] }))
    expect((await screen.findAllByText(t('report.regenerateBody', { version: 3 }))).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: en['report.regenerateConfirm'] }).className).toMatch(/primary/u)
  })

  it('日报区段：口径标签/小标题区段/账号名加粗/未发布提示胶囊；趋势图悬浮弹数值浮层', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'report.list') return { status: 'ready', data: { items: [reportItem('r-1', 'succeeded', 2)], nextCursor: null } }
      if (action === 'report.get') {
        return {
          status: 'ready',
          data: {
            report: {
              reportId: 'r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
              status: 'succeeded', outputSchemaVersion: 'daily-v1', errorCode: null, finishedAt: '2026-11-21T11:30:00Z',
              resultJson: {
                data: {
                  generatedAt: '2026-11-21T11:30:00Z',
                  coverage: null,
                  coreMetrics: [{ key: 'plays', label: '播放增量', value: 12000, available: true, changePct: 8.5, prevValue: 11000, note: null }],
                  trendSeries: { days: ['11-19', '11-20'], bars: [100, null], line: [5, null] },
                  accounts: [{ accountId: 'acc-1', nickname: '账号一', ownerName: null, sessionStatus: 'ok', fanCount: 12000, eachAvailable: true, marks: ['3 天未发布'], metrics: { plays: 12000, netFans: 30, publishes: 1, likes: 10, comments: 1, shares: 1 } }],
                  works: [], anomalies: [],
                },
                ai: { summary: '整体稳定', facts: [], inferences: [], recommendations: [], limitations: [] },
              },
            },
          },
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['report.view'] }))
    await screen.findByRole('button', { name: en['report.back'] })
    // 口径标签为 dl 的 dt（高亮标签）；三张区段卡（趋势/账号/作品）包区段容器（小标题竖杠加粗）。
    expect(screen.getByText(en['report.header.base']).tagName).toBe('DT')
    expect(document.querySelectorAll('[class*="reportSection"]').length).toBe(3)
    // 账号名加粗类 + 「N 天未发布」提示胶囊。
    expect(screen.getByText('账号一').className).toMatch(/reportAccountName/u)
    expect(screen.getByText('3 天未发布').className).toMatch(/reportMark/u)
    // 较昨日对比行挂 kpiChange（12px 加粗）。
    expect(screen.getByText(/▲8\.5%/u).className).toMatch(/kpiChange/u)
    // 趋势图：悬浮列 → 深色单行气泡只显示「净粉丝: 值」（旧 chart-tip 同构）。
    expect(screen.queryByText(`${en['report.trend.lineTip']}: +5`)).toBeNull()
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^11-19 /u }))
    expect(await screen.findByText(`${en['report.trend.lineTip']}: +5`)).not.toBeNull()
    // 气泡不含柱系列说明与日期标题（避免与图下说明重复）。
    expect(screen.queryByText(en['report.trend.barDaily'])).toBeNull()
    expect(screen.queryByText(en['report.trend.lineNote'])).toBeNull()
  })

  it('PDF 桥不可用：稳定报 export_unsupported，不假成功', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'report.list') return { status: 'ready', data: { items: [reportItem('r-1', 'succeeded', 1)], nextCursor: null } }
      if (action === 'report.get') {
        return { status: 'ready', data: { report: { reportId: 'r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21', status: 'succeeded', outputSchemaVersion: 'daily-v1', errorCode: null, finishedAt: null, resultJson: null } } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['report.view'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['report.exportPdf'] }))
    expect(await screen.findByText(new RegExp(en['reason.export_unsupported'], 'u'))).not.toBeNull()
  })
})

describe('按钮语义与状态样式（parity 矩阵 §8）', () => {
  const cssText = readFileSync(join(process.cwd(), 'src', 'client', 'workbench.module.css'), 'utf8')

  it('危险按钮 = dangerButton 类 + error token；进行中态样式存在', () => {
    expect(cssText).toContain('.dangerButton')
    expect(cssText).toMatch(/\.dangerButton\s*\{\s*color:\s*var\(--dsw-alias-state-error-primary\)/u)
    // runBanner 三色（失败/部分/完成）分别映射不同 token。
    expect(cssText).toMatch(/\.runBanner\[data-tone='failed'\]/u)
    expect(cssText).toMatch(/\.runBanner\[data-tone='partial'\]/u)
    expect(cssText).toMatch(/\.runBanner\[data-tone='completed'\]/u)
    // 行底色由 td 承载（旧插件同构）：saving 品牌 8% / error 8%（状态色优先于斑马纹）、
    // 已发布组成功色 12%、未发布组斑马纹 5%；表头加粗。
    expect(cssText).toMatch(/tr\.scheduleRowSaving td\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-brand-primary\) 8%/u)
    expect(cssText).toMatch(/tr\.scheduleRowError td\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 8%/u)
    expect(cssText).toMatch(/tr\.scheduleRowPublished td\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-state-success-primary\) 12%/u)
    expect(cssText).toMatch(/tr\.scheduleRowStriped td\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-label-primary\) 5%/u)
    expect(cssText).toMatch(/\.scheduleTable th\s*\{[^}]*font-weight: 700/u)
    // 底部账号栏：单行横向滚动（不换行），chip 不压缩。
    expect(cssText).toMatch(/\.scheduleAccountBar\s*\{[^}]*overflow-x: auto/u)
    expect(cssText).toMatch(/\.scheduleAccountChip\s*\{[^}]*flex: none/u)
  })

  it('disabled/focus/hover/pressed/selected 可感知样式规则存在', () => {
    expect(cssText).toMatch(/:focus-visible/u)
    expect(cssText).toMatch(/@media \(hover: hover\)/u)
    // selected（账号卡选中态 aria-current 指示条）。
    expect(cssText).toMatch(/\.accountCard\[aria-current='true'\]/u)
    // pressed/expanded（AI 折叠卡展开箭头旋转）。
    expect(cssText).toMatch(/\.aiCardToggle\[aria-expanded='true'\] \.aiArrow/u)
    // sticky 仅首列（url 列 sticky 已取消——偏移硬编码错位曾致断带与表头消失）。
    expect(cssText).toMatch(/\.cellSticky \{[^}]*position: sticky/u)
    expect(cssText).toMatch(/\.workTable th,[^}]*position: sticky/u)
    expect(cssText).not.toMatch(/\.workTable th:nth-child\(2\)/u)
    // 容器查询三档 + reduced-motion 守卫。
    expect(cssText).toContain('@container yootun-kit-page (max-width: 639px)')
    expect(cssText).toContain('@container yootun-kit-page (max-width: 879px)')
    expect(cssText).toContain('@container yootun-kit-page (max-width: 1119px)')
    expect(cssText).toContain('@container yootun-kit-page (min-width: 880px)')
    expect(cssText).toContain('prefers-reduced-motion')
  })

  it('运行中按钮 aria-busy + disabled（添加账号等待扫码）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'account.beginLogin') return { status: 'ready', login: { loginKey: 'pending-1', status: 'waiting', accountId: null, error: null, saveError: null } }
      if (action === 'account.loginStatus') return { status: 'ready', login: { loginKey: 'pending-1', status: 'waiting', accountId: null, error: null, saveError: null } }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [], total: 0, limit: 10, offset: 0, summary: worksSummaryEmpty }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['account.add'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['account.addBusy'] })).not.toBeNull())
    expect(screen.getByRole('button', { name: en['account.addBusy'] }).getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText(en['account.scanHint'])).not.toBeNull()
  })
})

describe('批量采集启动反馈（collectAll.start）', () => {
  const callsOf = (action: string): number =>
    apiMock.hostAction.mock.calls.filter(([name]) => name === action).length

  /** 刷新微任务队列：hostAction 异步 mock 与页面 promise 链在 act 内全部落定。 */
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

  it('成功启动：resolve 即已启动（不误报「批量采集未启动」），start 后立即 tick 并轮询，终态停轮询', async () => {
    vi.useFakeTimers()
    try {
      let statusCalls = 0
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
        if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
        if (action === 'collect.status') return { status: 'ready', collect: null }
        if (action === 'collectAll.start') {
          return { status: 'ready', batch: { batchId: 'batch-1', status: 'running', phase: 'probing', items: [] } }
        }
        if (action === 'collectAll.status') {
          statusCalls += 1
          // 第 1 次是挂载恢复查询（空态）；start 后立即 tick 运行中；下个间隔终态。
          return statusCalls === 1
            ? { status: 'ready', batch: null }
            : statusCalls === 2
              ? { status: 'ready', batch: { batchId: 'batch-1', status: 'running', phase: 'collecting', total: 1, runnableTotal: 1, runnableDone: 0, currentAccountId: 'acc-1', items: [] } }
              : { status: 'ready', batch: { batchId: 'batch-1', status: 'completed', phase: null, total: 1, runnableTotal: 1, runnableDone: 1, completedCount: 1, partialCount: 0, failedCount: 0, skippedCount: 0, items: [] } }
        }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await flush()
      const baselineStatusCalls = callsOf('collectAll.status')
      fireEvent.click(screen.getByRole('button', { name: en['account.collectAll'] }))
      await flush()
      // Host batch 投影替换乐观态；误导性失败 toast 不出现。
      expect(screen.queryByText(new RegExp(en['batch.startFailed'], 'u'))).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      // 依次 collectAll.start → collectAll.status（受理后立即 tick 一次）。
      const startCallIndex = apiMock.hostAction.mock.calls.findIndex(([name]) => name === 'collectAll.start')
      expect(startCallIndex).toBeGreaterThanOrEqual(0)
      expect(callsOf('collectAll.status') - baselineStatusCalls).toBe(1)
      expect(apiMock.hostAction.mock.calls.findIndex(([name], index) => name === 'collectAll.status' && index > startCallIndex)).toBeGreaterThan(startCallIndex)
      // 批量横幅进入 running（role=status 容器 aria-busy + 进度文案）；按钮运行态禁用。
      expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
      expect(screen.getByText(t('batch.progress.concurrent', { done: 0, total: 1 }))).not.toBeNull()
      expect(screen.getByRole('button', { name: en['account.collectAllRunning'] }).getAttribute('disabled')).not.toBeNull()
      // 第二次 tick 返回终态 → 汇总横幅、停止轮询。
      act(() => { vi.advanceTimersByTime(1600) })
      await flush()
      expect(screen.getByText(t('batch.summary.completed', { completed: 1, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull()
      expect(callsOf('collectAll.status') - baselineStatusCalls).toBe(2)
      act(() => { vi.advanceTimersByTime(3100) })
      await flush()
      expect(callsOf('collectAll.status') - baselineStatusCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collect_busy 失败：toast 报稳定原因、batch 清空、collectAll.status 一次都不调用', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
      if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      if (action === 'collectAll.start') return Promise.reject(new Error('collect_busy'))
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const button = await screen.findByRole('button', { name: en['account.collectAll'] })
    // 挂载恢复查询已落定（恰一次），失败路径自身不再发起 collectAll.status。
    await waitFor(() => expect(callsOf('collectAll.status')).toBe(1))
    const baselineStatusCalls = callsOf('collectAll.status')
    fireEvent.click(button)
    // 失败 toast：startFailed 前缀 + reasonText 收敛的稳定码。
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(`${en['batch.startFailed']}：${reasonText('collect_busy', t)}`)
    // batch 清空：无运行横幅，按钮回到可用态。
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: en['account.collectAll'] }).getAttribute('disabled')).toBeNull()
    expect(callsOf('collectAll.status')).toBe(baselineStatusCalls)
  })

  it('双击守卫：collectAll.start 在途时重复点击不发起第二次调用，且不吞成功路径', async () => {
    vi.useFakeTimers()
    try {
      let resolveStart: ((value: Record<string, unknown>) => void) | null = null
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }
        if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
        if (action === 'collect.status') return { status: 'ready', collect: null }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        if (action === 'collectAll.start') {
          return new Promise<Record<string, unknown>>(resolve => { resolveStart = resolve })
        }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await flush()
      const baselineStatusCalls = callsOf('collectAll.status')
      const button = screen.getByRole('button', { name: en['account.collectAll'] })
      fireEvent.click(button)
      fireEvent.click(button)
      await flush()
      expect(callsOf('collectAll.start')).toBe(1)
      // 释放首个请求：resolve 后照常投影 Host batch 并立即 tick。
      resolveStart?.({ status: 'ready', batch: { batchId: 'batch-1', status: 'running', phase: 'probing', items: [] } })
      await flush()
      expect(callsOf('collectAll.start')).toBe(1)
      expect(callsOf('collectAll.status') - baselineStatusCalls).toBe(1)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('批量面板多账号与熔断展示（collectAll.status 出参增量）', () => {
  const callsOf = (action: string): number =>
    apiMock.hostAction.mock.calls.filter(([name]) => name === action).length

  /** 刷新微任务队列：hostAction 异步 mock 与页面 promise 链在 act 内全部落定。 */
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

  /** 挂载链路落定：账号列表 → 选中账号 → 恢复三路查询。 */
  const settleMount = async (): Promise<void> => { await flush(); await flush() }

  const accountRow2 = { ...accountRow, accountId: 'acc-2', nickname: '账号二' }
  const accountRow3 = { ...accountRow, accountId: 'acc-3', nickname: '账号三' }
  const accountRow4 = { ...accountRow, accountId: 'acc-4', nickname: '账号四' }
  const accountRow5 = { ...accountRow, accountId: 'acc-5', nickname: '账号五' }

  /** 挂载恢复底盘：collect.running 报批量在跑，collectAll.status 按脚本应答。 */
  const mockBatchRecovery = (batch: Record<string, unknown>): void => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow, accountRow2, accountRow3, accountRow4, accountRow5], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
      if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: true }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collectAll.status') return { status: 'ready', batch }
      throw new Error(`unexpected action ${action}`)
    })
  }

  it('运行中：已完成账号数 + 正在采集三账号列表 + 并发数', async () => {
    vi.useFakeTimers()
    try {
      mockBatchRecovery({
        batchId: 'batch-1', status: 'running', phase: 'collecting',
        total: 5, runnableTotal: 5, runnableDone: 2,
        completedCount: 2, partialCount: 0, failedCount: 0, skippedCount: 0, probedCount: 5,
        currentAccountId: 'acc-1', runningAccountIds: ['acc-1', 'acc-2', 'acc-3'], concurrency: 3,
        items: [
          { accountId: 'acc-1', status: 'running', reason: null },
          { accountId: 'acc-2', status: 'running', reason: null },
          { accountId: 'acc-3', status: 'running', reason: null },
        ],
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      expect(screen.getByText(t('batch.progress.concurrent', { done: 2, total: 5 }))).not.toBeNull()
      expect(screen.getByText(t('batch.currentList', { names: '账号一、账号二、账号三' }))).not.toBeNull()
      expect(screen.getByText(t('batch.concurrency', { count: 3 }))).not.toBeNull()
      // 终态收尾：停轮询，不留悬挂定时器。
      act(() => { vi.advanceTimersByTime(1600) })
      await flush()
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行中仅一个账号：正在采集列表只显示该账号', async () => {
    vi.useFakeTimers()
    try {
      mockBatchRecovery({
        batchId: 'batch-1', status: 'running', phase: 'collecting',
        total: 3, runnableTotal: 3, runnableDone: 1,
        completedCount: 1, partialCount: 0, failedCount: 0, skippedCount: 0, probedCount: 3,
        currentAccountId: 'acc-2', runningAccountIds: ['acc-2'], concurrency: 1,
        items: [{ accountId: 'acc-2', status: 'running', reason: null }],
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      expect(screen.getByText(t('batch.currentList', { names: '账号二' }))).not.toBeNull()
      expect(screen.queryByText(t('batch.currentList', { names: '账号一、账号二' }))).toBeNull()
      expect(screen.getByText(t('batch.concurrency', { count: 1 }))).not.toBeNull()
      act(() => { vi.advanceTimersByTime(1600) })
      await flush()
    } finally {
      vi.useRealTimers()
    }
  })

  it('熔断暂停终态：汇总上方暂停提示与剩余数，未完成列表显示疑似风控原因', async () => {
    vi.useFakeTimers()
    try {
      mockBatchRecovery({
        batchId: 'batch-1', status: 'partial', phase: null,
        total: 5, runnableTotal: 5, runnableDone: 3,
        completedCount: 3, partialCount: 0, failedCount: 0, skippedCount: 2, probedCount: 5,
        currentAccountId: null, runningAccountIds: [], concurrency: 3, error: 'risk_paused',
        items: [
          { accountId: 'acc-1', status: 'completed', reason: null },
          { accountId: 'acc-2', status: 'completed', reason: null },
          { accountId: 'acc-3', status: 'completed', reason: null },
          { accountId: 'acc-4', status: 'skipped', reason: 'risk_paused' },
          { accountId: 'acc-5', status: 'skipped', reason: 'risk_paused' },
        ],
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      // 恢复查询收到终态：不进入轮询。
      expect(callsOf('collectAll.status')).toBe(1)
      const pausedNode = screen.getByText(t('batch.paused', { remaining: 2 }))
      const summaryNode = screen.getByText(t('batch.summary.partial', { completed: 3, partial: 0, failed: 0, skipped: 2 }))
      // 暂停提示行在汇总行上方。
      expect(pausedNode.compareDocumentPosition(summaryNode) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      // 未完成列表：两条 risk_paused 条目显示对应原因文案。
      const detail = screen.getByText(en['batch.unfinishedTitle']).parentElement
      expect(detail).not.toBeNull()
      expect(within(detail as HTMLElement).getAllByText(en['batch.reason.riskPaused'])).toHaveLength(2)
      expect(within(detail as HTMLElement).getByText('账号四')).not.toBeNull()
      expect(within(detail as HTMLElement).getByText('账号五')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('采集状态挂载恢复（collect.running；实施单附录 B.2）', () => {
  const callsOf = (action: string): number =>
    apiMock.hostAction.mock.calls.filter(([name]) => name === action).length

  /** 刷新微任务队列：hostAction 异步 mock 与页面 promise 链在 act 内全部落定。 */
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

  /** 挂载链路落定：账号列表 → 选中账号 → 恢复三路查询。 */
  const settleMount = async (): Promise<void> => { await flush(); await flush() }

  const accountRow2 = { ...accountRow, accountId: 'acc-2', nickname: '账号二' }

  const runningView = (accountId: string, index: number, total: number) => ({
    accountId, status: 'running', progress: { phase: 'work', index, total }, error: null, finishedAt: null,
  })

  const completedView = (accountId: string) => ({
    accountId, status: 'completed', progress: {}, error: null, finishedAt: '2026-11-25T10:00:00Z',
  })

  /** 按昵称定位账号卡片（article 容器）。 */
  const cardOf = (nickname: string): HTMLElement => {
    const card = [...document.querySelectorAll('article')].find(node => node.textContent?.includes(nickname))
    expect(card, `${nickname} 卡片存在`).not.toBeNull()
    return card as HTMLElement
  }

  it('D1 挂载时三路查询各一次；无运行中采集时不启动轮询', async () => {
    vi.useFakeTimers()
    try {
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
        if (action === 'collect.status') return { status: 'ready', collect: null }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      await settleMount()
      expect(callsOf('collect.running')).toBe(1)
      expect(callsOf('collect.status')).toBe(1)
      expect(callsOf('collectAll.status')).toBe(1)
      // 无运行中采集：恢复查询之外零轮询调用。
      act(() => { vi.advanceTimersByTime(5000) })
      await flush()
      expect(callsOf('collect.status')).toBe(1)
      expect(callsOf('collectAll.status')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('D2 单账号运行中恢复：按钮采集中禁用、进度来自返回记录、轮询按既有间隔继续、终态刷新', async () => {
    vi.useFakeTimers()
    try {
      let statusCalls = 0
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
        if (action === 'collect.running') return { status: 'ready', collect: runningView('acc-1', 3, 10), batchRunning: false }
        if (action === 'collect.status') {
          statusCalls += 1
          // 恢复查询与恢复轮询的立即 tick 均运行中；1.5s 间隔后的 tick 终态。
          return { status: 'ready', collect: statusCalls <= 2 ? runningView('acc-1', 3, 10) : completedView('acc-1') }
        }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      // 恢复态：按钮「采集中」禁用，进度来自 collect.running 返回记录。
      expect(screen.getByRole('button', { name: en['works.collecting'] }).getAttribute('disabled')).not.toBeNull()
      expect(screen.getByText(t('works.progress.collect', { index: 3, total: 10 }))).not.toBeNull()
      // 恢复查询 + 恢复轮询立即 tick 恰两次；既有间隔内不再调用。
      expect(callsOf('collect.status')).toBe(2)
      act(() => { vi.advanceTimersByTime(1000) })
      await flush()
      expect(callsOf('collect.status')).toBe(2)
      // 1.5s 间隔到 → 终态 → 停轮询并刷新作品当前页与账号列表。
      act(() => { vi.advanceTimersByTime(600) })
      await flush()
      expect(callsOf('collect.status')).toBe(3)
      expect(screen.getByRole('button', { name: en['works.collect'] }).getAttribute('disabled')).toBeNull()
      expect(screen.getByText(en['run.completed'])).not.toBeNull()
      expect(callsOf('works.list')).toBe(2)
      expect(callsOf('accounts.list')).toBe(2)
      act(() => { vi.advanceTimersByTime(3200) })
      await flush()
      expect(callsOf('collect.status')).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('D3 终态记录恢复：横幅显示，不轮询', async () => {
    vi.useFakeTimers()
    try {
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
        if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
        if (action === 'collect.status') return { status: 'ready', collect: completedView('acc-1') }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      expect(screen.getByText(en['run.completed'])).not.toBeNull()
      expect(callsOf('collect.status')).toBe(1)
      act(() => { vi.advanceTimersByTime(3200) })
      await flush()
      expect(callsOf('collect.status')).toBe(1)
      expect(screen.getByRole('button', { name: en['works.collect'] }).getAttribute('disabled')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('D4/I3 recovery_required：横幅「上次采集被中断」出现且 toast 不弹，不进入运行态', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
      if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
      if (action === 'collect.status') {
        // 单账号（count=1）：挂载恢复读取 interrupted（2.5 横幅数据源）。
        return { status: 'ready', collect: null, recovery: 'recovery_required', interrupted: { count: 1, accountIds: ['acc-1'] }, lastRun: { accountId: 'acc-1', status: 'interrupted', progress: {}, error: null, finishedAt: null } }
      }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await settleMount()
    // 横幅出现（单账号文案），旧 toast 文案不再出现（I3）。
    expect(await screen.findByText(en['run.interruptedBannerOne'])).not.toBeNull()
    // 旧 toast 键已删：若回归会渲染键名回退（t 返回 en[key] ?? key），断言键名不出现。
    expect(screen.queryByText('run.interrupted')).toBeNull()
    // 选中账号在 accountIds 内 → 「重新采集」按钮；count<2 无「重新采集全部」。
    expect(screen.getByRole('button', { name: en['run.recollect'] })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en['run.recollectAll'] })).toBeNull()
    // 不进入运行态：按钮可用、无进度文案。
    expect(screen.getByRole('button', { name: en['works.collect'] }).getAttribute('disabled')).toBeNull()
    expect(screen.queryByRole('button', { name: en['works.collecting'] })).toBeNull()
    expect(screen.queryByText(en['works.progress.fallback'])).toBeNull()
    // I4：点「重新采集」走账号栏「采集」同一启动路径（collect.start）。
    fireEvent.click(screen.getByRole('button', { name: en['run.recollect'] }))
    await vi.waitFor(() => {
      const startCalls = apiMock.hostAction.mock.calls.filter(([action]) => action === 'collect.start')
      expect(startCalls.length).toBeGreaterThan(0)
      expect((startCalls[0]?.[1] as Record<string, unknown>).accountId).toBe('acc-1')
    })
  })

  it('D4b/I4 关闭按钮：横幅隐藏且不再出现（本页面会话内），Host 摘要仍在', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
      if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
      if (action === 'collect.status') {
        // 双账号摘要 + 「重新采集全部」入口（count >= 2 分支）。
        return { status: 'ready', collect: null, recovery: 'recovery_required', interrupted: { count: 2, accountIds: ['acc-1', 'acc-2'] }, lastRun: { accountId: 'acc-1', status: 'interrupted', progress: {}, error: null, finishedAt: null } }
      }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await settleMount()
    // count >= 2：多账号文案 + 「重新采集全部」按钮出现。
    expect(await screen.findByText(t('run.interruptedBanner', { count: 2 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: en['run.recollectAll'] })).not.toBeNull()
    // 点关闭：横幅消失。
    fireEvent.click(screen.getByRole('button', { name: en['run.dismissBanner'] }))
    expect(screen.queryByText(t('run.interruptedBanner', { count: 2 }))).toBeNull()
  })

  it('D5 批量运行中恢复：面板与账号栏按返回值渲染，轮询继续；终态显示汇总不轮询', async () => {
    vi.useFakeTimers()
    try {
      let batchCalls = 0
      const runningBatch = { batchId: 'batch-1', status: 'running', phase: 'collecting', total: 2, runnableTotal: 2, runnableDone: 1, completedCount: 1, partialCount: 0, failedCount: 0, skippedCount: 0, probedCount: 2, currentAccountId: 'acc-2', items: [{ accountId: 'acc-1', status: 'completed', reason: null }, { accountId: 'acc-2', status: 'running', reason: null }] }
      const doneBatch = { batchId: 'batch-1', status: 'completed', phase: null, total: 2, runnableTotal: 2, runnableDone: 2, completedCount: 2, partialCount: 0, failedCount: 0, skippedCount: 0, probedCount: 2, currentAccountId: null, items: [{ accountId: 'acc-1', status: 'completed', reason: null }, { accountId: 'acc-2', status: 'completed', reason: null }] }
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow, accountRow2], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
        if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: true }
        if (action === 'collect.status') return { status: 'ready', collect: null }
        if (action === 'collectAll.status') {
          batchCalls += 1
          // 恢复查询给运行中（立即 tick 复读），1.5s 后的 tick 终态。
          return { status: 'ready', batch: batchCalls <= 2 ? runningBatch : doneBatch }
        }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      // 面板运行中渲染 + 账号栏 acc-2 显示采集中。
      expect(screen.getByText(t('batch.progress.concurrent', { done: 1, total: 2 }))).not.toBeNull()
      expect(within(cardOf('账号二')).getByText(en['account.collecting'])).not.toBeNull()
      // 恢复查询 + 恢复轮询立即 tick 恰两次。
      expect(callsOf('collectAll.status')).toBe(2)
      act(() => { vi.advanceTimersByTime(1600) })
      await flush()
      expect(screen.getByText(t('batch.summary.completed', { completed: 2, partial: 0, failed: 0, skipped: 0 }))).not.toBeNull()
      expect(callsOf('collectAll.status')).toBe(3)
      act(() => { vi.advanceTimersByTime(3200) })
      await flush()
      expect(callsOf('collectAll.status')).toBe(3)
      // 终态后 acc-2 状态点消失。
      expect(within(cardOf('账号二')).queryByText(en['account.collecting'])).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('D5b collect.running 无批量且查询为 null：无批量面板，采集全部可用', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
      if (action === 'collect.running') return { status: 'ready', collect: null, batchRunning: false }
      if (action === 'collect.status') return { status: 'ready', collect: null }
      if (action === 'collectAll.status') return { status: 'ready', batch: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await settleMount()
    expect(screen.queryByText(en['batch.unfinishedTitle'])).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: en['account.collectAll'] }).getAttribute('disabled')).toBeNull()
  })

  it('D6 恢复响应到达前用户点采集：恢复结果丢弃', async () => {
    vi.useFakeTimers()
    try {
      let resolveRunning: ((value: Record<string, unknown>) => void) | null = null
      let resolveRecoveryStatus: ((value: Record<string, unknown>) => void) | null = null
      let statusCalls = 0
      apiMock.hostAction.mockImplementation(async (action: string) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
        if (action === 'collect.running') {
          return new Promise<Record<string, unknown>>(resolve => { resolveRunning = resolve })
        }
        if (action === 'collect.status') {
          statusCalls += 1
          // 第 1 次是恢复查询（挂起待释放）；其后是用户采集的轮询 tick。
          if (statusCalls === 1) {
            return new Promise<Record<string, unknown>>(resolve => { resolveRecoveryStatus = resolve })
          }
          return { status: 'ready', collect: runningView('acc-1', 1, 5) }
        }
        if (action === 'collect.start') return { status: 'ready', collect: runningView('acc-1', 1, 5) }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      // 用户先点采集（恢复响应尚未到达）→ 运行态来自用户自己的 collect.start。
      fireEvent.click(screen.getByRole('button', { name: en['works.collect'] }))
      await flush()
      expect(screen.getByRole('button', { name: en['works.collecting'] }).getAttribute('disabled')).not.toBeNull()
      expect(screen.getByText(t('works.progress.collect', { index: 1, total: 5 }))).not.toBeNull()
      // 迟到的恢复响应：stale 运行投影（9/9）与终态记录都不得覆盖用户采集。
      resolveRunning?.({ status: 'ready', collect: runningView('acc-1', 9, 9), batchRunning: false })
      resolveRecoveryStatus?.({ status: 'ready', collect: completedView('acc-1') })
      await flush()
      expect(screen.getByText(t('works.progress.collect', { index: 1, total: 5 }))).not.toBeNull()
      expect(screen.queryByText(t('works.progress.collect', { index: 9, total: 9 }))).toBeNull()
      expect(screen.queryByText(en['run.completed'])).toBeNull()
      expect(screen.getByRole('button', { name: en['works.collecting'] }).getAttribute('disabled')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('D7 其他账号在采：该账号卡片显示采集中，选中面板不显示其进度，按钮禁用', async () => {
    vi.useFakeTimers()
    try {
      apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
        if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
        if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow, accountRow2], remoteError: null }
        if (action === 'works.list') return { status: 'ready', accountId: args.accountId, works: [workRow], total: 1 }
        if (action === 'collect.running') return { status: 'ready', collect: runningView('acc-2', 2, 8), batchRunning: false }
        if (action === 'collect.status') {
          // 选中账号的恢复查询给空；acc-2 的恢复轮询给运行中。
          return args.accountId === 'acc-2' ? { status: 'ready', collect: runningView('acc-2', 2, 8) } : { status: 'ready', collect: null }
        }
        if (action === 'collectAll.status') return { status: 'ready', batch: null }
        throw new Error(`unexpected action ${action}`)
      })
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await settleMount()
      expect(within(cardOf('账号二')).getByText(en['account.collecting'])).not.toBeNull()
      expect(within(cardOf('账号一')).queryByText(en['account.collecting'])).toBeNull()
      // 选中账号（acc-1）面板：按钮禁用、不显示 acc-2 的进度。
      expect(screen.getByRole('button', { name: en['works.collect'] }).getAttribute('disabled')).not.toBeNull()
      expect(screen.queryByText(t('works.progress.collect', { index: 2, total: 8 }))).toBeNull()
      // 轮询按 acc-2 继续（既有 tick）。
      expect(apiMock.hostAction).toHaveBeenCalledWith('collect.status', { accountId: 'acc-2' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('作品列表服务端分页 / 排序 / KPI 行', () => {
  const summary183 = { work_count: 183, play_count: 1250000, fans_gain_count: 4021, completion_rate_pct: 38.27, gap_count: 4 }
  const account2 = { ...accountRow, accountId: 'acc-2', nickname: '账号二' }
  /** works.list 全部调用参数（最近一次 = at(-1)）。 */
  let worksCalls: Array<Record<string, unknown>>
  /** 刷新微任务队列：hostAction 异步 mock 与页面 promise 链在 act 内全部落定。 */
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
  /** 播放列表头的可达名称（随排序态变化）。 */
  const playAria = (order: 'default' | 'desc' | 'asc'): string =>
    t('sort.aria', { label: en['col.play'], order: order === 'desc' ? en['sort.desc'] : order === 'asc' ? en['sort.asc'] : en['sort.default'] })
  /** kit Pager 信息文案（en 词典直取；页面 kitTranslate 为 en）。 */
  const pagerInfo = (total: number, page: number, pages: number): string =>
    kitEn['pager.info'].replace('{total}', String(total)).replace('{page}', String(page)).replace('{pages}', String(pages))
  /** 双账号 + total 183 分页 mock：行按 offset 命名并记录 works.list 调用参数。 */
  const installWorksMock = (extra: (action: string, args: Record<string, unknown>) => Record<string, unknown> | undefined = () => undefined): void => {
    worksCalls = []
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow, account2], remoteError: null }
      if (action === 'works.list') {
        worksCalls.push({ ...args })
        return {
          status: 'ready',
          accountId: args.accountId,
          works: [{ ...workRow, work_id: `w-${String(args.offset)}`, title: `作品 ${String(args.offset)}` }],
          total: 183, limit: 10, offset: typeof args.offset === 'number' ? args.offset : 0,
          summary: summary183,
        }
      }
      const extraResult = extra(action, args)
      if (extraResult !== undefined) return extraResult
      throw new Error(`unexpected action ${action}`)
    })
  }

  it('进入作品页拉第 1 页（limit 10 / offset 0 / publish_time desc）；点表头发新参数回第 1 页；三态循环', async () => {
    installWorksMock()
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(worksCalls[0]).toEqual({ accountId: 'acc-1', sort: 'publish_time', order: 'desc', limit: 10, offset: 0 }))
    fireEvent.click(screen.getByRole('button', { name: playAria('default') }))
    await waitFor(() => expect(worksCalls.at(-1)).toEqual({ accountId: 'acc-1', sort: 'play_count', order: 'desc', limit: 10, offset: 0 }))
    fireEvent.click(screen.getByRole('button', { name: playAria('desc') }))
    await waitFor(() => expect(worksCalls.at(-1)).toEqual({ accountId: 'acc-1', sort: 'play_count', order: 'asc', limit: 10, offset: 0 }))
    fireEvent.click(screen.getByRole('button', { name: playAria('asc') }))
    await waitFor(() => expect(worksCalls.at(-1)).toEqual({ accountId: 'acc-1', sort: 'publish_time', order: 'desc', limit: 10, offset: 0 }))
  })

  it('切账号回第 1 页且排序态保留', async () => {
    installWorksMock()
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(worksCalls.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: playAria('default') }))
    await waitFor(() => expect(worksCalls.at(-1)?.sort).toBe('play_count'))
    fireEvent.click(await screen.findByText('账号二'))
    await waitFor(() => expect(worksCalls.at(-1)).toEqual({ accountId: 'acc-2', sort: 'play_count', order: 'desc', limit: 10, offset: 0 }))
  })

  it('翻页只变 offset：排序与 limit 不变，信息文案随页推进', async () => {
    installWorksMock()
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText(pagerInfo(183, 1, 19))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: kitEn['pager.next'] }))
    await waitFor(() => expect(worksCalls.at(-1)).toEqual({ accountId: 'acc-1', sort: 'publish_time', order: 'desc', limit: 10, offset: 10 }))
    expect(await screen.findByText('作品 10')).not.toBeNull()
    expect(screen.getByText(pagerInfo(183, 2, 19))).not.toBeNull()
  })

  it('过期响应丢弃：慢的旧排序响应整体丢弃，不覆盖最新数据', async () => {
    let resolveSecond: ((value: Record<string, unknown>) => void) | null = null
    let worksCallCount = 0
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') {
        worksCallCount += 1
        if (worksCallCount === 2) {
          return new Promise<Record<string, unknown>>(resolve => { resolveSecond = resolve })
        }
        return {
          status: 'ready',
          accountId: args.accountId,
          works: [{ ...workRow, work_id: `w-${worksCallCount}`, title: worksCallCount >= 3 ? '收藏排序行' : '首发行' }],
          total: 183, limit: 10, offset: 0, summary: summary183,
        }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText('首发行')).not.toBeNull()
    // 点播放表头（请求 2 挂起，旧行保留）→ 再点播放表头升序（请求 3 立即返回）。
    fireEvent.click(screen.getByRole('button', { name: playAria('default') }))
    await waitFor(() => expect(worksCallCount).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: playAria('desc') }))
    expect(await screen.findByText('收藏排序行')).not.toBeNull()
    resolveSecond?.({ status: 'ready', accountId: 'acc-1', works: [{ ...workRow, work_id: 'w-stale', title: '过期播放行' }], total: 183, limit: 10, offset: 0, summary: summary183 })
    await flush()
    expect(screen.queryByText('过期播放行')).toBeNull()
    expect(screen.getByText('收藏排序行')).not.toBeNull()
  })

  it('采集完成后刷新当前页（offset 不回 0）', async () => {
    installWorksMock((action, args) => {
      if (action === 'collect.start') return { status: 'ready', collect: { accountId: args.accountId, status: 'running', phase: 'work', progress: { phase: 'work', index: 1, total: 3 }, error: null, finishedAt: null } }
      if (action === 'collect.status') return { status: 'ready', collect: { accountId: args.accountId, status: 'completed', phase: null, progress: {}, error: null, finishedAt: '2026-11-25T00:00:00Z' } }
      return undefined
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(worksCalls.length).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: kitEn['pager.next'] }))
    await waitFor(() => expect(worksCalls.at(-1)?.offset).toBe(10))
    fireEvent.click(screen.getByRole('button', { name: en['works.collect'] }))
    await waitFor(() => {
      const last = worksCalls.at(-1)
      expect(last?.offset).toBe(10)
      expect(last?.accountId).toBe('acc-1')
    })
    // 采集完成后 works.list 恰好再发一次（当前页重拉，不清缓存外账号）。
    expect(worksCalls.length).toBe(3)
  })

  it('KPI 四卡取值来自 summary；不再有缺口作品卡；工具栏不再有全部时间作品数', async () => {
    installWorksMock()
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText(en['works.kpi.worksTotal'])).not.toBeNull()
    expect(screen.getByText(en['works.kpi.playTotal'])).not.toBeNull()
    expect(screen.getByText(en['works.kpi.fansGainTotal'])).not.toBeNull()
    // 完播率卡与表格列头同文案（≥ 2 处）；卡值由 formatPercent(38.27) 单独锚定。
    expect(screen.getAllByText(en['works.kpi.completion']).length).toBeGreaterThanOrEqual(2)
    // 数量契约：摘要卡固定 4 张（缺口作品卡已删）。
    const summaryGrid = screen.getByText(en['works.kpi.worksTotal']).closest('div')
    expect(summaryGrid?.children.length).toBe(4)
    expect(screen.getByText(formatCount(183))).not.toBeNull()
    expect(screen.getByText(formatCount(1250000))).not.toBeNull()
    expect(screen.getByText(formatCount(4021))).not.toBeNull()
    expect(screen.getByText(formatPercent(38.27))).not.toBeNull()
    expect(screen.queryByText(/Works \(all time\)/u)).toBeNull()
  })

  it('KPI：summary 聚合列缺失显示「—」不造 0', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') {
        return { status: 'ready', accountId: args.accountId, works: [workRow], total: 1, limit: 10, offset: 0, summary: { work_count: 1, play_count: null, fans_gain_count: null, completion_rate_pct: null, gap_count: 0 } }
      }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await screen.findByRole('table', { name: en['works.table.label'] })
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
  })

  /** KPI 卡取值：标签所在卡片的第 2 个 span（值）。 */
  const kpiValueOf = (label: string): string | null | undefined =>
    screen.getByText(label).parentElement?.querySelector('span:nth-child(2)')?.textContent
  const baseHandlers = (worksList: (args: Record<string, unknown>) => unknown): ((action: string, args: Record<string, unknown>) => Promise<unknown>) =>
    async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return worksList(args)
      throw new Error(`unexpected action ${action}`)
    }
  const worksRegion = (): HTMLElement => screen.getByRole('region', { name: en['works.table.scrollLabel'] })

  it('作品加载失败：KPI 四卡显示「—」，列表区域只给一处出错提示与一个重试', async () => {
    apiMock.hostAction.mockImplementation(baseHandlers(() => { throw new Error('DOUYIN_OPERATION_REQUEST_FAILED') }))
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    // 出错提示与重试只在列表区域出现一次；卡片不再逐个重复。
    expect((await screen.findAllByText(kitEn['state.error'])).length).toBe(1)
    expect(screen.getAllByRole('button', { name: kitEn['state.retry'] }).length).toBe(1)
    expect(worksRegion().contains(screen.getByText(kitEn['state.error']))).toBe(true)
    expect(screen.queryByText(kitEn['state.empty'])).toBeNull()
    expect(screen.queryByText(kitEn['state.partial'])).toBeNull()
    for (const key of ['works.kpi.worksTotal', 'works.kpi.playTotal', 'works.kpi.fansGainTotal', 'works.kpi.completion'] as const) {
      expect(kpiValueOf(en[key])).toBe('—')
    }
    expect(screen.queryByRole('button', { name: kitEn['pager.next'] })).toBeNull()
  })

  it('部分失败（刷新时 works.list 失败）：保留已展示的行，不出现「部分数据」提示，工具栏提示刷新失败', async () => {
    let failNext = false
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'works.list' && failNext) {
        failNext = false
        throw new Error('DOUYIN_OPERATION_REQUEST_FAILED')
      }
      return baseHandlers(() => ({ status: 'ready', accountId: 'acc-1', works: [workRow], total: 1, limit: 10, offset: 0, summary: worksSummary }))(action, args)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    failNext = true
    fireEvent.click(screen.getByRole('button', { name: en['works.refresh'] }))
    // 行保留；卡片与列表区域都不再出现 partial 文案；失败由工具栏的一行提示负责。
    await waitFor(() => expect(screen.getByText(en['works.refreshPartial'].replace('{parts}', en['works.refreshPart.works']))).not.toBeNull())
    expect(screen.getByText('第一条作品')).not.toBeNull()
    expect(screen.queryByText(kitEn['state.partial'])).toBeNull()
    expect(screen.queryByText(kitEn['state.error'])).toBeNull()
    expect(kpiValueOf(en['works.kpi.worksTotal'])).toBe(String(worksSummary.work_count))
  })

  it('加载中：列表区域显示骨架，不显示「暂无数据」', async () => {
    apiMock.hostAction.mockImplementation(baseHandlers(() => new Promise(() => {})))
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(within(worksRegion()).getByText(kitEn['state.loading'])).not.toBeNull())
    expect(screen.queryByText(kitEn['state.empty'])).toBeNull()
    expect(worksRegion().getAttribute('data-state')).toBe('loading')
  })

  it('无账号可选：KPI 四卡为「—」，列表区域显示「暂无数据」而不是一直加载', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [], remoteError: null }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText(kitEn['state.empty'])).not.toBeNull()
    expect(worksRegion().getAttribute('data-state')).toBe('blank')
    expect(within(worksRegion()).getByText(kitEn['state.empty'])).not.toBeNull()
    expect(within(worksRegion()).queryByText(kitEn['state.loading'])).toBeNull()
    expect(kpiValueOf(en['works.kpi.worksTotal'])).toBe('—')
  })

  it('Pager total 来自服务端：信息文案与下一页按钮可用', async () => {
    installWorksMock()
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText(pagerInfo(183, 1, 19))).not.toBeNull()
    expect(screen.getByRole('button', { name: kitEn['pager.next'] }).getAttribute('disabled')).toBeNull()
    expect(screen.getByRole('button', { name: kitEn['pager.prev'] }).getAttribute('disabled')).not.toBeNull()
  })

  it('total=0：导出按钮禁用且不渲染 Pager 按钮', async () => {
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [accountRow], remoteError: null }
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [], total: 0, limit: 10, offset: 0, summary: worksSummaryEmpty }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const exportButton = await screen.findByRole('button', { name: en['works.exportExcel'] })
    await waitFor(() => expect(exportButton.getAttribute('disabled')).not.toBeNull())
    expect(screen.queryByRole('button', { name: kitEn['pager.next'] })).toBeNull()
    expect(screen.queryByRole('button', { name: kitEn['pager.prev'] })).toBeNull()
    // 列表区域始终存在；空列表在区域正中显示「暂无数据」（en：No data），不出错、不加载。
    expect(within(worksRegion()).getByText(kitEn['state.empty'])).not.toBeNull()
    expect(worksRegion().getAttribute('data-state')).toBe('blank')
    expect(screen.queryByText(kitEn['state.error'])).toBeNull()
  })
})

describe('词典与源码红线', () => {
  const clientDir = join(process.cwd(), 'src', 'client')

  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('R2：路由层拒绝原因（forbidden/unknown_action/method_not_allowed）显示 kit 2.6 文案', () => {
    const t = (key: DouyinLocaleKey): string => en[key] ?? key
    expect(reasonText('forbidden', t)).toBe(`${en['reason.forbidden']}（forbidden）`)
    expect(reasonText('unknown_action', t)).toBe(`${en['reason.unknown_action']}（unknown_action）`)
    expect(reasonText('method_not_allowed', t)).toBe(`${en['reason.method_not_allowed']}（method_not_allowed）`)
  })

  it('无硬编码 copy：组件文本均经 t()（词典外无中文字面量）', () => {
    for (const name of readdirSync(clientDir)) {
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
      if (name === 'locales.ts') continue
      const source = readFileSync(join(clientDir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/[^\n]*/gu, '')
      const chinese = source.match(/[一-鿿]+/gu)
      expect(chinese, `${name} 存在词典外中文: ${chinese?.join('、')}`).toBeNull()
    }
  })

  it('无旧 HTML inline style / 字面色值，图表动态几何与 token 例外符合现行规范（扫描 src/client 全部 .tsx 与 .module.css）', () => {
    const files = readdirSync(clientDir).filter(name => name.endsWith('.tsx') || name.endsWith('.css'))
    expect(files.length).toBeGreaterThan(10)
    for (const name of files) {
      const source = stripSourceComments(readFileSync(join(clientDir, name), 'utf8'))
      // 旧 HTML inline style（字符串 style="..."）与字面色值（#hex / rgb()/
      // rgba()/hsl()/hsla()/oklch()/oklab()）一律禁止——wx/xhs 现行规范。
      expect(source, `${name} 含旧 HTML inline style`).not.toContain('style="')
      expect(source, `${name} 含字面色值`).not.toMatch(COLOR_LITERAL_RE)
      expect(source, `${name} 含旧 ydo- 类名`).not.toMatch(/\bydo-/u)
    }
    const css = stripSourceComments(readFileSync(join(clientDir, 'workbench.module.css'), 'utf8'))
    expect(css).toContain('var(--dsw-alias-')
    expect(css).toContain('var(--yt-chart-')
  })

  it('TSX 动态 style 仅限图表几何；颜色类 style 属性必须引用 --yt-chart-*/--dsw-* token（直接引用或经文件内 token 映射函数）', () => {
    for (const name of readdirSync(clientDir).filter(item => item.endsWith('.tsx'))) {
      const source = stripSourceComments(readFileSync(join(clientDir, name), 'utf8'))
      expect(source, `${name} window.confirm/alert`).not.toMatch(/window\.(confirm|alert)\(/u)
      expect(source, `${name} dangerouslySetInnerHTML`).not.toMatch(/dangerouslySetInnerHTML/u)
      for (const match of source.matchAll(/style=\{\{([\s\S]*?)\}\}/gu)) {
        const body = match[1] ?? ''
        // 几何键（width/height/left/top/…）自由；颜色类键的值必须直接引用
        // var(--yt-chart-*/--dsw-*)，或是文件内定义、返回 token 串的映射
        // 函数调用（如性别环 colorOf——其实现逐一返回 var(--yt-chart-*)）。
        if (COLOR_PROP_RE.test(body) && !/var\(--(yt-chart|dsw)-/u.test(body)) {
          expect(body, `${name} 颜色类 style 属性必须是 token 引用或映射函数调用`).toMatch(/[A-Za-z_$][\w$]*\(/u)
          expect(source, `${name} 必须定义返回 token 的颜色映射`).toMatch(/var\(--(yt-chart|dsw)-/u)
        }
      }
    }
  })

  it('关键页面逐文件通过红线扫描（OverviewPage / WorkDetailModal / charts / ReportPage）', () => {
    for (const name of ['OverviewPage.tsx', 'WorkDetailModal.tsx', 'charts.tsx', 'ReportPage.tsx']) {
      expect(existsSync(join(clientDir, name)), `${name} 应存在`).toBe(true)
      const source = stripSourceComments(readFileSync(join(clientDir, name), 'utf8'))
      expect(source, `${name} inline style`).not.toContain('style="')
      expect(source, `${name} 字面色值`).not.toMatch(COLOR_LITERAL_RE)
      expect(source, `${name} dangerouslySetInnerHTML`).not.toMatch(/dangerouslySetInnerHTML/u)
    }
  })

  it('ReportPage 导出 HTML 的自包含 token 内联（专门例外）：运行时经 resolveToken/getComputedStyle 解析，源码零字面色值', () => {
    const source = readFileSync(join(clientDir, 'ReportPage.tsx'), 'utf8')
    // 导出的自包含 HTML 颜色在运行时由 token 解析内联（getComputedStyle），
    // 源码层不出现任何字面色值——这是与全局红线并存的受控例外，由本测试锁定。
    expect(source).toMatch(/resolveToken/u)
    expect(source).toMatch(/getComputedStyle/u)
    expect(stripSourceComments(source)).not.toMatch(COLOR_LITERAL_RE)
  })
})
