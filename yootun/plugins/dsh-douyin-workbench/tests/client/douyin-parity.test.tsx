/**
 * parity 对账测试（p4-douyin-workbench-d2-d5-ui-parity.md 逐行锚点 + 纯函数与
 * 词典契约）：排序三态/缺失恒最后、万位与百分比 clamp、上海时区时间、粉丝增量
 * 红涨绿跌语义、观看趋势四状态、数据缺口五类、批量六原因、排期 rowId 十进制
 * 字符串序与快照归一、投流逐项校验分键、schedule 18 码 / report 17 码 / AI 9
 * 码全表、Host 载荷读取器、kit 样式表装载清单。
 *
 * parity 锚点对账清单（§0–§8，无法本地锁定的项登记为真机遗留）：
 * - §0 顶级导航 7 Tab 冻结顺序（douyin-client.test.tsx「顶级导航」组）
 * - §1 账号总览：4 筛选 + KPI 6 卡缺失整卡消失 + 排行 11 列 + 爆款 6 列 +
 *   分布仅数组时 + 提醒三类 + 导出（「账号总览页结构」组）
 * - §2 单账号分析：返回保留筛选 + 5 KPI + 粉丝 5 卡整块缺失不渲染 + 趋势 7
 *   枚举 30 天窗口缺口虚线 + 内容指标 + 观众与流量 5 块 + 本账号爆款 7 列 +
 *   AI 弹层六卡/状态机/轮询 3s（「单账号分析」与「键盘路径」组；轮询节奏本地
 *   以实现常量锁定，真机节奏为遗留）
 * - §3 账号作品：左栏 280px 两列 + 批量三态/六原因 + 删除两步 RUN_STILL_ACTIVE
 *   文案 + 工具栏主/次分层 + runBanner 三色 + 12 列冻结 + 排序三态 + 详情弹层
 *   区块顺序冻结（「账号作品页」组）
 * - §4 发布排期：12 列 + 副标 + 行状态机六态 + no-op/dirty/同键重试/放弃 +
 *   折叠/斑马纹/发布日期升序 rowId 字符串序 + 账号切换互斥 + beforeunload +
 *   18 码全表（「发布排期看板」组与本文件 schedule 组）
 * - §5 AI 报表：列表/详情双态 + 状态五态 + 版本 + 重新生成确认同键 + HTML/
 *   PDF 导出（「AI 报表页」组；PDF 桥真机为遗留）
 * - §6 负责人/投流弹层：≤128/trim 空拒绝、六字段校验分键、recordId 重挂载、
 *   PROMOTION_ALREADY_EXISTS 自动转更新（本文件 promotion/owner 组 + client
 *   组 Esc 回归）
 * - §7 采集入口与登录扫码流：2s/1.5s 轮询、乐观运行态、宿主重启丢 record 清
 *   乐观态（client 组「运行中按钮 aria-busy」；真机扫码链路为遗留）
 * - §8 按钮语义层级：主=primary、次=ghost/toolbar、危险=dangerButton error
 *   token + 确认路径、进行中=disabled+aria-busy（client 组「按钮语义」）
 * @module
 */
// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORK_SORT, batchReasonKey, compareNullableNumbers, deltaText, domainErrorText,
  fanDelta, formatAgeBucket, formatCount, formatDateTime, formatDuration, formatPercent,
  formatSeconds, genderLabel, gapFieldLabel, gapReasonText, hotLabelText, nextWorkSort,
  reasonText, retentionStatus, retentionStatusKey, safeHttpUrl, safeWorkUrl, shiftDay,
  sortWorkRows, trafficSourceLabel, type Translate,
} from '../../src/client/format.ts'
import { validatePromotionForm } from '../../src/client/PromotionModal.tsx'
import { progressTextOf } from '../../src/client/WorksPanel.tsx'
import {
  SCHEDULE_PLATFORMS, buildServerSnapshot, comparePublishDate, compareRowId, readAccounts,
  readBatchStatus, readOverview, readReportDetail, readReportList, readScheduleRows,
  toScheduleUiRow, type ScheduleUiRow,
} from '../../src/client/schema.ts'
import { accountTrendRows, workTrendRows } from '../../src/client/charts.tsx'
import { en, zh, type DouyinLocaleKey } from '../../src/client/locales.ts'

