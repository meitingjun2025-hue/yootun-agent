/**
 * client 数据页 mock Host 测试：每个数据视图都有 mock response 内容断言
 * （works.list 真实 schema、overview 的 daily_* 字段、fans_profile envelope、
 * work.get/work.trend/run.get/account.probe/account.promote、started:false
 * reason、删除两步确认与失败短路、browser.status 五态、tab/键盘/aria）。
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { shanghaiCompletedDay } from '../../src/client/format.ts'
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
  feedCount: 12,
  sessionStatus: 'ok',
  isPending: false,
  hasStorageState: true,
  localCredentialsMissing: false,
}

/** 基础 handler 集：browser available + 单账号；各测试按需覆盖。 */
function baseHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'browser.status': () => ({ ...OK, chrome: 'available', driver: 'available' }),
    'accounts.list': () => ({ ...OK, accounts: [ACCOUNT], remoteOk: true }),
    'collect.status': () => ({ ...OK, busy: false, collect: null, lastRun: null }),
    'collectAll.status': () => ({ ...OK, ready: true, phase: 'finished', total: 0, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0 }),
    ...overrides,
  }
}

async function renderPage(handlers: Record<string, Handler>): Promise<{ calls: RecordedCall[] }> {
  const host = mockHost(handlers)
  render(<WorkbenchPage t={t} />)
  // 等账号列表就绪。
  await waitFor(() => expect(host.calls.some(call => call.action === 'accounts.list')).toBe(true))
  return host
}

describe('browser.status 五态', () => {
  it('available：状态条显示浏览器就绪且不阻断页面', async () => {
    await renderPage(baseHandlers())
    await screen.findByText(en['browser.ok'])
    expect(screen.queryByText(en['error.CHROME'])).toBeNull()
    expect(screen.getByRole('tab', { name: en['tab.overview'] })).not.toBeNull()
  })

  it('chrome missing：整页阻断门 + 重新检查按钮', async () => {
    await renderPage(baseHandlers({
      'browser.status': () => ({ ...OK, chrome: 'missing', driver: 'missing' }),
    }))
    expect(await screen.findByText(en['browser.missing'])).not.toBeNull()
    expect(screen.getByText(en['error.CHROME'])).not.toBeNull()
    expect(screen.getByRole('button', { name: en['browser.recheck'] })).not.toBeNull()
    expect(screen.queryByText(en['browser.driverMissing'])).toBeNull()
  })

  it('driver missing：阻断门给驱动文案，不伪造成 chrome 缺失', async () => {
    await renderPage(baseHandlers({
      'browser.status': () => ({ ...OK, chrome: 'available', driver: 'missing' }),
    }))
    expect(await screen.findByText(en['browser.driverMissing'])).not.toBeNull()
    expect(screen.getByText(en['error.CHROME_DRIVER'])).not.toBeNull()
    expect(screen.queryByText(en['browser.missing'])).toBeNull()
  })

  it('loading：检查期间显示检查中文案，随后到达 available', async () => {
    let resolveBrowser: ((payload: Payload) => void) | undefined
    mockHost(baseHandlers({
      'browser.status': () => new Promise<Payload>(resolve => { resolveBrowser = resolve }),
    }))
    render(<WorkbenchPage t={t} />)
    expect(screen.getByText(en['browser.checking'])).not.toBeNull()
    resolveBrowser?.({ ...OK, chrome: 'available', driver: 'available' })
    await screen.findByText(en['browser.ok'])
  })

  it('Host API error：非阻断 alert，不伪造成 chrome missing；重新检查可恢复', async () => {
    let browserCalls = 0
    await renderPage(baseHandlers({
      'browser.status': () => {
        browserCalls += 1
        if (browserCalls === 1) throw new Error('host api down')
        return { ...OK, chrome: 'available', driver: 'available' }
      },
    }))
    expect(await screen.findByText(en['browser.apiError'])).not.toBeNull()
    expect(screen.queryByText(en['browser.missing'])).toBeNull()
    expect(screen.queryByText(en['browser.driverMissing'])).toBeNull()
    // 页面主体保持可用。
    expect(screen.getByRole('tab', { name: en['tab.overview'] })).not.toBeNull()
    // 重新检查恢复 available。
    fireEvent.click(screen.getByRole('button', { name: en['browser.recheck'] }))
    await screen.findByText(en['browser.ok'])
  })
})

