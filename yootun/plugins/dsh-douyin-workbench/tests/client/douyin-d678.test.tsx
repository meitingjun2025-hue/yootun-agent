/**
 * D6–D8 client parity 测试（jsdom；p4-douyin-workbench-d6-d8-ui-parity.md 逐节
 * 锚点）：拆解页结构/状态筛选/详情页折叠卡与工具栏/导出错误就近/重仿写与强制
 * 重试确认；素材看板四子页/筛选与分页/KPI 缺失 —/评分理由抽屉四态/seed 弹窗
 * 编辑锁定与启停确认/采集确认与 activeRun 横幅/失败明细/去拆解跨 Tab 预填；
 * 基因库 facets 与已选条件/卡片墙缺失 —/详情编辑禁用矩阵/重建费用确认/失败
 * 列表同键重试；按钮语义（primary/ghost 相邻不同 variant、danger 确认路径、
 * running aria-busy）、Esc 关闭回归焦点、长文本 aria-label。
 * @module
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, zh, type DouyinLocaleKey } from '../../src/client/locales.ts'
import { en as kitEn } from '@yootun/dsh-client-ui-kit'
import { filterBreakdownHistory, breakdownStatusTone, shotScriptTable } from '../../src/client/BreakdownPage.tsx'

const apiMock = vi.hoisted(() => ({ hostAction: vi.fn() }))

vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(cleanup)

const t = (key: DouyinLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key] ?? key
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

/** kit 词典文案插值（分页控件文案随 WorkbenchPage 的 KitLocaleProvider 注入）。 */
const kitT = (key: keyof typeof kitEn, values?: Record<string, string | number>): string => {
  const text = kitEn[key]
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

const uuid = 'd'.repeat(32)

/** 拆解规则。 */
const rules = [{ rewriteRuleId: 'r1', name: '汽车口播', description: '高转化开场' }]

/** 拆解历史行（蛇形 candidate_id 由 Host 归一，此处已是 client 形态）。 */
const historyRow = (workflowId: string, status: string, title = '三分钟看懂增程车') => ({
  workflowId, candidateId: `c-${workflowId}`, status, currentStep: 'asr', currentStepLabel: '语音识别',
  candidateTitle: title, candidateAuthor: '车评人', candidatePlayCount: 123456,
  rewriteRuleId: 'r1', hasRewriteRuleKey: true, updatedAt: '2026-11-21T10:00:00Z',
  retryAfterSeconds: null, errorCode: null, hasStoryboard: status === 'succeeded',
})

/** 拆解详情载荷（storyboards 主体 + analysis + candidate）。 */
const breakdownDetail = {
  status: 'ready',
  storyboards: [{
    input: { rewriteRuleId: 'r1', rewriteRulePrompt: '开场 3 秒钩子' },
    originalVideoAnalysis: {
      summary: '原文摘要',
      segments: [{ timeRange: '00:00-00:05', role: 'hook', originalVisual: '封面定格', originalSpeech: '你还不知道增程车？' }],
    },
    rewrittenStoryboard: {
      summary: '改写摘要',
      segments: [{ timeRange: '00:00-00:05', role: 'hook', rewrittenSpeech: '新钩子', rewrittenVisual: '新画面', sourceSegmentIndexes: [1] }],
    },
    shotScript: { status: 'succeeded', markdown: '| 镜头 | 景别 |\n| --- | --- |\n| 1 | 远景 |\n\n补充段落', shotSizeQuotas: { 远: 2, 中: 3 } },
  }],
  analysis: { candidates: [{ products: { asr: { transcript: '口播全文内容' } } }] },
  analysisError: null,
  candidate: {
    playCount: 100000, likeCount: 5000, commentCount: 300, collectCount: 800, shareCount: 120,
    interactionRate: 0.0622, publishedAt: '2026-11-01T08:00:00Z', shareUrl: 'https://www.douyin.com/video/1',
  },
  candidateError: null,
}

/** 素材候选行。 */
const materialCandidate = {
  candidateId: 'm-1', awemeId: '7000000000000000001', title: '超长标题的超长标题的超长标题的超长标题',
  coverUrl: null, shareUrl: 'https://v.douyin.com/abc/', tags: ['对标', '口播'],
  hotScore: 88, hotLevel: 'S', playCount: 200000, likeCount: 9000, commentCount: 400,
  collectCount: 700, shareCount: 90, interactionRate: 0.0512, publishedAt: '2026-11-05T00:00:00Z',
  sourceMatches: [{ keyword: '增程车', accountSeedId: null }],
  scoreReasons: ['播放量进入前 1%'],
  scoreReasonDetails: [
    { name: '点赞', observed: 9000, threshold: 5000, points: 10, hit: true },
    { name: '评论', observed: 100, threshold: 400, points: 0, hit: false },
    { name: '互动', observed: null, threshold: 0.08, points: 0, hit: false },
  ],
  scoreRuleVersion: 'hot-v1',
}

/** run 行。 */
const materialRun = (runStatus: string) => ({
  runId: 'run-1', runStatus, startedAt: '2026-11-21T09:00:00Z', durationSeconds: 95,
  keywordCount: 5, accountCount: 2, succeededJobs: 6, failedJobs: 1, newVideos: 12,
  promotedCandidates: 3, duplicatesSkipped: 4, discovered: 16, candidatesInserted: 12,
  materialCandidateCount: 12, hotLevelSummary: { S: 2, A: 5, B: 4, C: 1 },
  failedKeywords: ['冬天用车'], failedAccounts: [], runError: null,
})

/** 基因记录。 */
const geneRecord = {
  recordId: 'g-1', awemeId: '7000000000000000002', title: '钩子拆解条目', coverUrl: null,
  authorName: '作者', publishedAt: '2026-11-01T00:00:00Z', durationSeconds: 61,
  metrics: { playCount: 300000, likeCount: 8000, commentCount: 200, shareCount: 90, collectCount: 600 },
  geneTags: { hook: ['提问式开场'] }, adoptionStatus: 'ai_draft', geneStatus: 'succeeded',
  updatedAt: '2026-11-20T10:00:00Z', shareUrl: null, manualNotes: null,
  reportJson: { summary: '报告摘要', segmentCount: 5, audienceInsight: null, bgmStyle: null },
  geneEvidenceJson: { hook: [{ label: '提问式开场', basis: '前 3 秒出现提问' }] },
  geneAttemptCount: 1, geneErrorCode: null, geneErrorSummary: null,
  audienceInsightState: 'legacy_snapshot', bgmStyleState: 'not_exposed',
}

const geneSearchPayload = {
  status: 'ready',
  data: {
    results: [geneRecord], total: 1, hasMore: false,
    facets: { hook: [{ label: '提问式开场', count: 1 }] }, facetsError: false,
    stats: { total: 1, last7d: 1, adoptedRatio: 0, failedCount: 0 }, statsError: false,
    dimensions: [{ id: 'hook', name: '开头钩子', maxLabels: 3 }], offset: 0, limit: 20,
  },
}

/** D6–D8 默认 mock（空态基线；单测按需覆盖）。 */
function mockAll(overrides: Record<string, unknown> = {}): void {
  apiMock.hostAction.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string, args: Record<string, unknown> = {}) => {
    if (action in overrides) {
      const value = overrides[action]
      if (typeof value === 'function') return value(args)
      return value
    }
    if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
    if (action === 'accounts.list') return { status: 'ready', accounts: [], remoteError: null }
    if (action === 'overview.get') return { status: 'ready', overview: { summary: {}, accounts: [], hotWorks: [], accountOptions: [], accountTotal: 0 } }
    if (action === 'collect.status') return { status: 'ready', collect: null }
    if (action === 'collectAll.status') return { status: 'ready', batch: null }
    if (action === 'breakdown.rewriteRules') return { status: 'ready', rules, total: 1 }
    if (action === 'breakdown.history') return { status: 'ready', history: [], total: 0 }
    if (action === 'breakdown.archiveStart') return { status: 'ready', archive: { runId: 'run-1', runStatus: 'waiting', nextAction: 'poll_status' } }
    if (action === 'breakdown.detail') return breakdownDetail
    if (action === 'breakdown.export') return { status: 'ready', file_name: 'douyin-storyboard-c.xlsx', mime_type: 'x', content_base64: 'QUJD', content_bytes: 3 }
    if (action === 'material.videos.list') return { status: 'ready', data: { candidates: [], total: 0, offset: 0, limit: 20 } }
    if (action === 'material.facets') return { status: 'ready', tags: [] }
    if (action === 'material.seeds.list') return { status: 'ready', data: { keywords: [], accounts: [], keywordByStatus: {}, accountByStatus: {} } }
    if (action === 'material.runs.list') return { status: 'ready', data: { runs: [], total: 0 } }
    if (action === 'material.collect.status') return { status: 'ready', data: { runId: 'run-1', runStatus: 'completed', nextAction: 'done' } }
    if (action === 'gene.search') return { status: 'ready', data: { results: [], total: 0, hasMore: false, facets: {}, facetsError: false, stats: null, statsError: false, dimensions: [], offset: 0, limit: 20 } }
    if (action === 'gene.get') return { status: 'ready', data: { record: geneRecord } }
    throw new Error(`unexpected action ${action}`)
  })
}

