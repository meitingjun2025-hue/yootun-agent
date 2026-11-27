/**
 * 报表业务页 locale 词典：zh 为键集事实源，en 全量同步（plugin-ui-ux §七）。
 * 词条上移自抖音工作台词典（除 `report.filePrefix` 属平台、留各插件词典）；
 * 报表错误码文案在本模块定义一次（`REPORT_REASONS_ZH` / `REPORT_REASONS_EN`），
 * 由消费插件展开并入各自词典，单一事实源在本包。作品卡次要行词条迁入时从
 * 「label {value}」模板改为纯 label（值由组件按 `work` 配置的 kind 格式化后
 * 拼接，页面文案与模板替换逐字一致）。词典按 props 的 `locale` 选择，不经
 * 宿主 locale 服务，也不需要 Provider。
 * @module
 */

/**
 * 13 个 `REPORT_*` 稳定码（`REPORT_REASONS_*` 的码清单；供测试核对键集，
 * Host 侧白名单不 import 本常量）。
 */
export const REPORT_ERROR_CODES = [
  'REPORT_NOT_FOUND',
  'REPORT_DISABLED',
  'REPORT_INSUFFICIENT_DATA',
  'REPORT_MODEL_FAILED',
  'REPORT_SCHEMA_INVALID',
  'REPORT_TIMEOUT',
  'REPORT_TRUNCATED',
  'REPORT_INPUT_TOO_LARGE',
  'REPORT_PAYLOAD_TOO_LARGE',
  'REPORT_ENQUEUE_FAILED',
  'REPORT_MODEL_CONFIG_MISSING',
  'REPORT_LEASE_EXPIRED',
  'REPORT_PROMPT_INVALID',
] as const

/** 报表错误码（13 个 `REPORT_*`）。 */
export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number]

