/**
 * Host 路由层：`/api/desktop/yootun/douyin-workbench` 单端点 POST 分发。安全
 * 口径（分册 08 §10.3 / 分册 15 §3）：只接受 POST、loopback 远端 + 浏览器来源
 * 标记信任判定（显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest`
 * 转发剥离两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式
 * action allowlist、每 action 输入 schema 并拒绝未知字段、稳定错误码（不透传
 * 内部异常）。
 *
 * action 契约 = 分册 15 §3 冻结的全部 56 项；已实现 action 按批次扩充
 * （D1 仅 browser.status），allowlist 内未实现项按 unknown_action 拒绝
 * （fail loud，不做静默半实现；wx/xhs 模板同款口径）。`collect.cancel` 是
 * D0 缺口 G-1：服务端工具与键模板已在册，但旧 Host 无取消入口，本阶段
 * 不加入分发、不伪造实现。
 * @module
 */
import { isStableCode, safeCode, type StableErrorCode } from './errors.ts'
import { DouyinError } from './errors.ts'

/** 路由固定路径。 */
export const ROUTE_PATH = '/api/desktop/yootun/douyin-workbench'

/** JSON 元数据体上限（bytes；沿用旧插件 64KB 口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** Structured request surface the route needs（IncomingMessage 结构兼容）. */
export interface RouteRequest {
  /** HTTP method; non-POST is rejected before parsing. */
  method?: string | undefined
  /** Loopback 远端基础防线所需的远端地址。 */
  socket: { remoteAddress?: string | undefined }
  /** Lowercased header record（IncomingHttpHeaders 结构兼容）. */
  headers: Record<string, unknown>
  /** Body byte stream（Readable 的异步迭代面）. */
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>
}

/** Structured response surface the route writes（ServerResponse 结构兼容）. */
export interface RouteResponse {
  /** HTTP status code. */
  statusCode: number
  /** Set one response header. */
  setHeader(name: string, value: string): void
  /** Write the JSON payload body. */
  end(payload: string): void
}

/** 字段输入契约的取值种类。 */
export type FieldKind = 'string' | 'boolean' | 'number' | 'integer' | 'date' | 'decimal' | 'stringArray' | 'objectArray' | 'object'

/** One objectArray entry's per-item contract（分册 15 §3 的 seed/账号条目）. */
export interface ObjectItemSchema {
  /** Allowed per-item fields; anything else is rejected. */
  fields: Readonly<Record<string, 'string' | 'number'>>
  /** Required per-item fields（缺失或空串拒绝）. */
  required: readonly string[]
  /** Per-item string max length（trim 后超限拒绝，不截断）. */
  limits?: Readonly<Record<string, number>>
  /** Per-item closed enumerations. */
  enums?: Readonly<Record<string, readonly string[]>>
  /** Per-item integer ranges. */
  ranges?: Readonly<Record<string, { min?: number; max?: number }>>
}

/** One whitelisted action's input contract. */
export interface ActionSchema {
  /** Allowed fields; anything else is rejected. */
  fields: Readonly<Record<string, FieldKind>>
  /** Required fields（缺失/null 拒绝；string 类型 trim 后空串同样按缺失拒绝）. */
  required?: readonly string[]
  /** 必须为字面量 true 的字段（写操作 confirm；false/非布尔/缺失均拒绝）。 */
  requireTrue?: readonly string[]
  /** 至少一个字段必须存在且非空（workflowId/candidateId 二选一）。 */
  requireAny?: readonly string[]
  /** 顶层封闭枚举（string 字段整体、stringArray 字段逐项；仅值存在时校验）。 */
  enums?: Readonly<Record<string, readonly string[]>>
  /** 绝对 http(s) URL 字段（有 host，不允许空白与控制字符）。 */
  urlFields?: readonly string[]
  /** stringArray 输出的固定顺序（自动去重后按此序重排）。 */
  normalizeOrder?: Readonly<Record<string, readonly string[]>>
  /** 幂等键模板（字段 → 段前缀；绑定字段时键内段必须与请求归一值一致）。 */
  idempotency?: Readonly<Record<string, { segment: string; boundField?: string }>>
  /** 定点十进制字符串边界（无符号、最多两位小数；定点串比较不丢精度）。 */
  decimals?: Readonly<Record<string, { min?: string; max?: string; exclusiveMin?: boolean }>>
  /** Max length for each string field（缺省 128；trim 后超限拒绝，不截断）. */
  limits?: Readonly<Record<string, number>>
  /** number 字段数值边界（缺省只要求有限数值）。 */
  ranges?: Readonly<Record<string, { min?: number; max?: number }>>
  /** 数组字段档位覆盖（stringArray 缺省 ≤9 项 × 128 字符；minItems 缺省 0）。 */
  arrays?: Readonly<Record<string, { minItems?: number; maxItems: number; itemMax?: number }>>
  /** objectArray 字段的逐项契约（键 = objectArray 字段名）。 */
  items?: Readonly<Record<string, ObjectItemSchema>>
  /** objectArray 条目的条件 URL 约束（homepage_url → inputValue）。 */
  itemUrl?: { when: { field: string; equals: string }; url: string }
}