/** zh 词典直取的翻译函数（纯逻辑测试底盘）。 */
const t: Translate = (key, values) => {
  const text = zh[key]
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, token: string) => (values[token] === undefined ? match : String(values[token])))
}

describe('格式化与排序（ui-format.js 语义迁移）', () => {
  it('formatCount 万位（≥1 万 locale compact）、缺失 — 不造 0', () => {
    expect(formatCount(null)).toBe('—')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(12345, 'zh')).toBe('1.2万')
    expect(formatCount(123456789, 'zh')).toBe('1.2亿')
    expect(formatCount(12345, 'en')).toBe('12.3K')
  })

  it('formatPercent clamp 0..100 两位小数；缺失 —', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(33.333)).toBe('33.33%')
    expect(formatPercent(120)).toBe('100%')
    expect(formatPercent(-5)).toBe('0%')
  })

  it('formatDateTime 固定 Asia/Shanghai（UTC+8，不随宿主时区）', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('2026-11-20T16:00:00Z')).toBe('2026-11-21 00:00')
    expect(formatDateTime('2026-11-20T15:59:00Z')).toBe('2026-11-20 23:59')
  })

  it('formatDuration：39219ms → 00:39；3761000ms → 1:02:41；缺失 null', () => {
    expect(formatDuration(39219)).toBe('00:39')
    expect(formatDuration(3761000)).toBe('1:02:41')
    expect(formatDuration(null)).toBeNull()
    expect(formatDuration(-1)).toBeNull()
  })

  it('fanDelta：net 正=+N 红、负=-N 绿、0/缺失=—；cancel 恒 -N 绿', () => {
    expect(fanDelta(45)).toEqual({ text: '+45', tone: 'up' })
    expect(fanDelta(-7)).toEqual({ text: '-7', tone: 'down' })
    expect(fanDelta(0)).toEqual({ text: '—', tone: 'flat' })
    expect(fanDelta(null)).toEqual({ text: '—', tone: 'flat' })
    expect(fanDelta(9, 'cancel')).toEqual({ text: '-9', tone: 'down' })
  })

  it('deltaText：正 +N、负原值、0/缺失 —', () => {
    expect(deltaText(12)).toEqual({ text: '+12', tone: 'up' })
    expect(deltaText(-3)).toEqual({ text: '-3', tone: 'down' })
    expect(deltaText(0)).toEqual({ text: '—', tone: 'flat' })
  })

  it('排序三态状态机 default → desc → asc → default；点击另一列直接 desc', () => {
    expect(nextWorkSort({ key: null, direction: 'default' }, 'play_count'))
      .toEqual({ key: 'play_count', direction: 'desc' })
    expect(nextWorkSort({ key: 'play_count', direction: 'desc' }, 'play_count'))
      .toEqual({ key: 'play_count', direction: 'asc' })
    expect(nextWorkSort({ key: 'play_count', direction: 'asc' }, 'play_count'))
      .toEqual(DEFAULT_WORK_SORT)
    expect(nextWorkSort({ key: 'play_count', direction: 'desc' }, 'like_count'))
      .toEqual({ key: 'like_count', direction: 'desc' })
  })

  it('缺失值排序恒最后且与方向无关；默认态严格保持接口顺序', () => {
    expect(compareNullableNumbers(null, 5, 'desc')).toBe(1)
    expect(compareNullableNumbers(null, 5, 'asc')).toBe(1)
    expect(compareNullableNumbers(5, null, 'desc')).toBe(-1)
    expect(compareNullableNumbers(3, 9, 'desc')).toBeGreaterThan(0)
    const rows = [{ play_count: 3 as number | null }, { play_count: null }, { play_count: 9 as number | null }]
    const valueOf = (row: { play_count: number | null }, key: 'play_count') => row[key]
    expect(sortWorkRows(rows, DEFAULT_WORK_SORT, valueOf)).toEqual(rows)
    expect(sortWorkRows(rows, { key: 'play_count', direction: 'desc' }, valueOf))
      .toEqual([{ play_count: 9 }, { play_count: 3 }, { play_count: null }])
  })

  it('观看趋势四状态：请求失败优先 / 未提供 / 未满 24h / 暂无', () => {
    const fresh = new Date(Date.now() - 3600_000).toISOString()
    const old = new Date(Date.now() - 48 * 3600_000).toISOString()
    expect(retentionStatus(null, 'request_failed', fresh)).toBe('request_failed')
    expect(retentionStatus(null, null, old)).toBe('not_exposed')
    expect(retentionStatus({}, null, fresh)).toBe('not_ready')
    expect(retentionStatus({}, null, old)).toBe('no_data')
    expect(retentionStatus({ current: [{ time_s: 3 }] }, null, old)).toBe('ok')
    expect(retentionStatusKey('not_ready')).toBe('retention.notReady')
    expect(retentionStatusKey('ok')).toBeNull()
  })

  it('数据缺口五类 reason + 字段中文化（未知收敛）', () => {
    expect(gapReasonText('not_exposed', t)).toBe(zh['gap.reason.not_exposed'])
    expect(gapReasonText('below_min_view', t)).toBe(zh['gap.reason.below_min_view'])
    expect(gapReasonText('past_item_below_min_count', t)).toBe(zh['gap.reason.past_item_below_min_count'])
    expect(gapReasonText('request_failed', t)).toBe(zh['gap.reason.request_failed'])
    expect(gapReasonText('no_data', t)).toBe(zh['gap.reason.no_data'])
    expect(gapReasonText('weird', t)).toBe(zh['gap.reason.other'])
    expect(gapFieldLabel('play_count', t)).toBe(zh['col.play'])
    expect(gapFieldLabel('retention_trend', t)).toBe(zh['gap.field.retention_trend'])
    expect(gapFieldLabel('mystery', t)).toBe(zh['gap.field.other'])
  })

  it('批量六原因映射；爆款依据/标签/性别/年龄/流量来源中文化', () => {
    expect(batchReasonKey('session_required')).toBe('batch.reason.sessionExpired')
    expect(batchReasonKey('session_invalid')).toBe('batch.reason.sessionExpired')
    expect(batchReasonKey('storage_state_missing')).toBe('batch.reason.storageMissing')
    expect(batchReasonKey('pending_account')).toBe('batch.reason.pending')
    expect(batchReasonKey('probe_failed')).toBe('batch.reason.probeFailed')
    expect(batchReasonKey('ingest_failed')).toBe('batch.reason.ingestFailed')
    expect(batchReasonKey('whatever')).toBe('batch.reason.failed')
    expect(batchReasonKey(null)).toBe('batch.reason.failed')
    expect(hotLabelText(['absolute', 'absolute', 'weird'], t)).toBe(`${zh['hot.label.absolute']} + ${zh['hot.label.other']}`)
    expect(hotLabelText(null, t)).toBe(zh['overview.insufficientSample'])
    expect(genderLabel('male', t)).toBe(zh['gender.male'])
    expect(formatAgeBucket('24-30', t)).toBe(zh['age.24-30'])
    expect(formatAgeBucket('999', t)).toBe(zh['age.other'])
    expect(trafficSourceLabel('homepage_hot', null, t)).toBe(zh['src.homepage_hot'])
    expect(trafficSourceLabel('unknown_key', 'unknown_key', t)).toBe(zh['src.other'])
    expect(trafficSourceLabel('x', '来自搜索聚合', t)).toBe('来自搜索聚合')
  })

  it('URL 白名单：作品链接仅 douyin.com 家族 http(s)；头像仅 http(s)', () => {
    expect(safeWorkUrl('https://www.douyin.com/video/1')).not.toBeNull()
    expect(safeWorkUrl('https://douyin.com/video/1')).not.toBeNull()
    expect(safeWorkUrl('https://evil.example.com/video/1')).toBeNull()
    expect(safeWorkUrl('javascript:douyin.com')).toBeNull()
    expect(safeWorkUrl(null)).toBeNull()
    expect(safeHttpUrl('http://cdn.example.com/a.jpg')).not.toBeNull()
    expect(safeHttpUrl('/relative.jpg')).toBeNull()
  })

  it('进度三态文案（采集进度 i/n · 入库进度 b/t · 获取列表 · 兜底）', () => {
    const base = { accountId: 'a', phase: null, progress: {}, error: null, finishedAt: null } as const
    expect(progressTextOf({ ...base, status: 'running', progress: { phase: 'work', index: 3, total: 10 } }, t))
      .toBe(t('works.progress.collect', { index: 3, total: 10 }))
    expect(progressTextOf({ ...base, status: 'running', progress: { phase: 'batch_done', batchNo: 2, totalBatches: 5, succeeded: 7, failed: 1 } }, t))
      .toBe(t('works.progress.ingest', { batchNo: 2, totalBatches: 5, succeeded: 7, expected: 8 }))
    expect(progressTextOf({ ...base, status: 'running', progress: { phase: 'collected' } }, t)).toBe(zh['works.progress.list'])
    expect(progressTextOf({ ...base, status: 'running', progress: {} }, t)).toBe(zh['works.progress.fallback'])
    expect(progressTextOf(null, t)).toBe(zh['works.progress.fallback'])
  })
})