describe('总览页 account.overview', () => {
  it('KPI 读 metrics.totals.daily_play_count / daily_like_count 与 fans_trend.totals.follower_net_count', async () => {
    await renderPage(baseHandlers({
      'account.overview': () => ({
        ...OK,
        metrics: { totals: { daily_play_count: 1234, daily_like_count: 56, work_count: 12 } },
        fans_trend: { totals: { follower_net_count: 7 }, daily: [
          { day: '2026-11-16', follower_total_count: 100, follower_net_count: 2 },
          { day: '2026-11-17', follower_total_count: 107, follower_net_count: 7 },
        ] },
      }),
      'fans.profile.get': () => ({ ...OK, fans_profile: { device: [{ key: 'ios', label: 'iOS', count: 1 }] } }),
    }))
    await waitFor(() => expect(screen.getByText('1234')).not.toBeNull())
    expect(screen.getByText('56')).not.toBeNull()
    expect(screen.getByText('7')).not.toBeNull()
    // availability：全部源就绪 → ok。
    expect(screen.getByText(t('overview.availability.ok'))).not.toBeNull()
    // 折线点：粉丝总数逐日点可聚焦（aria-label = day: value）。
    expect(screen.getByRole('button', { name: '2026-11-17: 107' })).not.toBeNull()
  })

  it('overview 加载失败 → availability partial，错误区可重试', async () => {
    await renderPage(baseHandlers({
      'account.overview': () => ({ status: 'error', reason: 'WX_TOOL_UNAVAILABLE' }),
      'fans.profile.get': () => ({ ...OK, fans_profile: { age: [{ key: '18-23', label: '18-23 岁', count: 40 }] } }),
    }))
    expect(await screen.findByText(t('overview.availability.partial'))).not.toBeNull()
    // 画像来自 envelope（profile 源成功），overview 错误区给重试按钮。
    expect(screen.getByText('18-23 岁')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: t('state.retry') }).length).toBeGreaterThan(0)
  })

  it('服务端 availability 驱动页面标注：partial 窗口与 no_data 画像不得标成数据完整', async () => {
    await renderPage(baseHandlers({
      // KPI 有值、趋势 partial（残缺窗口）、画像 no_data：整体必须是 partial。
      'account.overview': () => ({
        ...OK,
        metrics: { totals: { daily_play_count: 1234, daily_like_count: 56, work_count: 12 } },
        fans_trend: { totals: { follower_net_count: 7 }, daily: [{ day: '2026-11-17', follower_total_count: 107, follower_net_count: 7 }] },
        availability: { account_metrics: 'ok', fans_trend: 'partial', fans_profile: 'no_data' },
      }),
      'fans.profile.get': () => ({ ...OK, fans_profile: {} }),
    }))
    expect(await screen.findByText(t('overview.availability.partial'))).not.toBeNull()
    expect(screen.queryByText(t('overview.availability.ok'))).toBeNull()
    // 趋势卡 partial：数据 + 警告条同时呈现（kit en 文案）。
    expect(screen.getByText('Partial data shown; the rest failed to load')).not.toBeNull()
    expect(screen.getByRole('button', { name: '2026-11-17: 107' })).not.toBeNull()
    // 画像卡按服务端 no_data 呈现空态（不渲染维度选择）。
    expect(screen.queryByText(t('portrait.age'))).toBeNull()
  })

  it('总览 stale-write 守卫：切账号后旧账号响应不覆盖新账号数据', async () => {
    let resolveSlow: ((payload: Payload) => void) | undefined
    const otherAccount = { ...ACCOUNT, accountId: 'finder-b', nickname: '账号乙' }
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [ACCOUNT, otherAccount], remoteOk: true }),
      'account.overview': args => {
        if (args.accountId === 'finder-b') {
          return new Promise<Payload>(resolve => { resolveSlow = resolve })
        }
        return { ...OK, metrics: { totals: { daily_play_count: 111 } }, fans_trend: { totals: {} } }
      },
      'fans.profile.get': () => ({ ...OK, fans_profile: {} }),
    }))
    expect(await screen.findByText('111')).not.toBeNull()
    // 切到账号乙（overview 挂起），再切回账号甲（立即返回）。
    fireEvent.click(screen.getByRole('button', { name: 'Account: 演示账号' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '账号乙' }))
    fireEvent.click(screen.getByRole('button', { name: 'Account: 账号乙' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '演示账号' }))
    await waitFor(() => expect(screen.getByText('111')).not.toBeNull())
    // 账号乙的旧响应现在才返回：不得覆盖账号甲的数据。
    resolveSlow?.({ ...OK, metrics: { totals: { daily_play_count: 999 } }, fans_trend: { totals: {} } })
    await waitFor(() => expect(screen.queryByText('999')).toBeNull())
    expect(screen.getByText('111')).not.toBeNull()
  })
})