beforeEach(() => { mockAll() })

/** locale 座位假件：快照对象只建一次（引用稳定）；active 与用例词典口径一致（zh 格式）。 */
const localeSnapshot = { active: 'en' }
const locale = {
  subscribe: () => () => undefined,
  getSnapshot: () => localeSnapshot,
}

describe('纯函数（breakdown.js 语义迁移）', () => {
  it('状态 tone 归一：未登记按 running 不误报；cancelled=warn、needs_input=warn', () => {
    expect(breakdownStatusTone('succeeded')).toBe('ok')
    expect(breakdownStatusTone('failed')).toBe('error')
    expect(breakdownStatusTone('invalid_input')).toBe('error')
    expect(breakdownStatusTone('cancelled')).toBe('warn')
    expect(breakdownStatusTone('needs_input')).toBe('warn')
    expect(breakdownStatusTone('queued')).toBe('running')
    expect(breakdownStatusTone('whatever-new')).toBe('running')
  })

  it('历史筛选四值：failed 收敛 error+warn（未成功）', () => {
    const rows = [historyRow('a', 'succeeded'), historyRow('b', 'failed'), historyRow('c', 'cancelled'), historyRow('d', 'running')]
    expect(filterBreakdownHistory(rows, 'all')).toHaveLength(4)
    expect(filterBreakdownHistory(rows, 'succeeded').map(row => row.workflowId)).toEqual(['a'])
    expect(filterBreakdownHistory(rows, 'failed').map(row => row.workflowId)).toEqual(['b', 'c'])
    expect(filterBreakdownHistory(rows, 'running').map(row => row.workflowId)).toEqual(['d'])
  })

  it('拍摄脚本 Markdown 表格解析：head/rows/paragraphs 纯文本', () => {
    const parsed = shotScriptTable('| 镜头 | 景别 |\n| --- | --- |\n| 1 | 远景 |\n\n补充段落')
    expect(parsed.head).toEqual(['镜头', '景别'])
    expect(parsed.rows).toEqual([['1', '远景']])
    expect(parsed.paragraphs).toEqual(['补充段落'])
  })
})