describe('发布排期纯函数（schedule-ui.js 语义迁移）', () => {
  it('rowId 十进制字符串比较：不转 Number，超 safe integer 仍正确', () => {
    expect(compareRowId('9007199254740993', '9007199254740992')).toBeGreaterThan(0)
    expect(compareRowId('9', '10')).toBeLessThan(0)
    expect(compareRowId('12', '12')).toBe(0)
  })

  it('发布日期升序：无日期最后；同日期按 rowId 字符串序稳定', () => {
    const row = (id: string, publishDate: string): ScheduleUiRow => ({
      rowId: id, accountId: 'a', shootingDate: '', videoContent: '', shootingStatus: false,
      published: false, assetLink: '', note: '', publishDate, publishPlatforms: [],
      shootingOwner: '', editingOwner: '', rowVersion: '1',
    })
    const sorted = [row('3', ''), row('10', '2026-11-25'), row('2', '2026-11-25'), row('9', '2026-11-24')]
      .sort(comparePublishDate)
    expect(sorted.map(item => item.rowId)).toEqual(['9', '2', '10', '3'])
  })

  it('服务端快照归一：空串 → null、平台白名单重排、trim', () => {
    const ui = toScheduleUiRow({
      id: 12, account_id: 'a', shooting_date: '', video_content: ' 内容 ', shooting_status: 1,
      published: false, asset_link: '', note: '', publish_date: '', publish_platforms: ['wx_channels', 'douyin', 'xhs', 'bogus'],
      shooting_owner: '  ', editing_owner: '李四', row_version: 3,
    })
    expect(ui).not.toBeNull()
    expect(ui?.publishPlatforms).toEqual(['wx_channels', 'douyin', 'xhs'])
    const snapshot = buildServerSnapshot(ui as ScheduleUiRow)
    expect(snapshot.shootingDate).toBeNull()
    expect(snapshot.videoContent).toBe('内容')
    expect(snapshot.shootingOwner).toBeNull()
    expect(snapshot.publishPlatforms).toEqual(SCHEDULE_PLATFORMS)
    expect(toScheduleUiRow({ id: null })).toBeNull()
    expect(readScheduleRows({ status: 'ready', data: { rows: [{ id: 1 }] } })).toHaveLength(1)
  })
})