describe('总览页 fans_profile envelope', () => {
  it('画像只从 fans_profile envelope 读取，顶层平铺字段不消费', async () => {
    await renderPage(baseHandlers({
      'account.overview': () => ({ ...OK, metrics: { totals: {} }, fans_trend: { totals: {} } }),
      'fans.profile.get': () => ({
        ...OK,
        // 顶层 decoy：若实现误读顶层字段会渲染 DECOY。
        age: 'DECOY',
        gender: 'DECOY',
        fans_profile: {
          age: [
            { key: '18-23', label: '18-23 岁', count: 40 },
            { key: '24-30', label: '24-30 岁', count: 60 },
          ],
          gender: [
            { key: 'female', label: '女', count: 30 },
            { key: 'male', label: '男', count: 70 },
          ],
        },
      }),
    }))
    // 默认年龄维度：桶标签与计数渲染。
    expect(await screen.findByText('18-23 岁')).not.toBeNull()
    expect(screen.getByText('60')).not.toBeNull()
    expect(screen.queryByText('DECOY')).toBeNull()
    // 切性别维度：envelope 的 gender 行渲染。
    fireEvent.click(screen.getByRole('tab', { name: t('portrait.gender') }))
    await waitFor(() => expect(screen.getByText('70')).not.toBeNull())
    expect(screen.getByText('30')).not.toBeNull()
  })
})