describe('爆款拆解页（parity §1–§3）', () => {
  it('新建区结构：链接输入 + 开始拆解 primary + 下载直链 ghost + 规则单选 + 受理横幅语义', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    expect(await screen.findByRole('button', { name: en['bd.startButton'] })).not.toBeNull()
    const start = screen.getByRole('button', { name: en['bd.startButton'] })
    const download = screen.getByRole('button', { name: en['bd.downloadButton'] })
    // 相邻不同语义不同 variant（源码级锁定：primary 与 ghost 并存）。
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'BreakdownPage.tsx'), 'utf8')
    expect(source).toContain("variant='primary' disabled={submitting || shareUrl.trim() === ''}")
    expect(source).toContain("variant='ghost' disabled={downloading || submitting}")
    // 空链接时主按钮禁用（可感知禁用态）。
    expect(start.getAttribute('disabled')).not.toBeNull()
    expect(download.getAttribute('disabled')).toBeNull()
    // 规则单选卡（radiogroup + aria-checked）。
    const radio = screen.getByRole('radio', { name: /汽车口播/u })
    expect(radio.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(radio)
    expect(radio.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(radio)
    expect(radio.getAttribute('aria-checked')).toBe('false')
  })

  it('状态筛选带「状态」文字；规则胶囊按规则分色；详情步骤全部完成态', async () => {
    mockAll({
      'breakdown.rewriteRules': {
        status: 'ready',
        rules: [
          { rewriteRuleId: 'r1', name: '规则甲', description: null },
          { rewriteRuleId: 'r2', name: '规则乙', description: null },
        ],
        total: 2,
      },
      'breakdown.history': {
        status: 'ready',
        history: [historyRow('wf-1', 'succeeded', '视频甲'), { ...historyRow('wf-2', 'succeeded', '视频乙'), rewriteRuleId: 'r2' }],
        total: 2,
      },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    await screen.findByRole('table', { name: en['bd.historyLabel'] })
    const statusLabels = [...document.querySelectorAll('[class*="filterGroupLabel"]')]
    expect(statusLabels.map(label => label.textContent)).toEqual([en['bd.col.status']])
    // 两条记录分属不同规则 → 胶囊取不同色（同规则恒同色）。
    const pills = [...document.querySelectorAll('[class*="bdRulePill"]')]
    expect(pills.map(pill => pill.textContent)).toEqual(['规则甲', '规则乙'])
    expect(pills[0]?.getAttribute('data-tone')).not.toBe(pills[1]?.getAttribute('data-tone'))
    // 进入详情：成功工作流 8 步全部 done（文字随完成态着色）。
    fireEvent.keyDown(screen.getByRole('row', { name: /视频甲/u }), { key: 'Enter' })
    await screen.findByRole('button', { name: en['bd.backToList'] })
    const steps = [...document.querySelectorAll('li[data-state]')]
    expect(steps).toHaveLength(8)
    expect(steps.every(step => step.getAttribute('data-state') === 'done')).toBe(true)
  })

  it('下载直链空链接：非空提示不发起请求', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    await screen.findByRole('button', { name: en['bd.downloadButton'] })
    fireEvent.click(screen.getByRole('button', { name: en['bd.downloadButton'] }))
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.getByText(en['bd.downloadRequired'])).not.toBeNull()
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('breakdown.downloadStart', expect.anything())
  })

  it('历史列表：5 列结构 + 状态 Tag + hasStoryboard 标记 + 状态筛选', async () => {
    mockAll({ 'breakdown.history': { status: 'ready', history: [historyRow('wf-1', 'succeeded'), historyRow('wf-2', 'failed', '失败的拆解记录')], total: 2 } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    const table = await screen.findByRole('table', { name: en['bd.historyLabel'] })
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toEqual([en['bd.col.video'], en['bd.col.status'], en['bd.col.rule'], en['bd.col.step'], en['bd.col.time'], en['action.viewDetail']])
    expect(screen.getByText(en['bd.status.succeeded'])).not.toBeNull()
    expect(screen.getByText(new RegExp(en['bd.hasStoryboard'], 'u'))).not.toBeNull()
    // 状态筛选菜单切换到「未成功」：成功行隐藏、失败行保留。
    fireEvent.click(screen.getByRole('button', { name: en['bd.filterLabel'] }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en['bd.filter.failed'] }))
    await waitFor(() => expect(screen.queryByText('三分钟看懂增程车')).toBeNull())
    expect(screen.getByText('失败的拆解记录')).not.toBeNull()
    // 切「进行中」：无匹配行 → 空筛选态。
    fireEvent.click(screen.getByRole('button', { name: en['bd.filterLabel'] }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en['bd.filter.running'] }))
    await waitFor(() => expect(screen.getByText(en['bd.historyEmptyFiltered'])).not.toBeNull())
  })

  it('历史行 Enter 进入详情：工具栏三按钮 + 8 步骤 + KPI 6 卡 + 五折叠卡 + 导出错误就近', async () => {
    mockAll({ 'breakdown.history': { status: 'ready', history: [historyRow('wf-1', 'succeeded')], total: 1 } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    const row = await screen.findByRole('row', { name: /三分钟看懂增程车/u })
    fireEvent.keyDown(row, { key: 'Enter' })
    // 工具栏：返回 / 导出 / 重新改写（全部 ghost 次操作）。
    expect(await screen.findByRole('button', { name: en['bd.backToList'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['bd.exportExcel'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['bd.rewriteButton'] })).not.toBeNull()
    // 8 步骤名称齐全。
    // 8 步骤名齐全（storyboard/shot_script 与折叠卡标题 EN 同词，用计数断言）。
    for (const step of ['archive_original', 'transcode_audio', 'asr', 'extract_frames', 'vision', 'breakdown', 'storyboard', 'shot_script'] as const) {
      expect(screen.getAllByText(en[`bd.step.${step}` as 'bd.step.asr']).length).toBeGreaterThan(0)
    }
    // 候选 6 KPI + 互动率 6.22%。
    for (const key of ['bd.kpi.play', 'bd.kpi.like', 'bd.kpi.comment', 'bd.kpi.collect', 'bd.kpi.share', 'bd.kpi.interaction'] as const) {
      expect(screen.getByText(en[key])).not.toBeNull()
    }
    expect(screen.getByText('6.22%')).not.toBeNull()
    // 五折叠卡（原文与仿写默认展开，其余收起；storyboard 卡名与步骤名 EN 同词，用多匹配断言）。
    expect(screen.getAllByText(en['bd.card.original']).length).toBeGreaterThan(0)
    expect(screen.getAllByText(en['bd.card.storyboard']).length).toBeGreaterThan(1)
    expect(screen.getAllByText('原文摘要').length).toBeGreaterThan(1)
    expect(screen.getByText('新钩子')).not.toBeNull()
    // 导出失败：独立就近 alert，不替换详情。
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'breakdown.export') throw new Error('STORYBOARD_NOT_READY')
      if (action === 'breakdown.detail') return breakdownDetail
      if (action === 'breakdown.rewriteRules') return { status: 'ready', rules, total: 1 }
      if (action === 'breakdown.history') return { status: 'ready', history: [historyRow('wf-1', 'succeeded')], total: 1 }
      throw new Error(`unexpected ${action}`)
    })
    fireEvent.click(screen.getByRole('button', { name: en['bd.exportExcel'] }))
    expect(await screen.findByText(en['bd.error.STORYBOARD_NOT_READY'])).not.toBeNull()
    expect(screen.getByText(en['bd.card.original'])).not.toBeNull()
  })

  it('详情页：candidate 辅助源降级错误就近展示；失败终态给失败文案与强制重试确认', async () => {
    const failedDetail = { ...breakdownDetail, candidate: null, candidateError: 'CANDIDATE_NOT_FOUND' }
    mockAll({
      'breakdown.history': { status: 'ready', history: [historyRow('wf-9', 'failed')], total: 1 },
      'breakdown.detail': failedDetail,
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    const row = await screen.findByRole('row', { name: /三分钟看懂增程车/u })
    fireEvent.keyDown(row, { key: 'Enter' })
    // 辅助源错误就近（不替换详情主体）。
    await waitFor(() => expect(screen.getByText(new RegExp(en['bd.candidateDegraded']))).not.toBeNull())
    // 失败终态：失败文案 + 强制重试按钮 + 确认弹层（含费用警示）。
    expect(screen.getByText(en['bd.wf.failed'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['bd.forceRetry'] }))
    expect(await screen.findByRole('dialog', { name: en['bd.forceRetryTitle'] })).not.toBeNull()
    expect(screen.getByText(en['bd.forceRetryConfirm'])).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['bd.forceRetryTitle'] })).toBeNull())
  })

  it('重新改写：弹层规则单选 + 开始改写 primary 确认（不自动发起）', async () => {
    mockAll({ 'breakdown.history': { status: 'ready', history: [historyRow('wf-1', 'succeeded')], total: 1 } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    const row = await screen.findByRole('row', { name: /三分钟看懂增程车/u })
    fireEvent.keyDown(row, { key: 'Enter' })
    await screen.findByRole('button', { name: en['bd.rewriteButton'] })
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('breakdown.workflowStart', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: en['bd.rewriteButton'] }))
    expect(await screen.findByRole('dialog', { name: en['bd.rewriteTitle'] })).not.toBeNull()
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('breakdown.workflowStart', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: en['bd.rewriteStart'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('breakdown.workflowStart', expect.objectContaining({
      candidateId: 'c-wf-1',
      idempotencyKey: expect.stringMatching(/^douyin:vv_workflow:/u),
    })))
  })
})

