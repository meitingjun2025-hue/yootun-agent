/** client 组件测试（jsdom）：键集、三 tab 布局骨架、页面区域、键盘、AI 报表页、样式红线。 */
// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en as reportEn } from '@yootun/dsh-client-report'
import { en, zh, type WxLocaleKey } from '../../src/client/locales.ts'

const apiMock = vi.hoisted(() => ({ hostAction: vi.fn() }))
vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(() => {
  cleanup()
  apiMock.hostAction.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string) => {
    if (action === 'browser.status') return { status: 'ok', chrome: 'available', driver: 'available' }
    if (action === 'accounts.list') return { status: 'ok', accounts: [] }
    if (action === 'collect.status') return { status: 'ok', collect: null, busy: false, runningAccountIds: [], lastRun: null }
    if (action === 'collectAll.status') return { status: 'ok', ready: true, phase: 'ready', items: [], total: 0 }
    if (action === 'report.list') return { data: { items: [], nextCursor: null } }
    throw new Error(`unexpected action ${action}`)
  })
})

const t = (key: WxLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key] ?? key
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

/** locale 座位假件：快照对象只建一次（引用稳定）；与用例的 en kit 文案口径一致。 */
const localeSnapshot = { active: 'en' }
const locale = {
  subscribe: () => () => undefined,
  getSnapshot: () => localeSnapshot,
}

describe('词典键集', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('稳定码全集每个码都有词典文案（REASON_KEYS 编译期穷尽的运行时面）', async () => {
    const { STABLE_ERROR_CODES } = await import('../../src/errors.ts')
    const { reasonText } = await import('../../src/client/format.ts')
    const interpolate = (key: string, values?: Record<string, string | number>): string =>
      values === undefined ? (en[key as WxLocaleKey] ?? key) : `${en[key as WxLocaleKey] ?? key}:${String(values.code ?? '')}`
    for (const code of STABLE_ERROR_CODES) {
      expect(reasonText(code, interpolate).includes('error.unknownWithCode'), `reasonText ${code}`).toBe(false)
    }
    // 连接器鉴权投影与 Host 收敛码的口径（分册 08 §5.2 / 实施单 2.7）。
    expect(reasonText('UNAUTHORIZED', interpolate)).toBe(`${en['reason.UNAUTHORIZED']}（UNAUTHORIZED）`)
    expect(reasonText('host_unreachable', interpolate)).toBe(`${en['reason.host_unreachable']}（host_unreachable）`)
    expect(reasonText('LOCAL_CLEARED_REQUIRED', interpolate)).toBe(`${en['reason.LOCAL_CLEARED_REQUIRED']}（LOCAL_CLEARED_REQUIRED）`)
    // 批内熔断批次 / 条目原因文案（采集全部并发实施单 2.6/2.7）。
    expect(reasonText('risk_paused', interpolate)).toBe(`${en['reason.risk_paused']}（risk_paused）`)
    // 批量取消与空账号 ID 的稳定码文案（实施单 5.3 补齐轮，2.6 增量）。
    expect(reasonText('collect_cancelled', interpolate)).toBe(`${en['reason.collect_cancelled']}（collect_cancelled）`)
    expect(reasonText('account_id_required', interpolate)).toBe(`${en['reason.account_id_required']}（account_id_required）`)
    // 路由层拒绝原因文案（workbench-host-kit 2.6：kit 路由字面量的显式分支，R2）。
    expect(reasonText('forbidden', interpolate)).toBe(`${en['reason.forbidden']}（forbidden）`)
    expect(reasonText('unknown_action', interpolate)).toBe(`${en['reason.unknown_action']}（unknown_action）`)
    expect(reasonText('method_not_allowed', interpolate)).toBe(`${en['reason.method_not_allowed']}（method_not_allowed）`)
  })

  it('账号采集中状态点文案 zh / en 成对', () => {
    expect(zh['account.collecting']).toBe('采集中')
    expect(en['account.collecting']).toBe('Collecting')
  })

  it('W3 报表码错误文案不带码后缀；非报表码沿用 reasonText 形态；空码回退域默认', async () => {
    const { reportErrorText } = await import('../../src/client/format.ts')
    // 报表域码（report.error.* 词典命中，展开自共享包常量）不带码后缀。
    expect(reportErrorText('REPORT_MODEL_FAILED', t)).toBe(en['report.error.REPORT_MODEL_FAILED'])
    expect(reportErrorText('INVALID_CURSOR', t)).toBe(en['report.error.INVALID_CURSOR'])
    expect(reportErrorText('VALIDATION_ERROR', t)).toBe(en['report.error.VALIDATION_ERROR'])
    // 非报表码沿用 reasonText 的形态（文案附原码）。
    expect(reportErrorText('WX_TOOL_UNAVAILABLE', t)).toBe(`${en['error.WX_TOOL_UNAVAILABLE']}（WX_TOOL_UNAVAILABLE）`)
    // 空码回退报表域默认文案。
    expect(reportErrorText(null, t)).toBe(en['report.error.default'])
    expect(reportErrorText('', t)).toBe(en['report.error.default'])
  })
})

