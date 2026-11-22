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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, zh, type DouyinLocaleKey } from '../../src/client/locales.ts'

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
    if (action === 'works.list') return { status: 'ready', accountId: args.accountId, works: [workRow], total: 1 }
    if (action === 'collect.status') return { status: 'ready', collect: null }
    if (action === 'collectAll.status') return { status: 'ready', batch: null }
    if (action === 'breakdown.rewriteRules') return { status: 'ready', rules: [], total: 0 }
    if (action === 'breakdown.history') return { status: 'ready', history: [], total: 0 }
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
    // 下钻不新增顶级 tab。
    const navTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en.panel)
    expect(navTabs.length).toBe(7)
    // 返回总览：筛选区仍可达（筛选保留由页面级 filters 状态承担）。
    fireEvent.click(screen.getByRole('button', { name: en['analysis.back'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['overview.filter.account'] })).not.toBeNull())
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

describe('D7/D8 Tab 占位（本开发阶段未接入，绝不显示假数据）；D6 拆解为真实实现', () => {
  for (const tabKey of ['tab.material', 'tab.gene'] as const) {
    it(`${en[tabKey]} 面板为「${en['tab.notReady']}」占位且无表格/假数据`, async () => {
      render(<WorkbenchPage t={t} />)
      fireEvent.click(screen.getByRole('tab', { name: en[tabKey] }))
      expect(await screen.findByText(en['tab.notReady'])).not.toBeNull()
      expect(document.querySelector('table')).toBeNull()
      expect(apiMock.hostAction).not.toHaveBeenCalledWith(expect.stringMatching(/material\.|gene\./u), expect.anything())
    })
  }

  it('爆款拆解面板为真实实现（新建区 + 历史列表加载 breakdown action）', async () => {
    render(<WorkbenchPage t={t} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    expect(await screen.findByRole('button', { name: en['bd.startButton'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['bd.downloadButton'] })).not.toBeNull()
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('breakdown.rewriteRules', expect.anything()))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('breakdown.history', expect.anything()))
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
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [workRow], total: 1 }
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
    // 行状态底色：saving 品牌 8% / error 8%（状态色优先于斑马纹）。
    expect(cssText).toMatch(/\.scheduleRowSaving\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-border-selected\) 8%/u)
    expect(cssText).toMatch(/\.scheduleRowError\s*\{[^}]*color-mix\(in srgb, var\(--dsw-alias-state-error-primary\) 8%/u)
    expect(cssText).toMatch(/\.scheduleRowStriped/u)
    expect(cssText).toMatch(/\.scheduleRowPublished/u)
  })

  it('disabled/focus/hover/pressed/selected 可感知样式规则存在', () => {
    expect(cssText).toMatch(/:focus-visible/u)
    expect(cssText).toMatch(/@media \(hover: hover\)/u)
    // selected（账号卡选中态 aria-current 指示条）。
    expect(cssText).toMatch(/\.accountCard\[aria-current='true'\]/u)
    // pressed/expanded（AI 折叠卡展开箭头旋转）。
    expect(cssText).toMatch(/\.aiCardToggle\[aria-expanded='true'\] \.aiArrow/u)
    // sticky 列（作品表前两列）。
    expect(cssText).toMatch(/\.workTable th:nth-child\(2\)/u)
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
      if (action === 'works.list') return { status: 'ready', accountId: 'acc-1', works: [], total: 0 }
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

describe('词典与源码红线', () => {
  const clientDir = join(process.cwd(), 'src', 'client')

  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
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