describe('爆款素材看板（parity §4–§7）', () => {
  it('看板结构：12 列 + 档位 Tag + 长标题 aria-label + 分页 + KPI 服务端 total', async () => {
    mockAll({
      'material.videos.list': { status: 'ready', data: { candidates: [materialCandidate], total: 40, offset: 0, limit: 20, hotLevelSummary: { S: 3, A: 7 } } },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    const table = await screen.findByRole('table', { name: en['mat.section.board'] })
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers).toHaveLength(12)
    expect(headers[3]).toBe(en['mat.col.play'])
    // 档位色附文字。
    expect(screen.getByText(t('mat.score.level', { level: 'S' }))).not.toBeNull()
    // 长标题截断但保留完整 aria-label。
    const titleCell = screen.getByLabelText('超长标题的超长标题的超长标题的超长标题')
    expect(titleCell).not.toBeNull()
    // KPI total 用服务端 40 不用当页行数 1 冒充。
    expect(screen.getByText('40')).not.toBeNull()
    // 分页：共 40 条 → 第 1/2 页，下一页可点、上一页禁用。
    expect(screen.getByText(kitT('pager.info', { total: 40, page: 1, pages: 2 }))).not.toBeNull()
    expect(screen.getByRole('button', { name: kitEn['pager.prev'] }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: kitEn['pager.next'] }).getAttribute('disabled')).toBeNull()
  })

  it('筛选变化 offset 归零并按最新请求收口；q 走防抖路径不立即发', async () => {
    mockAll({ 'material.videos.list': { status: 'ready', data: { candidates: [], total: 25, offset: 0, limit: 20 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.videos.list', expect.objectContaining({ offset: 0 })))
    fireEvent.click(screen.getByRole('button', { name: kitEn['pager.next'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.videos.list', expect.objectContaining({ offset: 20 })))
    // 切换档位筛选 → offset 归零。
    fireEvent.click(screen.getByRole('button', { name: en['mat.filter.minLevel'] }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en['mat.filter.minLevel.S'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenLastCalledWith('material.videos.list', expect.objectContaining({ minLevel: 'S', offset: 0 })))
  })

  it('评分理由抽屉：结构化对照四态（命中 +N / 还差 / 未采集 / 互动率注记）', async () => {
    mockAll({ 'material.videos.list': { status: 'ready', data: { candidates: [materialCandidate], total: 1, offset: 0, limit: 20 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['mat.action.reason'] }))
    const drawer = await screen.findByRole('dialog', { name: en['mat.reason.title'] })
    expect(drawer).not.toBeNull()
    expect(screen.getByText(t('mat.reason.hit', { points: 10 }))).not.toBeNull()
    expect(screen.getByText(t('mat.reason.gap', { gap: '300' }))).not.toBeNull()
    expect(screen.getByText(en['mat.reason.notCollected'])).not.toBeNull()
    expect(screen.getByText(en['mat.reason.interactionNote'])).not.toBeNull()
    expect(screen.getByText(t('mat.reason.ruleVersion.hot-v1'))).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['mat.close'] }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['mat.reason.title'] })).toBeNull())
  })

  it('关键词 seed：新增弹窗字段 + 编辑锁定 + 启停二次确认', async () => {
    mockAll({
      'material.seeds.list': {
        status: 'ready',
        data: {
          keywords: [{ seedId: 's1', keyword: '增程车', priority: 'P1', status: 'active', searchCount: 10, updatedAt: '2026-11-20T10:00:00Z' }],
          accounts: [], keywordByStatus: { active: 1 }, accountByStatus: {},
        },
      },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 切关键词子页（页内二级 tablist）。
    fireEvent.click((await screen.findAllByRole('tab', { name: new RegExp(en['mat.section.keywords']) }))[0])
    expect(await screen.findByRole('table', { name: en['mat.section.keywords'] })).not.toBeNull()
    // 编辑弹窗：关键词输入锁定（disabled）。
    const editTrigger = screen.getByRole('button', { name: en['mat.seed.edit'] })
    editTrigger.focus()
    fireEvent.click(editTrigger)
    const dialog = await screen.findByRole('dialog', { name: en['mat.seed.title.keywordEdit'] })
    expect(dialog).not.toBeNull()
    const locked = dialog.querySelector('input')
    expect(locked?.getAttribute('disabled')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['mat.seed.title.keywordEdit'] })).toBeNull())
    // Esc 关闭后焦点回归触发按钮（官方 Modal 承担）。
    await waitFor(() => expect(document.activeElement).toBe(editTrigger))
    // 启停二次确认。
    fireEvent.click(screen.getByRole('button', { name: en['mat.seed.disable'] }))
    expect(await screen.findByText(en['mat.seedConfirm.disable.keyword'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['mat.seedConfirm.confirm'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('material.keyword.upsert', expect.objectContaining({
      keywords: [{ keyword: '增程车', status: 'disabled' }],
      confirm: true,
      idempotencyKey: expect.stringMatching(/^douyin:vv_keyword_upsert:/u),
    })))
  })

  it('手动采集：确认弹层统计与提示；受理后 activeRun 横幅；ACTIVE_RUN_EXISTS 冲突解释不重发', async () => {
    mockAll({
      'material.runs.list': { status: 'ready', data: { runs: [materialRun('running')], total: 1 } },
      'material.seeds.list': {
        status: 'ready',
        data: { keywords: [], accounts: [], keywordByStatus: { active: 3 }, accountByStatus: { active: 2 } },
      },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    fireEvent.click((await screen.findAllByRole('tab', { name: new RegExp(en['mat.section.runs']) }))[0])
    // resume：最新行在途 → activeRun 横幅 + 立即采集禁用（不自动重发）。
    await waitFor(() => expect(screen.getByRole('status')).not.toBeNull())
    expect(screen.getByRole('button', { name: en['mat.runs.start'] }).getAttribute('disabled')).not.toBeNull()
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'material.runs.list') return { status: 'ready', data: { runs: [], total: 0 } }
      if (action === 'material.seeds.list') return { status: 'ready', data: { keywords: [], accounts: [], keywordByStatus: {}, accountByStatus: {} } }
      if (action === 'material.videos.list') return { status: 'ready', data: { candidates: [], total: 0 } }
      if (action === 'material.facets') return { status: 'ready', tags: [] }
      if (action === 'material.collect.start') throw new Error('VIRAL_VIDEO_ACTIVE_RUN_EXISTS')
      throw new Error(`unexpected ${action}`)
    })
    // 冲突场景：重新打开采集确认 → 冲突文案 + run 历史刷新。
    fireEvent.click(screen.getByRole('button', { name: en['mat.runs.refresh'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['mat.runs.start'] }).getAttribute('disabled')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: en['mat.runs.start'] }))
    expect(await screen.findByRole('dialog', { name: en['mat.collect.title'] })).not.toBeNull()
    expect(screen.getByText(en['mat.collect.note'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['mat.collect.confirm'] }))
    await waitFor(() => expect(screen.getByText(en['mat.error.VIRAL_VIDEO_ACTIVE_RUN_EXISTS'])).not.toBeNull())
    expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'material.collect.start')).toHaveLength(1)
  })

  it('run 历史 9 列 + 失败明细弹层（种子级两行 + 关键词列表）', async () => {
    mockAll({ 'material.runs.list': { status: 'ready', data: { runs: [materialRun('partial_failed')], total: 1 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    fireEvent.click((await screen.findAllByRole('tab', { name: new RegExp(en['mat.section.runs']) }))[0])
    const table = await screen.findByRole('table', { name: en['mat.section.runs'] })
    expect([...table.querySelectorAll('thead th')]).toHaveLength(9)
    fireEvent.click(screen.getByRole('button', { name: en['mat.runs.failureDetail'] }))
    const dialog = await screen.findByRole('dialog', { name: en['mat.failure.title'] })
    expect(dialog).not.toBeNull()
    expect(screen.getByText(t('mat.failure.keywords', { count: 1 }))).not.toBeNull()
    expect(screen.getByText('冬天用车')).not.toBeNull()
  })

  it('去拆解：预填链接并切爆款拆解 Tab，不自动开始归档', async () => {
    mockAll({ 'material.videos.list': { status: 'ready', data: { candidates: [materialCandidate], total: 1, offset: 0, limit: 20 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['mat.action.breakdown'] }))
    // 已切到拆解 Tab 且输入预填。
    expect(await screen.findByDisplayValue('https://v.douyin.com/abc/')).not.toBeNull()
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('breakdown.archiveStart', expect.anything())
  })

  it('看板加载失败：KPI 随看板降级为 —，不沿用旧筛选口径', async () => {
    mockAll({ 'material.videos.list': Promise.reject(new Error('PROVIDER_ERROR')) })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    expect(await screen.findByText(en['mat.error.PROVIDER_ERROR'])).not.toBeNull()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('breakdown.archiveStart', expect.anything())
  })

  it('facets 刷新失败保留既有标签，看板主请求独立成功不被吞（可选辅助数据）', async () => {
    const boardPayload = { status: 'ready', data: { candidates: [materialCandidate], total: 1, offset: 0, limit: 20 } }
    // mockAll 会 mockReset 清调用记录，facets 次数用自带计数器跨轮累计。
    let facetsCalls = 0
    mockAll({
      'material.facets': () => {
        facetsCalls += 1
        return { status: 'ready', tags: [{ tag: '对标', count: 3 }] }
      },
      'material.videos.list': boardPayload,
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 第一轮：标签筛选菜单出现服务端标签。
    fireEvent.click(await screen.findByRole('button', { name: en['mat.filter.tag'] }))
    expect(await screen.findByRole('menuitem', { name: '对标（3）' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['mat.filter.tag'] }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '对标（3）' })).toBeNull())
    // 重进 Tab：facets 拒绝、看板仍成功。
    mockAll({
      'material.facets': () => {
        facetsCalls += 1
        throw new Error('VIRAL_DASHBOARD_FAILED')
      },
      'material.videos.list': boardPayload,
    })
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 看板主请求独立成功：表格与行仍渲染，无任何数据域错误 alert。
    expect(await screen.findByRole('table', { name: en['mat.section.board'] })).not.toBeNull()
    expect(screen.getByLabelText('超长标题的超长标题的超长标题的超长标题')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // facets 刷新确实发起过且失败被丢弃：既有标签原样保留。
    expect(facetsCalls).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByRole('button', { name: en['mat.filter.tag'] }))
    expect(await screen.findByRole('menuitem', { name: '对标（3）' })).not.toBeNull()
  })
})

describe('爆款基因库（parity §8–§10）', () => {
  it('检索工具栏 + KPI 四卡 + facets chips + 已选条件条与清空', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('gene.search', expect.objectContaining({ limit: 20 })))
    // facets chip 可选中（aria-pressed）→ 已选条件条出现。
    const chip = await screen.findByRole('button', { name: /提问式开场/u })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip)
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenLastCalledWith('gene.search', expect.objectContaining({ geneTags: { hook: ['提问式开场'] } })))
    expect(screen.getByText(en['gene.selected'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['gene.clearAll'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenLastCalledWith('gene.search', expect.objectContaining({ limit: 20 })))
  })

  it('卡片墙：封面降级占位、缺失 — 不补 0、查看详情按钮', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    expect(await screen.findByRole('button', { name: en['gene.card.detail'] })).not.toBeNull()
    // 缺失指标显示 — （评论 200 有值，分享缺失 → 至少存在 —）。
    expect(screen.getAllByText('提问式开场').length).toBeGreaterThan(1)
  })

  it('详情弹层：报告四态字段（legacy_snapshot/not_exposed 文案）+ 编辑保存同键语义', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['gene.card.detail'] }))
    const dialog = await screen.findByRole('dialog', { name: en['gene.detail.title'] })
    expect(dialog).not.toBeNull()
    // 受众画像 = 旧快照待刷新；BGM = 模型未输出；摘要已采集。
    expect(screen.getByText(en['gene.report.state.legacy_snapshot'])).not.toBeNull()
    expect(screen.getByText(en['gene.report.state.not_exposed'])).not.toBeNull()
    expect(screen.getByText('报告摘要')).not.toBeNull()
    // 保存修正：成功路径带同 recordId 键模板。
    fireEvent.click(screen.getByRole('button', { name: en['gene.edit.save'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('gene.update', expect.objectContaining({
      recordId: 'g-1',
      idempotencyKey: expect.stringMatching(/^douyin:vv_gene_upd:g-1:/u),
    })))
  })

  it('重建确认：费用与异步警示文案；确认后发起 regenerate（同 recordId 键模板）', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['gene.card.detail'] }))
    await screen.findByRole('dialog', { name: en['gene.detail.title'] })
    expect(apiMock.hostAction).not.toHaveBeenCalledWith('gene.regenerate', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: en['gene.regenerate'] }))
    expect(await screen.findByText(en['gene.regenerateBody'])).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['gene.regenerateConfirm'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('gene.regenerate', expect.objectContaining({
      recordId: 'g-1',
      idempotencyKey: expect.stringMatching(/^douyin:vv_gene_reg:g-1:/u),
    })))
  })

  it('失败胶囊：failedCount>0 显示并可打开失败列表（逐项重试）', async () => {
    mockAll({
      'gene.search': {
        status: 'ready',
        data: {
          ...geneSearchPayload.data,
          results: [{ ...geneRecord, geneStatus: 'failed', geneErrorCode: 'GENE_EXTRACT_TIMEOUT', geneAttemptCount: 2 }],
          stats: { total: 1, last7d: 0, adoptedRatio: 0, failedCount: 1 },
        },
      },
      'gene.list': { status: 'ready', data: { items: [{ recordId: 'g-1', title: '钩子拆解条目', geneStatus: 'failed', geneErrorCode: 'GENE_EXTRACT_TIMEOUT', geneAttemptCount: 2, adoptionStatus: null, updatedAt: null }], total: 1 } },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['gene.failedEntryAria'] }))
    expect(await screen.findByRole('dialog', { name: en['gene.failed.title'] })).not.toBeNull()
    const dialog = screen.getByRole('dialog', { name: en['gene.failed.title'] })
    const retryInDialog = [...dialog.querySelectorAll('button')].find(button => button.textContent === en['gene.failed.retry'])
    expect(retryInDialog).toBeDefined()
    fireEvent.click(retryInDialog as HTMLElement)
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenCalledWith('gene.regenerate', expect.objectContaining({
      recordId: 'g-1',
      idempotencyKey: expect.stringMatching(/^douyin:vv_gene_reg:g-1:/u),
    })))
  })
})

