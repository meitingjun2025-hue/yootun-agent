/**
 * 账号总览页（全宽；对齐旧总览布局）：FilterBar 4 筛选（账号 Menu / 发布时间
 * 窗 Menu + 自定义起止 date Input / 排序 Menu / 负责人 Menu，「全部」「全部
 * 账号」恒首；chips 可清除）→ KPI 行 6 卡（缺失指标整卡消失不造 0；净增粉丝
 * 红涨绿跌）→ 账号表现排行 11 列（行 Enter 下钻单账号分析；过期/可疑 Tag；
 * 目录不完整禁筛选 + 同步提示）→ 爆款视频 6 列（行开统一详情；已投流 Tag +
 * 淡底）→ 爆款账号分布（仅数组时渲染）→ 运营提醒（三类 StateDot 前缀）→
 * 导出总览 ghost + icon。请求按最新序号收口；自定义窗口空值不提交、越界
 * 纠偏只触发一次查询。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, DataCard, DataState, FilterBar, FilterMenu, type FilterChip } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import {
  basisLines, fanDelta, formatCount, formatDateTime, formatPercent, hotLabelText,
  reasonText, shiftDay, type Translate,
} from './format.ts'
import css from './workbench.module.css'
import { readOverview, type HotWorkRow, type OverviewData } from './schema.ts'

/** 总览筛选态（页面级持有；返回分析页保留）。 */
export interface OverviewFilters {
  accountIds: string[]
  window: '7d' | '30d' | '90d' | 'custom'
  sort: 'hot_count' | 'hot_rate' | 'median_play' | 'total_play' | 'engagement_rate'
  ownerName: string
  customFrom: string | null
  customTo: string | null
}

/** 默认筛选：30d / hot_count。 */
export const DEFAULT_OVERVIEW_FILTERS: OverviewFilters = {
  accountIds: [],
  window: '30d',
  sort: 'hot_count',
  ownerName: '',
  customFrom: null,
  customTo: null,
}

type LoadState = 'loading' | 'ready' | 'error'

export interface OverviewPageProps {
  t: Translate
  localeTag: string
  filters: OverviewFilters
  onFiltersChange: (next: OverviewFilters) => void
  /** 下钻单账号分析。 */
  onOpenAccount: (accountId: string) => void
  /** 打开统一作品详情（跨账号显式携带 accountId）。 */
  onOpenWork: (accountId: string, work: HotWorkRow) => void
  onNotice: (text: string) => void
}

