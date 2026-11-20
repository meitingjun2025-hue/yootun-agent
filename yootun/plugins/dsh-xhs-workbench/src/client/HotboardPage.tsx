/**
 * 车衣爆款看板页（12 册 §5 含 R1–R3 修订；旧 hotboard-ui.js HotboardPage 系列
 * 重译）：二级子导航（案例看板/关键词与扩词/标签与 AI 标记/采集与规则）+ 待办
 * 角标 + 写操作通知条（失败保留原数据）+ KPI 行 + 筛选行与 chips + 1100px 表格
 * 转卡 + 案例详情抽屉/图片灯箱/运行历史抽屉/确认弹层。配置只读（R3：仅
 * scheduleEnabled 真实生效，页面只读展示，无编辑入口）。写操作全部先确认并
 * 携幂等键（machine 内生成）。
 * @module
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import css from './workbench.module.css'
import {
  ACTIVE_RUN_STATUSES, BOARD_FILTER_DEFAULTS, CANDIDATE_STATUS_KEYS, KEYWORD_RUN_STATUS_KEYS, PROPOSAL_STATUS_KEYS,
  RUN_STATUS_KEYS, RUN_TYPE_KEYS, SETTING_THRESHOLD_FIELDS, SORT_LABEL_KEYS, SOURCE_KEYS, WINDOW_LABEL_KEYS,
  hbCount, hbEnumText, hbPct, hbScore, hbText, hbTime, hotboardScheduleText, runErrorText, tf,
} from './hotboard-format.ts'
import { createHotboardHub, type HotboardMachine, type HotboardNoteRow, type HotboardSnapshot } from './hotboard-machine.ts'
import type { XhsLocaleKey } from './locales.ts'
import type { Translate } from './format.ts'

const SUB_PAGES: ReadonlyArray<{ id: 'board' | 'keywords' | 'tags' | 'rules'; key: XhsLocaleKey }> = [
  { id: 'board', key: 'hb.subBoard' },
  { id: 'keywords', key: 'hb.subKeywords' },
  { id: 'tags', key: 'hb.subTags' },
  { id: 'rules', key: 'hb.subRules' },
]

/** 模块级单例：筛选草稿与二级页状态跨 Tab/页面开关保留（旧 hotboardHub 同型）。 */
class HubHolder {
  private readonly listeners = new Set<(visible: boolean) => void>()
  private hub: HotboardMachine | null = null

  get(): HotboardMachine | null {
    return this.hub
  }

  set(hub: HotboardMachine): void {
    this.hub = hub
    for (const listener of this.listeners) listener(this.visible)
  }

  visible = false

  setVisible(visible: boolean): void {
    this.visible = visible
    for (const listener of this.listeners) listener(visible)
  }

