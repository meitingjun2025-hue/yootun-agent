/**
 * 报表 Host action 载荷 → 页面视图模型的投影层（上移自抖音工作台
 * `schema.ts` 的 `report.*` 段，投影行为不变）：`report.list` 挂 envelope
 * `data` 键、`report.get` 的正文在 `report.resultJson`。缺失与非数值一律
 * null 不补 0；作品指标按服务端给出的键动态投影，非数值键原样保留给扩展区。
 * @module
 */

/** record 读取：对象返回原值，否则 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 数值读取：有限数字原样返回，其余 null（缺失不补 0）。 */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 文本读取：非字符串或 trim 后空串为 null。 */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** 布尔读取：仅字面 true 为 true，其余 false。 */
function booleanOf(value: unknown): boolean {
  return value === true
}

/** 数组读取：非数组为空数组。 */
function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 报表列表行。 */
export interface ReportListItem {
  reportId: string
  reportType: string
  periodStart: string | null
  periodEnd: string | null
  status: string
  version: number | null
  coreAvailable: boolean | null
  coveredAccounts: number | null
  totalAccounts: number | null
  finishedAt: string | null
  createdAt: string | null
  summary: string | null
  errorCode: string | null
  isCurrent: boolean
}

/** KPI 指标卡（available=false → —）。 */
export interface ReportMetric {
  key: string
  label: string | null
  value: number | null
  available: boolean
  changePct: number | null
  prevValue: number | null
  note: string | null
}

/**
 * 报表作品卡：`metrics` 是数值指标（读取器遍历服务端给出的键，值为有限数字
 * 则保留、否则记为 null；不要求两个平台的键一致）；`extra` 是同一对象里非数值
 * 的键，原样保留给扩展区，由注入方自己校验。
 */
export interface ReportWork {
  workId: string
  title: string | null
  nickname: string | null
  accountId: string | null
  isHot: boolean
  metrics: Readonly<Record<string, number | null>>
  extra: Readonly<Record<string, unknown>>
}

/** 报表账号行（抖音数据 9 列；无 `ownerName` 数据的投影见页面渲染规则）。 */
export interface ReportAccountRow {
  accountId: string
  nickname: string | null
  ownerName: string | null
  sessionStatus: string | null
  fanCount: number | null
  eachAvailable: boolean
  marks: string[]
  metrics: { plays: number | null; netFans: number | null; publishes: number | null; likes: number | null; comments: number | null; shares: number | null }
}

/** 报表详情投影。 */
export interface ReportDetail {
  reportId: string
  reportType: string
  periodStart: string | null
  periodEnd: string | null
  status: string
  outputSchemaVersion: string
  errorCode: string | null
  finishedAt: string | null
  data: {
    generatedAt: string | null
    coverage: {
      totalAccounts: number | null
      coveredAccounts: number | null
      lastCollectedAt: string | null
      missingAccounts: { nickname: string | null; accountId: string; reason: string | null }[]
      signals: Record<string, number | null>
      insufficientReason: string | null
    } | null
    coreMetrics: ReportMetric[]
    trendSeries: { days: string[]; bars: (number | null)[]; line: (number | null)[] }
    accounts: ReportAccountRow[]
    works: ReportWork[]
    worksOmittedCount: number | null
    anomalies: { type: string; message: string | null }[]
  } | null
  ai: {
    summary: string | null
    facts: { title: string | null; detail: string | null; evidence: string | null }[]
    inferences: { title: string | null; detail: string | null; evidence: string | null; confidence: string | null }[]
    recommendations: { title: string | null; detail: string | null; evidence: string | null; priority: string | null }[]
    limitations: string[]
  } | null
}

/** report.list → 行数组 + nextCursor。 */
export function readReportList(payload: Record<string, unknown>): { items: ReportListItem[]; nextCursor: string | null } {
  const data = recordOf(payload.data) ?? {}
  const items = arrayOf(data.items).map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const reportId = textOf(record.reportId)
    if (reportId === null) return null
    const coverage = recordOf(record.coverageSummary)
    return {
      reportId,
      reportType: textOf(record.reportType) ?? 'daily',
      periodStart: textOf(record.periodStart),
      periodEnd: textOf(record.periodEnd),
      status: textOf(record.status) ?? 'pending',
      version: numberOf(record.version),
      coreAvailable: record.coreAvailable === undefined || record.coreAvailable === null ? null : booleanOf(record.coreAvailable),
      coveredAccounts: coverage === undefined ? null : numberOf(coverage.coveredAccounts),
      totalAccounts: coverage === undefined ? null : numberOf(coverage.totalAccounts),
      finishedAt: textOf(record.finishedAt),
      createdAt: textOf(record.createdAt),
      summary: textOf(record.summary),
      errorCode: textOf(record.errorCode),
      isCurrent: booleanOf(record.isCurrent),
    } satisfies ReportListItem
  }).filter((row): row is ReportListItem => row !== null)
  return { items, nextCursor: textOf(data.nextCursor) }
}