describe('投流逐项校验（分键文案）', () => {
  it('六字段：必填缺失与非法逐项分键；合法通过', () => {
    expect(validatePromotionForm({ playCount: '', costAmount: '1', fansCount: '1', durationHours: '1' })).toBe('promotion.playRequired')
    expect(validatePromotionForm({ playCount: '1.5', costAmount: '1', fansCount: '1', durationHours: '1' })).toBe('promotion.playInvalid')
    expect(validatePromotionForm({ playCount: '0', costAmount: '', fansCount: '1', durationHours: '1' })).toBe('promotion.costRequired')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1.234', fansCount: '1', durationHours: '1' })).toBe('promotion.costInvalid')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1000000000000', fansCount: '1', durationHours: '1' })).toBe('promotion.costInvalid')
    expect(validatePromotionForm({ playCount: '0', costAmount: '999999999999.99', fansCount: '', durationHours: '1' })).toBe('promotion.fansRequired')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1', fansCount: '-1', durationHours: '1' })).toBe('promotion.fansInvalid')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1', fansCount: '0', durationHours: '' })).toBe('promotion.hoursRequired')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1', fansCount: '0', durationHours: '0' })).toBe('promotion.hoursInvalid')
    expect(validatePromotionForm({ playCount: '0', costAmount: '1', fansCount: '0', durationHours: '999999.99' })).toBeNull()
  })
})