  subscribeVisible = (listener: (visible: boolean) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

const hubHolder = new HubHolder()

function getHub(): HotboardMachine {
  const existing = hubHolder.get()
  if (existing !== null) return existing
  const hub = createHotboardHub({
    call: async (action, args) => {
      const res = await hostAction(action, args ?? {})
      return res as unknown as import('./hotboard-machine.ts').HotboardCallResult
    },
  })
  hubHolder.set(hub)
  return hub
}

export interface HotboardPageProps { t: Translate }

/**
 * Render the hotboard page (四子区 + 抽屉 + 确认弹层).
 * @param props - page translator.
 * @returns the page node.
 */
export function HotboardPage(props: HotboardPageProps): ReactNode {
  const t = props.t
  const hub = getHub()
  const [, setVisibleTick] = useState(0)
  useState(() => {
    // 挂载即订阅可见性（切换离开时 stop 轮询，已加载数据保留）。
    hubHolder.subscribeVisible(visible => {
      if (visible === true) hub.init()
      else hub.stop()
      setVisibleTick(tick => tick + 1)
    })
    hubHolder.setVisible(true)
    return true
  })

  const state = useSyncExternalStore(hub.subscribe, hub.get, hub.get)
  const todoBadge = (sub: 'board' | 'keywords' | 'tags' | 'rules'): number | null => {
    if (sub === 'keywords' && state.todos.candidates !== null && state.todos.candidates > 0) return state.todos.candidates
    if (sub === 'tags' && state.todos.proposals !== null && state.todos.proposals > 0) return state.todos.proposals
    return null
  }

  return (
    <div className={css.hbRoot}>
      <div className={css.hbSubNav} role='tablist' aria-label={t('hb.title')}>
        {SUB_PAGES.map(item => (
          <button
            key={item.id}
            type='button'
            role='tab'
            aria-selected={state.sub === item.id}
            className={css.hbSubTab}
            onClick={() => { hub.setSub(item.id) }}
          >
            {t(item.key)}
            {todoBadge(item.id) !== null && <span className={css.hbCount}>{String(todoBadge(item.id))}</span>}
          </button>
        ))}
      </div>
      {state.notice !== null && (
        <div className={css.hbNotice} role={state.notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{tf(t, state.notice.key as XhsLocaleKey, state.notice.extra ?? {})}</span>
          <button type='button' className={css.hbNoticeClose} aria-label={t('hb.close')} onClick={() => { hub.dismissNotice() }}>×</button>
        </div>
      )}
      {state.error !== '' && state.loading !== true && (
        <div className={css.hbPageError} role='alert'>
          <span>{t('hb.loadFailed')}</span>
          <Button variant='ghost' onClick={() => { void hub.refresh() }}>{t('state.retry')}</Button>
        </div>
      )}
      {state.sub === 'board' && <BoardPage state={state} hub={hub} t={t} />}
      {state.sub === 'keywords' && <KeywordsPage state={state} hub={hub} t={t} />}
      {state.sub === 'tags' && <TagsPage state={state} hub={hub} t={t} />}
      {state.sub === 'rules' && <RulesPage state={state} hub={hub} t={t} />}
      <NoteDrawer state={state} hub={hub} t={t} />
      <RunDrawer state={state} hub={hub} t={t} />
      {state.confirm !== null && (
        <Modal
          open={true}
          onClose={() => { hub.dismissConfirm() }}
          title={t('hb.confirm')}
          closeLabel={t('action.confirmNo')}
        >
          <p className={css.confirmText}>{state.confirm.message}</p>
          <div className={css.actionRow}>
            <Button variant='primary' onClick={() => { hub.resolveConfirm() }}>{t('action.confirmYes')}</Button>
            <Button variant='ghost' onClick={() => { hub.dismissConfirm() }}>{t('action.confirmNo')}</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---- 案例看板（12 册 §5.1）----

function SelectFilter(props: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; disabled: boolean }): ReactNode {
  return (
    <label className={css.hbFilter}>
      <span>{props.label}</span>
      <select value={props.value} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }}>
        {props.options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </label>
  )
}

function Pager(props: { meta: Record<string, unknown> | null; page: number; onPage: (p: number) => void; t: Translate }): ReactNode {
  const total = Number(props.meta?.total) || 0
  const pageSize = Number(props.meta?.pageSize) || 20
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1 && total === 0) return null
  return (
    <div className={css.hbPager}>
      <Button variant='ghost' disabled={props.page <= 1} onClick={() => { props.onPage(props.page - 1) }}>{props.t('hb.prev')}</Button>
      <span>{props.page} / {pages} · {props.t('hb.total')} {hbCount(total)}</span>
      <Button variant='ghost' disabled={props.page >= pages} onClick={() => { props.onPage(props.page + 1) }}>{props.t('hb.next')}</Button>
    </div>
  )
}

function BoardPage(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const data = state.overview?.data ?? null
  const meta = state.overview?.meta ?? null
  const f = state.filters.board
  const page = state.pages.board
  const options = data?.filterOptions ?? null
  const kpis = data?.kpis ?? null
  const disabled = state.loading || state.pending > 0
  const total = Number(meta?.total) || 0
  const pageSize = Number(meta?.pageSize) || 20
  const pagesCount = Math.max(1, Math.ceil(total / pageSize))
  const scheduleEnabled = kpis?.nextRun?.scheduleEnabled === true

  const chips: Array<{ key: string; label: string }> = []
  if (f.window !== '90d') chips.push({ key: 'window', label: t(WINDOW_LABEL_KEYS[f.window] ?? 'hb.window90d') })
  for (const [key, label] of [['keyword', t('hb.filterKeyword')], ['style', t('hb.style')], ['color', t('hb.color')], ['noteWord', t('hb.noteWord')], ['commentWord', t('hb.commentWord')]] as const) {
    if (f[key] !== '') chips.push({ key, label: `${label}: ${f[key]}` })
  }
  if (f.scoreMin !== '') chips.push({ key: 'scoreMin', label: `${t('hb.scoreMin')} ≥ ${f.scoreMin}` })
  if (f.sort !== '' && f.sort !== 'score') chips.push({ key: 'sort', label: `${t('hb.sort')}: ${t(SORT_LABEL_KEYS[f.sort] ?? 'hb.sortScore')}` })

  return (
    <div className={css.hbBoard}>
      <div className={css.hbKpis}>
        <KpiCard label={t('hb.kpiCases')} value={hbCount(kpis?.totalCases)} footnote={tf(t, 'hb.kpiCasesHint', { page, pages: pagesCount })} />
        <KpiCard label={t('hb.kpiCoverage')} value={hbPct(kpis?.coverageRate)} footnote={t('hb.kpiCoverageHint')} />
        <KpiCard label={t('hb.kpiAiTagged')} value={hbPct(kpis?.aiTaggedRate)} footnote={t('hb.kpiAiTaggedHint')} />
        <KpiCard label={t('hb.kpiDuplicates')} value={hbCount(kpis?.duplicateGroupCount)} footnote={t('hb.kpiDuplicatesHint')} />
        <KpiCard label={t('hb.kpiLowQuality')} value={hbCount(kpis?.lowQualityCount)} footnote={t('hb.kpiLowQualityHint')} />
        <KpiCard label={t('hb.kpiFailedKeywords')} value={hbCount(kpis?.failedKeywordCount)} footnote={t('hb.kpiFailedKeywordsHint')} />
        <KpiCard label={t('hb.kpiLastCollected')} value={hbTime(kpis?.lastCollectedAt)} />
        <KpiCard
          label={t('hb.kpiNextRun')}
          value={scheduleEnabled ? t('hb.scheduleOn') : t('hb.scheduleOff')}
          footnote={scheduleEnabled ? hotboardScheduleText(kpis?.nextRun?.cron, t) : undefined}
        />
      </div>
      <div className={css.hbFilters} aria-label={t('hb.filters')}>
        <SelectFilter label={t('hb.window')} value={f.window} disabled={disabled} onChange={v => { hub.setFilter('board', 'window', v) }}
          options={[{ value: '7d', label: t('hb.window7d') }, { value: '30d', label: t('hb.window30d') }, { value: '90d', label: t('hb.window90d') }]} />
        <SelectFilter label={t('hb.filterKeyword')} value={f.keyword} disabled={disabled} onChange={v => { hub.setFilter('board', 'keyword', v) }}
          options={[{ value: '', label: t('hb.all') }, ...(options?.keywords ?? []).map(item => ({ value: item.keyword, label: item.keyword }))]} />
        <SelectFilter label={t('hb.style')} value={f.style} disabled={disabled} onChange={v => { hub.setFilter('board', 'style', v) }}
          options={[{ value: '', label: t('hb.all') }, ...(options?.styles ?? []).map(item => ({ value: item.code, label: item.name }))]} />
        <SelectFilter label={t('hb.color')} value={f.color} disabled={disabled} onChange={v => { hub.setFilter('board', 'color', v) }}
          options={[{ value: '', label: t('hb.all') }, ...(options?.colors ?? []).map(item => ({ value: item.code, label: item.name }))]} />
        <SelectFilter label={t('hb.noteWord')} value={f.noteWord} disabled={disabled} onChange={v => { hub.setFilter('board', 'noteWord', v) }}
          options={[{ value: '', label: t('hb.all') }, ...(options?.noteWords ?? []).map(w => ({ value: w, label: w }))]} />
        <SelectFilter label={t('hb.commentWord')} value={f.commentWord} disabled={disabled} onChange={v => { hub.setFilter('board', 'commentWord', v) }}
          options={[{ value: '', label: t('hb.all') }, ...(options?.commentWords ?? []).map(w => ({ value: w, label: w }))]} />
        <label className={css.hbFilter}>
          <span>{t('hb.scoreMin')}</span>
          <Input type='number' min={0} max={100} placeholder={t('hb.scoreMinPlaceholder')} value={f.scoreMin} disabled={disabled}
            aria-label={t('hb.scoreMin')}
            onChange={event => { hub.setFilter('board', 'scoreMin', event.target.value === '' ? '' : Number(event.target.value).toString()) }} />
        </label>
        <SelectFilter label={t('hb.sort')} value={f.sort} disabled={disabled} onChange={v => { hub.setFilter('board', 'sort', v) }}
          options={Object.entries(SORT_LABEL_KEYS).map(([value, key]) => ({ value, label: t(key) }))} />
        <label className={css.hbCheck}>
          <Checkbox checked={f.onlyMain === true} disabled={disabled} label={t('hb.onlyMain')}
            onChange={checked => { hub.setFilter('board', 'onlyMain', checked) }} />
        </label>
        <label className={css.hbCheck}>
          <Checkbox checked={f.onlyTagged === true} disabled={disabled} label={t('hb.onlyTagged')}
            onChange={checked => { hub.setFilter('board', 'onlyTagged', checked) }} />
        </label>
      </div>
      {chips.length > 0 && (
        <div className={css.hbChipRow}>
          {chips.map(chip => (
            <span key={chip.key} className={css.hbChipFilter}>
              {chip.label}
              <button type='button' className={css.hbChipRemove} aria-label={t('hb.close')}
                onClick={() => { hub.setFilter('board', chip.key, BOARD_FILTER_DEFAULTS[chip.key] as string | boolean) }}>×</button>
            </span>
          ))}
          <button type='button' className={css.hbLink} onClick={() => { hub.resetFilters('board') }}>{t('hb.clearFilters')}</button>
        </div>
      )}
      <div className={css.hbTableWrap}>
        <table className={css.hbTableBoard}>
          <thead>
            <tr>
              {[t('hb.colCase'), t('hb.colComposite'), t('hb.colCollects'), t('hb.colLikes'), t('hb.colComments'), t('hb.colShares'), t('hb.colInteraction'), t('hb.colAuthorPublish'), t('hb.colTagsWords'), t('hb.colDupGroup'), t('hb.colActions')].map(label => <th key={label}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {(data?.notes ?? []).map(note => <BoardRow key={note.noteId} note={note} state={state} hub={hub} t={t} disabled={disabled} windowKey={f.window} />)}
          </tbody>
          {(data?.notes ?? []).length === 0 && state.loading !== true && (
            <tfoot>
              <tr><td colSpan={11} className={css.hbEmpty}>{t('hb.noCases')}</td></tr>
            </tfoot>
          )}
        </table>
      </div>
      <Pager meta={meta} page={page} onPage={p => { hub.setPage('board', p) }} t={t} />
    </div>
  )
}

function BoardRow(props: { note: HotboardNoteRow; state: HotboardSnapshot; hub: HotboardMachine; t: Translate; disabled: boolean; windowKey: string }): ReactNode {
  const { note, hub, t, disabled, windowKey } = props
  const tagNames = [note.styleTag?.name, note.colorTag?.name].filter(Boolean) as string[]
  const words = Array.isArray(note.matchedKeywords) ? note.matchedKeywords : []
  const scoreNumber = note.score === null || note.score === undefined ? null : Number(note.score)
  const exclude = (): void => {
    hub.askConfirm(tf(props.t, 'hb.confirmExcludeNote', { title: note.title ?? note.noteId }), () => { void hub.noteExclude(note.noteId) })
  }
  return (
    <tr className={css.hbRow} onClick={() => { void hub.openNote(note.noteId) }}>
      <td data-label={t('hb.colCase')} className={css.hbCellCase}>
        <span className={css.hbCellFlex}>
          <NoteThumb note={note} t={t} />
          <span className={css.hbCaseMain}>
            <span className={css.hbCaseTitle}>{hbText(note.title)}</span>
            {words.length > 0 && <span className={css.hbCaseHit}>{t('hb.hitLabel')}: {words.join(' / ')}</span>}
            <span className={css.hbCaseTime}>{t('hb.collectedAt')} {hbTime(note.retrievedAt)}</span>
          </span>
        </span>
      </td>
      <td data-label={t('hb.colComposite')} className={css.hbCellScore}>
        <span className={css.hbCellCol}>
          <span className={css.hbScoreNum}>{hbScore(note.score)}</span>
          <span className={css.hbScoreLabel}>{tf(t, 'hb.scoreWindowLabel', { window: t(WINDOW_LABEL_KEYS[windowKey] ?? 'hb.window90d') })}</span>
          {scoreNumber !== null && Number.isFinite(scoreNumber) && (
            <span className={css.hbScoreBar}><span className={css.hbScoreFill} style={{ width: `${Math.max(0, Math.min(100, scoreNumber))}%` }} /></span>
          )}
        </span>
      </td>
      <td data-label={t('hb.colCollects')} className={css.hbCellNum}>{hbCount(note.collectCount)}</td>
      <td data-label={t('hb.colLikes')} className={css.hbCellNum}>{hbCount(note.likeCount)}</td>
      <td data-label={t('hb.colComments')} className={css.hbCellNum}>{hbCount(note.commentCount)}</td>
      <td data-label={t('hb.colShares')} className={css.hbCellNum}>{hbCount(note.shareCount)}</td>
      <td data-label={t('hb.colInteraction')} className={`${css.hbCellNum} ${css.hbCellTotal}`}>{hbCount(note.interactionTotal)}</td>
      <td data-label={t('hb.colAuthorPublish')} className={css.hbCellPub}>
        <span className={css.hbCellAuthor}>{hbText(note.authorName)}</span>
        <span className={css.hbCellDate}>{hbTime(note.publishTime)}</span>
      </td>
      <td data-label={t('hb.colTagsWords')}>
        {tagNames.length > 0 || words.length > 0
          ? (
              <div className={css.hbChips}>
                {tagNames.map((name, index) => <span key={`tag-${index}-${name}`} className={`${css.hbChip} ${css.hbChipTag}`}>{name}</span>)}
                {words.map((word, index) => <span key={`word-${index}-${word}`} className={css.hbChip}>{word}</span>)}
              </div>
            )
          : '—'}
      </td>
      <td data-label={t('hb.colDupGroup')}>{note.duplicateGroupId !== null && note.duplicateGroupId !== undefined ? `${t('hb.dupGroupShort')} ${String(note.duplicateGroupId).slice(0, 8)}` : t('hb.mainRecord')}</td>
      <td data-label={t('hb.colActions')}>
        <span className={css.hbCellFlex}>
          <button type='button' className={css.hbMiniPrimary} onClick={event => { event.stopPropagation(); void hub.openNote(note.noteId) }}>
            {t('hb.viewDetail')}
          </button>
          <button type='button' className={css.hbMiniSecondary} disabled={disabled} onClick={event => { event.stopPropagation(); exclude() }}>
            {t('hb.exclude')}
          </button>
        </span>
      </td>
    </tr>
  )
}

/** 案例缩略图：coverUrl 缺失或加载失败显示类型占位（旧 NoteThumb 同口径）。 */
function NoteThumb(props: { note: HotboardNoteRow; t: Translate }): ReactNode {
  const [broken, setBroken] = useState(false)
  const url = props.note.coverUrl
  const typeLabel = props.note.noteType === 'video' ? props.t('hb.typeVideo') : props.t('hb.typeImage')
  if (url === null || url === undefined || broken) {
    return <span className={`${css.hbThumb} ${css.hbThumbEmpty}`}><span className={css.hbThumbFallback}>{typeLabel}</span></span>
  }
  return (
    <span className={css.hbThumb}>
      <img src={url} alt='' loading='lazy' onError={() => { setBroken(true) }} />
      <span className={css.hbThumbBadge}>{typeLabel}</span>
    </span>
  )
}

// ---- 关键词与扩词（12 册 §5.2 R1：关键词面板 + 扩词候选审核面板）----

function KeywordsPage(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const kwData = state.keywords?.data ?? null
  const kwMeta = state.keywords?.meta ?? null
  const candData = state.candidates?.data ?? null
  const candMeta = state.candidates?.meta ?? null
  const kf = state.filters.keywords
  const cf = state.filters.candidates
  const disabled = state.loading || state.pending > 0
  const kwRows = kwData?.keywords ?? []
  const [keywordDraft, setKeywordDraft] = useState('')
  const [category, setCategory] = useState('product')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const pendingCandidates = (candData?.candidates ?? []).filter(item => item.status === 'pending')

  const togglePick = (id: string): void => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const submitKeyword = (): void => {
    const keyword = keywordDraft.trim()
    if (keyword === '') return
    hub.askConfirm(tf(t, 'hb.confirmCreateKeyword', { keyword }), () => {
      void hub.keywordSave({ action: 'create', keyword, category }).then(ok => {
        if (ok !== false) setKeywordDraft('')
      })
    })
  }

  return (
    <div className={css.hbKeywords}>
      <section className={css.hbPanel} aria-label={t('hb.panelKeywords')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelKeywords')}</h2>
        <div className={css.hbFilters}>
          <SelectFilter label={t('hb.category')} value={kf.category} disabled={disabled} onChange={v => { hub.setFilter('keywords', 'category', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'product', label: t('hb.categoryProduct') }, { value: 'scene', label: t('hb.categoryScene') }]} />
          <SelectFilter label={t('hb.status')} value={kf.status} disabled={disabled} onChange={v => { hub.setFilter('keywords', 'status', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'active', label: t('hb.statusActive') }, { value: 'disabled', label: t('hb.statusDisabled') }]} />
          <SelectFilter label={t('hb.sourceHeader')} value={kf.source} disabled={disabled} onChange={v => { hub.setFilter('keywords', 'source', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'built_in', label: t('hb.sourceBuiltIn') }, { value: 'manual', label: t('hb.sourceManual') }, { value: 'agent', label: t('hb.sourceAgent') }]} />
        </div>
        <div className={css.hbEditor}>
          <Input value={keywordDraft} placeholder={t('hb.keywordPlaceholder')} maxLength={128} disabled={disabled}
            aria-label={t('hb.keywordPlaceholder')}
            onChange={event => { setKeywordDraft(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') submitKeyword() }} />
          <SelectFilter label={t('hb.category')} value={category} disabled={disabled} onChange={setCategory}
            options={[{ value: 'product', label: t('hb.categoryProduct') }, { value: 'scene', label: t('hb.categoryScene') }]} />
          <Button variant='primary' disabled={disabled || keywordDraft.trim() === ''} onClick={submitKeyword}>{t('hb.createKeyword')}</Button>
        </div>
        <div className={css.hbTableWrap}>
          <table className={`${css.hbTable} ${css.hbTableCompact}`}>
            <thead><tr>{[t('hb.colKeyword'), t('hb.category'), t('hb.status'), t('hb.sourceHeader'), t('hb.colActions')].map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>
              {kwRows.map(row => (
                <tr key={row.keywordId}>
                  <td>{hbText(row.keyword)}</td>
                  <td>{hbEnumText(t, { product: 'hb.categoryProduct', scene: 'hb.categoryScene' }, row.category)}</td>
                  <td>
                    <span className={css.hbBadgeWrap}>
                      <StateDot state={row.status === 'active' ? 'done' : 'idle'} />
                      {row.status === 'active' ? t('hb.statusActive') : t('hb.statusDisabled')}
                    </span>
                  </td>
                  <td>{hbEnumText(t, SOURCE_KEYS, row.source)}</td>
                  <td>
                    <Button variant={row.status === 'active' ? 'ghost' : 'primary'} disabled={disabled || row.keywordId === ''}
                      onClick={() => {
                        hub.askConfirm(
                          tf(t, row.status === 'active' ? 'hb.confirmDisableKeyword' : 'hb.confirmEnableKeyword', { keyword: row.keyword }),
                          () => { void hub.keywordSave({ action: row.status === 'active' ? 'disable' : 'enable', keywordId: row.keywordId }) },
                        )
                      }}>
                      {row.status === 'active' ? t('hb.disable') : t('hb.enable')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            {kwRows.length === 0 && state.loading !== true && <tfoot><tr><td colSpan={5} className={css.hbEmpty}>{t('hb.noKeywords')}</td></tr></tfoot>}
          </table>
        </div>
        <Pager meta={kwMeta} page={state.pages.keywords} onPage={p => { hub.setPage('keywords', p) }} t={t} />
      </section>
      <section className={css.hbPanel} aria-label={t('hb.panelCandidates')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelCandidates')}</h2>
        <div className={css.hbFilters}>
          <SelectFilter label={t('hb.status')} value={cf.status} disabled={disabled} onChange={v => { hub.setFilter('candidates', 'status', v) }}
            options={[
              { value: 'pending', label: t('hb.pending') }, { value: 'accepted', label: t('hb.accepted') },
              { value: 'rejected', label: t('hb.rejected') }, { value: 'expired', label: t('hb.expired') }, { value: '', label: t('hb.all') },
            ]} />
          <SelectFilter label={t('hb.category')} value={cf.category} disabled={disabled} onChange={v => { hub.setFilter('candidates', 'category', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'product', label: t('hb.categoryProduct') }, { value: 'scene', label: t('hb.categoryScene') }]} />
          <label className={css.hbFilter}><span>{t('hb.dateFrom')}</span>
            <Input type='date' value={cf.dateFrom} disabled={disabled} aria-label={t('hb.dateFrom')}
              onChange={event => { hub.setFilter('candidates', 'dateFrom', event.target.value) }} /></label>
          <label className={css.hbFilter}><span>{t('hb.dateTo')}</span>
            <Input type='date' value={cf.dateTo} disabled={disabled} aria-label={t('hb.dateTo')}
              onChange={event => { hub.setFilter('candidates', 'dateTo', event.target.value) }} /></label>
        </div>
        {pendingCandidates.length > 0 && (
          <div className={css.hbBulk}>
            <span>{t('hb.picked')} {picked.size}</span>
            <Button variant='primary' disabled={disabled || picked.size === 0}
              onClick={() => {
                hub.askConfirm(tf(t, 'hb.confirmAcceptCandidates', { count: picked.size }), () => {
                  const ids = [...picked]
                  setPicked(new Set())
                  void hub.candidateReview('accepted', ids)
                })
              }}>
              {t('hb.accept')}
            </Button>
            <Button variant='ghost' disabled={disabled || picked.size === 0}
              onClick={() => {
                hub.askConfirm(tf(t, 'hb.confirmRejectCandidates', { count: picked.size }), () => {
                  const ids = [...picked]
                  setPicked(new Set())
                  void hub.candidateReview('rejected', ids)
                })
              }}>
              {t('hb.reject')}
            </Button>
          </div>
        )}
        <div className={css.hbTableWrap}>
          <table className={`${css.hbTable} ${css.hbTableCompact}`}>
            <thead><tr>{[t('hb.colPick'), t('hb.colKeyword'), t('hb.category'), t('hb.colScore'), t('hb.colReason'), t('hb.status')].map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>
              {(candData?.candidates ?? []).map(row => (
                <tr key={row.candidateId}>
                  <td>{row.status === 'pending'
                    ? (
                        // Checkbox 原语无可关 label 变体：选择列用原生 checkbox + aria
                        //（官方 tokens 样式，label 走 aria-label，与旧 pick 列一致）。
                        <input
                          type='checkbox'
                          className={css.hbPick}
                          aria-label={t('hb.colPick')}
                          checked={picked.has(row.candidateId)}
                          disabled={disabled}
                          onChange={() => { togglePick(row.candidateId) }}
                        />
                      )
                    : null}</td>
                  <td>{hbText(row.keyword)}</td>
                  <td>{hbEnumText(t, { product: 'hb.categoryProduct', scene: 'hb.categoryScene' }, row.category)}</td>
                  <td>{hbScore(row.score)}</td>
                  <td className={css.hbCellReason}>{hbText(row.reason)}</td>
                  <td>{hbEnumText(t, CANDIDATE_STATUS_KEYS, row.status)}</td>
                </tr>
              ))}
            </tbody>
            {(candData?.candidates ?? []).length === 0 && state.loading !== true && <tfoot><tr><td colSpan={6} className={css.hbEmpty}>{t('hb.noCandidates')}</td></tr></tfoot>}
          </table>
        </div>
        <Pager meta={candMeta} page={state.pages.candidates} onPage={p => { hub.setPage('candidates', p) }} t={t} />
      </section>
    </div>
  )
}

// ---- 标签与 AI 标记（12 册 §5.3 R2：提案审核 + 标签库）----

function TagsPage(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const data = state.labels?.data ?? null
  const meta = state.labels?.meta ?? null
  const f = state.filters.labels
  const disabled = state.loading || state.pending > 0
  const labels = data?.labels ?? []
  const proposals = data?.proposals ?? []
  const pendingProposals = proposals.filter(item => item.status === 'pending')
  const [mergeTarget, setMergeTarget] = useState('')
  const [editor, setEditor] = useState<{ labelId: string | null; tagType: string; code: string; name: string; aliases: string[]; definition: string } | null>(null)

  return (
    <div className={css.hbTags}>
      <section className={css.hbPanel} aria-label={t('hb.panelProposals')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelProposals')}</h2>
        <div className={css.hbFilters}>
          <SelectFilter label={t('hb.proposalStatus')} value={f.proposalStatus} disabled={disabled} onChange={v => { hub.setFilter('labels', 'proposalStatus', v) }}
            options={[
              { value: 'pending', label: t('hb.pending') }, { value: 'auto_activated', label: t('hb.proposalAuto') },
              { value: 'accepted', label: t('hb.accepted') }, { value: 'rejected', label: t('hb.rejected') },
              { value: 'merged', label: t('hb.proposalMerged') }, { value: 'expired', label: t('hb.expired') }, { value: '', label: t('hb.all') },
            ]} />
        </div>
        {pendingProposals.length > 0 && <p className={css.hbHint}>{t('hb.mergeHint')}</p>}
        <div className={css.hbTableWrap}>
          <table className={`${css.hbTable} ${css.hbTableCompact}`}>
            <thead><tr>{[t('hb.colLabel'), t('hb.tagType'), t('hb.colConfidence'), t('hb.colEvidence'), t('hb.colActions')].map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>
              {proposals.map(row => (
                <tr key={row.proposalId}>
                  <td>{hbText(row.proposedLabel)}</td>
                  <td>{row.tagType === 'style' ? t('hb.styleType') : t('hb.colorType')}</td>
                  <td>{hbPct(row.confidence)}</td>
                  <td>{hbCount(row.evidenceNoteCount)}</td>
                  <td>
                    {row.status === 'pending'
                      ? (
                          <div className={css.hbRowActions}>
                            <Button variant='primary' disabled={disabled}
                              onClick={() => { hub.askConfirm(tf(t, 'hb.confirmAcceptProposal', { label: row.proposedLabel }), () => { void hub.labelReview({ action: 'accept', proposalId: row.proposalId }) }) }}>
                              {t('hb.accept')}
                            </Button>
                            <Button variant='ghost' disabled={disabled}
                              onClick={() => { hub.askConfirm(tf(t, 'hb.confirmRejectProposal', { label: row.proposedLabel }), () => { void hub.labelReview({ action: 'reject', proposalId: row.proposalId }) }) }}>
                              {t('hb.reject')}
                            </Button>
                            <Button variant='ghost' disabled={disabled}
                              onClick={() => {
                                const target = mergeTarget === '' ? '—' : (labels.find(item => item.labelId === mergeTarget)?.name ?? mergeTarget)
                                hub.askConfirm(tf(t, 'hb.confirmMergeProposal', { label: row.proposedLabel, target }), () => {
                  void hub.labelReview(mergeTarget === '' ? { action: 'merge', proposalId: row.proposalId } : { action: 'merge', proposalId: row.proposalId, targetLabelId: mergeTarget })
                })
                              }}>
                              {t('hb.merge')}
                            </Button>
                          </div>
                        )
                      : <span className={css.hbBadge}>{hbEnumText(t, PROPOSAL_STATUS_KEYS, row.status)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            {proposals.length === 0 && state.loading !== true && <tfoot><tr><td colSpan={5} className={css.hbEmpty}>{t('hb.noProposals')}</td></tr></tfoot>}
          </table>
        </div>
        {pendingProposals.length > 0 && (
          <div className={css.hbEditor}>
            <SelectFilter label={t('hb.mergeTarget')} value={mergeTarget} disabled={disabled} onChange={setMergeTarget}
              options={[{ value: '', label: t('hb.mergeTargetNone') }, ...labels.filter(item => item.status === 'active').map(item => ({ value: item.labelId, label: `${item.name} (${item.code})` }))]} />
          </div>
        )}
      </section>
      <section className={css.hbPanel} aria-label={t('hb.panelLabels')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelLabels')}</h2>
        <div className={css.hbFilters}>
          <SelectFilter label={t('hb.tagType')} value={f.tagType} disabled={disabled} onChange={v => { hub.setFilter('labels', 'tagType', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'style', label: t('hb.styleType') }, { value: 'color', label: t('hb.colorType') }]} />
          <SelectFilter label={t('hb.status')} value={f.status} disabled={disabled} onChange={v => { hub.setFilter('labels', 'status', v) }}
            options={[{ value: '', label: t('hb.all') }, { value: 'active', label: t('hb.statusActive') }, { value: 'retired', label: t('hb.statusRetired') }]} />
          <Button variant='ghost' disabled={disabled}
            onClick={() => { setEditor({ labelId: null, tagType: 'style', code: '', name: '', aliases: [], definition: '' }) }}>
            {t('hb.createLabel')}
          </Button>
        </div>
        {editor !== null && <LabelEditor hub={hub} t={t} disabled={disabled} editor={editor} onClose={() => { setEditor(null) }} />}
        <div className={css.hbTableWrap}>
          <table className={`${css.hbTable} ${css.hbTableCompact}`}>
            <thead><tr>{[t('hb.colLabel'), t('hb.colCode'), t('hb.colAliases'), t('hb.tagType'), t('hb.status'), t('hb.colActions')].map(label => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>
              {labels.map(row => (
                <tr key={row.labelId}>
                  <td>{hbText(row.name)}</td>
                  <td className={css.hbMono}>{hbText(row.code)}</td>
                  <td>
                    {(row.aliases ?? []).length > 0
                      ? <div className={css.hbChips}>{(row.aliases ?? []).map(alias => <span key={alias} className={css.hbChip}>{alias}</span>)}</div>
                      : '—'}
                  </td>
                  <td>{row.tagType === 'style' ? t('hb.styleType') : t('hb.colorType')}</td>
                  <td>{row.status === 'active' ? t('hb.statusActive') : t('hb.statusRetired')}</td>
                  <td>
                    <div className={css.hbRowActions}>
                      <Button variant='ghost' disabled={disabled}
                        onClick={() => { setEditor({ labelId: row.labelId, tagType: row.tagType ?? 'style', code: row.code, name: row.name, aliases: row.aliases ?? [], definition: row.definition ?? '' }) }}>
                        {t('hb.edit')}
                      </Button>
                      {row.status === 'active'
                        ? (
                            <Button variant='ghost' disabled={disabled}
                              onClick={() => { hub.askConfirm(tf(t, 'hb.confirmRetireLabel', { label: row.name }), () => { void hub.labelReview({ action: 'retire', labelId: row.labelId }) }) }}>
                              {t('hb.retire')}
                            </Button>
                          )
                        : (
                            <Button variant='primary' disabled={disabled}
                              onClick={() => { hub.askConfirm(tf(t, 'hb.confirmEnableLabel', { label: row.name }), () => { void hub.labelReview({ action: 'enable', labelId: row.labelId }) }) }}>
                              {t('hb.enable')}
                            </Button>
                          )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {labels.length === 0 && state.loading !== true && <tfoot><tr><td colSpan={6} className={css.hbEmpty}>{t('hb.noLabels')}</td></tr></tfoot>}
          </table>
        </div>
        <Pager meta={meta} page={state.pages.labels} onPage={p => { hub.setPage('labels', p) }} t={t} />
      </section>
    </div>
  )
}

/** 标签新增/编辑就近编辑卡（新增带 code+tagType；编辑锁定 code/tagType，服务端同约束）。 */
function LabelEditor(props: { hub: HotboardMachine; t: Translate; disabled: boolean; editor: { labelId: string | null; tagType: string; code: string; name: string; aliases: string[]; definition: string }; onClose: () => void }): ReactNode {
  const { hub, t, disabled, editor, onClose } = props
  const isEdit = editor.labelId !== null
  const [tagType, setTagType] = useState(editor.tagType)
  const [name, setName] = useState(editor.name)
  const [code, setCode] = useState(editor.code)
  const [aliases, setAliases] = useState(editor.aliases.join('，'))
  const [definition, setDefinition] = useState(editor.definition)
  const parseAliases = (): string[] => aliases.split(/[,，、]/u).map(item => item.trim()).filter(Boolean)
  const submit = (): void => {
    const payload: { labelId?: string; tagType?: string; code?: string; name: string; aliases: string[]; definition?: string } = { name: name.trim(), aliases: parseAliases() }
    if (editor.labelId !== null) payload.labelId = editor.labelId
    if (definition.trim() !== '') payload.definition = definition.trim()
    if (!isEdit) {
      payload.tagType = tagType
      payload.code = code.trim()
    }
    hub.askConfirm(tf(t, isEdit ? 'hb.confirmUpdateLabel' : 'hb.confirmCreateLabel', { label: name.trim() }), () => {
      void hub.labelSave(payload).then(ok => {
        if (ok !== false) onClose()
      })
    })
  }
  return (
    <div className={css.hbEditorCard}>
      <SelectFilter label={t('hb.tagType')} value={tagType} disabled={disabled || isEdit} onChange={setTagType}
        options={[{ value: 'style', label: t('hb.styleType') }, { value: 'color', label: t('hb.colorType') }]} />
      {isEdit
        ? null
        : (
            <label className={css.hbFilter}>
              <span>{t('hb.colCode')}</span>
              <Input value={code} placeholder={t('hb.codePlaceholder')} maxLength={64} disabled={disabled} onChange={event => { setCode(event.target.value) }} />
            </label>
          )}
      <label className={css.hbFilter}>
        <span>{t('hb.fieldName')}</span>
        <Input value={name} placeholder={t('hb.namePlaceholder')} maxLength={128} disabled={disabled} onChange={event => { setName(event.target.value) }} />
      </label>
      <label className={css.hbFilter}>
        <span>{t('hb.colAliases')}</span>
        <Input value={aliases} placeholder={t('hb.aliasesPlaceholder')} maxLength={512} disabled={disabled} onChange={event => { setAliases(event.target.value) }} />
      </label>
      <label className={css.hbFilter}>
        <span>{t('hb.fieldDefinition')}</span>
        <Input value={definition} placeholder={t('hb.definitionPlaceholder')} maxLength={2000} disabled={disabled} onChange={event => { setDefinition(event.target.value) }} />
      </label>
      <div className={css.hbRowActions}>
        <Button variant='primary' disabled={disabled || name.trim() === '' || (!isEdit && code.trim() === '')} onClick={submit}>{t('hb.save')}</Button>
        <Button variant='ghost' disabled={disabled} onClick={onClose}>{t('hb.cancelEdit')}</Button>
      </div>
    </div>
  )
}

// ---- 采集与规则（12 册 §5.4 R3：手动采集 + 只读配置展示）----

function RulesPage(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const settings = state.settings
  const disabled = state.loading || state.pending > 0
  const scheduleEnabled = settings?.scheduleEnabled === true
  return (
    <div className={css.hbRules}>
      <section className={css.hbPanel} aria-label={t('hb.panelCollect')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelCollect')}</h2>
        <p className={css.hbHint}>{t('hb.manualHint')}</p>
        <div className={css.hbRowActions}>
          <Button variant='primary' disabled={disabled}
            onClick={() => { hub.askConfirm(t('hb.confirmRunStart'), () => { void hub.runStart() }) }}>
            {t('hb.startIncrement')}
          </Button>
          <Button variant='ghost' disabled={state.pending > 0} onClick={() => { void hub.openRun(null) }}>{t('hb.runHistory')}</Button>
        </div>
        {state.runLive?.run?.status !== undefined && ACTIVE_RUN_STATUSES.has(state.runLive.run.status) && (
          <p className={css.hbHint} role='status'>
            <StateDot state='ongoing' /> {t('hb.runLivePrefix')}
            {t(RUN_STATUS_KEYS[state.runLive.run.status] ?? 'hb.runQueued')}
          </p>
        )}
      </section>
      <section className={css.hbPanel} aria-label={t('hb.panelSettings')}>
        <h2 className={css.hbPanelTitle}>{t('hb.panelSettings')}</h2>
        <p className={css.hbHint}>{t('hb.settingsReadonlyHint')}</p>
        {settings !== null
          ? (
              <div className={css.hbSettingsReadonly}>
                <div className={css.hbSettingRow}>
                  <span className={css.hbSettingLabel}>{t('hb.setScheduleEnabled')}</span>
                  <span className={css.hbSettingValue}>
                    <StateDot state={scheduleEnabled ? 'done' : 'idle'} />
                    {scheduleEnabled ? t('hb.scheduleOn') : t('hb.scheduleOff')}
                  </span>
                </div>
                {settings.fullScheduleCron !== null && settings.fullScheduleCron !== undefined && settings.fullScheduleCron !== '' && (
                  <div className={css.hbSettingRow}>
                    <span className={css.hbSettingLabel}>{t('hb.kpiNextRun')}</span>
                    <span className={css.hbSettingValue}>{scheduleEnabled ? hotboardScheduleText(settings.fullScheduleCron, t) : '—'}</span>
                  </div>
                )}
                {SETTING_THRESHOLD_FIELDS.map(([field, key]) => (
                  <div className={css.hbSettingRow} key={field}>
                    <span className={css.hbSettingLabel}>{t(key)}</span>
                    <span className={css.hbSettingValue}>{settings[field] === null || settings[field] === undefined ? '—' : hbText(settings[field])}</span>
                  </div>
                ))}
              </div>
            )
          : <p className={css.hbHint}>{t('state.loading')}</p>}
        {settings?.ruleVersion !== null && settings?.ruleVersion !== undefined && settings.ruleVersion !== '' && (
          <p className={css.hbHint}>{t('hb.ruleVersion')} · {hbText(settings.ruleVersion)}</p>
        )}
      </section>
    </div>
  )
}

// ---- 抽屉与灯箱 ----

/** 正文话题高亮（#xx# 封闭式与行内 #词 开放式；React 元素切分，绝无 innerHTML）。 */
function renderNoteBody(body: string): ReactNode[] {
  const closed = /#[^#\n]{1,64}#/gu
  const open = /(^|\s)(#[^\s#]{1,64})/gu
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let index = 0
  closed.lastIndex = 0
  while ((match = closed.exec(body)) !== null) {
    if (match.index > last) nodes.push(...renderPlain(body.slice(last, match.index), nodes.length))
    nodes.push(<span key={`c-${index++}`} className={css.hbTopic}>{match[0]}</span>)
    last = match.index + match[0].length
  }
  if (last < body.length) nodes.push(...renderPlain(body.slice(last), nodes.length))
  function renderPlain(text: string, offset: number): ReactNode[] {
    const plain: ReactNode[] = []
    let plainLast = 0
    let plainMatch: RegExpExecArray | null
    open.lastIndex = 0
    while ((plainMatch = open.exec(text)) !== null) {
      const lead = plainMatch[1] ?? ''
      const topic = plainMatch[2] ?? ''
      const start = plainMatch.index + lead.length
      if (start > plainLast) plain.push(<span key={`p-${offset}-${plain.length}`}>{text.slice(plainLast, start)}</span>)
      plain.push(<span key={`o-${offset}-${plain.length}`} className={css.hbTopic}>{topic}</span>)
      plainLast = start + topic.length
    }
    if (plainLast < text.length) plain.push(<span key={`p-${offset}-${plain.length}`}>{text.slice(plainLast)}</span>)
    return plain
  }
  return nodes
}

function DrawerSection(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className={css.hbSection}>
      <h3 className={css.hbSectionTitle}>{props.title}</h3>
      {props.children}
    </section>
  )
}

function MetricCell(props: { label: string; value: string }): ReactNode {
  return (
    <div className={css.hbMetric}>
      <span className={css.hbMetricLabel}>{props.label}</span>
      <span className={css.hbMetricValue}>{props.value}</span>
    </div>
  )
}

/** 图片灯箱：←/→ 键盘切换、点空白/Esc 关闭（关闭走遮罩，导航两侧不放关闭键）。 */
function ImageLightbox(props: { urls: string[]; initialIndex: number; onClose: () => void; t: Translate }): ReactNode {
  const [index, setIndex] = useState(props.initialIndex)
  useState(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
      else if (event.key === 'ArrowLeft') setIndex(prev => (prev - 1 + props.urls.length) % props.urls.length)
      else if (event.key === 'ArrowRight') setIndex(prev => (prev + 1) % props.urls.length)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  })
  if (props.urls.length === 0) return null
  const step = (delta: number): void => { setIndex(prev => (prev + delta + props.urls.length) % props.urls.length) }
  return (
    <div className={css.hbLightbox} role='dialog' aria-modal='true' aria-label={props.t('hb.lightbox')}
      onClick={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <span className={css.hbLightboxCounter}>{index + 1} / {props.urls.length}</span>
      {props.urls.length > 1 && (
        <button type='button' className={`${css.hbLightboxNav} ${css.hbLightboxPrev}`} aria-label={props.t('hb.prevImage')}
          onClick={event => { event.stopPropagation(); step(-1) }}>‹</button>
      )}
      <img className={css.hbLightboxImg} src={props.urls[index]} alt='' />
      {props.urls.length > 1 && (
        <button type='button' className={`${css.hbLightboxNav} ${css.hbLightboxNext}`} aria-label={props.t('hb.nextImage')}
          onClick={event => { event.stopPropagation(); step(1) }}>›</button>
      )}
      <span className={css.hbLightboxHint}>{props.t('hb.lightboxCloseHint')}</span>
    </div>
  )
}

function NoteDrawer(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const drawer = state.noteDrawer
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  if (drawer === null) return null
  const data = drawer.data
  const markBroken = (url: string): void => {
    setBroken(prev => new Set(prev).add(url))
  }
  const note = data?.note ?? null
  const metrics = data?.metrics ?? null
  const styleOptions = state.overview?.data.filterOptions?.styles ?? []
  const colorOptions = state.overview?.data.filterOptions?.colors ?? []
  const currentStyle = (data?.currentTags ?? []).find(tag => tag.tagType === 'style')
  const currentColor = (data?.currentTags ?? []).find(tag => tag.tagType === 'color')
  const imageUrls = [data?.images?.coverUrl, ...(data?.images?.imageUrls ?? [])].filter((url): url is string => url !== null && url !== undefined && url !== '')
  const similarNotes = data?.similarNotes ?? []
  const wordStats = data?.wordStats ?? []
  const tagSelect = (tagType: 'style' | 'color'): ReactNode => {
    const current = tagType === 'style' ? currentStyle : currentColor
    const options = tagType === 'style' ? styleOptions : colorOptions
    return (
      <SelectFilter
        label={tagType === 'style' ? t('hb.style') : t('hb.color')}
        value={current?.labelCode ?? ''}
        disabled={state.pending > 0}
        onChange={code => {
          if (code === '') return
          hub.askConfirm(tf(t, 'hb.confirmTagUpdate', { tag: options.find(item => item.code === code)?.name ?? code }), () => {
            void hub.noteTagUpdate(note?.noteId ?? drawer.noteId, tagType, code)
          })
        }}
        options={[{ value: '', label: current?.labelName ?? t('hb.untagged') }, ...options.map(item => ({ value: item.code, label: item.name }))]}
      />
    )
  }
  return (
    <div className={css.hbDrawerOverlay} role='dialog' aria-modal='true' aria-label={t('hb.noteDetail')}
      onClick={event => { if (event.target === event.currentTarget) hub.closeNote() }}>
      <aside className={css.hbDrawer}>
        <header className={css.hbDrawerHead}>
          <h2>{t('hb.noteDetail')}</h2>
          <Button variant='ghost' onClick={() => { hub.closeNote() }}>{t('hb.closeDrawer')}</Button>
        </header>
        {drawer.loading && <p className={css.hbEmpty}>{t('state.loading')}</p>}
        {drawer.error !== '' && <p className={css.hbError}>{t('hb.loadFailed')}</p>}
        {data !== null && (
          <div className={css.hbDrawerBody}>
            <div className={css.hbNoteHead}>
              <h3>{hbText(note?.title)}</h3>
              <p className={css.hbHint}>{hbText(note?.authorName)} · {note?.noteType === 'video' ? t('hb.typeVideo') : t('hb.typeImage')} · {hbTime(note?.publishTime)}</p>
              {note?.link !== null && note?.link !== undefined && note.link !== '' && (
                <a className={css.hbExternal} href={note.link} target='_blank' rel='noreferrer noopener'>{t('hb.openNote')} ↗</a>
              )}
            </div>
            <DrawerSection title={t('hb.noteImages')}>
              {imageUrls.length > 0
                ? (
                    <div className={css.hbImages}>
                      {imageUrls.map((url, index) => broken.has(url)
                        ? <div key={url} className={`${css.hbImage} ${css.hbImageBroken}`}>{t('hb.imageBroken')}</div>
                        : <img key={url} className={css.hbImage} src={url} alt='' loading='lazy' onClick={() => { setLightboxIndex(index) }} onError={() => { markBroken(url) }} />)}
                    </div>
                  )
                : <p className={css.hbHint}>{t('hb.noImages')}</p>}
            </DrawerSection>
            <DrawerSection title={t('hb.metrics')}>
              <div className={css.hbMetricGrid}>
                <MetricCell label={t('hb.statLikes')} value={hbCount(metrics?.likeCount)} />
                <MetricCell label={t('hb.statCollects')} value={hbCount(metrics?.collectCount)} />
                <MetricCell label={t('hb.statComments')} value={hbCount(metrics?.commentCount)} />
                <MetricCell label={t('hb.statShares')} value={hbCount(metrics?.shareCount)} />
                <MetricCell label={t('hb.colInteraction')} value={hbCount(metrics?.interactionTotal)} />
                <MetricCell label={t('hb.score7d')} value={hbScore(metrics?.score7d)} />
                <MetricCell label={t('hb.score30d')} value={hbScore(metrics?.score30d)} />
                <MetricCell label={t('hb.score90d')} value={hbScore(metrics?.score90d)} />
              </div>
            </DrawerSection>
            <DrawerSection title={t('hb.currentTags')}>
              <div className={css.hbTagEdit}>{tagSelect('style')}{tagSelect('color')}</div>
            </DrawerSection>
            {note?.body !== null && note?.body !== undefined && note.body !== '' && (
              <DrawerSection title={t('hb.noteBody')}>
                <div className={css.hbNoteBody}>
                  {renderNoteBody(note.body).map((node, index) => <p key={index} className={css.hbBodyLine}>{node}</p>)}
                </div>
              </DrawerSection>
            )}
            <DrawerSection title={t('hb.similarNotes')}>
              {similarNotes.length > 0
                ? (
                    <ul className={css.hbSimilar}>
                      {similarNotes.map(item => (
                        <li key={item.noteId}>
                          {item.coverUrl !== null && item.coverUrl !== undefined && <img className={css.hbSimilarThumb} src={item.coverUrl} alt='' loading='lazy' />}
                          <span className={css.hbSimilarTitle}>{hbText(item.title)}</span>
                        </li>
                      ))}
                    </ul>
                  )
                : <p className={css.hbHint}>—</p>}
            </DrawerSection>
            <DrawerSection title={t('hb.wordStats')}>
              {wordStats.length > 0
                ? <div className={css.hbWords}>{wordStats.map(item => <span key={`${item.wordType ?? ''}:${item.word}`} className={css.hbTagChip}>{item.word} ×{hbCount(item.frequency)}</span>)}</div>
                : <p className={css.hbHint}>—</p>}
            </DrawerSection>
          </div>
        )}
      </aside>
      {lightboxIndex !== null && imageUrls.length > 0 && (
        <ImageLightbox urls={imageUrls} initialIndex={Math.min(lightboxIndex, imageUrls.length - 1)} onClose={() => { setLightboxIndex(null) }} t={t} />
      )}
    </div>
  )
}

function RunDrawer(props: { state: HotboardSnapshot; hub: HotboardMachine; t: Translate }): ReactNode {
  const { state, hub, t } = props
  const drawer = state.runDrawer
  if (drawer === null) return null
  const run = drawer.data?.run ?? null
  const rows = drawer.data?.keywordRuns ?? []
  const failed = drawer.data?.failedKeywords ?? []
  const runStatus = run?.status
  return (
    <div className={css.hbDrawerOverlay} role='dialog' aria-modal='true' aria-label={t('hb.runDetail')}
      onClick={event => { if (event.target === event.currentTarget) hub.closeRun() }}>
      <aside className={css.hbDrawer}>
        <header className={css.hbDrawerHead}>
          <h2>{t('hb.runDetail')}</h2>
          <Button variant='ghost' onClick={() => { hub.closeRun() }}>{t('hb.closeDrawer')}</Button>
        </header>
        {drawer.loading && <p className={css.hbEmpty}>{t('state.loading')}</p>}
        {drawer.error !== '' && <p className={css.hbError}>{t('hb.loadFailed')}</p>}
        {drawer.data !== null && (
          <div className={css.hbDrawerBody}>
            <div className={css.hbRunSummary}>
              <div className={css.hbRunBadges}>
                <span className={css.hbBadge}>
                  <StateDot state={runStatus !== undefined && ACTIVE_RUN_STATUSES.has(runStatus) ? 'ongoing' : runStatus === 'completed' ? 'done' : runStatus === 'partial' ? 'warning' : runStatus === undefined ? ('idle' as StateDotState) : 'error'} />
                  {hbEnumText(t, RUN_STATUS_KEYS, runStatus)}
                </span>
                <span className={css.hbBadge}>{hbEnumText(t, RUN_TYPE_KEYS, run?.runType)}</span>
              </div>
              <div className={`${css.hbMetricGrid} ${css.hbMetricGrid3}`}>
                <MetricCell label={t('hb.runStarted')} value={hbTime(run?.startedAt)} />
                <MetricCell label={t('hb.runFinished')} value={hbTime(run?.finishedAt)} />
                <MetricCell label={t('hb.remainingBudget')} value={hbCount(drawer.data.remainingSearchBudget)} />
              </div>
              {run?.errorCode !== null && run?.errorCode !== undefined && run.errorCode !== '' && (
                <p className={css.hbError}>{t('hb.runError')} · {runErrorText(t, run.errorCode)}</p>
              )}
            </div>
            <DrawerSection title={t('hb.runCounters')}>
              <div className={css.hbMetricGrid}>
                <MetricCell label={t('hb.runKeywords')} value={hbCount(run?.activeKeywordCount)} />
                <MetricCell label={t('hb.runSuccess')} value={hbCount(run?.successKeywordCount)} />
                <MetricCell label={t('hb.runFailedKeywords')} value={hbCount(run?.failedKeywordCount)} />
                <MetricCell label={t('hb.runNoResult')} value={hbCount(run?.noResultKeywordCount)} />
                <MetricCell label={t('hb.runCollected')} value={hbCount(run?.collectedNoteCount)} />
                <MetricCell label={t('hb.runQualified')} value={hbCount(run?.qualifiedNoteCount)} />
                <MetricCell label={t('hb.runDuplicates')} value={hbCount(run?.duplicateNoteCount)} />
                <MetricCell label={t('hb.kpiLowQuality')} value={hbCount(run?.lowQualityNoteCount)} />
                <MetricCell label={t('hb.runAiTagged')} value={hbCount(run?.aiTaggedCount)} />
                <MetricCell label={t('hb.runAiPending')} value={hbCount(run?.aiPendingCount)} />
              </div>
            </DrawerSection>
            {failed.length > 0 && (
              <DrawerSection title={t('hb.panelFailedKeywords')}>
                <ul className={css.hbSimilar}>
                  {failed.map(item => <li key={item.keyword}>{item.keyword} · {runErrorText(t, item.errorCode)}</li>)}
                </ul>
              </DrawerSection>
            )}
            <DrawerSection title={t('hb.panelKeywordRuns')}>
              <div className={css.hbTableWrap}>
                <table className={`${css.hbTable} ${css.hbTableCompact}`}>
                  <thead><tr>{[t('hb.colKeyword'), t('hb.status'), t('hb.runCollected'), t('hb.runQualified'), t('hb.runError')].map(label => <th key={label}>{label}</th>)}</tr></thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.keyword}>
                        <td>{hbText(row.keyword)}</td>
                        <td>{hbEnumText(t, KEYWORD_RUN_STATUS_KEYS, row.status)}</td>
                        <td>{hbCount(row.collectedCount)}</td>
                        <td>{hbCount(row.qualifiedCount)}</td>
                        <td>{runErrorText(t, row.errorCode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </DrawerSection>
          </div>
        )}
      </aside>
    </div>
  )
}