describe('作品页 works.list / work.get / work.trend', () => {
  const WORKS = {
    works: [
      { work_id: 'w-100', title: '第一条作品', play_count: 1000, like_count: 50, publish_time: '2026-11-17T08:00:00.000Z' },
      { work_id: 'w-101', title: '第二条', play_count: 7, like_count: null, publish_time: null },
    ],
  }

  const trendHandlers = (overrides: Record<string, Handler> = {}): Record<string, Handler> => baseHandlers({
    'works.list': () => ({ ...OK, ...WORKS }),
    'work.get': args => ({ ...OK, work: { work_id: args.workId, title: '第一条作品', play_count: 1000, like_count: 50, publish_time: '2026-11-17T08:00:00.000Z' } }),
    // tools 真实形状：顶层 snapshots（account_id / work_id + 日行）。
    'work.trend': args => ({
      ...OK,
      account_id: 'finder-a',
      work_id: args.workId,
      snapshots: [
        { day: '2026-11-16', daily_play_count: 100, daily_like_count: 5 },
        { day: '2026-11-17', daily_play_count: 140, daily_like_count: 9 },
      ],
    }),
    ...overrides,
  })

  it('真实 schema 渲染：snake_case 字段、null 计数显示占位、计数行可见', async () => {
    const { calls } = await renderPage(trendHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    expect(await screen.findByText('第一条作品')).not.toBeNull()
    expect(screen.getByText('第二条')).not.toBeNull()
    expect(screen.getByText(`${t('work.playCount')} 1000 · ${t('work.likeCount')} 50 · 2026-11-17 16:00`)).not.toBeNull()
    expect(screen.getByText(`${t('work.playCount')} 7 · ${t('work.likeCount')} —`)).not.toBeNull()
    expect(screen.getByText(t('works.count', { count: 2 }))).not.toBeNull()
    const listCall = calls.find(call => call.action === 'works.list')
    expect(listCall?.args).toMatchObject({ accountId: 'finder-a', sort: 'publish_time', order: 'desc' })
  })

  it('排序切换带服务端参数；搜索粗筛过滤标题', async () => {
    const { calls } = await renderPage(trendHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await screen.findByText('第一条作品')
    fireEvent.click(screen.getByRole('tab', { name: t('works.sort.play') }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'works.list')
      expect(last?.args).toMatchObject({ sort: 'play_count', order: 'desc' })
    })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: '第二条' } })
    await waitFor(() => expect(screen.queryByText('第一条作品')).toBeNull())
    expect(screen.getByText('第二条')).not.toBeNull()
    expect(screen.getByText(t('works.count', { count: 1 }))).not.toBeNull()
  })

  it('行按钮键盘路径：work.get 详情渲染 work_id 行字段', async () => {
    const { calls } = await renderPage(trendHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    const row = await screen.findByRole('button', { name: '第一条作品' })
    // 键盘路径：行是原生 button（可聚焦、可 Enter 激活）。
    row.focus()
    expect(document.activeElement).toBe(row)
    fireEvent.click(row)
    await screen.findByText(t('works.detail'))
    const getCall = calls.find(call => call.action === 'work.get')
    expect(getCall?.args).toMatchObject({ accountId: 'finder-a', workId: 'w-100' })
    // 详情字段 dt/dd 成对渲染（限定详情卡范围，避免与图表图例重名）。
    const detailCard = screen.getByText(t('works.detail')).closest('section')
    expect(detailCard).not.toBeNull()
    const detail = within(detailCard as HTMLElement)
    expect(detail.getByText(t('work.playCount'))).not.toBeNull()
    expect(detail.getByText(t('work.likeCount'))).not.toBeNull()
    expect(detail.getByText(t('work.publishTime'))).not.toBeNull()
    expect(detail.getByText('1000')).not.toBeNull()
    expect(detail.getByText('50')).not.toBeNull()
    expect(detail.getByText('2026-11-17 16:00')).not.toBeNull()
  })

  it('work.trend 折线点从顶层 snapshots 渲染（daily_play_count 主线、点赞进 tooltip）', async () => {
    const { calls } = await renderPage(trendHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    fireEvent.click(await screen.findByRole('button', { name: '第一条作品' }))
    expect(await screen.findByRole('button', { name: '2026-11-17: 140' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '2026-11-16: 100' })).not.toBeNull()
    const trendCall = calls.find(call => call.action === 'work.trend')
    expect(trendCall?.args).toMatchObject({ accountId: 'finder-a', workId: 'w-100' })
  })

  it('时间窗切换传服务端 publishedFrom/publishedTo（上海已完成自然日）', async () => {
    const { calls } = await renderPage(trendHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await screen.findByText('第一条作品')
    // 全部时间：不传窗口参数。
    const allCall = [...calls].reverse().find(call => call.action === 'works.list')
    expect(allCall?.args['publishedFrom']).toBeUndefined()
    // 近 7 天：from = 上海 7 天前已完成日，to = 上海昨天。
    fireEvent.click(screen.getByRole('tab', { name: t('works.filter.last_7d') }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'works.list')
      expect(last?.args['publishedTo']).toEqual(shanghaiCompletedDay(1))
      expect(last?.args['publishedFrom']).toEqual(shanghaiCompletedDay(7))
    })
    // 昨日：from = to = 上海昨天。
    fireEvent.click(screen.getByRole('tab', { name: t('works.filter.yesterday') }))
    await waitFor(() => {
      const last = [...calls].reverse().find(call => call.action === 'works.list')
      expect(last?.args['publishedFrom']).toEqual(shanghaiCompletedDay(1))
      expect(last?.args['publishedTo']).toEqual(shanghaiCompletedDay(1))
    })
  })

  it('stale-write 守卫：排序慢响应晚于新排序返回时不覆盖新数据', async () => {
    let resolveSlow: ((payload: Payload) => void) | undefined
    const { calls } = await renderPage({
      ...trendHandlers(),
      'works.list': args => {
        if (args.sort === 'play_count') {
          return new Promise<Payload>(resolve => { resolveSlow = resolve })
        }
        return { ...OK, ...WORKS }
      },
    })
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await screen.findByText('第一条作品')
    // 切到最多播放（挂起），再切回最新发布（立即返回）。
    fireEvent.click(screen.getByRole('tab', { name: t('works.sort.play') }))
    fireEvent.click(screen.getByRole('tab', { name: t('works.sort.desc') }))
    await waitFor(() => expect(screen.getAllByText('第一条作品').length).toBeGreaterThan(0))
    // 旧的 play_count 响应现在才返回：不得覆盖。
    resolveSlow?.({ ...OK, works: [{ work_id: 'w-stale', title: '过期数据', play_count: 1, like_count: 1, publish_time: null }] })
    await waitFor(() => {
      expect(screen.queryByText('过期数据')).toBeNull()
      expect(screen.getByText('第一条作品')).not.toBeNull()
    })
    // 此时再放行也不会重放旧代次（seq 已前进）。
    const listCalls = calls.filter(call => call.action === 'works.list')
    expect(listCalls.length).toBeGreaterThanOrEqual(3)
  })
})