describe('错误码词典全表（schedule 18 码 / report 17 码 / AI 9 码）', () => {
  const scheduleCodes = [
    'account_id_required', 'row_id_invalid', 'version_invalid', 'VALIDATION_ERROR',
    'idempotency_key_required', 'INVALID_IDEMPOTENCY_KEY', 'CONFIRMATION_REQUIRED',
    'ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_ACCESSIBLE', 'SCHEDULE_ROW_NOT_FOUND',
    'SCHEDULE_ROW_CONFLICT', 'SCHEDULE_VALIDATION_ERROR', 'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'UNAUTHORIZED',
    'PAYLOAD_TOO_LARGE', 'douyin_operation_request_failed',
  ]
  const reportCodes = [
    'REPORT_NOT_FOUND', 'REPORT_DISABLED', 'REPORT_INSUFFICIENT_DATA', 'REPORT_MODEL_FAILED',
    'REPORT_SCHEMA_INVALID', 'REPORT_TIMEOUT', 'REPORT_TRUNCATED', 'REPORT_INPUT_TOO_LARGE',
    'REPORT_PAYLOAD_TOO_LARGE', 'REPORT_ENQUEUE_FAILED', 'REPORT_MODEL_CONFIG_MISSING',
    'REPORT_LEASE_EXPIRED', 'REPORT_PROMPT_INVALID', 'IDEMPOTENCY_CONFLICT',
    'INVALID_IDEMPOTENCY_KEY', 'INVALID_CURSOR', 'VALIDATION_ERROR',
  ]
  const aiCodes = [
    'AI_ANALYSIS_RUNNING', 'AI_ANALYSIS_GLOBAL_CONCURRENCY_LIMIT', 'AI_ANALYSIS_INSUFFICIENT_DATA',
    'AI_ANALYSIS_MODEL_FAILED', 'AI_ANALYSIS_SCHEMA_INVALID', 'AI_ANALYSIS_TIMEOUT',
    'AI_ANALYSIS_ENQUEUE_FAILED', 'AI_ANALYSIS_MODEL_CONFIG_MISSING', 'AI_ANALYSIS_PROMPT_INVALID',
  ]

  it('schedule.error.* 恰好 18 码 + default（键集锁定）', () => {
    expect(scheduleCodes).toHaveLength(18)
    for (const code of scheduleCodes) {
      expect(zh[`schedule.error.${code}` as DouyinLocaleKey], code).toBeDefined()
    }
    const scheduleKeys = Object.keys(zh).filter(key => key.startsWith('schedule.error.'))
    expect(scheduleKeys.length).toBe(19)
  })

  it('report.error.* 恰好 17 码 + default（键集锁定）', () => {
    expect(reportCodes).toHaveLength(17)
    for (const code of reportCodes) {
      expect(zh[`report.error.${code}` as DouyinLocaleKey], code).toBeDefined()
    }
    const reportKeys = Object.keys(zh).filter(key => key.startsWith('report.error.'))
    expect(reportKeys.length).toBe(18)
  })

  it('ai.error.* 恰好 9 码 + default/retained（键集锁定）', () => {
    expect(aiCodes).toHaveLength(9)
    for (const code of aiCodes) {
      expect(zh[`ai.error.${code}` as DouyinLocaleKey], code).toBeDefined()
    }
    const aiKeys = Object.keys(zh).filter(key => key.startsWith('ai.error.'))
    expect(aiKeys.length).toBe(11)
  })

  it('分域文案：已知码出全表文案，未知码回退 default', () => {
    expect(domainErrorText('schedule', 'SCHEDULE_ROW_CONFLICT', t)).toBe(zh['schedule.error.SCHEDULE_ROW_CONFLICT'])
    expect(domainErrorText('report', 'REPORT_TIMEOUT', t)).toBe(zh['report.error.REPORT_TIMEOUT'])
    expect(domainErrorText('ai', 'AI_ANALYSIS_TIMEOUT', t)).toBe(zh['ai.error.AI_ANALYSIS_TIMEOUT'])
    expect(domainErrorText('schedule', 'NOT_A_CODE', t)).toBe(zh['schedule.error.default'])
    expect(domainErrorText('report', null, t)).toBe(zh['report.error.default'])
  })

  it('通用 reason.*：已知码附原码，未知码走通用文案', () => {
    expect(reasonText('RUN_STILL_ACTIVE', t)).toBe(`${zh['reason.RUN_STILL_ACTIVE']}（RUN_STILL_ACTIVE）`)
    expect(reasonText('CLEANUP_FAILED_X', t)).toBe(t('error.unknownWithCode', { code: 'CLEANUP_FAILED_X' }))
  })

  it('报表状态五态词典键齐全', () => {
    for (const key of ['report.status.succeeded', 'report.status.incomplete', 'report.status.failed', 'report.status.insufficient', 'report.status.running'] as const) {
      expect(zh[key]).toBeDefined()
    }
  })
})