describe('zh/en 词典与 D6–D8 键集', () => {
  it('D6–D8 键 zh/en 全量同步（bd./mat./gene. 前缀）', () => {
    const zhKeys = Object.keys(zh).filter(key => key.startsWith('bd.') || key.startsWith('mat.') || key.startsWith('gene.'))
    expect(zhKeys.length).toBeGreaterThan(300)
    for (const key of zhKeys) {
      expect(en[key as DouyinLocaleKey], `${key} 缺 en`).toBeDefined()
      expect(typeof en[key as DouyinLocaleKey]).toBe('string')
    }
  })
})

describe('D6–D8 第一轮验收修复（keep-alive / 轮询 / parity 细节）', () => {
  it('未访问过的 D6–D8 Tab 不 eager mount（不发起任何请求）', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    await act(async () => { await Promise.resolve() })
    const lazy = apiMock.hostAction.mock.calls.filter(([action]) => /^(material|breakdown|gene)\./u.test(action))
    expect(lazy).toEqual([])
  })

  it('Breakdown archive 轮询不随顶级 Tab 切换停止；重进刷新 rules/history', async () => {
    vi.useFakeTimers()
    try {
      const archiveStatus = vi.fn(async () => ({ status: 'ready', archive: { runId: 'run-1', runStatus: 'waiting', nextAction: 'poll_status' } }))
      mockAll({ 'breakdown.archiveStatus': archiveStatus })
      render(<WorkbenchPage t={t} locale={locale} />)
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
      await act(async () => { await Promise.resolve() })
      const historyCalls = () => apiMock.hostAction.mock.calls.filter(([action]) => action === 'breakdown.history').length
      const initialHistory = historyCalls()
      fireEvent.change(screen.getByLabelText(en['bd.shareLabel']), { target: { value: 'https://v.douyin.com/x/' } })
      fireEvent.click(screen.getByRole('button', { name: en['bd.startButton'] }))
      await act(async () => { await Promise.resolve() })
      // 受理后轮询进行中：横幅可见（fake timers 下用同步查询）。
      expect(screen.getByText(en['bd.archivePending'])).not.toBeNull()
      const before = archiveStatus.mock.calls.length
      // 切走（works Tab）：轮询继续（keep-alive）。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(archiveStatus.mock.calls.length).toBeGreaterThan(before)
      // 重进：rules/history 刷新（history 调用数增加）。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
      await act(async () => { await Promise.resolve() })
      expect(historyCalls()).toBeGreaterThan(initialHistory)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Breakdown openDetail 不停止 archive 轮询（旧语义：完成时在看详情则挂起补启动）', async () => {
    vi.useFakeTimers()
    try {
      const archiveStatus = vi.fn(async () => ({ status: 'ready', archive: { runId: 'run-1', runStatus: 'waiting', nextAction: 'poll_status' } }))
      mockAll({
        'breakdown.archiveStatus': archiveStatus,
        'breakdown.history': { status: 'ready', history: [historyRow('wf-1', 'succeeded')], total: 1 },
      })
      render(<WorkbenchPage t={t} locale={locale} />)
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
      await act(async () => { await Promise.resolve() })
      fireEvent.change(screen.getByLabelText(en['bd.shareLabel']), { target: { value: 'https://v.douyin.com/x/' } })
      fireEvent.click(screen.getByRole('button', { name: en['bd.startButton'] }))
      await act(async () => { await Promise.resolve() })
      // 归档受理后进入历史行详情：详情视图可见，且 archive 轮询未被 openDetail
      // 清掉（横幅在主视图，进详情后不显示是旧语义；轮询继续才是断言点）。
      const row = screen.getAllByRole('row').find(tr => tr.textContent?.includes('三分钟看懂增程车'))
      expect(row).toBeDefined()
      fireEvent.doubleClick(row as HTMLElement)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('button', { name: en['bd.backToList'] })).not.toBeNull()
      const before = archiveStatus.mock.calls.length
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(archiveStatus.mock.calls.length).toBeGreaterThan(before)
      expect(screen.getByRole('button', { name: en['bd.backToList'] })).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Breakdown 历史短页不显示「加载更多」（返回行数 < 当前 limit）', async () => {
    const shortRows = Array.from({ length: 5 }, (_item, index) => historyRow(`wf-${index}`, 'succeeded'))
    mockAll({ 'breakdown.history': { status: 'ready', history: shortRows, total: 5 } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    await screen.findByRole('table', { name: en['bd.historyLabel'] })
    expect(screen.queryByRole('button', { name: en['bd.loadMore'] })).toBeNull()
    // 满页（10 行 = 当前 limit）显示加载更多。
    const fullRows = Array.from({ length: 10 }, (_item, index) => historyRow(`wf-${index}`, 'succeeded'))
    mockAll({ 'breakdown.history': { status: 'ready', history: fullRows, total: 10 } })
    cleanup()
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    await screen.findByRole('table', { name: en['bd.historyLabel'] })
    expect(screen.getByRole('button', { name: en['bd.loadMore'] })).not.toBeNull()
  })

  it('Material 离开 Tab 停 run 轮询、重进恢复并从最新 run 续轮（runs.list 显式 limit=50）', async () => {
    vi.useFakeTimers()
    try {
      const collectStatus = vi.fn(async () => ({ status: 'ready', data: { runId: 'run-1', runStatus: 'running', startedAt: '2026-11-21T09:00:00Z', nextAction: 'poll_status' } }))
      mockAll({
        'material.runs.list': { status: 'ready', data: { runs: [materialRun('running')], total: 1 } },
        'material.collect.status': collectStatus,
      })
      render(<WorkbenchPage t={t} locale={locale} />)
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      // Tab 进入预取显式 limit=50（旧客户端口径）。
      expect(apiMock.hostAction).toHaveBeenCalledWith('material.runs.list', { limit: 50 })
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(1)
      // 切走：轮询停止。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      act(() => { vi.advanceTimersByTime(9100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(1)
      // 切回：runs 重拉并恢复轮询。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'material.runs.list').length).toBe(2)
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Material collect.status 连续 5 次 malformed：统一停轮询、清 activeRun、runs 区稳定失败', async () => {
    vi.useFakeTimers()
    try {
      // 无 data 键 → readMaterialRunStatus null（malformed 路径与异常共用 fail()）。
      mockAll({
        'material.runs.list': { status: 'ready', data: { runs: [materialRun('running')], total: 1 } },
        'material.collect.status': { status: 'ready' },
      })
      render(<WorkbenchPage t={t} locale={locale} />)
      // 外层 DataState 等 accounts.list 就绪才挂 Tab 内容：先 flush 再切 Tab。
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      // fake timers 下 find* 家族（内部 waitFor）会挂起：改用同步 getAllByRole。
      const runsTabs = screen.getAllByRole('tab').filter(node => node.textContent?.includes(en['mat.section.runs']))
      expect(runsTabs.length).toBeGreaterThan(0)
      fireEvent.click(runsTabs[0] as HTMLElement)
      await act(async () => { await Promise.resolve() })
      for (let tick = 0; tick < 5; tick += 1) {
        act(() => { vi.advanceTimersByTime(3100) })
        await act(async () => { await Promise.resolve() })
      }
      const statusCalls = () => apiMock.hostAction.mock.calls.filter(([action]) => action === 'material.collect.status').length
      const stopped = statusCalls()
      expect(stopped).toBe(5)
      act(() => { vi.advanceTimersByTime(9100) })
      await act(async () => { await Promise.resolve() })
      expect(statusCalls()).toBe(stopped)
      // activeRun 清除（横幅消失）+ runs 区稳定失败。
      expect([...document.querySelectorAll('[role="status"]')].some(node => node.textContent?.includes(en['mat.runs.active'].split('{')[0] ?? ''))).toBe(false)
      expect(screen.getByText(en['mat.error.douyin_operation_request_failed'])).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Material 状态保留与 portal 不泄漏：seed 弹窗 open 状态跨 Tab 保留；重进 board 预取携带既有筛选', async () => {
    mockAll({
      'material.seeds.list': {
        status: 'ready',
        data: { keywords: [{ seedId: 's1', keyword: '增程车', priority: 'P1', status: 'active', searchCount: 10, updatedAt: null }], accounts: [], keywordByStatus: { active: 1 }, accountByStatus: {} },
      },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 先在 board 子页设置筛选（S 档）→ 后续 board 请求携带 minLevel。
    fireEvent.click(await screen.findByRole('button', { name: en['mat.filter.minLevel'] }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en['mat.filter.minLevel.S'] }))
    await waitFor(() => expect(apiMock.hostAction).toHaveBeenLastCalledWith('material.videos.list', expect.objectContaining({ minLevel: 'S' })))
    // 切到关键词子页开编辑弹窗。
    fireEvent.click((await screen.findAllByRole('tab', { name: new RegExp(en['mat.section.keywords']) }))[0])
    // 打开编辑弹窗后切走：无 portal 泄漏。
    fireEvent.click(screen.getByRole('button', { name: en['mat.seed.edit'] }))
    expect(await screen.findByRole('dialog', { name: en['mat.seed.title.keywordEdit'] })).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: en['mat.seed.title.keywordEdit'] })).toBeNull()
    // 切回：弹窗恢复 + 预取 board 仍携带既有筛选（filters 保留；预取并发不保证
    // board 是最后一个调用，按带筛选的调用计数断言）。
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: en['mat.seed.title.keywordEdit'] })).not.toBeNull())
    const filteredBoardCalls = () => apiMock.hostAction.mock.calls
      .filter(([action, args]) => action === 'material.videos.list' && (args as { minLevel?: string }).minLevel === 'S' && (args as { offset?: number }).offset === 0)
      .length
    await waitFor(() => expect(filteredBoardCalls()).toBeGreaterThanOrEqual(2))
  })

  it('Material 看板行标题链接与纯文本退化；activeRun 横幅带查看看板入口；KPI 最新批次取 runs[0]', async () => {
    const linked = { ...materialCandidate }
    const unlinked = { ...materialCandidate, candidateId: 'm-2', title: '无链接候选', shareUrl: null }
    mockAll({
      'material.videos.list': { status: 'ready', data: { candidates: [linked, unlinked], total: 2, offset: 0, limit: 20 } },
      'material.runs.list': { status: 'ready', data: { runs: [materialRun('running')], total: 1 } },
    })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 有 shareUrl：标题为链接（新窗口 + noreferrer），长文本 aria-label 完整。
    const anchor = await screen.findByRole('link', { name: '超长标题的超长标题的超长标题的超长标题' })
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toContain('noreferrer')
    // 无 shareUrl：退化为纯文本（无链接）。
    expect(screen.getByText('无链接候选')).not.toBeNull()
    expect(screen.queryByRole('link', { name: '无链接候选' })).toBeNull()
    // KPI 最新批次 = runs[0]（在途 run 也是最新批次：显示其开始日期而非 —）。
    await waitFor(() => expect(screen.getByText('2026-11-21')).not.toBeNull())
  })

  it('Material activeRun 横幅：查看看板入口切回 board 子页', async () => {
    mockAll({ 'material.runs.list': { status: 'ready', data: { runs: [materialRun('running')], total: 1 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    // 切到采集记录子页 → 横幅出现（resume 最新 run 在途）。
    fireEvent.click((await screen.findAllByRole('tab', { name: new RegExp(en['mat.section.runs']) }))[0])
    // 横幅入口与 run 行按钮同名：取横幅（role=status 容器）内那枚。
    await waitFor(() => {
      const banner = [...document.querySelectorAll('[role="status"]')].find(node => node.querySelector('button'))
      expect(banner).toBeDefined()
    })
    const bannerButton = [...document.querySelectorAll('[role="status"]')].flatMap(node => [...node.querySelectorAll('button')])
      .find(button => button.textContent === en['mat.runs.viewBoard'])
    expect(bannerButton).toBeDefined()
    fireEvent.click(bannerButton as HTMLElement)
    // 切回看板子页：筛选条（board 独有）重新可达。
    await waitFor(() => expect(screen.getByRole('button', { name: en['mat.filter.minLevel'] })).not.toBeNull())
  })

  it('Material 看板请求失败保留已有 rows，仅 total/levelSummary 降级并显示错误', async () => {
    mockAll({ 'material.videos.list': { status: 'ready', data: { candidates: [materialCandidate], total: 40, offset: 0, limit: 20 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    expect(await screen.findByRole('link', { name: '超长标题的超长标题的超长标题的超长标题' })).not.toBeNull()
    // 改变筛选触发新请求 → 失败：行保留 + 错误显示 + total 降级。
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }
      if (action === 'accounts.list') return { status: 'ready', accounts: [], remoteError: null }
      if (action === 'material.facets') return { status: 'ready', tags: [] }
      if (action === 'material.seeds.list') return { status: 'ready', data: { keywords: [], accounts: [], keywordByStatus: {}, accountByStatus: {} } }
      if (action === 'material.runs.list') return { status: 'ready', data: { runs: [], total: 0 } }
      if (action === 'material.collect.status') return { status: 'ready', data: { runId: 'run-1', runStatus: 'completed', nextAction: 'done' } }
      if (action === 'material.videos.list') throw new Error('PROVIDER_ERROR')
      throw new Error(`unexpected ${action}`)
    })
    fireEvent.click(screen.getByRole('button', { name: en['mat.filter.minLevel'] }))
    fireEvent.click(await screen.findByRole('menuitem', { name: en['mat.filter.minLevel.S'] }))
    expect(await screen.findByText(en['mat.error.PROVIDER_ERROR'])).not.toBeNull()
    // 已有行仍可见（不清空可见数据）；total 降级为统计加载中。
    expect(screen.getByRole('link', { name: '超长标题的超长标题的超长标题的超长标题' })).not.toBeNull()
    expect(screen.getByText(kitEn['pager.loading'])).not.toBeNull()
  })

  it('评分理由抽屉：Esc 关闭并回归焦点触发按钮；遮罩点击关闭', async () => {
    mockAll({ 'material.videos.list': { status: 'ready', data: { candidates: [materialCandidate], total: 1, offset: 0, limit: 20 } } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
    const trigger = await screen.findByRole('button', { name: en['mat.action.reason'] })
    trigger.focus()
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: en['mat.reason.title'] })).not.toBeNull()
    // Esc 关闭 + 焦点回归。
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['mat.reason.title'] })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    // 遮罩点击同样关闭。
    fireEvent.click(trigger)
    const drawer = await screen.findByRole('dialog', { name: en['mat.reason.title'] })
    const overlay = drawer.previousElementSibling
    expect(overlay?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(overlay as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: en['mat.reason.title'] })).toBeNull())
  })

  it('按钮语义源级锁定：评分理由 primary / 去拆解浅灰；seed 启用 primary / 禁用浅灰（关键词与对标账号同款）', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'MaterialPage.tsx'), 'utf8')
    expect(source).toContain("variant='primary' size='sm' onClick={props.onOpenReason}")
    // 浅灰次操作 = 官方 toolbar 变体 + softAction（参照小红书车衣爆款看板过滤按钮）。
    expect(source).toContain("variant='toolbar' size='sm' className={css.softAction} onClick={() => { props.onStartBreakdown(row.shareUrl ?? '') }}")
    expect(source).toMatch(/<Button variant='primary' size='sm' onClick=\{\(\) => \{ props\.onToggle\(row\) \}\}>\{t\('mat\.seed\.enable'\)\}<\/Button>/u)
    expect(source).toMatch(/<Button variant='toolbar' size='sm' className=\{css\.softAction\} onClick=\{\(\) => \{ props\.onToggle\(row\) \}\}>\{t\('mat\.seed\.disable'\)\}<\/Button>/u)
    expect(source).toMatch(/<Button variant='toolbar' size='sm' className=\{css\.softAction\} onClick=\{\(\) => \{ props\.onToggle\(account\) \}\}>\{t\('mat\.seed\.disable'\)\}<\/Button>/u)
  })

  it('inactive 竞态守卫：晚到的 runs 响应不恢复轮询；切回后重新 load/resume', async () => {
    vi.useFakeTimers()
    try {
      const collectStatus = vi.fn(async () => ({ status: 'ready', data: { runId: 'run-1', runStatus: 'running', startedAt: null, nextAction: 'poll_status' } }))
      let resolveRuns: (value: unknown) => void = () => undefined
      mockAll({
        'material.runs.list': new Promise(resolve => { resolveRuns = resolve }),
        'material.collect.status': collectStatus,
      })
      render(<WorkbenchPage t={t} locale={locale} />)
      // 外层 DataState 等 accounts ready：flush 后进入 Material（runs 挂起未决）。
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      // 用户切走：inactive effect 停轮询；此后晚到 runs 才返回 running 行。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await act(async () => { await Promise.resolve() })
      resolveRuns({ status: 'ready', data: { runs: [materialRun('running')], total: 1 } })
      await act(async () => { await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(0, 'hidden Material 不得恢复 run 轮询')
      // 切回：active effect 重新 load/resume，轮询恢复。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('inactive 竞态守卫：collect.start 晚到 ACTIVE_RUN_EXISTS 冲突不恢复轮询；切回后 resume', async () => {
    vi.useFakeTimers()
    try {
      const collectStatus = vi.fn(async () => ({ status: 'ready', data: { runId: 'run-1', runStatus: 'running', startedAt: null, nextAction: 'poll_status' } }))
      let rejectStart: (reason: unknown) => void = () => undefined
      let runsCalls = 0
      mockAll({
        // 首次（挂载预取）空列表使「立即采集」可用；冲突刷新起返回 running 行。
        'material.runs.list': async () => {
          runsCalls += 1
          return runsCalls === 1
            ? { status: 'ready', data: { runs: [], total: 0 } }
            : { status: 'ready', data: { runs: [materialRun('running')], total: 1 } }
        },
        'material.collect.start': new Promise((_resolve, reject) => { rejectStart = reject }),
        'material.collect.status': collectStatus,
      })
      render(<WorkbenchPage t={t} locale={locale} />)
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      // 采集记录子页：确认弹层 → 确认采集（collect.start 挂起未决）。
      const runsTabs = screen.getAllByRole('tab').filter(node => node.textContent?.includes(en['mat.section.runs']))
      fireEvent.click(runsTabs[0] as HTMLElement)
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('button', { name: en['mat.runs.start'] }))
      await act(async () => { await Promise.resolve() })
      fireEvent.click(screen.getByRole('button', { name: en['mat.collect.confirm'] }))
      await act(async () => { await Promise.resolve() })
      // 立即切走，再让受理以冲突拒绝：loadRuns 刷新返回 running 行也不得轮询。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
      await act(async () => { await Promise.resolve() })
      rejectStart(new Error('VIRAL_VIDEO_ACTIVE_RUN_EXISTS'))
      await act(async () => { await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(0, 'hidden Material 不得经冲突刷新恢复轮询')
      // 切回：重新 load/resume，轮询恢复。
      fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
      fireEvent.click(screen.getByRole('tab', { name: en['tab.material'] }))
      await act(async () => { await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(3100) })
      await act(async () => { await Promise.resolve() })
      expect(collectStatus.mock.calls.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Gene 重进 Tab offset 归零重拉 search；弹窗 open 状态与 portal 隔离', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    await waitFor(() => expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'gene.search').length).toBe(1))
    fireEvent.click(await screen.findByRole('button', { name: en['gene.card.detail'] }))
    expect(await screen.findByRole('dialog', { name: en['gene.detail.title'] })).not.toBeNull()
    // 切走：无 portal 泄漏；切回：弹窗恢复 + search 重拉（offset 归零）。
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.data'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.works'] }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: en['gene.detail.title'] })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: en['gene.detail.title'] })).not.toBeNull())
    await waitFor(() => expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'gene.search').length).toBe(2))
    expect(apiMock.hostAction.mock.calls.filter(([action]) => action === 'gene.search').every(([, args]) => (args as { offset?: number }).offset === 0 || (args as { offset?: number }).offset === undefined)).toBe(true)
  })

  it('基因详情采纳状态：当前状态高亮，切换后新状态高亮（旧选中态反馈）', async () => {
    mockAll({ 'gene.search': geneSearchPayload })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.gene'] }))
    fireEvent.click(await screen.findByRole('button', { name: en['gene.card.detail'] }))
    await screen.findByRole('dialog', { name: en['gene.detail.title'] })
    // geneRecord.adoptionStatus = ai_draft：默认高亮「AI 草稿」。
    const draft = screen.getByRole('button', { name: en['gene.filter.adoption.ai_draft'] })
    expect(draft.getAttribute('aria-pressed')).toBe('true')
    expect(draft.className).toMatch(/adoptionChipActive/u)
    // 切到「已采纳」：高亮随之转移，原选中项取消高亮。
    fireEvent.click(screen.getByRole('button', { name: en['gene.filter.adoption.adopted'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['gene.filter.adoption.adopted'] }).getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByRole('button', { name: en['gene.filter.adoption.adopted'] }).className).toMatch(/adoptionChipActive/u)
    expect(screen.getByRole('button', { name: en['gene.filter.adoption.ai_draft'] }).className).not.toMatch(/adoptionChipActive/u)
  })
})