describe('采集页 collect / run.get', () => {
  it('started:false 展示稳定 reason 且不进入 running', async () => {
    await renderPage(baseHandlers({
      'collect.start': () => ({ ...OK, started: false, reason: 'collect_busy' }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.collect'] }))
    const start = await screen.findByRole('button', { name: t('collect.start') })
    fireEvent.click(start)
    await screen.findByRole('alert')
    expect(screen.getByText(t('collect.startFailedReason'))).not.toBeNull()
    expect(screen.getByText(`${t('collect.reason.collect_busy')}（collect_busy）`)).not.toBeNull()
    // busy 保持 false：开始按钮可用、单账号取消按钮禁用、当前任务卡无进行中记录。
    expect(start.hasAttribute('disabled')).toBe(false)
    const singleCancel = screen.getAllByRole('button', { name: t('collect.cancel') })[0]
    expect(singleCancel?.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(t('collect.noCurrent'))).not.toBeNull()
  })

  it('running 记录展示 attemptId / runId / phase / 批次进度', async () => {
    await renderPage(baseHandlers({
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
    fireEvent.click(screen.getByRole('tab', { name: en['tab.collect'] }))
    expect(await screen.findByText('finder-a-abc')).not.toBeNull()
    expect(screen.getByText(t('collect.status.running'))).not.toBeNull()
    expect(screen.getByText(t('collect.phase.ingest', { batchNo: 2, totalBatches: 5 }))).not.toBeNull()
    expect(screen.getByText(`#2/5 · ${t('collect.batch.completed', { count: 30 })} · ${t('collect.batch.failed', { count: 1 })}`)).not.toBeNull()
  })

  it('cancelled / interrupted 终态可见；lastRun 分卡呈现', async () => {
    await renderPage(baseHandlers({
      'collect.status': () => ({
        ...OK,
        busy: false,
        collect: { accountId: 'finder-a', attemptId: 'finder-a-old', status: 'cancelled', startedAt: '2026-11-18T09:00:00.000Z', finishedAt: '2026-11-18T09:05:00.000Z', error: null, progress: { phase: 'list' }, result: null },
        lastRun: {
          accountId: 'finder-a', attemptId: 'finder-a-prev', runId: 'run-prev-1', status: 'interrupted',
          startedAt: '2026-11-17T09:00:00.000Z', finishedAt: null, error: 'WX_RUN_INTERRUPTED',
        },
      }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.collect'] }))
    expect(await screen.findByText(t('collect.status.cancelled'))).not.toBeNull()
    // lastRun 卡：attemptId / runId / interrupted 可见。
    expect(screen.getByText('finder-a-prev')).not.toBeNull()
    expect(screen.getByText('run-prev-1')).not.toBeNull()
    expect(screen.getByText(t('collect.status.interrupted'))).not.toBeNull()
    expect(screen.getByText(t('collect.errorReason'))).not.toBeNull()
  })

  it('run.get 查询：真实形状（run + batches）渲染运行字段与批次表', async () => {
    const { calls } = await renderPage(baseHandlers({
      // tools 真实形状：顶层 { run, batches }。
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
          { batch_no: 1, batch_type: 'works', batch_status: 'succeeded', item_count: 20, succeeded_objects: ['a', 'b'], failed_objects: [] },
          { batch_no: 2, batch_type: 'works', batch_status: 'partial', item_count: 20, succeeded_objects: ['c'], failed_objects: ['d'] },
        ],
      }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.collect'] }))
    const input = await screen.findByPlaceholderText(t('collect.runLookup.placeholder'))
    fireEvent.change(input, { target: { value: 'run-hit' } })
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText('run-hit')).not.toBeNull()
    expect(screen.getByText('finder-a')).not.toBeNull()
    expect(screen.getByText('completed')).not.toBeNull()
    expect(screen.getByText(t('run.label.expected'))).not.toBeNull()
    // 「Succeeded」出现在运行字段 label 与批次表头（共 2 处）。
    expect(screen.getAllByText(t('run.label.succeeded')).length).toBe(2)
    expect(screen.getByText('45')).not.toBeNull()
    expect(screen.getByText('40')).not.toBeNull()
    expect(screen.getByText('3')).not.toBeNull()
    // 批次表：batch_no / batch_type / batch_status / item_count / 成功失败对象数。
    expect(screen.getByText(t('run.batch.batchNo'))).not.toBeNull()
    expect(screen.getByText(t('run.batch.type'))).not.toBeNull()
    expect(screen.getAllByText('works').length).toBe(2)
    expect(screen.getByText('succeeded')).not.toBeNull()
    expect(screen.getByText('partial')).not.toBeNull()
    // 「2」是批次 2 的 batch_no 与批次 1 的成功对象数（共 2 处）。
    expect(screen.getAllByText('2').length).toBe(2)
    const runCall = calls.find(call => call.action === 'run.get')
    expect(runCall?.args).toMatchObject({ runId: 'run-hit' })
  })

  it('run.get 未命中（RUN_NOT_FOUND）呈现空态；服务失败以失败态呈现，不伪装成未找到', async () => {
    let failNext = false
    await renderPage(baseHandlers({
      'run.get': () => {
        if (failNext) throw new Error('WX_TOOL_UNAVAILABLE')
        return { status: 'error', reason: 'RUN_NOT_FOUND' }
      },
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.collect'] }))
    const input = await screen.findByPlaceholderText(t('collect.runLookup.placeholder'))
    // 未命中。
    fireEvent.change(input, { target: { value: 'run-miss' } })
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText(t('collect.runLookup.empty'))).not.toBeNull()
    expect(screen.queryByText(t('collect.runLookup.failed'))).toBeNull()
    // 服务失败：失败态 + 稳定 reason，不得显示「未找到」。
    failNext = true
    fireEvent.click(screen.getByRole('button', { name: t('collect.runLookup.action') }))
    expect(await screen.findByText(t('collect.runLookup.failed'))).not.toBeNull()
    expect(screen.getByText(`${t('error.WX_TOOL_UNAVAILABLE')}（WX_TOOL_UNAVAILABLE）`)).not.toBeNull()
    expect(screen.queryByText(t('collect.runLookup.empty'))).toBeNull()
  })
})

describe('账号页 probe / promote / 删除两步', () => {
  it('account.probe 结果可见（ok）', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.probe': () => ({ ...OK, sessionStatus: 'ok', reason: null, reported: true }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.probe') }))
    expect(await screen.findByText(`${t('account.probe')}: ${t('account.sessionOk')}`)).not.toBeNull()
    const probeCall = calls.find(call => call.action === 'account.probe')
    expect(probeCall?.args).toMatchObject({ accountId: 'finder-a' })
  })

  it('account.promote：pending 账号提升成功后刷新列表', async () => {
    const { calls } = await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [{ ...ACCOUNT, accountId: 'pending-1', sessionStatus: 'unknown', isPending: true, hasStorageState: true }], remoteOk: true }),
      'account.promote': () => ({ ...OK, promoted: true, accountId: 'finder-a' }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.promote') }))
    expect(await screen.findByText(t('account.promoted'))).not.toBeNull()
    expect(calls.filter(call => call.action === 'account.promote').length).toBe(1)
    const promoteCall = calls.find(call => call.action === 'account.promote')
    expect(promoteCall?.args).toMatchObject({ accountId: 'pending-1' })
    // promoted → 刷新账号列表（两次 accounts.list）。
    expect(calls.filter(call => call.action === 'accounts.list').length).toBeGreaterThanOrEqual(2)
  })

  it('删除两步：confirm → removeLocal 成功后才 removeRemote', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ ...OK, removed: true }),
      'account.removeRemote': () => ({ ...OK, removed: true }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    // 第一步确认出现（warning + confirm + cancel），尚未调用任何删除。
    expect(screen.getByText(en['account.removeWarning'])).not.toBeNull()
    expect(calls.some(call => call.action.startsWith('account.remove'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirm')}：演示账号` }))
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
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirm')}：演示账号` }))
    expect(await screen.findByText(`${t('collect.reason.collect_busy')}（collect_busy）`)).not.toBeNull()
    expect(calls.some(call => call.action === 'account.removeRemote')).toBe(false)
    // 重试回到确认步。
    fireEvent.click(screen.getByRole('button', { name: t('state.retry') }))
    expect(screen.getByRole('button', { name: `${t('account.removeConfirm')}：演示账号` })).not.toBeNull()
    expect(calls.filter(call => call.action === 'account.removeLocal').length).toBe(1)
  })

  it('删除短路：removeLocal 失败 → localFailed 可重试，removeRemote 未调用', async () => {
    const { calls } = await renderPage(baseHandlers({
      'account.removeLocal': () => ({ status: 'error', reason: 'WX_TOOL_UNAVAILABLE' }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirm')}：演示账号` }))
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
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: `${t('account.removeConfirm')}：演示账号` }))
    expect(await screen.findByText(en['account.delete.remoteFailed'], { exact: false })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('account.delete.retryRemote') }))
    await waitFor(() => expect(calls.filter(call => call.action === 'account.removeRemote').length).toBe(2))
    expect(calls.filter(call => call.action === 'account.removeLocal').length).toBe(1)
  })

  it('两步确认可取消：cancel 回到列表且不发生任何删除调用', async () => {
    const { calls } = await renderPage(baseHandlers())
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    fireEvent.click(await screen.findByRole('button', { name: t('account.remove') }))
    fireEvent.click(screen.getByRole('button', { name: t('account.delete.cancel') }))
    expect(screen.queryByText(en['account.removeWarning'])).toBeNull()
    expect(calls.some(call => call.action.startsWith('account.remove'))).toBe(false)
  })

  it('会话过期账号提供重新扫码入口', async () => {
    await renderPage(baseHandlers({
      'accounts.list': () => ({ ...OK, accounts: [{ ...ACCOUNT, sessionStatus: 'expired' }], remoteOk: true }),
    }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    // KPI 卡与账号行都出现过期文案。
    await waitFor(() => expect(screen.getAllByText(t('account.sessionExpired')).length).toBeGreaterThanOrEqual(2))
    expect(screen.getByRole('button', { name: t('account.relogin') })).not.toBeNull()
  })
})

describe('tab / keyboard / aria 基础', () => {
  it('四个 tab aria-selected 与键盘左右切换', async () => {
    await renderPage(baseHandlers())
    const overviewTab = screen.getByRole('tab', { name: en['tab.overview'] })
    expect(overviewTab.getAttribute('aria-selected')).toBe('true')
    const worksTab = screen.getByRole('tab', { name: en['tab.works'] })
    expect(worksTab.getAttribute('aria-selected')).toBe('false')
    // ArrowRight → 选中并聚焦下一 tab（SegmentedTabs 键盘语义）。
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('tab', { name: en['tab.works'] }).getAttribute('aria-selected')).toBe('true'))
    expect(document.activeElement?.getAttribute('role')).toBe('tab')
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.works'] }), { key: 'End' })
    await waitFor(() => expect(screen.getByRole('tab', { name: en['tab.accounts'] }).getAttribute('aria-selected')).toBe('true'))
  })

  it('panel region 与 tabpanel 可访问', async () => {
    await renderPage(baseHandlers())
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
    expect(screen.getByRole('tabpanel', { name: en.panel })).not.toBeNull()
  })

  it('画像分布行键盘可达：tabIndex 与完整 aria-label', async () => {
    await renderPage(baseHandlers({
      'account.overview': () => ({ ...OK, metrics: { totals: {} }, fans_trend: { totals: {} } }),
      'fans.profile.get': () => ({ ...OK, fans_profile: { age: [{ key: '18-23', label: '18-23 岁', count: 40 }, { key: '24-30', label: '24-30 岁', count: 60 }] } }),
    }))
    const row = await screen.findByText('18-23 岁')
    const rowItem = row.closest('li')
    expect(rowItem).not.toBeNull()
    expect(rowItem?.getAttribute('tabindex')).toBe('0')
    expect(rowItem?.getAttribute('aria-label')).toBe('18-23 岁: 40 (Share 40%)')
  })
})

describe('词典键集（W4 新增键同步）', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