describe('Host 载荷读取器（缺失 null 不补 0）', () => {
  it('readAccounts / readBatchStatus 白名单投影', () => {
    const accounts = readAccounts({ status: 'ready', accounts: [
      { accountId: 'a', nickname: '', avatar: 'javascript:x', fanCount: '12000', sessionStatus: 'ok' },
      { accountId: '', nickname: 'x' },
    ], remoteError: null })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.nickname).toBeNull()
    expect(accounts[0]?.avatar).toBeNull()
    expect(accounts[0]?.fanCount).toBe(12000)
    const batch = readBatchStatus({ batch: { status: 'partial', phase: null, total: 3, runnableTotal: 2, runnableDone: 2, completedCount: 1, failedCount: 1, skippedCount: 1, probedCount: 3, currentAccountId: null, items: [{ accountId: 'a', status: 'failed', reason: 'session_required' }] } })
    expect(batch.status).toBe('partial')
    expect(batch.items[0]?.reason).toBe('session_required')
  })

  it('readOverview：目录完整性判定字段 + 缺失 KPI 字段为 null', () => {
    const view = readOverview({ overview: { summary: { accountCount: 2, workCount: 3 }, accounts: [], hotWorks: [], accountOptions: [{ accountId: 'a' }], accountTotal: 2 } })
    expect(view.summary.totalPlayCount).toBeNull()
    expect(view.distribution).toBeNull()
    expect(view.catalog).toHaveLength(1)
    expect(view.accountTotal).toBe(2)
  })

  it('readReportList / readReportDetail：envelope `data` 投影', () => {
    const list = readReportList({ data: { items: [{ reportId: 'r', reportType: 'daily', status: 'running', version: 1 }], nextCursor: 'c' } })
    expect(list.items[0]?.status).toBe('running')
    expect(list.nextCursor).toBe('c')
    const detail = readReportDetail({ data: { report: { reportId: 'r', reportType: 'weekly', periodStart: '2026-11-16', periodEnd: '2026-11-23', status: 'succeeded', resultJson: { data: { coreMetrics: [{ key: 'plays', value: 5 }], trendSeries: { days: ['d1'], bars: [null], line: [3] } }, ai: { facts: [{ title: 'f' }] } } } } })
    expect(detail.reportType).toBe('weekly')
    expect(detail.data?.coreMetrics[0]?.value).toBe(5)
    expect(detail.data?.trendSeries.bars[0]).toBeNull()
    expect(detail.ai?.facts).toHaveLength(1)
  })
})