describe('gene.get 投影真实形状（D9B 真机第五缺陷回归）', () => {
  it('readGeneRecord 兼容 data 顶层平铺（Workbench MCP 实际形状）与 data.record 包装', async () => {
    const { readGeneRecord } = await import('../../src/client/schema.ts')
    const realRecord = { recordId: 'vvk_106bc17761441659', awemeId: '7710859062174670159', title: '#父子日常 #大润发', geneStatus: 'succeeded', geneTags: { hook: ['提问式开场'] }, metrics: { playCount: 17000, likeCount: 126, commentCount: 53, shareCount: 5, collectCount: 7 } }
    // Workbench MCP 实际响应：record 平铺在 data 顶层（真机 2026-11-22 复现详情弹层空白）。
    const flat = readGeneRecord({ status: 'ready', data: realRecord })
    assert.equal(flat?.recordId, 'vvk_106bc17761441659', 'data 顶层平铺形态必须可解析')
    // 旧 route 形态：data.record 包装仍兼容。
    const wrapped = readGeneRecord({ status: 'ready', data: { record: realRecord } })
    assert.equal(wrapped?.recordId, 'vvk_106bc17761441659')
  })
})

describe('work.trend 快照投影（D9B 真机第七缺陷回归）', () => {
  it('readWorkTrend 读 play_count 并同日取 captured_at 最大（旧 snapshotTrendPoints 同构）', async () => {
    const { readWorkTrend } = await import('../../src/client/schema.ts')
    // work.trend 快照行真实形状：无 value 字段，值为 play_count；同日两条取后者。
    const payload = {
      status: 'ready',
      data: {
        snapshots: [
          { day: '2026-11-21', captured_at: '2026-11-21T20:15:00+08:00', play_count: 100 },
          { day: '2026-11-22', captured_at: '2026-11-22T10:00:00+08:00', play_count: 150 },
          { day: '2026-11-22', captured_at: '2026-11-22T22:00:00+08:00', play_count: 300 },
          { day: '2026-11-23', captured_at: '2026-11-23T10:22:00+08:00', play_count: null },
        ],
      },
    }
    const points = readWorkTrend(payload)
    assert.deepEqual(points.map(p => p.day), ['2026-11-21', '2026-11-22'])
    assert.deepEqual(points.map(p => p.value), [100, 300], '同日多条取 captured_at 最大')
    // play_count null 的行丢弃（不造 0）。
  })
})

describe('ui-accessibility 行级手势统一（A5）', () => {
  it('X3 拆解历史行：单击不打开；双击文字区与 Enter 各打开一次', async () => {
    mockAll({ 'breakdown.history': { status: 'ready', history: [historyRow('wf-1', 'succeeded')], total: 1 } })
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['nav.group.material'] }))
    fireEvent.click(screen.getByRole('tab', { name: en['tab.breakdown'] }))
    const row = await screen.findByRole('row', { name: /三分钟看懂增程车/u })
    // 单击：详情不打开。
    fireEvent.click(row)
    expect(screen.queryByRole('button', { name: en['bd.backToList'] })).toBeNull()
    // 双击文字区域：打开一次。
    fireEvent.doubleClick(row)
    await screen.findByRole('button', { name: en['bd.backToList'] })
    // 返回列表后 Enter 仍打开（键盘路径不变）。
    fireEvent.click(screen.getByRole('button', { name: en['bd.backToList'] }))
    const rowAgain = await screen.findByRole('row', { name: /三分钟看懂增程车/u })
    fireEvent.keyDown(rowAgain, { key: 'Enter' })
    await screen.findByRole('button', { name: en['bd.backToList'] })
  })
})