describe('顶级导航（布局契约：作品数据 / 账号总览 / AI 报表三个 tab）', () => {
  it('tab 数量为 3，顺序为作品数据 → 账号总览 → AI 报表，默认选中作品数据', () => {
    const { container } = render(<WorkbenchPage t={t} locale={locale} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.length).toBe(3)
    expect(tabs[0]?.getAttribute('aria-label') ?? tabs[0]?.textContent).toContain(en['tab.works'])
    expect(tabs.map(tab => tab.textContent)).toEqual([en['tab.works'], en['tab.overview'], en['tab.report']])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    void container
  })

  it('W1 第三个 Tab「AI 报表」存在（id wx-tab-report）且默认不选中；切换后渲染共享包报表页', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    const reportTab = screen.getByRole('tab', { name: en['tab.report'] })
    expect(reportTab.getAttribute('id')).toBe('wx-tab-report')
    expect(reportTab.getAttribute('aria-selected')).toBe('false')
    // 默认选中不变，仍为「作品数据」。
    expect(screen.getByRole('tab', { name: en['tab.works'] }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(reportTab)
    // 切换后渲染报表页：空列表空态文案来自共享包词典（报表 Tab 不 keep-alive）。
    expect(await screen.findByText(reportEn['report.empty'])).not.toBeNull()
  })

  it('I3(wx) 挂载恢复：collect.status 带中断摘要 → 横幅出现（应用退出重开主场景）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'browser.status') return { status: 'ready', chrome: 'available', driver: 'available' }
      if (action === 'accounts.list') return { status: 'ok', accounts: [] }
      // 挂载恢复的选中账号状态查询：带中断摘要（重启后内存记录为 null，只有 lastRun）。
      if (action === 'collect.status') return { status: 'ok', collect: null, busy: false, runningAccountIds: [], lastRun: null, interrupted: { count: 2, accountIds: ['acc-1', 'acc-2'] } }
      if (action === 'collectAll.status') return { status: 'ok', ready: true, phase: 'ready', items: [], total: 0, interrupted: { count: 2, accountIds: ['acc-1', 'acc-2'] } }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    // 横幅出现（多账号文案），不再有 toast。
    await waitFor(() => expect(screen.getByText(t('run.interruptedBanner', { count: 2 }))).not.toBeNull(), { timeout: 4000 })
    // 账号列表为空：无选中账号 → 无「重新采集」；有「重新采集全部」与关闭。
    expect(screen.queryByRole('button', { name: en['run.recollect'] })).toBeNull()
    expect(screen.getByRole('button', { name: en['run.recollectAll'] })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['run.dismissBanner'] }))
    expect(screen.queryByText(t('run.interruptedBanner', { count: 2 }))).toBeNull()
  })

  it('I3(wx) 灵敏度：只有 collect.status 带摘要 → 横幅仍出现（批量恢复路不带摘要）', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args?: Record<string, unknown>) => {
      if (action === 'browser.status') return { status: 'ready', chrome: 'available', driver: 'available' }
      if (action === 'accounts.list') return { status: 'ok', accounts: [] }
      // 只有单账号恢复路带摘要：collectAll.status 无摘要（横幅只能来自 collect.status）。
      if (action === 'collect.status') return { status: 'ok', collect: null, busy: false, runningAccountIds: [], lastRun: null, interrupted: { count: 2, accountIds: ['acc-1', 'acc-2'] } }
      if (action === 'collectAll.status') return { status: 'ok', ready: true, phase: 'ready', items: [], total: 0 }
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await waitFor(() => expect(screen.getByText(t('run.interruptedBanner', { count: 2 }))).not.toBeNull(), { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: en['run.dismissBanner'] }))
    expect(screen.queryByText(t('run.interruptedBanner', { count: 2 }))).toBeNull()
  })

  it('采集与账号不再是顶级 tab（旧四 tab 契约废除）', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.queryByRole('tab', { name: 'Collect' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull()
    // 词典里也不再提供旧 tab 键。
    expect('tab.collect' in zh).toBe(false)
    expect('tab.accounts' in zh).toBe(false)
  })

  it('tab 键盘左右切换在三个 tab 间循环', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<WorkbenchPage t={t} locale={locale} />)
    const worksTab = screen.getByRole('tab', { name: en['tab.works'] })
    fireEvent.keyDown(worksTab, { key: 'ArrowRight' })
    await waitForTabSelected(en['tab.overview'])
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.overview'] }), { key: 'ArrowRight' })
    await waitForTabSelected(en['tab.report'])
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.report'] }), { key: 'End' })
    await waitForTabSelected(en['tab.report'])
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.report'] }), { key: 'ArrowRight' })
    await waitForTabSelected(en['tab.works'])
  })

  it('jsdom 无 Host：加载态可达（empty/error 由 Host 集成验证）', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
  })

  it('jsdom 无 Host：挂载恢复查询失败按无运行中采集处理，不弹错误', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    // 恢复查询在无 Host 时失败：按无运行中采集处理，页面骨架保持可用。
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en['works.collecting'] })).toBeNull()
  })
})