const DEFAULT_STRING_LIMIT = 128
const DEFAULT_ARRAY_MAX_ITEMS = 9
const DEFAULT_ARRAY_ITEM_MAX = 128

/**
 * Per-action input contracts：分册 15 §3 冻结的全部 56 项（显式 allowlist；
 * 未知字段拒绝；长度/数值/数组边界就地拒绝，不静默截断数值越界）。
 */
export const ACTION_SCHEMAS: Readonly<Record<string, ActionSchema>> = Object.freeze({
  'browser.status': { fields: {} },
  'accounts.list': { fields: {} },
  'account.beginLogin': { fields: { accountId: 'string' } },
  'account.loginStatus': { requireAny: ['accountId', 'loginKey'], fields: { accountId: 'string', loginKey: 'string' } },
  'account.probe': { required: ['accountId'], fields: { accountId: 'string' } },
  'account.removeLocal': { required: ['accountId'], fields: { accountId: 'string' } },
  'account.removeRemote': { required: ['accountId'], fields: { accountId: 'string' } },
  'collect.start': { required: ['accountId'], fields: { accountId: 'string', maxPages: 'integer' }, ranges: { maxPages: { min: 1, max: 1000 } } },
  'collect.status': { required: ['accountId'], fields: { accountId: 'string' } },
  'collectAll.start': { fields: {} },
  'collectAll.status': { fields: {} },
  'works.list': { required: ['accountId'], fields: { accountId: 'string', includeNotInList: 'boolean' } },
  'work.get': { required: ['accountId', 'workId'], fields: { accountId: 'string', workId: 'string' } },
  'work.trend': { required: ['accountId', 'workId'], fields: { accountId: 'string', workId: 'string' } },
  'run.get': { required: ['runId'], fields: { runId: 'string' } },
  'export': { required: ['accountId'], fields: { accountId: 'string' } },
  'overview.get': {
    fields: {
      accountIds: 'stringArray', publishFrom: 'date', publishTo: 'date', ownerName: 'string', sort: 'string',
      topN: 'integer', hotType: 'string', cursor: 'string', limit: 'integer', ruleVersion: 'string',
    },
    limits: { sort: 32, hotType: 32, cursor: 512, ruleVersion: 32 },
    ranges: { topN: { min: 1, max: 10000 }, limit: { min: 1, max: 10000 } },
    enums: { sort: ['hot_count', 'hot_rate', 'median_play', 'total_play', 'engagement_rate'] },
    arrays: { accountIds: { maxItems: 200 } },
  },
  'hotWorks.list': {
    // 与 overview.get 同参面但无 ownerName（旧 hot_work_list DTO 不收负责人）。
    fields: {
      accountIds: 'stringArray', publishFrom: 'date', publishTo: 'date', sort: 'string',
      topN: 'integer', hotType: 'string', cursor: 'string', limit: 'integer', ruleVersion: 'string',
    },
    limits: { cursor: 512, ruleVersion: 32 },
    ranges: { topN: { min: 1, max: 10000 }, limit: { min: 1, max: 10000 } },
    enums: {
      sort: ['play', 'engagement', 'retention', 'share', 'growth'],
      hotType: ['all', 'absolute', 'account_relative', 'potential'],
    },
    arrays: { accountIds: { maxItems: 200 } },
  },
  'overview.export': {
    fields: { accountIds: 'stringArray', publishFrom: 'date', publishTo: 'date', ruleVersion: 'string' },
    limits: { ruleVersion: 32 },
    arrays: { accountIds: { maxItems: 200 } },
  },
  'account.analysis': { required: ['accountId'],
    fields: { accountId: 'string', publishFrom: 'date', publishTo: 'date', sort: 'string', ruleVersion: 'string' },
    limits: { ruleVersion: 32 },
    enums: { sort: ['hot_count', 'hot_rate', 'median_play', 'total_play', 'engagement_rate'] },
  },
  'account.trend': { required: ['accountId'],
    fields: { accountId: 'string', metric: 'string', fromDay: 'date', toDay: 'date', cohortDelta: 'boolean', contractVersion: 'string' },
    limits: { contractVersion: 32 },
    enums: { metric: ['play', 'like', 'comment', 'collect', 'share', 'fans', 'net_fans'] },
  },
  'accountAnalysis.export': { required: ['accountId'],
    fields: { accountId: 'string', publishFrom: 'date', publishTo: 'date', ruleVersion: 'string' },
    limits: { ruleVersion: 32 },
  },
  'aiAnalysis.start': { required: ['accountId', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:ai_analysis' } }, fields: { accountId: 'string', idempotencyKey: 'string' } },
  'aiAnalysis.get': { required: ['accountId'], fields: { accountId: 'string' } },
  'breakdown.rewriteRules': { fields: {} },
  'breakdown.archiveStart': { required: ['shareUrl', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_archive' } }, requireTrue: ['confirm'], fields: { shareUrl: 'string', confirm: 'boolean', idempotencyKey: 'string' }, limits: { shareUrl: 2048 } },
  'breakdown.archiveStatus': { required: ['runId'], fields: { runId: 'string' } },
  'breakdown.downloadStart': { required: ['shareUrl', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_download' } }, fields: { shareUrl: 'string', idempotencyKey: 'string' }, limits: { shareUrl: 2048 } },
  'breakdown.downloadStatus': { required: ['jobId'], fields: { jobId: 'string' } },
  'breakdown.workflowStart': { required: ['candidateId', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_workflow' } }, requireTrue: ['confirm'],
    fields: { candidateId: 'string', confirm: 'boolean', idempotencyKey: 'string', rewriteRuleId: 'string', force: 'boolean' },
    limits: { rewriteRuleId: 64 },
  },
  'breakdown.workflowStatus': { requireAny: ['workflowId', 'candidateId'],
    fields: { workflowId: 'string', candidateId: 'string', limit: 'integer' },
    ranges: { limit: { min: 1, max: 20 } },
  },
  'breakdown.detail': { required: ['candidateId'], fields: { candidateId: 'string' } },
  'breakdown.export': { required: ['candidateId'], fields: { candidateId: 'string' } },
  'breakdown.history': { fields: { limit: 'integer' }, ranges: { limit: { min: 1, max: 200 } } },
  'report.list': {
    fields: { reportType: 'string', periodStart: 'date', status: 'string', limit: 'integer', cursor: 'string', allVersions: 'boolean' },
    limits: { status: 16, cursor: 512 },
    ranges: { limit: { min: 1, max: 100 } },
    enums: { reportType: ['daily', 'weekly'], status: ['pending', 'running', 'succeeded', 'failed', 'insufficient'] },
  },
  'report.get': { required: ['reportId'], fields: { reportId: 'string' } },
  'report.regenerate': { required: ['reportId', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:report_regenerate', boundField: 'reportId' } }, fields: { reportId: 'string', idempotencyKey: 'string' } },
  'account.owner.set': { required: ['accountId', 'ownerName', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:account_owner_set' } }, fields: { accountId: 'string', ownerName: 'string', idempotencyKey: 'string' } },
  'work.promotion.save': { required: ['accountId', 'workId', 'playCount', 'fansCount', 'costAmount', 'durationHours', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:work_promotion_save' } },
    fields: {
      accountId: 'string', workId: 'string', playCount: 'integer', fansCount: 'integer', costAmount: 'decimal',
      durationHours: 'decimal', recordId: 'integer', idempotencyKey: 'string',
    },
    decimals: {
      costAmount: { min: '0', max: '999999999999.99' },
      durationHours: { min: '0', exclusiveMin: true, max: '999999.99' },
    },
    ranges: { playCount: { min: 0 }, fansCount: { min: 0 } },
  },
  'schedule.list': { required: ['accountId'], fields: { accountId: 'string' } },
  'schedule.rowCreate': { required: ['accountId', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:publish_schedule_create' } }, requireTrue: ['confirm'], fields: { accountId: 'string', confirm: 'boolean', idempotencyKey: 'string' } },
  'schedule.rowUpdate': { required: ['accountId', 'rowId', 'expectedVersion', 'confirm', 'idempotencyKey', 'shootingStatus', 'published', 'publishPlatforms'], idempotency: { idempotencyKey: { segment: 'douyin:publish_schedule_update', boundField: 'rowId' } }, requireTrue: ['confirm'],
    fields: {
      accountId: 'string', rowId: 'integer', expectedVersion: 'integer', confirm: 'boolean', idempotencyKey: 'string',
      shootingDate: 'date', videoContent: 'string', shootingStatus: 'boolean', published: 'boolean', assetLink: 'string',
      note: 'string', publishDate: 'date', publishPlatforms: 'stringArray', shootingOwner: 'string', editingOwner: 'string',
    },
    limits: { videoContent: 2000, assetLink: 2048, note: 2000, shootingOwner: 128, editingOwner: 128 },
    enums: { publishPlatforms: ['xhs', 'douyin', 'wx_channels'] },
    arrays: { publishPlatforms: { maxItems: 3, itemMax: 16 } },
    urlFields: ['assetLink'],
    normalizeOrder: { publishPlatforms: ['xhs', 'douyin', 'wx_channels'] },
  },
  'schedule.rowDelete': { required: ['accountId', 'rowId', 'expectedVersion', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:publish_schedule_delete', boundField: 'rowId' } }, requireTrue: ['confirm'],
    fields: { accountId: 'string', rowId: 'integer', expectedVersion: 'integer', confirm: 'boolean', idempotencyKey: 'string' },
  },
  'material.seeds.list': { fields: {} },
  'material.keyword.upsert': { required: ['keywords', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_keyword_upsert' } }, requireTrue: ['confirm'],
    fields: { keywords: 'objectArray', confirm: 'boolean', idempotencyKey: 'string' },
    arrays: { keywords: { minItems: 1, maxItems: 1000 } },
    items: {
      keywords: {
        fields: { keyword: 'string', priority: 'string', status: 'string', searchCount: 'number' },
        required: ['keyword'],
        limits: { keyword: 128, priority: 8, status: 16 },
        enums: { priority: ['P1', 'P2', 'P3', 'P4', 'P5'], status: ['active', 'disabled'] },
        ranges: { searchCount: { min: 1, max: 100 } },
      },
    },
  },
  'material.account.upsert': { required: ['accounts', 'confirm', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_account_upsert' } }, requireTrue: ['confirm'],
    fields: { accounts: 'objectArray', confirm: 'boolean', idempotencyKey: 'string' },
    arrays: { accounts: { minItems: 1, maxItems: 1000 } },
    items: {
      accounts: {
        fields: { inputForm: 'string', inputValue: 'string', displayName: 'string', priority: 'string', status: 'string', maxVideos: 'number' },
        required: ['inputForm', 'inputValue'],
        limits: { inputForm: 32, inputValue: 512, displayName: 256, priority: 8, status: 16 },
        enums: { inputForm: ['douyin_id', 'homepage_url', 'sec_user_id'], priority: ['P1', 'P2', 'P3', 'P4', 'P5'], status: ['active', 'disabled'] },
        ranges: { maxVideos: { min: 1, max: 100 } },
      },
    },
    itemUrl: { when: { field: 'inputForm', equals: 'homepage_url' }, url: 'inputValue' },
  },
  'material.collect.start': { required: ['idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_seed_search' } },
    fields: { idempotencyKey: 'string', keywordLimit: 'integer', accountLimit: 'integer', priorities: 'stringArray', candidateMinLevel: 'string' },
    ranges: { keywordLimit: { min: 1, max: 500 }, accountLimit: { min: 1, max: 500 } },
    enums: { priorities: ['P1', 'P2', 'P3', 'P4', 'P5'], candidateMinLevel: ['S', 'A', 'B', 'C'] },
    arrays: { priorities: { maxItems: 10, itemMax: 8 } },
  },
  'material.collect.status': { required: ['runId'], fields: { runId: 'string' } },
  'material.videos.list': {
    fields: {
      taskId: 'string', runId: 'string', minLevel: 'string', sourceType: 'string', candidateId: 'string', awemeId: 'string',
      storyboardStatus: 'string', sortBy: 'string', offset: 'integer', limit: 'integer', q: 'string', sourceKeyword: 'string',
      accountSeedId: 'string', publishedFrom: 'date', publishedTo: 'date', tag: 'string', scope: 'string', sourceKind: 'string',
    },
    limits: {
      sourceType: 64, awemeId: 64, sortBy: 32, q: 128,
      sourceKeyword: 256, tag: 64, scope: 16, sourceKind: 16,
    },
    ranges: { offset: { min: 0, max: 1000000 }, limit: { min: 1, max: 1000 } },
    enums: {
      minLevel: ['S', 'A', 'B', 'C'], storyboardStatus: ['succeeded', 'running', 'failed'],
      sortBy: ['hot', 'latest', 'published_at', 'play_count', 'like_count', 'comment_count', 'share_count', 'collect_count', 'interaction_rate'],
      scope: ['material'], sourceKind: ['keyword', 'account', 'both'],
    },
  },
  'material.runs.list': {
    fields: { offset: 'integer', limit: 'integer' },
    ranges: { offset: { min: 0, max: 1000000 }, limit: { min: 1, max: 100 } },
  },
  'material.facets': { fields: {} },
  'gene.search': {
    fields: { query: 'string', category: 'string', geneTags: 'object', adoptionStatus: 'string', offset: 'integer', limit: 'integer' },
    limits: { category: 64 },
    ranges: { offset: { min: 0 }, limit: { min: 1, max: 50 } },
    enums: { adoptionStatus: ['ai_draft', 'adopted', 'revised'] },
  },
  'gene.get': { required: ['recordId'], fields: { recordId: 'string' } },
  'gene.update': { required: ['recordId', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_gene_upd', boundField: 'recordId' } },
    fields: { recordId: 'string', idempotencyKey: 'string', geneTags: 'object', manualNotes: 'string', adoptionStatus: 'string' },
    limits: { manualNotes: 2000 },
    enums: { adoptionStatus: ['ai_draft', 'adopted', 'revised'] },
  },
  'gene.regenerate': { required: ['recordId', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'douyin:vv_gene_reg', boundField: 'recordId' } }, fields: { recordId: 'string', idempotencyKey: 'string' } },
  'gene.list': {
    fields: { geneStatus: 'string', offset: 'integer', limit: 'integer' },
    ranges: { offset: { min: 0 }, limit: { min: 1, max: 200 } },
    enums: { geneStatus: ['pending', 'running', 'succeeded', 'failed'] },
  },
})

/**
 * action → Workbench 工具绑定（分册 15 §3/§4 冻结）。`kind: 'local'` 为本地
 * action，不发起任何远端调用；remote 绑定声明分组与该编排触达的全部工具。
 * D0 缺口 G-1：`workbench_douyin_collect_run_cancel` 无 action 绑定（旧 Host
 * 无取消入口），本阶段不得私自加入分发。
 */
export type ActionToolBinding =
  | { kind: 'local' }
  | { kind: 'remote'; domain: 'douyin' | 'viral'; tools: readonly string[] }

/** Per-action remote/local bindings（collect 编排触达的工具集合全列）。 */
export const ACTION_TOOL_MAP: Readonly<Record<string, ActionToolBinding>> = Object.freeze({
  'browser.status': { kind: 'local' },
  'accounts.list': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_list'] },
  'account.beginLogin': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_save'] },
  'account.loginStatus': { kind: 'local' },
  'account.probe': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_session_status_report'] },
  'account.removeLocal': { kind: 'local' },
  'account.removeRemote': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_remove'] },
  'collect.start': {
    kind: 'remote',
    domain: 'douyin',
    tools: [
      'workbench_douyin_account_save',
      'workbench_douyin_session_status_report',
      'workbench_douyin_account_list',
      'workbench_douyin_collect_run_start',
      'workbench_douyin_collect_run_set_list_meta',
      'workbench_douyin_collect_run_heartbeat',
      'workbench_douyin_collect_ingest_batch',
      'workbench_douyin_collect_ingest_daily',
      'workbench_douyin_collect_run_finish',
    ],
  },
  'collect.status': { kind: 'local' },
  'collectAll.start': {
    kind: 'remote',
    domain: 'douyin',
    tools: [
      'workbench_douyin_account_save',
      'workbench_douyin_session_status_report',
      'workbench_douyin_account_list',
      'workbench_douyin_collect_run_start',
      'workbench_douyin_collect_run_set_list_meta',
      'workbench_douyin_collect_run_heartbeat',
      'workbench_douyin_collect_ingest_batch',
      'workbench_douyin_collect_ingest_daily',
      'workbench_douyin_collect_run_finish',
    ],
  },
  'collectAll.status': { kind: 'local' },
  'works.list': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_work_list'] },
  'work.get': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_work_get'] },
  'work.trend': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_work_trend'] },
  'run.get': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_collect_run_get'] },
  'export': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_export'] },
  'overview.get': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_overview'] },
  'hotWorks.list': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_hot_work_list'] },
  'overview.export': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_overview_export'] },
  'account.analysis': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_analysis'] },
  'account.trend': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_trend'] },
  'accountAnalysis.export': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_analysis_export'] },
  'aiAnalysis.start': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_ai_analysis_start'] },
  'aiAnalysis.get': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_ai_analysis_get'] },
  'breakdown.rewriteRules': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_rewrite_rules_list'] },
  'breakdown.archiveStart': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_archive_submit'] },
  'breakdown.archiveStatus': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_async_submit_get'] },
  'breakdown.downloadStart': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_douyin_download_url_start'] },
  'breakdown.downloadStatus': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_douyin_download_url_get'] },
  'breakdown.workflowStart': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_workflow_start'] },
  'breakdown.workflowStatus': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_workflow_get'] },
  'breakdown.detail': {
    kind: 'remote',
    domain: 'viral',
    tools: ['workbench_viral_storyboards_list', 'workbench_viral_analysis_status_get', 'workbench_viral_candidates_list'],
  },
  'breakdown.export': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_storyboard_export'] },
  'breakdown.history': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_workflow_get'] },
  'report.list': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_report_list'] },
  'report.get': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_report_get'] },
  'report.regenerate': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_report_regenerate'] },
  'account.owner.set': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_account_owner_set'] },
  'work.promotion.save': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_work_promotion_save'] },
  'schedule.list': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_publish_schedule_list'] },
  'schedule.rowCreate': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_publish_schedule_row_create'] },
  'schedule.rowUpdate': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_publish_schedule_row_update'] },
  'schedule.rowDelete': { kind: 'remote', domain: 'douyin', tools: ['workbench_douyin_publish_schedule_row_delete'] },
  'material.seeds.list': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_seeds_list'] },
  'material.keyword.upsert': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_keyword_seeds_upsert'] },
  'material.account.upsert': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_account_seeds_upsert'] },
  'material.collect.start': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_seed_search_submit'] },
  'material.collect.status': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_async_submit_get'] },
  'material.videos.list': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_candidates_list'] },
  'material.runs.list': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_runs_list'] },
  'material.facets': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_dashboard_get'] },
  'gene.search': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_knowledge_search'] },
  'gene.get': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_knowledge_get'] },
  'gene.update': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_knowledge_update'] },
  'gene.regenerate': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_knowledge_regenerate'] },
  'gene.list': { kind: 'remote', domain: 'viral', tools: ['workbench_viral_knowledge_list'] },
})

/** One handled action's arguments after validation. */
export type ActionArgs = Record<string, string | boolean | number | string[] | Record<string, unknown>[] | Record<string, unknown> | undefined>

/**
 * Validate one request body against the action's schema: unknown actions,
 * unknown fields, missing required fields, wrong types, out-of-range numbers,
 * oversized arrays and over-limit strings are rejected
 * (`DOUYIN_ROUTE_INVALID_REQUEST`); strings are trimmed but never truncated —
 * over-limit input fails loud; integers accept decimal strings（分册 15 §8：
 * UI/Host 十进制串边界，Host 放行 1..MAX_SAFE_INTEGER）.
 * @param action - the whitelisted action name.
 * @param body - the parsed request body.
 * @returns the validated arguments.
 * @throws {DouyinError} `DOUYIN_ROUTE_UNKNOWN_ACTION` / `DOUYIN_ROUTE_INVALID_REQUEST`.
 */
export function validateActionArgs(action: string, body: Record<string, unknown>): ActionArgs {
  const schema = ACTION_SCHEMAS[action]
  if (schema === undefined) throw new DouyinError('DOUYIN_ROUTE_UNKNOWN_ACTION', `unknown action ${action}`)
  for (const key of Object.keys(body)) {
    // `action` 是分发键本身，不属于各 action 的参数 schema。
    if (key === 'action') continue
    if (!(key in schema.fields)) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `unknown field "${key}" for ${action}`)
  }
  for (const key of schema.required ?? []) {
    // 必填字段缺失/null 拒绝；string 类型 trim 后空串同样按缺失拒绝。
    const value = body[key]
    const isStringField = schema.fields[key] === 'string'
    if (value === undefined || value === null
      || (isStringField && (typeof value !== 'string' || value.trim() === ''))) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `missing required field "${key}" for ${action}`)
    }
  }
  for (const key of schema.requireTrue ?? []) {
    // 写操作 confirm 必须为字面量 true；false/非布尔/缺失都在此拒绝。
    if (body[key] !== true) {
      throw new DouyinError('CONFIRMATION_REQUIRED', `field "${key}" for ${action} must be literal true`)
    }
  }
  if (schema.requireAny !== undefined) {
    // 二选一：至少一个字段存在且非空（字符串 trim 后非空才算非空）。
    const satisfied = schema.requireAny.some(key => {
      const value = body[key]
      return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null
    })
    if (!satisfied) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `one of [${schema.requireAny.join(', ')}] is required for ${action}`)
    }
  }
  const args: ActionArgs = {}
  for (const [key, kind] of Object.entries(schema.fields)) {
    const value = body[key]
    if (value === undefined || value === null) continue
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be boolean`)
      args[key] = value
      continue
    }
    if (kind === 'number') {
      const num = typeof value === 'number' ? value : Number.NaN
      if (!Number.isFinite(num)) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be a finite number`)
      const range = schema.ranges?.[key]
      const belowMin = range?.min !== undefined && num < range.min
      const aboveMax = range?.max !== undefined && num > range.max
      if (belowMin || aboveMax) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" out of range`)
      args[key] = num
      continue
    }
    if (kind === 'integer') {
      // 十进制数值或十进制字符串（UI/Host 十进制串边界，分册 15 §8）。
      // 字符串只接受纯十进制位（trim 后 /^[0-9]+$/，前导零归一）——十六进制、
      // 指数、加号、小数点、空串一律拒绝；小数、NaN、非有限数一律拒绝；
      // 范围由 ranges 覆盖（缺省正安全整数）。
      const num = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
      if (!Number.isInteger(num) || !Number.isFinite(num)) {
        throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be an integer`)
      }
      const range = schema.ranges?.[key]
      const min = range?.min ?? 1
      const max = range?.max ?? Number.MAX_SAFE_INTEGER
      if (num < min || num > max) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" out of range`)
      args[key] = num
      continue
    }
    if (kind === 'date') {
      if (typeof value !== 'string') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be a date string`)
      const text = value.trim()
      if (!isCalendarDate(text)) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be a real calendar date (YYYY-MM-DD)`)
      args[key] = text
      continue
    }
    if (kind === 'decimal') {
      // 定点十进制字符串：无符号、最多两位小数；边界定点串比较不丢精度。
      if (typeof value !== 'string') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be a decimal string`)
      const text = value.trim()
      if (!/^\d+(\.\d{1,2})?$/.test(text)) {
        throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be an unsigned decimal with at most two fraction digits`)
      }
      const bounds = schema.decimals?.[key]
      if (bounds !== undefined) {
        if (bounds.max !== undefined && compareDecimal(text, bounds.max) > 0) {
          throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" exceeds ${bounds.max}`)
        }
        const belowMin = bounds.min !== undefined && compareDecimal(text, bounds.min) < 0
        const atMin = bounds.min !== undefined && compareDecimal(text, bounds.min) === 0
        if (belowMin || (atMin === true && bounds.exclusiveMin === true)) {
          throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" below the allowed minimum`)
        }
      }
      args[key] = text
      continue
    }
    if (kind === 'stringArray' || kind === 'objectArray') {
      const bounds = schema.arrays?.[key] ?? { maxItems: DEFAULT_ARRAY_MAX_ITEMS, itemMax: DEFAULT_ARRAY_ITEM_MAX }
      if (!Array.isArray(value)) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be an array`)
      const minItems = bounds.minItems ?? 0
      if (value.length < minItems) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" needs at least ${String(minItems)} items`)
      if (value.length > bounds.maxItems) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" exceeds ${String(bounds.maxItems)} items`)
      const allowed = schema.enums?.[key]
      if (kind === 'objectArray') {
        const projected: Record<string, unknown>[] = []
        for (const item of value) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" items must be objects`)
          }
          projected.push(validateItem(action, key, schema, item))
        }
        args[key] = projected
        continue
      }
      const items: string[] = []
      for (const item of value) {
        if (typeof item !== 'string') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" items must be strings`)
        const text = item.trim()
        if (text === '') continue
        const itemMax = bounds.itemMax ?? DEFAULT_ARRAY_ITEM_MAX
        if (text.length > itemMax) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" item exceeds ${String(itemMax)} characters`)
        if (allowed !== undefined && !allowed.includes(text)) {
          throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" item is not an allowed value`)
        }
        items.push(text)
      }
      const order = schema.normalizeOrder?.[key]
      args[key] = order === undefined ? items : order.filter(value => items.includes(value))
      continue
    }
    if (kind === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be an object`)
      }
      args[key] = value as Record<string, unknown>
      continue
    }
    if (typeof value !== 'string') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be a string`)
    const text = value.trim()
    if (text === '') continue
    const limit = schema.limits?.[key] ?? DEFAULT_STRING_LIMIT
    // 只 trim 不截断：超长输入确定拒绝（D1 验收口径）。
    if (text.length > limit) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" exceeds ${String(limit)} characters`)
    const allowed = schema.enums?.[key]
    if (allowed !== undefined && !allowed.includes(text)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" is not an allowed value`)
    }
    if (schema.urlFields?.includes(key) === true && !isAbsoluteHttpUrl(text)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${key}" must be an absolute http(s) url with a host`)
    }
    args[key] = text
  }
  // 幂等键模板：段前缀 + （绑定字段归一值 +）UUID（32 位小写 hex 或
  // 8-4-4-4-12 小写 UUID）；键内绑定段与请求字段不一致 = 跨行/跨记录重放，
  // 一律拒绝。绑定值做结构性前缀精确比较（startsWith + 后缀白名单），绝不拼进
  // 动态 RegExp——外部输入含正则元字符时动态拼接会扩大匹配（regex 注入）。
  for (const [field, contract] of Object.entries(schema.idempotency ?? {})) {
    const keyText = args[field]
    if (typeof keyText !== 'string' || keyText === '') continue
    const bound = contract.boundField === undefined ? undefined : args[contract.boundField]
    if (contract.boundField !== undefined && (bound === undefined || bound === null)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${contract.boundField}" is required for the idempotency key`)
    }
    const expectedPrefix = contract.boundField === undefined
      ? `${contract.segment}:`
      : `${contract.segment}:${String(bound)}:`
    if (!keyText.startsWith(expectedPrefix)) {
      throw new DouyinError('INVALID_IDEMPOTENCY_KEY', `field "${field}" does not match the required idempotency key template`)
    }
    const suffix = keyText.slice(expectedPrefix.length)
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(suffix)) {
      throw new DouyinError('INVALID_IDEMPOTENCY_KEY', `field "${field}" does not match the required idempotency key template`)
    }
  }
  return args
}

/** 绝对 http(s) URL 校验：协议限 http/https、协议后必须紧跟 host（不接受
 * `http:///` 空宿形态，WHATWG 解析对三斜杠宽容）、禁止空白与控制字符。 */
function isAbsoluteHttpUrl(value: string): boolean {
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) return false
  if (!/^https?:\/\/[^/]/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}

/** 按月天数（含闰年）校验 YYYY-MM-DD 真实日历日期。 */
function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 定点十进制字符串比较（两值均为无符号定点；返回 -1/0/1）。 */
function compareDecimal(a: string, b: string): number {
  const [intA = '', fracA = ''] = a.split('.')
  const [intB = '', fracB = ''] = b.split('.')
  const normA = intA.replace(/^0+(?=\d)/, '')
  const normB = intB.replace(/^0+(?=\d)/, '')
  if (normA.length !== normB.length) return normA.length < normB.length ? -1 : 1
  if (normA !== normB) return normA < normB ? -1 : 1
  const width = Math.max(fracA.length, fracB.length)
  const fracAPadded = (fracA + '0'.repeat(width)).slice(0, width)
  const fracBPadded = (fracB + '0'.repeat(width)).slice(0, width)
  if (fracAPadded === fracBPadded) return 0
  return fracAPadded < fracBPadded ? -1 : 1
}

/**
 * Validate one objectArray entry against its per-item contract: unknown keys,
 * missing required values, over-limit strings, non-enum values and
 * out-of-range integers are rejected; the conditional URL constraint
 * (homepage_url) applies after field validation.
 */
function validateItem(action: string, field: string, schema: ActionSchema, raw: Record<string, unknown>): Record<string, unknown> {
  const item = schema.items?.[field]
  if (item === undefined) return raw
  for (const key of Object.keys(raw)) {
    if (!(key in item.fields)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}" item has unknown key "${key}" for ${action}`)
    }
  }
  for (const key of item.required) {
    const value = raw[key]
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}" item is missing required "${key}"`)
    }
  }
  const result: Record<string, unknown> = {}
  for (const [key, kind] of Object.entries(item.fields)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (kind === 'string') {
      if (typeof value !== 'string') throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}.${key}" must be a string`)
      const text = value.trim()
      if (text === '') continue
      const limit = item.limits?.[key] ?? DEFAULT_STRING_LIMIT
      if (text.length > limit) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}.${key}" exceeds ${String(limit)} characters`)
      const allowed = item.enums?.[key]
      if (allowed !== undefined && !allowed.includes(text)) {
        throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}.${key}" is not an allowed value`)
      }
      result[key] = text
      continue
    }
    // number：整数 + 范围（旧采集口径：非整数即非法，不截断不取整）。
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}.${key}" must be an integer`)
    }
    const range = item.ranges?.[key]
    const belowMin = range?.min !== undefined && value < range.min
    const aboveMax = range?.max !== undefined && value > range.max
    if (belowMin || aboveMax) throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${field}.${key}" out of range`)
    result[key] = value
  }
  const itemUrl = schema.itemUrl
  if (itemUrl !== undefined && result[itemUrl.when.field] === itemUrl.when.equals) {
    const url = result[itemUrl.url]
    if (typeof url !== 'string' || !isDouyinHomepageUrl(url)) {
      throw new DouyinError('DOUYIN_ROUTE_INVALID_REQUEST', `field "${itemUrl.url}" must be an https douyin homepage url`)
    }
  }
  return result
}