describe('趋势窗口（30 天分析 / 7 天详情；缺口断线不补零）', () => {
  it('readAccountTrend 读 trend.points 的 {day, value}；readWorkTrend 读快照 play_count（两形态不可共用投影）', async () => {
    const { readAccountTrend, readWorkTrend } = await import('../../src/client/schema.ts')
    // account.trend 真实响应（2026-11-23 真机抓包形态）：点为 {day, value}。
    const accountPoints = readAccountTrend({
      status: 'ready',
      trend: {
        metric: 'play', gapDays: 0, contractVersion: 'trend-v2',
        points: [
          { day: '2026-11-20', value: 416, elapsedSeconds: 0, counterRevised: false },
          { day: '2026-11-21', value: 429, elapsedSeconds: 0, counterRevised: false },
          { day: '2026-11-22', value: 433, elapsedSeconds: 0, counterRevised: false },
        ],
      },
    })
    expect(accountPoints).toEqual([
      { day: '2026-11-20', value: 416 },
      { day: '2026-11-21', value: 429 },
      { day: '2026-11-22', value: 433 },
    ])
    // work.trend 快照行：值为 play_count，按 day 收盘。
    const workPoints = readWorkTrend({
      status: 'ready',
      data: { snapshots: [{ day: '2026-11-22', captured_at: '2026-11-22T10:37:40+08:00', play_count: 1279 }] },
    })
    expect(workPoints).toEqual([{ day: '2026-11-22', value: 1279 }])
  })

  it('accountTrendRows：30 行窗口锚定最后有效点；缺失日 value=null', () => {
    const points = [
      { day: '2026-11-01', value: 1 },
      { day: '2026-11-05', value: null },
      { day: '2026-11-30', value: 9 },
    ]
    const rows = accountTrendRows(points)
    expect(rows).toHaveLength(30)
    expect(rows[0]?.day).toBe('2026-11-01')
    expect(rows[4]?.value).toBeNull()
    expect(rows.at(-1)?.value).toBe(9)
    expect(accountTrendRows([{ day: 'x', value: null }])).toHaveLength(0)
  })

  it('workTrendRows：7 行窗口；发布前窗口外历史日不入窗', () => {
    const rows = workTrendRows([{ day: '2026-11-28', value: 4 }, { day: '2026-11-30', value: 6 }])
    expect(rows).toHaveLength(7)
    expect(rows[0]?.day).toBe('2026-11-24')
    expect(rows[1]?.value).toBeNull()
    expect(rows.at(-1)?.value).toBe(6)
  })

  it('shiftDay：UTC 语义位移（月末/年末边界）', () => {
    expect(shiftDay('2026-11-21', 1)).toBe('2026-11-22')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('kit 样式表装载清单（源码层，防新增组件漏样式）', () => {
  const packageDir = process.cwd()
  const clientDir = join(packageDir, 'src', 'client')
  const kitSrc = join(packageDir, '..', '..', 'packages', 'dsh-client-ui-kit', 'src')

  /** 无样式表的 kit 导出名。 */
  const NO_STYLESHEET_EXPORTS = new Set([
    'createKitTranslate', 'KitLocaleProvider', 'useKitLocale', 'NS', 'en', 'zh',
    'LOCALE_PLACEHOLDERS', 'YtKitLocaleKey', 'YT_CHART_VARS', 'ytChartStyle',
    'YtChartColor', 'YtChartColorExport', 'ChartTooltipRow', 'KpiDeltaDirection',
    'FilterChip', 'DataStateKind', 'DataStateShape', 'DataStateProps', 'ChartFrameProps',
    'FilterBarProps', 'DataCardProps', 'ChartTooltipProps',
  ])

  const IRREGULAR_FILES: Readonly<Record<string, string>> = { PluginPageShell: 'page-shell.module.css' }

  /** client 源码里从 kit 桶导入的组件名集合。 */
  function consumedKitComponents(): Set<string> {
    const names = new Set<string>()
    for (const file of readdirSync(clientDir).sort()) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
      if (file === 'kit-styles.ts') continue
      const source = readFileSync(join(clientDir, file), 'utf8')
      for (const match of source.matchAll(/import \{([^}]+)\} from '@yootun\/dsh-client-ui-kit'/gu)) {
        for (const raw of match[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/u)[0]?.trim().replace(/^type /u, '') ?? ''
          if (name !== '' && !NO_STYLESHEET_EXPORTS.has(name)) names.add(name)
        }
      }
    }
    return names
  }

  it('清单与本插件消费的 kit 组件一一对应，无缺漏、无冗余', () => {
    const declared = [...readFileSync(join(clientDir, 'kit-styles.ts'), 'utf8').matchAll(/'@yootun\/dsh-client-ui-kit\/src\/([\w-]+\.module\.css)'/gu)]
      .map(match => match[1] as string)
    const expected = [...consumedKitComponents()]
      .map(component => IRREGULAR_FILES[component] ?? `${component.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}.module.css`)
      .sort()
    expect(expected.length).toBeGreaterThan(0)
    expect([...declared].sort()).toEqual(expected)
    for (const file of declared) {
      expect(existsSync(join(kitSrc, file)), `${file} exists`).toBe(true)
    }
  })

  it('构建脚本容器名配置未被哈希化（tsdown.client.ts container: false）', () => {
    const presetSource = readFileSync(join(packageDir, '..', '..', '..', 'packages', 'client', 'tsdown.client.ts'), 'utf8')
    const sites = presetSource.match(/cssModules: \{ pattern: '\[hash\]_\[local\]', container: false \}/gu) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(2)
    expect(presetSource.match(/cssModules: \{ pattern: '\[hash\]_\[local\]' \}/gu)).toBeNull()
  })
})

describe('插件 CSS Modules 类存在性（源码层，防 css.Xxx 引用未定义类）', () => {
  it('TSX 引用的每个 css.Xxx 都在 workbench.module.css 中定义', () => {
    const clientDir = join(process.cwd(), 'src', 'client')
    const cssText = readFileSync(join(clientDir, 'workbench.module.css'), 'utf8')
    const referenced = new Set<string>()
    for (const name of readdirSync(clientDir)) {
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
      const source = readFileSync(join(clientDir, name), 'utf8')
      for (const match of source.matchAll(/\bcss\.([A-Za-z0-9_]+)/gu)) {
        referenced.add(match[1] as string)
      }
    }
    expect(referenced.size).toBeGreaterThan(80)
    const undefinedClasses = [...referenced]
      .filter(cls => new RegExp(String.raw`\.` + cls + String.raw`(?![\w-])`, 'u').test(cssText) === false)
      .sort()
    expect(undefinedClasses, '未定义的 css.Xxx 引用').toEqual([])
  })
})

describe('词典完整性', () => {
  it('en 与 zh 键集完全一致（zh 为键集事实源）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('占位符一致（zh/en 同键占位符集合相同）', () => {
    const tokens = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort().join(',')
    for (const key of Object.keys(zh) as DouyinLocaleKey[]) {
      expect(tokens(en[key]), key).toBe(tokens(zh[key]))
    }
  })

  it('面板文案锚点（标题与副题逐字锁定 parity 册）', () => {
    expect(zh.panel).toBe('抖音工作台')
    expect(zh['panel.subtitle']).toBe('扫码登录抖音创作者账号，采集并查看作品经营数据')
    expect(zh['tab.notReady']).toBe('本开发阶段未接入')
    expect(zh['report.empty']).toContain('日报每天 11:00 / 周报周一 12:00')
    expect(zh['ai.rerunBody']).toContain('可能产生模型调用费用')
    expect(zh['schedule.col.shootingStatusSub']).toBe('（需要补拍或配音在下方补充）')
    expect(zh['schedule.col.assetLinkSub']).toBe('（编导和账号主理人确认）')
  })
})