/** 报表文案覆盖的 4 个通用稳定码（与 `REPORT_*` 一同组成 17 码）。 */
const REPORT_REASON_GENERIC_CODES = ['IDEMPOTENCY_CONFLICT', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_CURSOR', 'VALIDATION_ERROR'] as const

/** 报表错误文案覆盖的稳定码（17 个）。 */
export type ReportReasonCode = ReportErrorCode | (typeof REPORT_REASON_GENERIC_CODES)[number]

/** 报表错误文案的词典键：17 个稳定码 + `default`。 */
export type ReportReasonKey = `report.error.${ReportReasonCode | 'default'}`

/**
 * 报表错误码中文文案（17 码 + default；键名沿用抖音词典现有键，缺键即编译
 * 失败）。消费插件展开并入词典后，各自的错误码映射表以稳定码全集穷尽约束。
 */
export const REPORT_REASONS_ZH = {
  'report.error.REPORT_NOT_FOUND': '报表不存在或已被清理',
  'report.error.REPORT_DISABLED': 'AI 报表功能当前未启用',
  'report.error.REPORT_INSUFFICIENT_DATA': '数据不足：该周期核心指标缺失或无数据，请先完成采集后重新生成',
  'report.error.REPORT_MODEL_FAILED': 'AI 生成失败，请稍后重试；已保留当前版本',
  'report.error.REPORT_SCHEMA_INVALID': 'AI 输出校验失败，已自动重试仍失败，请稍后再试',
  'report.error.REPORT_TIMEOUT': 'AI 生成超时，请稍后重试',
  'report.error.REPORT_TRUNCATED': 'AI 输出被截断，已停止重试避免重复计费',
  'report.error.REPORT_INPUT_TOO_LARGE': '报表输入数据量过大，请联系管理员调整范围',
  'report.error.REPORT_PAYLOAD_TOO_LARGE': '报表数据超出传输上限',
  'report.error.REPORT_ENQUEUE_FAILED': '任务投递失败，将由系统自动重投',
  'report.error.REPORT_MODEL_CONFIG_MISSING': '服务端模型配置缺失',
  'report.error.REPORT_LEASE_EXPIRED': '生成任务超时回收，请重试',
  'report.error.REPORT_PROMPT_INVALID': '服务端报表提示词缺失，请联系管理员',
  'report.error.IDEMPOTENCY_CONFLICT': '重复提交参数不一致，请刷新后重试',
  'report.error.INVALID_IDEMPOTENCY_KEY': '请求标识格式不正确，请刷新后重试',
  'report.error.INVALID_CURSOR': '列表参数已过期，请刷新',
  'report.error.VALIDATION_ERROR': '请求参数非法，请刷新重试',
  'report.error.default': '请求失败，请稍后重试',
} as const satisfies Readonly<Record<ReportReasonKey, string>>

/**
 * 报表错误码英文文案：与 {@linkcode REPORT_REASONS_ZH} 键集完全一致，缺键即
 * 编译失败。
 */
export const REPORT_REASONS_EN: Readonly<Record<ReportReasonKey, string>> = {
  'report.error.REPORT_NOT_FOUND': 'The report does not exist or was cleaned up',
  'report.error.REPORT_DISABLED': 'AI reports are currently disabled',
  'report.error.REPORT_INSUFFICIENT_DATA': 'Insufficient data: core metrics for this period are missing or empty; complete a collection and regenerate',
  'report.error.REPORT_MODEL_FAILED': 'AI generation failed; retry later. The current version is kept',
  'report.error.REPORT_SCHEMA_INVALID': 'AI output failed validation after automatic retries; try again later',
  'report.error.REPORT_TIMEOUT': 'AI generation timed out; retry later',
  'report.error.REPORT_TRUNCATED': 'AI output was truncated; retries stopped to avoid duplicate billing',
  'report.error.REPORT_INPUT_TOO_LARGE': 'Report input too large; ask an administrator to adjust the range',
  'report.error.REPORT_PAYLOAD_TOO_LARGE': 'Report data exceeds the transfer limit',
  'report.error.REPORT_ENQUEUE_FAILED': 'Task enqueue failed; the system will retry automatically',
  'report.error.REPORT_MODEL_CONFIG_MISSING': 'Server model configuration is missing',
  'report.error.REPORT_LEASE_EXPIRED': 'Generation lease expired; retry',
  'report.error.REPORT_PROMPT_INVALID': 'Server report prompt is missing; contact an administrator',
  'report.error.IDEMPOTENCY_CONFLICT': 'Repeated submission with different parameters; refresh and retry',
  'report.error.INVALID_IDEMPOTENCY_KEY': 'Request id format invalid; refresh and retry',
  'report.error.INVALID_CURSOR': 'List parameters expired; refresh',
  'report.error.VALIDATION_ERROR': 'Invalid request parameters; refresh and retry',
  'report.error.default': 'Request failed; retry later',
}

export const zh = {
  'report.daily': '日报',
  'report.weekly': '周报',
  'report.refresh': '刷新',
  'report.col.period': '周期',
  'report.col.status': '状态',
  'report.col.version': '版本',
  'report.col.coverage': '覆盖账号',
  'report.col.generatedAt': '生成时间',
  'report.col.note': '说明',
  'report.view': '查看',
  'report.loadMore': '加载更多',
  'report.empty': '等待首个调度周期（日报每天 11:00 / 周报周一 12:00 自动生成）',
  'report.listLoading': '加载中…',
  'report.status.succeeded': '已生成',
  'report.status.incomplete': '数据不全',
  'report.status.failed': '生成失败',
  'report.status.insufficient': '数据不足',
  'report.status.running': '生成中',
  'report.back': '返回列表',
  'report.version': '版本',
  'report.versionCurrent': '（当前）',
  'report.generating': '生成中…',
  'report.submitting': '提交中…',
  'report.regenerate': '重新生成',
  'report.regenerateTitle': '追加新版本',
  'report.regenerateBody': '将基于当前已回补数据追加新版本 v{version}，旧版本保留。是否继续？',
  'report.regenerateConfirm': '继续生成',
  'report.cancel': '取消',
  'report.exportHtml': '导出 HTML',
  'report.exporting': '导出中…',
  'report.htmlDone': 'HTML 已导出',
  'report.header.generatedAt': '生成时间 {time} · 账号 {count} 个',
  'report.header.base': '对比基准',
  'report.header.baseDaily': '环比对比昨日（{day}）',
  'report.header.baseWeekly': '环比对比上一自然周（{from} ~ {to}）',
  'report.header.kpi': 'KPI 口径',
  'report.header.kpiDaily': '「KPI 与账号明细」各数值 = {day} 单日增量（播放/互动/涨粉为当日新增；发布 = 当日新发作品数）',
  'report.header.kpiWeekly': '「KPI 与账号周对比」各数值 = {from} ~ {to} 七天日度增量求和（缺采日不计入，不补零）',
  'report.header.interaction': '互动口径',
  'report.header.interactionText': '互动总量 = 点赞 + 评论 + 分享 · 互动率 = 互动总量 ÷ 播放增量',
  'report.header.works': '作品口径',
  'report.header.worksText': '作品卡 / Top 作品 = 采集时点累计值（收藏仅作品级展示）',
  'report.header.note': '标注说明',
  'report.header.noteText': '「—*」= 该账号无快照（不补零，未发布显示 0） · 爆款 = 报表独立口径（播放 ≥ 阈值）',
  'report.quality.covered': '覆盖账号 {covered}/{total}',
  'report.quality.lastCollected': '上次采集 {time}',
  'report.quality.missing': '缺采：{list}',
  'report.missing.session_expired': '会话过期',
  'report.missing.not_collected': '未采集',
  'report.missing.no_data': '无数据',
  'report.change.daily': '较昨日',
  'report.change.weekly': '较上周',
  'report.change.prev': '上期 {value}',
  'report.change.noBase': '无对比基准',
  'report.trend.daily': '近 7 天播放增量与净增粉丝趋势',
  'report.trend.weekly': '近 4 周播放增量与净增粉丝趋势',
  'report.trend.barNote': '柱（左轴）',
  'report.trend.barDaily': '播放增量 = 当日矩阵内所有有效账号播放增量之和',
  'report.trend.barWeekly': '播放增量 = 当周矩阵内所有有效账号播放增量之和',
  'report.trend.lineTip': '净粉丝',
  'report.trend.lineNote': '线（右轴）',
  'report.trend.lineDaily': '净增粉丝 = 当日矩阵净增粉丝之和（悬停数据点查看每日数值）',
  'report.trend.lineWeekly': '净增粉丝 = 当周矩阵净增粉丝之和（悬停数据点查看每周数值）',
  'report.trend.gapNote': '缺口',
  'report.trend.gapText': '缺采日断开不补零 · 末位（最新一期）深色',
  'report.trend.noBars': '无有效播放数据',
  'report.trend.noLine': '净增粉丝趋势点不足，暂不绘制连线',
  'report.accounts.daily': '账号明细（{day} 当日）',
  'report.accounts.weekly': '账号周对比（{from} ~ {to}）',
  'report.col.account': '账号',
  'report.col.owner': '账号负责人',
  'report.col.fans': '现有粉丝',
  'report.col.plays': '播放增量',
  'report.col.netFans': '净增粉丝',
  'report.col.publishes': '发布',
  'report.col.likes': '点赞',
  'report.col.comments': '评论',
  'report.col.shares': '分享',
  'report.mark.expired': '会话过期',
  'report.works.daily': '{day} 新发作品（{count} 条）',
  'report.works.weekly': '本周 Top 作品（{count} 条）',
  'report.works.omitted': '其余 {count} 条作品未展示（按播放量取前 {shown} 条，上限为服务端配置）',
  'report.works.empty': '周期内无新发作品',
  'report.work.hot': '爆款',
  'report.work.collect': '收藏',
  'report.work.share': '分享',
  'report.work.completion5s': '5s 完播',
  'report.work.bounce2s': '2s 跳出',
  'report.work.avgWatch': '均观看',
  'report.anomaly.gap': '数据缺口',
  'report.anomaly.business': '业务异常',
  'report.ai.title': 'AI 洞察',
  'report.ai.facts': '① 事实 · 来自数据',
  'report.ai.inferences': '② 推断 · 谨慎解释',
  'report.ai.recommendations': '③ 建议 · 可执行',
  'report.ai.more': '展开完整依据',
  'report.ai.limits': '数据覆盖说明',
  'report.ai.evidence': '依据：{text}',
  'report.insufficient.daily': '该周期核心日度指标缺失（采集未覆盖到当天日度数据），暂无法生成指标正文。',
  'report.insufficient.all': '周期内所有账号均无数据，请先完成采集后再重新生成。',
  'report.insufficient.dailyRows': '账号日度行',
  'report.insufficient.workSnapshotRows': '作品快照行',
  'report.insufficient.fansProfileRows': '粉丝画像行',
  'report.insufficient.periodWorks': '周期内发布作品',
  'report.insufficient.rows': '{count} 行/条',
  'report.waitingTitle': 'AI 正在生成本期报表',
  'report.waitingHint': '通常需要 1~2 分钟，生成完成后本页自动刷新；期间可在版本下拉中查看历史版本。',
  'report.noContent': '暂无报表内容',
  // 迁入时插件词典同文案词条的页面用途随页面上移；键名为本包新增（原词条
  // 分属插件的 tab/schedule/dialog/ai 域，其他页面仍在用，不迁移）。
  'report.regionLabel': 'AI 报表',
  'report.refreshing': '刷新中…',
  'report.dialogClose': '关闭',
  'report.ai.gradeHigh': '高',
  'report.ai.gradeMedium': '中',
  'report.ai.gradeLow': '低',
  'report.exportFailed': '导出失败，请稍后重试',
  ...REPORT_REASONS_ZH,
} as const

/** The zh key set is the source of truth; en must match it exactly. */
export type ReportLocaleKey = keyof typeof zh

/** 报表页内部翻译函数：词典键为 {@linkcode ReportLocaleKey}。 */
export type ReportTranslate = (key: ReportLocaleKey, values?: Record<string, string | number>) => string

export const en: Record<ReportLocaleKey, string> = {
  'report.daily': 'Daily',
  'report.weekly': 'Weekly',
  'report.refresh': 'Refresh',
  'report.col.period': 'Period',
  'report.col.status': 'Status',
  'report.col.version': 'Version',
  'report.col.coverage': 'Accounts covered',
  'report.col.generatedAt': 'Generated',
  'report.col.note': 'Note',
  'report.view': 'View',
  'report.loadMore': 'Load more',
  'report.empty': 'Waiting for the first schedule cycle (daily 11:00 / weekly Monday 12:00)',
  'report.listLoading': 'Loading…',
  'report.status.succeeded': 'Generated',
  'report.status.incomplete': 'Incomplete',
  'report.status.failed': 'Failed',
  'report.status.insufficient': 'Insufficient data',
  'report.status.running': 'Generating',
  'report.back': 'Back to list',
  'report.version': 'Version',
  'report.versionCurrent': ' (current)',
  'report.generating': 'Generating…',
  'report.submitting': 'Submitting…',
  'report.regenerate': 'Regenerate',
  'report.regenerateTitle': 'Append a new version',
  'report.regenerateBody': 'A new version v{version} will be appended from the currently backfilled data; old versions are kept. Continue?',
  'report.regenerateConfirm': 'Generate',
  'report.cancel': 'Cancel',
  'report.exportHtml': 'Export HTML',
  'report.exporting': 'Exporting…',
  'report.htmlDone': 'HTML exported',
  'report.header.generatedAt': 'Generated {time} · {count} accounts',
  'report.header.base': 'Comparison base',
  'report.header.baseDaily': 'Compared with yesterday ({day})',
  'report.header.baseWeekly': 'Compared with the previous natural week ({from} ~ {to})',
  'report.header.kpi': 'KPI scope',
  'report.header.kpiDaily': 'Values in "KPI and account details" = single-day growth for {day} (plays/interactions/fans are that day\'s increments; publishes = works published that day)',
  'report.header.kpiWeekly': 'Values in "KPI and weekly comparison" = sum of daily growth over {from} ~ {to} (days without collection excluded, never zero-filled)',
  'report.header.interaction': 'Interaction scope',
  'report.header.interactionText': 'Total interactions = likes + comments + shares · interaction rate = total interactions ÷ play growth',
  'report.header.works': 'Work scope',
  'report.header.worksText': 'Work cards / top works = cumulative values at collection time (favorites shown per work only)',
  'report.header.note': 'Notation',
  'report.header.noteText': '"—*" = no snapshot for the account (never zero-filled; unpublished shows 0) · hot = report-specific scope (plays ≥ threshold)',
  'report.quality.covered': 'Accounts covered {covered}/{total}',
  'report.quality.lastCollected': 'Last collected {time}',
  'report.quality.missing': 'Missing: {list}',
  'report.missing.session_expired': 'session expired',
  'report.missing.not_collected': 'not collected',
  'report.missing.no_data': 'no data',
  'report.change.daily': 'vs yesterday',
  'report.change.weekly': 'vs last week',
  'report.change.prev': 'previous {value}',
  'report.change.noBase': 'no comparison base',
  'report.trend.daily': 'Play growth and net fans over the last 7 days',
  'report.trend.weekly': 'Play growth and net fans over the last 4 weeks',
  'report.trend.barNote': 'Bars (left axis)',
  'report.trend.barDaily': 'Play growth = sum of valid accounts\' daily play growth',
  'report.trend.barWeekly': 'Play growth = sum of valid accounts\' weekly play growth',
  'report.trend.lineTip': 'Net fans',
  'report.trend.lineNote': 'Line (right axis)',
  'report.trend.lineDaily': 'Net fans = sum of the matrix\'s daily net fans (hover a point for the value)',
  'report.trend.lineWeekly': 'Net fans = sum of the matrix\'s weekly net fans (hover a point for the value)',
  'report.trend.gapNote': 'Gaps',
  'report.trend.gapText': 'Missing days break the line without zero-fill · the last (latest) bar is solid dark',
  'report.trend.noBars': 'No valid play data',
  'report.trend.noLine': 'Not enough net-fan points to draw the line',
  'report.accounts.daily': 'Account details ({day})',
  'report.accounts.weekly': 'Weekly comparison ({from} ~ {to})',
  'report.col.account': 'Account',
  'report.col.owner': 'Account owner',
  'report.col.fans': 'Current fans',
  'report.col.plays': 'Play growth',
  'report.col.netFans': 'Net fans',
  'report.col.publishes': 'Publishes',
  'report.col.likes': 'Likes',
  'report.col.comments': 'Comments',
  'report.col.shares': 'Shares',
  'report.mark.expired': 'Session expired',
  'report.works.daily': 'Works published on {day} ({count})',
  'report.works.weekly': 'Top works this week ({count})',
  'report.works.omitted': '{count} more works not shown (top {shown} by plays; cap set by the server)',
  'report.works.empty': 'No works published in this period',
  'report.work.hot': 'Hot',
  'report.work.collect': 'Favorites',
  'report.work.share': 'Shares',
  'report.work.completion5s': '5s completion',
  'report.work.bounce2s': '2s bounce',
  'report.work.avgWatch': 'Avg watch',
  'report.anomaly.gap': 'Data gap',
  'report.anomaly.business': 'Business anomaly',
  'report.ai.title': 'AI insights',
  'report.ai.facts': '① Facts · from data',
  'report.ai.inferences': '② Inferences · interpret with care',
  'report.ai.recommendations': '③ Recommendations · actionable',
  'report.ai.more': 'Expand full evidence',
  'report.ai.limits': 'Data coverage notes',
  'report.ai.evidence': 'Evidence: {text}',
  'report.insufficient.daily': 'Core daily metrics for this period are missing (collection did not cover that day\'s daily data); the metric body cannot be generated yet.',
  'report.insufficient.all': 'No account has data in this period; complete a collection and regenerate.',
  'report.insufficient.dailyRows': 'Account daily rows',
  'report.insufficient.workSnapshotRows': 'Work snapshot rows',
  'report.insufficient.fansProfileRows': 'Fans profile rows',
  'report.insufficient.periodWorks': 'Works published in period',
  'report.insufficient.rows': '{count} rows/items',
  'report.waitingTitle': 'AI is generating this report',
  'report.waitingHint': 'Usually 1-2 minutes; this page refreshes automatically. Meanwhile you can browse old versions in the version menu.',
  'report.noContent': 'No report content yet',
  'report.regionLabel': 'AI reports',
  'report.refreshing': 'Refreshing…',
  'report.dialogClose': 'Close',
  'report.ai.gradeHigh': 'High',
  'report.ai.gradeMedium': 'Medium',
  'report.ai.gradeLow': 'Low',
  'report.exportFailed': 'Export failed; retry later',
  ...REPORT_REASONS_EN,
}

/** Dictionary namespace owned by this package. */
export const NS = 'yootun.report'

/** Interpolate `{token}` placeholders; unknown tokens stay literal. */
function interpolate(text: string, values: Record<string, string | number> | undefined): string {
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = values[token]
    return value === undefined ? match : String(value)
  })
}

/**
 * 按语言构造报表页翻译函数（组件内部使用；词典不经宿主 locale 服务）。
 * @param locale - 当前语言。
 * @returns 词典翻译函数。
 */
export function createReportTranslate(locale: 'zh' | 'en'): ReportTranslate {
  const dictionary: Record<ReportLocaleKey, string> = locale === 'zh' ? zh : en
  return (key, values) => interpolate(dictionary[key], values)
}