/** homepage_url 约束（分册 15 §3：必须 HTTPS 且 host 为抖音域）。 */
function isDouyinHomepageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return host === 'douyin.com' || host.endsWith('.douyin.com')
  } catch {
    return false
  }
}

/**
 * 路由信任判定（对齐官方浏览器信任边界 api-request-trust，wx/xhs 模板同款）：
 * loopback 远端是基础防线，负责把请求绑定到本机；显式 `sec-fetch-site:
 * cross-site` 一律拒绝；显式 Origin 必须精确等于 expectedOrigin（字面 `null`、
 * 异源都拒绝），Origin 缺失不单独视为攻击——Windows Desktop 的 Electron main
 * 进程 `forwardWebRequest` 转发请求时会剥掉 Origin 与 Sec-Fetch-Site 两枚头，
 * 双头缺失是 Desktop 转发的合法形态，来源边界由 loopback 承担。
 * @param req - Node HTTP 请求。
 * @param expectedOrigin - 本 webServer 绑定的精确 origin。
 * @returns 是否放行。
 */
export function permitted(req: RouteRequest, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  return origin === undefined || origin === expectedOrigin
}

/** Read and parse the JSON body with the size cap; malformed bodies become `{}` (schema layer rejects them). */
async function readBody(req: RouteRequest): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new DouyinError('DOUYIN_ROUTE_PAYLOAD_TOO_LARGE', 'request body too large')
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    // JSON 解析失败按空体处理，schema 层给出确定性拒绝。
    void error
    return {}
  }
}