/** report.get → 详情投影。 */
export function readReportDetail(payload: Record<string, unknown>): ReportDetail {
  const data = recordOf(payload.data) ?? {}
  const report = recordOf(data.report) ?? data
  const resultJson = recordOf(report.resultJson)
  const resultData = recordOf(resultJson?.data)
  const coverage = recordOf(resultData?.coverage)
  const series = recordOf(resultData?.trendSeries)
  const ai = recordOf(resultJson?.ai)
  const metric = (entry: unknown): ReportMetric | null => {
    const record = recordOf(entry)
    if (record === undefined) return null
    return {
      key: textOf(record.key) ?? '',
      label: textOf(record.label),
      value: numberOf(record.value),
      available: record.available !== false,
      changePct: numberOf(record.changePct),
      prevValue: numberOf(record.prevValue),
      note: textOf(record.note),
    }
  }
  return {
    reportId: textOf(report.reportId) ?? '',
    reportType: textOf(report.reportType) ?? 'daily',
    periodStart: textOf(report.periodStart),
    periodEnd: textOf(report.periodEnd),
    status: textOf(report.status) ?? 'pending',
    outputSchemaVersion: textOf(report.outputSchemaVersion) ?? '',
    errorCode: textOf(report.errorCode),
    finishedAt: textOf(report.finishedAt),
    data: resultData === undefined ? null : {
      generatedAt: textOf(resultData.generatedAt),
      coverage: coverage === undefined ? null : {
        totalAccounts: numberOf(coverage.totalAccounts),
        coveredAccounts: numberOf(coverage.coveredAccounts),
        lastCollectedAt: textOf(coverage.lastCollectedAt),
        missingAccounts: arrayOf(coverage.missingAccounts).map(entry => {
          const record = recordOf(entry)
          if (record === undefined) return null
          const accountId = textOf(record.accountId) ?? ''
          return { nickname: textOf(record.nickname), accountId, reason: textOf(record.reason) }
        }).filter((row): row is { nickname: string | null; accountId: string; reason: string | null } => row !== null),
        signals: {
          dailyRows: numberOf(recordOf(coverage.signals)?.dailyRows),
          workSnapshotRows: numberOf(recordOf(coverage.signals)?.workSnapshotRows),
          fansProfileRows: numberOf(recordOf(coverage.signals)?.fansProfileRows),
          periodWorks: numberOf(recordOf(coverage.signals)?.periodWorks),
        },
        insufficientReason: textOf(coverage.insufficientReason),
      },
      coreMetrics: arrayOf(resultData.coreMetrics).map(metric).filter((row): row is ReportMetric => row !== null),
      trendSeries: {
        days: arrayOf(series?.days).map(day => typeof day === 'string' ? day : '').filter(day => day !== ''),
        bars: arrayOf(series?.bars).map(bar => numberOf(bar)),
        line: arrayOf(series?.line).map(point => numberOf(point)),
      },
      accounts: arrayOf(resultData.accounts).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        const metrics = recordOf(record.metrics)
        return {
          accountId: textOf(record.accountId) ?? '',
          nickname: textOf(record.nickname),
          ownerName: textOf(record.ownerName),
          sessionStatus: textOf(record.sessionStatus),
          fanCount: numberOf(record.fanCount),
          eachAvailable: record.eachAvailable !== false,
          marks: arrayOf(record.marks).map(mark => typeof mark === 'string' ? mark : '').filter(mark => mark !== ''),
          metrics: {
            plays: numberOf(metrics?.plays),
            netFans: numberOf(metrics?.netFans),
            publishes: numberOf(metrics?.publishes),
            likes: numberOf(metrics?.likes),
            comments: numberOf(metrics?.comments),
            shares: numberOf(metrics?.shares),
          },
        }
      }).filter((row): row is ReportAccountRow => row !== null),
      works: arrayOf(resultData.works).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        const metricsRecord = recordOf(record.metrics)
        const metrics: Record<string, number | null> = {}
        const extra: Record<string, unknown> = {}
        if (metricsRecord !== undefined) {
          for (const [key, value] of Object.entries(metricsRecord)) {
            if (value === null || typeof value === 'number') {
              metrics[key] = numberOf(value)
            } else {
              extra[key] = value
            }
          }
        }
        return {
          workId: textOf(record.workId) ?? '',
          title: textOf(record.title),
          nickname: textOf(record.nickname),
          accountId: textOf(record.accountId),
          isHot: booleanOf(record.isHot),
          metrics,
          extra,
        }
      }).filter((row): row is ReportWork => row !== null),
      worksOmittedCount: numberOf(resultData.worksOmittedCount),
      anomalies: arrayOf(resultData.anomalies).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        return { type: textOf(record.type) ?? 'business', message: textOf(record.message) }
      }).filter((row): row is { type: string; message: string | null } => row !== null),
    },
    ai: ai === undefined ? null : {
      summary: textOf(ai.summary),
      facts: insightItems(ai.facts, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence) })),
      inferences: insightItems(ai.inferences, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence), confidence: textOf(record.confidence) })),
      recommendations: insightItems(ai.recommendations, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence), priority: textOf(record.priority) })),
      limitations: arrayOf(ai.limitations).map(limit => typeof limit === 'string' ? limit : '').filter(limit => limit !== ''),
    },
  }
}

/** AI 洞察条目投影（detail/evidence 折叠区数据；调用方映射徽章字段）。 */
function insightItems<T>(value: unknown, map: (record: Record<string, unknown>) => T): T[] {
  return arrayOf(value).map(entry => {
    const record = recordOf(entry)
    return record === undefined ? null : map(record)
  }).filter((row): row is T => row !== null)
}