async function waitForTabSelected(label: string): Promise<void> {
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() => expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true'))
}

describe('AI 报表页（wx-report-client 附录 B W2 / W4）', () => {
  /** 报表列表行（远端投影形态）。 */
  const reportRow = {
    reportId: 'wx-r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
    status: 'succeeded', version: 1, coreAvailable: true,
    coverageSummary: { coveredAccounts: 1, totalAccounts: 2 },
    finishedAt: '2026-11-21T11:30:00Z', createdAt: null, summary: null, errorCode: null, isCurrent: true,
  }
  /** 报表详情（works 行由用例给定；其余最小可渲染）。 */
  const reportDetail = (works: unknown[]): Record<string, unknown> => ({
    data: {
      report: {
        reportId: 'wx-r-1', reportType: 'daily', periodStart: '2026-11-20', periodEnd: '2026-11-21',
        status: 'succeeded', outputSchemaVersion: 'daily-v1', errorCode: null, finishedAt: '2026-11-21T11:30:00Z',
        resultJson: {
          data: {
            generatedAt: '2026-11-21T11:30:00Z',
            coverage: null,
            coreMetrics: [{ key: 'plays', label: '播放增量', value: 12000, available: true, changePct: null, prevValue: null, note: null }],
            trendSeries: { days: ['11-20'], bars: [100], line: [5] },
            accounts: [{ accountId: 'acc-1', nickname: '账号一', sessionStatus: 'ok', fanCount: 12000, eachAvailable: true, marks: [], metrics: { plays: 100, netFans: 3, publishes: 1, likes: 10, comments: 1, shares: 2 } }],
            works, anomalies: [],
          },
          ai: { summary: null, facts: [], inferences: [], recommendations: [], limitations: [] },
        },
      },
    },
  })

  it('W2 报表页的请求经本插件 hostAction：action 名与 reportId 参数正确', async () => {
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ok', chrome: 'available', driver: 'available' }
      if (action === 'accounts.list') return { status: 'ok', accounts: [] }
      if (action === 'collect.status') return { status: 'ok', collect: null, busy: false, runningAccountIds: [], lastRun: null }
      if (action === 'collectAll.status') return { status: 'ok', ready: true, phase: 'ready', items: [], total: 0 }
      if (action === 'report.list') return { data: { items: [reportRow], nextCursor: null } }
      if (action === 'report.get') return reportDetail([])
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    fireEvent.click(await screen.findByRole('button', { name: reportEn['report.view'] }))
    await screen.findByRole('button', { name: reportEn['report.back'] })
    const calls = apiMock.hostAction.mock.calls.map(call => call[0])
    expect(calls).toContain('report.list')
    expect(calls).toContain('report.get')
    const getCall = apiMock.hostAction.mock.calls.find(call => call[0] === 'report.get')
    expect(getCall?.[1]).toEqual({ reportId: 'wx-r-1' })
  })

  it('W4 视频号作品卡渲染流量来源与最大流失点；形状不符的条目整条丢弃', async () => {
    // 服务端真实形态：扩展区数据与数值指标同在 metrics 对象里（非数值键由
    // 共享包读取器投影进 extra）。
    const works = [{
      workId: 'w-1', title: '视频号作品', nickname: '账号一', accountId: 'acc-1', isHot: false,
      metrics: {
        plays: 1000, likes: 20, comments: 3, fansGain: 4, collects: 5, shares: 6,
        completionRate: 42.5, avgPlaySeconds: 9.8, fastFlipRate: 12.3,
        trafficSource: [
          { name: '推荐', plays: 600 },
          { name: '朋友♡', plays: 250 },
          { bogus: true },
          { name: '', plays: 5 },
        ],
        retention: { durationSeconds: 45, maxLostSecond: 3, retentionAtMaxLostPct: 36 },
      },
    }]
    apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
      if (action === 'browser.status') return { status: 'ok', chrome: 'available', driver: 'available' }
      if (action === 'accounts.list') return { status: 'ok', accounts: [] }
      if (action === 'collect.status') return { status: 'ok', collect: null, busy: false, runningAccountIds: [], lastRun: null }
      if (action === 'collectAll.status') return { status: 'ok', ready: true, phase: 'ready', items: [], total: 0 }
      if (action === 'report.list') return { data: { items: [reportRow], nextCursor: null } }
      if (action === 'report.get') return reportDetail(works)
      throw new Error(`unexpected action ${action}`)
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.report'] }))
    fireEvent.click(await screen.findByRole('button', { name: reportEn['report.view'] }))
    await screen.findByText('视频号作品')
    // 扩展区三行：流量来源（形状不符的 {bogus:true} 与空 name 条目被丢弃）、
    // 最大流失点（该秒留存率）、视频时长；文案来自本插件词典。
    expect(screen.getByText('Traffic sources 推荐 600 · 朋友♡ 250')).not.toBeNull()
    expect(screen.getByText('Max drop-off at 3s · 36.00% still watching')).not.toBeNull()
    expect(screen.getByText('Video length 45s')).not.toBeNull()
    // 次要行按插件声明渲染完播率/平均播放时长/快速划过率；进度条为完播率
    // （数值格式为共享包口径：最多两位小数，无补零）。
    expect(screen.getByText('Completion 42.5%')).not.toBeNull()
    expect(screen.getByText('Avg play duration 9.8s')).not.toBeNull()
    expect(screen.getByText('Fast flip rate 12.3%')).not.toBeNull()
    expect(screen.getByRole('img', { name: 'Completion 42.5%' })).not.toBeNull()
  })
})