function send(res: RouteResponse, code: number, payload: object): void {
  res.statusCode = code
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/**
 * Handler 响应的判别联合：error 分支的 reason 必须是稳定码白名单成员——未收录
 * reason 码编译期报错（新增 reason 码必须先进 STABLE_ERROR_CODES）。
 */
export type HandlerPayload =
  | ({ status: 'ready' | 'started' } & Record<string, unknown>)
  | ({ status: 'error'; reason: StableErrorCode } & Record<string, unknown>)

/** One action's business handler: receives validated args and the request-level
 * abort signal（dispose 取消在途请求；后台任务型 action 不消费它）, returns the JSON payload. */
export type ActionHandler = (args: ActionArgs, signal?: AbortSignal) => Promise<HandlerPayload>

/**
 * Build the POST handler for the route.
 * @param expectedOrigin - origin provider (the local webServer binds during init).
 * @param handlers - per-action business handlers（allowlist 内未实现项缺席即
 *   unknown_action，fail loud；不伪造半实现）.
 * @returns the webServer route handler.
 */
export function createRouteHandler(
  expectedOrigin: () => string,
  handlers: Readonly<Record<string, ActionHandler>>,
): (req: RouteRequest, res: RouteResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, { status: 'error', reason: 'invalid_request' })
      return
    }
    if (!permitted(req, expectedOrigin())) {
      send(res, 403, { status: 'error', reason: 'forbidden' })
      return
    }
    try {
      const body = await readBody(req)
      const action = typeof body.action === 'string' ? body.action.trim().slice(0, 64) : ''
      if (!(action in ACTION_SCHEMAS) || handlers[action] === undefined) {
        send(res, 400, { status: 'error', reason: 'unknown_action' })
        return
      }
      const args = validateActionArgs(action, body)
      const payload = await handlers[action](args)
      send(res, 200, payload)
    } catch (error) {
      // 统一收敛：稳定码白名单外的原始错误不透传（分册 15 §6）。
      const code = safeCode(error)
      const reason = isStableCode(code) ? code : 'DOUYIN_ROUTE_INVALID_REQUEST'
      const status = code === 'DOUYIN_ROUTE_PAYLOAD_TOO_LARGE' ? 413 : reason.startsWith('DOUYIN_ROUTE') ? 400 : 200
      send(res, status, { status: 'error', reason })
    }
  }
}