/** 账号总览页组件。 */
export function OverviewPage(props: OverviewPageProps): ReactNode {
  const t = props.t
  const [data, setData] = useState<OverviewData | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const seqRef = useRef(0)

  /** 请求参数装配：近 N 天 = [today-(N-1), tomorrow)；自定义 = [from, to+1]。 */
  const buildArgs = useCallback((): Record<string, unknown> => {
    const filters = props.filters
    const args: Record<string, unknown> = { sort: filters.sort }
    if (filters.accountIds.length > 0) args.accountIds = filters.accountIds
    if (filters.ownerName !== '') args.ownerName = filters.ownerName
    if (filters.window === 'custom') {
      if (filters.customFrom !== null && filters.customFrom !== '' && filters.customTo !== null && filters.customTo !== '') {
        args.publishFrom = filters.customFrom
        args.publishTo = shiftDay(filters.customTo, 1)
      }
    } else {
      const days = filters.window === '7d' ? 7 : filters.window === '90d' ? 90 : 30
      const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
      args.publishFrom = shiftDay(today, -(days - 1))
      args.publishTo = shiftDay(today, 1)
    }
    return args
  }, [props.filters])

  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current
    setState('loading')
    setErrorReason(null)
    try {
      const res = await hostAction('overview.get', buildArgs())
      if (seqRef.current !== seq) return
      setData(readOverview(res))
      setState('ready')
    } catch (error) {
      if (seqRef.current !== seq) return
      setData(null)
      setErrorReason(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      setState('error')
    }
  }, [buildArgs])

  useEffect(() => { void load() }, [load])

  const exportOverview = useCallback((): void => {
    setExporting(true)
    void (async () => {
      const args = buildArgs()
      try {
        const res = await hostAction('overview.export', {
          ...(props.filters.accountIds.length > 0 ? { accountIds: props.filters.accountIds } : {}),
          ...(args.publishFrom !== undefined ? { publishFrom: args.publishFrom as string } : {}),
          ...(args.publishTo !== undefined ? { publishTo: args.publishTo as string } : {}),
        })
        downloadBase64(
          typeof res.file_name === 'string' ? res.file_name : 'douyin-overview-export.xlsx',
          typeof res.content_base64 === 'string' ? res.content_base64 : '',
          typeof res.mime_type === 'string' ? res.mime_type : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
      } catch (error) {
        props.onNotice(reasonText(error instanceof Error ? error.message : 'export_failed', t))
      } finally {
        setExporting(false)
      }
    })()
  }, [buildArgs, props, t])

  const filters = props.filters
  const catalogComplete = data !== null && data.accountTotal !== null && data.catalog.length === data.accountTotal
  const filterDisabled = data === null || data.catalog.length === 0 || !catalogComplete
  const scopedCatalog = filters.ownerName !== ''
    ? data?.catalog.filter(item => item.ownerName?.trim() === filters.ownerName) ?? []
    : data?.catalog ?? []
  const ownerOptions = [...new Set((data?.catalog ?? [])
    .map(item => item.ownerName?.trim())
    .filter((name): name is string => name !== undefined && name !== ''))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const summary = data?.summary ?? null
  const rangeLabel = filters.window === 'custom'
    ? t('overview.range.custom', { from: filters.customFrom ?? '?', to: filters.customTo ?? '?' })
    : t(`overview.window.${filters.window}` as 'overview.window.30d')

  const chips: FilterChip[] = []
  if (filters.accountIds.length > 0) {
    const picked = data?.catalog.find(item => item.accountId === filters.accountIds[0])
    chips.push({
      id: 'account',
      label: t('overview.chip.account', { value: picked?.nickname ?? picked?.accountId ?? filters.accountIds[0] ?? '' }),
      onClear: () => { props.onFiltersChange({ ...filters, accountIds: [] }) },
    })
  }
  chips.push({
    id: 'window',
    label: t('overview.chip.window', { value: rangeLabel }),
    onClear: () => { props.onFiltersChange({ ...filters, window: '30d', customFrom: null, customTo: null }) },
  })
  chips.push({
    id: 'sort',
    label: t('overview.chip.sort', { value: t(`overview.sort.${filters.sort}` as 'overview.sort.hot_count') }),
    onClear: () => { props.onFiltersChange({ ...filters, sort: 'hot_count' }) },
  })
  if (filters.ownerName !== '') {
    chips.push({
      id: 'owner',
      label: t('overview.chip.owner', { value: filters.ownerName }),
      onClear: () => { props.onFiltersChange({ ...filters, ownerName: '', accountIds: [] }) },
    })
  }

  // 自定义范围越界纠偏（单次 setState 单次查询）：改开始致 from>to → to 跟随；
  // 改截止致 to<from → from 跟随；空值不提交（受控值保留）。
  const applyCustomRange = (key: 'customFrom' | 'customTo', value: string): void => {
    if (value === '') return
    const next = { ...filters, [key]: value }
    if (next.customFrom !== null && next.customTo !== null && next.customFrom > next.customTo) {
      if (key === 'customFrom') next.customTo = value
      else next.customFrom = value
    }
    props.onFiltersChange(next)
  }

  const alerts = deriveAlerts(data, t)

  return (
    <div className={css.pageBody}>
      <FilterBar
        chips={chips}
        onClearAll={() => { props.onFiltersChange({ ...DEFAULT_OVERVIEW_FILTERS }) }}
      >
        <FilterMenu
          label={t('overview.filter.account')}
          visibleLabel={t('overview.filter.account')}
          disabled={filterDisabled}
          currentLabel={filters.accountIds.length > 0
            ? scopedCatalog.find(item => item.accountId === filters.accountIds[0])?.nickname ?? filters.accountIds[0] ?? t('overview.filter.allAccounts')
            : t('overview.filter.allAccounts')}
          items={[{ id: '', label: t('overview.filter.allAccounts') },
            ...scopedCatalog.map(item => ({ id: item.accountId, label: item.workCount === 0 ? `${item.nickname ?? item.accountId}${t('overview.noWorks')}` : item.nickname ?? item.accountId }))]}
          selectedId={filters.accountIds[0] ?? ''}
          onSelect={id => { props.onFiltersChange({ ...filters, accountIds: id === '' ? [] : [id] }) }}
        />
        <FilterMenu
          label={t('overview.filter.window')}
          visibleLabel={t('overview.filter.window')}
          currentLabel={rangeLabel}
          items={[
            { id: '7d', label: t('overview.window.7d') },
            { id: '30d', label: t('overview.window.30d') },
            { id: '90d', label: t('overview.window.90d') },
            { id: 'custom', label: t('overview.window.custom') },
          ]}
          selectedId={filters.window}
          onSelect={id => { props.onFiltersChange({ ...filters, window: id as OverviewFilters['window'] }) }}
        />
        {filters.window === 'custom' && (
          <span className={css.customRange}>
            <input
              type='date'
              className={css.dateInput}
              aria-label={t('overview.filter.customFrom')}
              value={filters.customFrom ?? ''}
              max={filters.customTo ?? undefined}
              onChange={event => { applyCustomRange('customFrom', event.target.value) }}
            />
            <span className={css.customRangeDash} aria-hidden='true'>-</span>
            <input
              type='date'
              className={css.dateInput}
              aria-label={t('overview.filter.customTo')}
              value={filters.customTo ?? ''}
              min={filters.customFrom ?? undefined}
              onChange={event => { applyCustomRange('customTo', event.target.value) }}
            />
          </span>
        )}
        <FilterMenu
          label={t('overview.filter.sort')}
          visibleLabel={t('overview.filter.sort')}
          currentLabel={t(`overview.sort.${filters.sort}` as 'overview.sort.hot_count')}
          items={[
            { id: 'hot_count', label: t('overview.sort.hot_count') },
            { id: 'hot_rate', label: t('overview.sort.hot_rate') },
            { id: 'median_play', label: t('overview.sort.median_play') },
            { id: 'total_play', label: t('overview.sort.total_play') },
            { id: 'engagement_rate', label: t('overview.sort.engagement_rate') },
          ]}
          selectedId={filters.sort}
          onSelect={id => { props.onFiltersChange({ ...filters, sort: id as OverviewFilters['sort'] }) }}
        />
        <FilterMenu
          label={t('overview.filter.owner')}
          visibleLabel={t('overview.filter.owner')}
          disabled={filterDisabled}
          currentLabel={filters.ownerName === '' ? t('overview.owner.all') : filters.ownerName}
          items={[{ id: '', label: t('overview.owner.all') }, ...ownerOptions.map(name => ({ id: name, label: name }))]}
          selectedId={filters.ownerName}
          onSelect={id => {
            // 联动：新负责人名下不含当前选中账号 → 重置「全部账号」（单次 setState
            // 单次查询）。
            const picked = filters.accountIds[0]
            const keep = picked !== undefined && picked !== ''
              && (id === '' || (data?.catalog ?? []).some(item => item.accountId === picked && item.ownerName?.trim() === id))
            props.onFiltersChange({ ...filters, ownerName: id, accountIds: keep ? filters.accountIds : [] })
          }}
        />
        <Button variant='ghost' size='sm' icon={<ExportIcon />} disabled={exporting} aria-busy={exporting || undefined} onClick={exportOverview}>
          {exporting ? t('report.exporting') : t('overview.export')}
        </Button>
      </FilterBar>
      {data !== null && !catalogComplete && (
        <p className={css.inlineHint} role='status'>{t('overview.rank.syncing')}</p>
      )}
      {data !== null && data.catalog.length === 0 && (
        <p className={css.inlineHint} role='status'>{t('overview.rank.catalogUnavailable')}</p>
      )}

      <DataState state={state} shape='block' onRetry={() => { void load() }}>
        {state === 'error' && errorReason !== null && <p className={css.formError} role='alert'>{reasonText(errorReason, t)}</p>}
        {state === 'ready' && data !== null && summary !== null && summary.accountCount === 0 && (
          <div className={css.emptyState} role='status'><p>{t('overview.empty.addAccount')}</p></div>
        )}
        {state === 'ready' && data !== null && summary !== null && (summary.accountCount ?? 0) > 0 && (summary.workCount ?? 0) === 0 && props.filters.window !== 'custom' && (
          <div className={css.emptyState} role='status'><p>{t('overview.empty.collectFirst')}</p></div>
        )}
        {state === 'ready' && data !== null && summary !== null && (summary.workCount ?? 0) === 0 && props.filters.window === 'custom' && (
          <div className={css.emptyState} role='status'><p>{t('overview.empty.customRange')}</p></div>
        )}
        {state === 'ready' && data !== null && summary !== null && (summary.workCount ?? 0) > 0 && (
          <>
            <div className={css.kpiRow}>
              <KpiTile label={t('overview.kpi.accounts')} value={formatCount(summary.accountCount, props.localeTag)} footnote={rangeLabel} />
              <KpiTile label={t('overview.kpi.works')} value={formatCount(summary.workCount, props.localeTag)} footnote={rangeLabel} />
              {summary.totalPlayCount !== null && (
                <KpiTile label={t('overview.kpi.totalPlay')} value={formatCount(summary.totalPlayCount, props.localeTag)} footnote={rangeLabel} />
              )}
              {summary.netFansCount !== null && (
                <KpiTile
                  label={t('overview.kpi.netFans')}
                  value={deltaNode(summary.netFansCount, props.localeTag)}
                  footnote={rangeLabel}
                />
              )}
              {summary.completionRate5sPct !== null && (
                <KpiTile label={t('overview.kpi.completion5s')} value={formatPercent(summary.completionRate5sPct)} footnote={t('overview.kpi.playWeighted')} />
              )}
              <KpiTile
                label={t('overview.kpi.hot')}
                value={formatCount(summary.hotWorkCount, props.localeTag)}
                footnote={summary.hotRatePct === null ? t('overview.insufficientSample') : formatPercent(summary.hotRatePct)}
              />
            </div>

            <DataCard
              title={t('overview.rank.title')}
              footnote={filters.accountIds.length === 0 && data.accountTotal !== null && data.accountTotal > data.accounts.length
                ? t('overview.rank.count', { total: data.accountTotal, shown: data.accounts.length })
                : undefined}
              state='ready'
            >
              <div className={css.tableWrap} role='region' aria-label={t('overview.rank.title')} tabIndex={0}>
                <table className={css.dataTable} aria-label={t('overview.rank.title')}>
                  <thead>
                    <tr>
                      {[
                        t('overview.col.rank'), t('overview.col.account'), t('overview.col.owner'), t('overview.col.fans'),
                        `${rangeLabel}${t('overview.col.windowNetFans')}`, `${rangeLabel}${t('overview.col.windowPlay')}`,
                        t('overview.col.works'), t('overview.col.medianPlay'), t('overview.col.hotWorks'),
                        t('overview.col.hotRate'), t('overview.col.engagement'),
                        t('action.viewAnalysis'),
                      ].map(label => <th key={label} scope='col'>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {data.accounts.map((account, index) => (
                      <tr
                        key={account.accountId}
                        tabIndex={0}
                        aria-label={`${t('overview.col.account')} ${account.nickname ?? account.accountId}`}
                        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onOpenAccount(account.accountId) } }}
                        onDoubleClick={() => { props.onOpenAccount(account.accountId) }}
                      >
                        <td>{index + 1}</td>
                        <td className={css.cellMain}>
                          <span className={css.accountNameCell} title={account.nickname ?? account.accountId}>{account.nickname ?? account.accountId}</span>
                          {account.sessionStatus === 'expired' && <Tag tone='danger'>{t('overview.tag.expired')}</Tag>}
                          {account.suspiciousEmptyCollect && <Tag tone='warning'>{t('overview.tag.suspicious')}</Tag>}
                        </td>
                        <td>{account.ownerName ?? '—'}</td>
                        <td className={css.cellNum}>{formatCount(account.fanCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{deltaNode(account.windowNetFansCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{formatCount(account.windowPlayCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{formatCount(account.workCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{formatCount(account.medianPlayCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{formatCount(account.hotWorkCount, props.localeTag)}</td>
                        <td className={css.cellNum}>{formatPercent(account.hotRatePct)}</td>
                        <td className={css.cellNum}>{formatPercent(account.engagementRatePct)}</td>
                        <td className={css.colAction}>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={event => {
                              event.stopPropagation()
                              props.onOpenAccount(account.accountId)
                            }}
                          >
                            {t('action.viewAnalysis')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DataCard>

            <div className={css.ovTwoCol}>
            {data.distribution !== null && data.distribution.length > 0 && (() => {
              const rows = data.distribution.filter(row => row.hotWorkCount > 0).slice(0, 5)
              const max = Math.max(1, ...rows.map(row => row.hotWorkCount))
              return (
                <ChartFrame title={t('overview.dist.title')} ariaLabel={t('overview.dist.title')} state='ready' height='fit'>
                  <ul className={css.barList} aria-label={t('overview.dist.title')}>
                    {rows.map((row, index) => (
                      <li key={row.accountId} className={`${css.hotDistRow} ${index < 3 ? css[`barTop${index + 1}` as 'barTop1'] : ''}`}>
                        <span className={css.barRank} aria-hidden='true'>{index + 1}</span>
                        <span className={css.barLabel} title={row.nickname ?? row.accountId}>{row.nickname ?? row.accountId}</span>
                        <span className={css.barTrack}>
                          <span className={`${css.barFill} ${index < 3 ? css[`barFillTop${index + 1}` as 'barFillTop1'] : ''}`} style={{ width: `${(row.hotWorkCount / max) * 100}%` }} />
                        </span>
                        <span className={css.barCount}>{formatCount(row.hotWorkCount, props.localeTag)}</span>
                      </li>
                    ))}
                  </ul>
                </ChartFrame>
              )
            })()}

            <DataCard title={t('overview.alerts.title')} state='ready'>
              {alerts.length > 0
                ? (
                  <ul className={css.alertList}>
                    {alerts.map(alert => (
                      <li key={`${alert.accountId}:${alert.kind}`} className={css.alertItem}>
                        <StateDot state={alert.kind === 'session_expired' ? 'error' : 'warning'} />
                        <span>{`${alert.name}：${alert.text}`}</span>
                      </li>
                    ))}
                  </ul>
                )
                : <p className={css.inlineHint}>{t('overview.alerts.none')}</p>}
            </DataCard>
            </div>

            <DataCard title={t('overview.hot.title')} state='ready'>
              <DataState state={data.hotWorks.length > 0 ? 'ready' : 'empty'} shape='rows'>
                <div className={css.tableWrap} role='region' aria-label={t('overview.hot.title')} tabIndex={0}>
                  <table className={css.dataTable} aria-label={t('overview.hot.title')}>
                    <thead>
                      <tr>
                        {[t('overview.col.video'), t('overview.col.hotOwnerAccount'), t('overview.col.publishTime'),
                          t('col.play'), t('overview.col.engagement'), t('overview.col.hotBasis'), t('action.viewDetail')].map(label => <th key={label} scope='col'>{label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {data.hotWorks.map(work => (
                        <tr
                          key={work.workId}
                          tabIndex={0}
                          className={work.promoted ? css.rowPromoted : undefined}
                          aria-label={t('row.detailAria', { title: work.title ?? work.workId })}
                          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onOpenWork(work.accountId ?? '', work) } }}
                          onDoubleClick={() => { props.onOpenWork(work.accountId ?? '', work) }}
                        >
                          <td className={css.cellMain}>
                            <button type='button' className={css.workLinkButton} title={work.title ?? work.workId} onClick={() => { props.onOpenWork(work.accountId ?? '', work) }}>
                              {work.title ?? work.workId}
                            </button>
                            {work.promoted && <Tag tone='danger'>{t('promotion.badge')}</Tag>}
                          </td>
                          <td>{work.accountNickname ?? '—'}</td>
                          <td>{formatDateTime(work.publishTime)}</td>
                          <td className={css.cellNum}>{formatCount(work.playCount, props.localeTag)}</td>
                          <td className={css.cellNum}>{formatPercent(work.engagementRatePct)}</td>
                          <td>
                            <BasisCell lines={basisLines(work.basis)} fallback={hotLabelText(work.labels, t)} />
                          </td>
                          <td className={css.colAction}>
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={event => {
                                event.stopPropagation()
                                props.onOpenWork(work.accountId ?? '', work)
                              }}
                            >
                              {t('action.viewDetail')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DataState>
            </DataCard>

            </>
        )}
      </DataState>
    </div>
  )
}

/** 运营提醒（dataQuality 派生：会话过期/可疑空采集/超 7 天未采集；每账号 ≤3 条）。 */
function deriveAlerts(data: OverviewData | null, t: Translate): { accountId: string; name: string; kind: 'session_expired' | 'suspicious_empty' | 'stale_collect'; text: string }[] {
  if (data === null) return []
  const alerts: { accountId: string; name: string; kind: 'session_expired' | 'suspicious_empty' | 'stale_collect'; text: string }[] = []
  const now = Date.now()
  for (const account of data.accounts) {
    const name = account.nickname ?? account.accountId
    if (account.sessionStatus === 'expired') {
      alerts.push({ accountId: account.accountId, name, kind: 'session_expired', text: t('overview.alert.sessionExpired') })
    }
    if (account.suspiciousEmptyCollect) {
      alerts.push({ accountId: account.accountId, name, kind: 'suspicious_empty', text: t('overview.alert.suspiciousEmpty') })
    }
    if (account.lastCollectedAt !== null) {
      const collected = Date.parse(account.lastCollectedAt)
      if (Number.isFinite(collected) && now - collected > 7 * 24 * 3_600_000) {
        alerts.push({ accountId: account.accountId, name, kind: 'stale_collect', text: t('overview.alert.staleCollect') })
      }
    }
  }
  return alerts
}

/** 爆款依据单元格（分行；缺失回退命中标签）。 */
function BasisCell(props: { lines: string[]; fallback: string }): ReactNode {
  if (props.lines.length > 0) {
    return (
      <span className={css.basisCell}>
        {props.lines.map(line => <span key={line} className={css.basisLine}>{line}</span>)}
      </span>
    )
  }
  return <span className={css.basisCell}><span className={css.basisLine}>{props.fallback}</span></span>
}

/** KPI 瓦片（插件局部；kit KpiCard 的紧凑变体不满足 6 卡行时用局部网格）。 */
function KpiTile(props: { label: string; value: ReactNode; footnote: string }): ReactNode {
  return (
    <div className={css.kpiTile}>
      <span className={css.metricLabel}>{props.label}</span>
      <strong className={css.kpiValue}>{props.value}</strong>
      <span className={css.metricFootnote}>{props.footnote}</span>
    </div>
  )
}

/** 净增/吸粉着色节点（红涨绿跌 token）。 */
function deltaNode(value: number | null, localeTag: string): ReactNode {
  const delta = fanDelta(value, 'net', localeTag)
  if (delta.tone === 'flat') return <span>{delta.text}</span>
  return <span className={delta.tone === 'up' ? css.deltaUp : css.deltaDown}>{delta.text}</span>
}

/** 导出图标。 */
function ExportIcon(): ReactNode {
  return (
    <svg width='14' height='14' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <path d='M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 12.5h10' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
  )
}

/** base64 下载（Blob + anchor；失败由调用方提示）。 */
export function downloadBase64(fileName: string, base64: string, mimeType: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