describe('样式红线', () => {
  const srcDir = join(process.cwd(), 'src', 'client')
  it('无 !important、无全局选择器、无字面色', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css')) continue
      const source = readFileSync(join(srcDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(source).not.toMatch(/!important/u)
      expect(source).not.toMatch(/@tailwind|@apply/u)
      expect(source).not.toMatch(/(^|[}\n,{])(\s*)(body|html|:root|\*)\s*[,{]/u)
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
      expect(source).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/u)
    }
  })

  it('无 ywc-* 旧类名迁移、无 <style> 注入、无旧 inline style 技术', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css') && !name.endsWith('.tsx')) continue
      const source = readFileSync(join(srcDir, name), 'utf8')
      expect(source).not.toMatch(/\bywc-/u)
      expect(source).not.toMatch(/dangerouslySetInnerHTML|document\.createElement\('style'\)/u)
    }
  })

  it('断点与 reduced-motion 覆盖（640 / 880 / 1120 容器档）', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('yootun-kit-page')
    expect(css).toContain('max-width: 1119px')
    expect(css).toContain('max-width: 879px')
    expect(css).toContain('max-width: 639px')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('280px 账号栏布局契约存在于样式', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('280px minmax(0, 1fr)')
  })

  it('容器查询依赖 PluginPageShell（容器名对齐）', () => {
    const kitDir = join(process.cwd(), '..', '..', 'packages', 'dsh-client-ui-kit', 'src')
    expect(existsSync(join(kitDir, 'page-shell.module.css'))).toBe(true)
  })
})
