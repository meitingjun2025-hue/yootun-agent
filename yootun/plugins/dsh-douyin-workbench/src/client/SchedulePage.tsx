/**
 * 发布排期看板（RQ-2026-013 全量保留）：工具栏（新增行 primary / 刷新 ghost /
 * 就近提示 role=alert|status 2600ms 回落）→ 12 列表格（colgroup 宽序冻结
 * [80,160,300,220,140,300,240,160,220,170,170,90]，拍摄情况/成片链接带副标）→
 * 行内控件（date change 即存；textarea/text blur 存；checkbox/平台 change 存）
 * → 行状态机 idle/saving/queued/failed/conflict/unknown（行底色 token：saving
 * 品牌 8% / error 8%，状态色优先；no-op 失焦不发请求；saving 中继续输入进
 * dirty 成功后新键补提交；失败保留输入同键重试/放弃修改（先还原后重拉）；
 * conflict/unknown 只读）→ 已发布折叠（会话内保留）+ 未发布发布日期升序
 * （无日期最后，同日期 rowId 十进制字符串序）+ 组内奇偶斑马纹 → 底部账号栏
 * 账号 chip（单行横向滚动；切换互斥矩阵）→ 删除 RiskConfirmation（带行内容）→ beforeunload
 * 新增在途拦截。迟到响应按序号丢弃；18 码错误文案字典。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { avatarFallbackChar, domainErrorText, formatCount, safeHttpUrl, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  SCHEDULE_PLATFORMS, buildServerSnapshot, comparePublishDate, compareRowId, readScheduleRow,
  readScheduleRows, type ScheduleUiRow,
} from './schema.ts'
import { attemptId } from './AnalysisPage.tsx'
import type { AccountRow } from './WorkbenchPage.tsx'

/** 12 列宽序冻结（colgroup）。 */
const COLUMN_WIDTHS: readonly number[] = [80, 160, 300, 220, 140, 300, 240, 160, 220, 170, 170, 90]

/** 行级状态（§9.4 六态）。 */
interface RowState {
  status: 'idle' | 'saving' | 'queued' | 'failed' | 'conflict' | 'unknown'
  operation: 'save' | 'delete' | null
  expectedVersion: string
  idempotencyKey: string | null
  dirtySnapshot: Partial<ScheduleUiRow> | null
  lastSavedSnapshot: ReturnType<typeof buildServerSnapshot> | null
  lastServerError: string | null
}

/** 新行行级状态。 */
function createRowState(expectedVersion: string, saved: ReturnType<typeof buildServerSnapshot> | null = null): RowState {
  return {
    status: 'idle',
    operation: null,
    expectedVersion,
    idempotencyKey: null,
    dirtySnapshot: null,
    lastSavedSnapshot: saved,
    lastServerError: null,
  }
}

/** 行是否持有未落定修改（账号切换互斥矩阵）。 */
function rowHasPendingWork(state: RowState | undefined): boolean {
  if (state === undefined) return false
  if (state.status === 'saving' || state.status === 'queued' || state.status === 'unknown') return true
  return (state.status === 'failed' || state.status === 'conflict') && state.dirtySnapshot !== null
}

/** 表格刷新互斥（saving/queued 或 failed/conflict/unknown 带 dirty 均阻塞）。 */
function refreshBlocked(rowStates: Record<string, RowState>, deleteBusy: boolean): boolean {
  if (deleteBusy) return true
  return Object.values(rowStates).some(state => {
    if (state.status === 'saving' || state.status === 'queued') return true
    return (state.status === 'failed' || state.status === 'conflict' || state.status === 'unknown') && state.dirtySnapshot !== null
  })
}

/** 非 idle 行禁删；delete 在途整行只读。 */
function deleteAllowed(state: RowState | undefined, deleteInFlight: boolean): boolean {
  return !deleteInFlight && (state === undefined || state.status === 'idle')
}

/** 失败原因 → 行状态。 */
function rowStatusOnFailure(reason: string): RowState['status'] {
  if (reason === 'IDEMPOTENCY_OUTCOME_UNKNOWN') return 'unknown'
  if (reason === 'SCHEDULE_ROW_CONFLICT') return 'conflict'
  return 'failed'
}

/** no-op 判定：当前业务快照与最近一次服务端快照一致。 */
function savedSnapshotChanged(row: ScheduleUiRow, state: RowState): boolean {
  const saved = state.lastSavedSnapshot
  if (saved === null) return true
  return JSON.stringify(buildServerSnapshot(row)) !== JSON.stringify(saved)
}

/** 成功落库后 dirty 合并行与服务端行是否存在业务差异（补提交判定）。 */
function dirtyResubmitNeeded(serverRow: ScheduleUiRow, mergedRow: ScheduleUiRow): boolean {
  return JSON.stringify(buildServerSnapshot(mergedRow)) !== JSON.stringify(buildServerSnapshot(serverRow))
}

/** 表头 12 列（含两处副标）。 */
const HEADERS: readonly { labelKey: Parameters<Translate>[0]; subKey?: Parameters<Translate>[0] }[] = [
  { labelKey: 'schedule.col.index' },
  { labelKey: 'schedule.col.shootingDate' },
  { labelKey: 'schedule.col.videoContent' },
  { labelKey: 'schedule.col.shootingStatus', subKey: 'schedule.col.shootingStatusSub' },
  { labelKey: 'schedule.col.published' },
  { labelKey: 'schedule.col.assetLink', subKey: 'schedule.col.assetLinkSub' },
  { labelKey: 'schedule.col.note' },
  { labelKey: 'schedule.col.publishDate' },
  { labelKey: 'schedule.col.platforms' },
  { labelKey: 'schedule.col.shootingOwner' },
  { labelKey: 'schedule.col.editingOwner' },
  { labelKey: 'schedule.col.actions' },
]

export interface SchedulePageProps {
  t: Translate
  accounts: AccountRow[]
  accountsState: 'loading' | 'ready' | 'error'
}

/** 发布排期看板组件。 */
export function SchedulePage(props: SchedulePageProps): ReactNode {
  const t = props.t
  const [scheduleAccountId, setScheduleAccountId] = useState<string | null>(null)
  const [rows, setRows] = useState<ScheduleUiRow[]>([])
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})
  const [loading, setLoading] = useState(false)
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [publishedExpanded, setPublishedExpanded] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [hint, setHint] = useState<{ text: string; tone: 'ok' | 'saving' | 'error' } | null>(null)
  const [focusRowId, setFocusRowId] = useState<string | null>(null)
  const seqRef = useRef(0)
  const rowsRef = useRef<ScheduleUiRow[]>([])
  const statesRef = useRef<Record<string, RowState>>({})
  const accountIdRef = useRef<string | null>(null)
  const creatingRef = useRef(false)
  const createRetryKeyRef = useRef<string | null>(null)
  const focusRef = useRef<HTMLTextAreaElement>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const performSaveRef = useRef<(rowId: string, reuseKey?: boolean) => Promise<void>>(() => Promise.resolve())

  useEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => { statesRef.current = rowStates }, [rowStates])
  useEffect(() => { accountIdRef.current = scheduleAccountId }, [scheduleAccountId])

  // 首个有效账号默认选中（刷新后回落首个）。
  useEffect(() => {
    if (scheduleAccountId !== null) return
    const first = props.accounts.find(row => row.deleteState !== 'remote_deleted')
    if (first !== undefined) setScheduleAccountId(first.accountId)
  }, [props.accounts, scheduleAccountId])

  // beforeunload：新增行在途拦截（防误刷新丢行）。
  useEffect(() => {
    if (!creating) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => { window.removeEventListener('beforeunload', guard) }
  }, [creating])

  // 新增成功聚焦视频内容（ref 在渲染行挂载后生效）。
  useEffect(() => {
    focusRef.current?.focus()
  }, [focusRowId])

  const flashHint = useCallback((text: string, tone: 'ok' | 'saving' | 'error'): void => {
    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    setHint({ text, tone })
    hintTimerRef.current = setTimeout(() => { setHint(null) }, 2600)
  }, [])

  const loadRows = useCallback(async (accountId: string): Promise<boolean> => {
    const seq = ++seqRef.current
    setLoading(true)
    setErrorReason(null)
    try {
      const res = await hostAction('schedule.list', { accountId })
      if (seq !== seqRef.current) return false
      const next = readScheduleRows(res).sort((a, b) => compareRowId(a.rowId, b.rowId))
      setRows(next)
      const states: Record<string, RowState> = {}
      for (const row of next) states[row.rowId] = createRowState(row.rowVersion, buildServerSnapshot(row))
      setRowStates(states)
      setLoading(false)
      return true
    } catch (error) {
      if (seq !== seqRef.current) return false
      setLoading(false)
      setErrorReason(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      return false
    }
  }, [])

  useEffect(() => {
    if (scheduleAccountId === null) return
    setFocusRowId(null)
    setDeleteTarget(null)
    setRows([])
    setRowStates({})
    void loadRows(scheduleAccountId)
  }, [scheduleAccountId, loadRows])

  const editCell = useCallback((rowId: string, field: keyof ScheduleUiRow, value: unknown): void => {
    setRows(previous => previous.map(row => (row.rowId === rowId ? { ...row, [field]: value } as ScheduleUiRow : row)))
    // saving/queued 中继续输入：合并进 dirty 快照（成功后按差异补提交）。
    setRowStates(previous => {
      const state = previous[rowId]
      if (state === undefined || (state.status !== 'saving' && state.status !== 'queued')) return previous
      return { ...previous, [rowId]: { ...state, dirtySnapshot: { ...state.dirtySnapshot, [field]: value } as Partial<ScheduleUiRow> } }
    })
  }, [])

  /** 整行保存（reuseKey = 同键重试）。 */
  const performSave = useCallback(async (rowId: string, reuseKey = false): Promise<void> => {
    const row = rowsRef.current.find(item => item.rowId === rowId)
    const state = statesRef.current[rowId]
    if (row === undefined || state === undefined) return
    if (!reuseKey && state.status === 'idle' && !savedSnapshotChanged(row, state)) return
    const seq = seqRef.current
    const key = reuseKey && state.idempotencyKey !== null ? state.idempotencyKey : `douyin:publish_schedule_update:${rowId}:${attemptId()}`
    const dirty = state.dirtySnapshot
    setRowStates(previous => ({
      ...previous,
      [rowId]: {
        ...createRowState(state.expectedVersion),
        status: 'saving',
        operation: 'save',
        idempotencyKey: key,
        lastSavedSnapshot: state.lastSavedSnapshot,
        dirtySnapshot: previous[rowId]?.dirtySnapshot ?? null,
        lastServerError: null,
      },
    }))
    flashHint(t('schedule.hint.saving'), 'saving')
    const snapshot = buildServerSnapshot(row)
    let res: Record<string, unknown>
    try {
      res = await hostAction('schedule.rowUpdate', {
        accountId: row.accountId,
        rowId: row.rowId,
        expectedVersion: state.expectedVersion,
        confirm: true,
        idempotencyKey: key,
        ...snapshot,
      })
    } catch (error) {
      if (seq !== seqRef.current) return
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      const reason = timedOut ? 'IDEMPOTENCY_OUTCOME_UNKNOWN' : error instanceof Error ? error.message : 'douyin_operation_request_failed'
      setRowStates(previous => ({
        ...previous,
        [rowId]: {
          ...(previous[rowId] ?? createRowState(state.expectedVersion)),
          status: rowStatusOnFailure(reason),
          operation: 'save',
          idempotencyKey: key,
          lastServerError: reason,
        },
      }))
      flashHint(domainErrorText('schedule', reason, t), 'error')
      return
    }
    // 迟到响应丢弃：保存期间已切换账号/重拉列表（seq 推进）时行集已被替换。
    if (seq !== seqRef.current) return
    const serverRow = readScheduleRow(res)
    if (serverRow === null || serverRow.rowId !== rowId) {
      setRowStates(previous => ({
        ...previous,
        [rowId]: { ...(previous[rowId] ?? createRowState(state.expectedVersion)), status: 'failed', operation: 'save', idempotencyKey: key, lastServerError: 'douyin_operation_request_failed' },
      }))
      flashHint(domainErrorText('schedule', 'douyin_operation_request_failed', t), 'error')
      return
    }
    if (dirty !== null && dirty !== undefined) {
      const merged = { ...serverRow, ...dirty } as ScheduleUiRow
      setRows(previous => previous.map(item => (item.rowId === rowId ? merged : item)))
      setRowStates(previous => ({ ...previous, [rowId]: createRowState(serverRow.rowVersion, buildServerSnapshot(serverRow)) }))
      if (dirtyResubmitNeeded(serverRow, merged)) {
        await performSaveRef.current(rowId)
      } else {
        flashHint(t('schedule.hint.saved'), 'ok')
      }
      return
    }
    setRows(previous => previous.map(item => (item.rowId === rowId ? serverRow : item)))
    setRowStates(previous => ({ ...previous, [rowId]: createRowState(serverRow.rowVersion, buildServerSnapshot(serverRow)) }))
    flashHint(t('schedule.hint.saved'), 'ok')
  }, [flashHint, t])
  performSaveRef.current = performSave

  const handleBlur = useCallback((rowId: string, field: keyof ScheduleUiRow, value: unknown): void => {
    editCell(rowId, field, value)
    const state = statesRef.current[rowId]
    if (state === undefined || state.status === 'idle') void performSaveRef.current(rowId)
  }, [editCell])

  const handleImmediate = useCallback((rowId: string, field: keyof ScheduleUiRow, value: unknown): void => {
    editCell(rowId, field, value)
    const state = statesRef.current[rowId]
    if (state === undefined || state.status === 'idle') void performSaveRef.current(rowId)
  }, [editCell])

  const handlePlatformToggle = useCallback((rowId: string, platform: string, checked: boolean): void => {
    const row = rowsRef.current.find(item => item.rowId === rowId)
    if (row === undefined) return
    const next = new Set(checked
      ? [...row.publishPlatforms, platform]
      : row.publishPlatforms.filter(value => value !== platform))
    handleImmediate(rowId, 'publishPlatforms', SCHEDULE_PLATFORMS.filter(value => next.has(value)))
  }, [handleImmediate])

  /** 新增行（服务端成功才插入；迟到跨账号响应丢弃）。 */
  const createRow = useCallback((): void => {
    if (creatingRef.current) return
    const accountId = accountIdRef.current
    if (accountId === null) return
    const seq = seqRef.current
    creatingRef.current = true
    setCreating(true)
    const key = createRetryKeyRef.current ?? `douyin:publish_schedule_create:${attemptId()}`
    createRetryKeyRef.current = null
    void (async () => {
      let res: Record<string, unknown>
      try {
        res = await hostAction('schedule.rowCreate', { accountId, confirm: true, idempotencyKey: key })
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') createRetryKeyRef.current = key
        flashHint(domainErrorText('schedule', 'douyin_operation_request_failed', t), 'error')
        creatingRef.current = false
        setCreating(false)
        return
      }
      creatingRef.current = false
      setCreating(false)
      if (seq !== seqRef.current) return
      const row = readScheduleRow(res)
      if (row === null || row.accountId !== accountId) {
        flashHint(domainErrorText('schedule', 'douyin_operation_request_failed', t), 'error')
        return
      }
      setRows(previous => [...previous, row])
      setRowStates(previous => ({ ...previous, [row.rowId]: createRowState(row.rowVersion, buildServerSnapshot(row)) }))
      setFocusRowId(row.rowId)
      flashHint(t('schedule.hint.saved'), 'ok')
    })()
  }, [flashHint, t])

  /** 删除（两步确认后；同键重试）。 */
  const performDelete = useCallback(async (rowId: string, reuseKey: string | null = null): Promise<void> => {
    const row = rowsRef.current.find(item => item.rowId === rowId)
    const state = statesRef.current[rowId]
    if (row === undefined || state === undefined) return
    const key = reuseKey ?? `douyin:publish_schedule_delete:${rowId}:${attemptId()}`
    setDeleteBusy(true)
    setRowStates(previous => ({
      ...previous,
      [rowId]: { ...createRowState(state.expectedVersion), status: 'saving', operation: 'delete', idempotencyKey: key },
    }))
    try {
      await hostAction('schedule.rowDelete', {
        accountId: row.accountId,
        rowId: row.rowId,
        expectedVersion: state.expectedVersion,
        confirm: true,
        idempotencyKey: key,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      setDeleteBusy(false)
      setDeleteTarget(null)
      const reason = timedOut ? 'IDEMPOTENCY_OUTCOME_UNKNOWN' : error instanceof Error ? error.message : 'douyin_operation_request_failed'
      if (reason === 'IDEMPOTENCY_OUTCOME_UNKNOWN' || reason === 'SCHEDULE_ROW_CONFLICT') {
        setRowStates(previous => ({
          ...previous,
          [rowId]: { ...(previous[rowId] ?? createRowState(state.expectedVersion)), status: rowStatusOnFailure(reason), operation: 'delete', idempotencyKey: key },
        }))
      } else {
        setRowStates(previous => ({ ...previous, [rowId]: createRowState(state.expectedVersion, state.lastSavedSnapshot) }))
      }
      flashHint(domainErrorText('schedule', reason, t), 'error')
      return
    }
    setDeleteBusy(false)
    setDeleteTarget(null)
    setRows(previous => previous.filter(item => item.rowId !== rowId))
    setRowStates(previous => {
      const next = { ...previous }
      delete next[rowId]
      return next
    })
    flashHint(t('schedule.hint.saved'), 'ok')
  }, [flashHint, t])

  /** 同键重试（save/delete 分流）。 */
  const retryRow = useCallback((rowId: string): void => {
    const state = statesRef.current[rowId]
    if (state === undefined || state.idempotencyKey === null) return
    if (state.operation === 'delete') void performDelete(rowId, state.idempotencyKey)
    else void performSaveRef.current(rowId, true)
  }, [performDelete])

  /** 放弃修改：先用最近服务端快照还原，再重拉列表。 */
  const discardRow = useCallback((rowId: string): void => {
    const state = statesRef.current[rowId]
    const row = rowsRef.current.find(item => item.rowId === rowId)
    if (state === undefined || row === undefined) return
    if (state.lastSavedSnapshot !== null) {
      const saved = state.lastSavedSnapshot
      setRows(previous => previous.map(item => (item.rowId === rowId ? {
        ...item,
        shootingDate: saved.shootingDate ?? '',
        videoContent: saved.videoContent ?? '',
        shootingStatus: saved.shootingStatus,
        published: saved.published,
        assetLink: saved.assetLink ?? '',
        note: saved.note ?? '',
        publishDate: saved.publishDate ?? '',
        publishPlatforms: saved.publishPlatforms,
        shootingOwner: saved.shootingOwner ?? '',
        editingOwner: saved.editingOwner ?? '',
      } : item)))
    }
    setRowStates(previous => ({ ...previous, [rowId]: createRowState(state.expectedVersion, state.lastSavedSnapshot) }))
    if (accountIdRef.current !== null) void loadRows(accountIdRef.current)
  }, [loadRows])

  const canSwitch = !Object.values(rowStates).some(rowHasPendingWork) && !deleteBusy
  const boardRefreshBlocked = refreshBlocked(rowStates, deleteBusy)

  const switchAccount = (accountId: string): void => {
    if (accountId === scheduleAccountId) return
    if (!canSwitch) {
      flashHint(t('schedule.switchBlocked'), 'error')
      return
    }
    setScheduleAccountId(accountId)
  }

  // 渲染层分组：已发布组（仅 idle 参与；折叠态会话内保留）+ 未发布组（发布
  // 日期升序；组内奇偶斑马纹；状态色优先于斑马纹）。
  const publishedGroup: ScheduleUiRow[] = []
  const unpublishedGroup: ScheduleUiRow[] = []
  for (const row of rows) {
    const state = rowStates[row.rowId]
    if (row.published && (state === undefined || state.status === 'idle')) publishedGroup.push(row)
    else unpublishedGroup.push(row)
  }
  const sortedUnpublished = [...unpublishedGroup].sort(comparePublishDate)
  const deleteTargetRow = deleteTarget !== null ? rows.find(row => row.rowId === deleteTarget) : undefined
  const deleteTargetContent = (deleteTargetRow?.videoContent ?? '').trim() || t('overview.col.video')
  const hasAccounts = props.accounts.length > 0

  return (
    <div className={css.schedulePage}>
      <div className={css.workToolbarRow}>
        <Button variant='primary' size='sm' disabled={creating || !hasAccounts} aria-busy={creating || undefined} onClick={createRow}>
          {creating ? t('schedule.adding') : t('schedule.add')}
        </Button>
        <Button
          variant='ghost'
          size='sm'
          disabled={loading || creating || boardRefreshBlocked}
          aria-busy={loading || undefined}
          onClick={() => { if (scheduleAccountId !== null) void loadRows(scheduleAccountId) }}
        >
          {loading ? t('schedule.refreshing') : t('schedule.refresh')}
        </Button>
        {hint !== null && (
          <span className={css.scheduleHint} role={hint.tone === 'error' ? 'alert' : 'status'} data-tone={hint.tone}>{hint.text}</span>
        )}
      </div>

      {!hasAccounts && props.accountsState !== 'loading' && (
        <p className={css.inlineHint} role='status'>{t('schedule.accountsEmpty')}</p>
      )}
      {hasAccounts && (
        <DataState state={loading && rows.length === 0 ? 'loading' : errorReason !== null && rows.length === 0 ? 'error' : 'ready'} shape='rows' onRetry={() => { if (scheduleAccountId !== null) void loadRows(scheduleAccountId) }}>
          <div className={css.scheduleBoard}>
            {errorReason !== null && rows.length > 0 && (
              <p className={css.formError} role='alert'>{domainErrorText('schedule', errorReason, t)}</p>
            )}
            <div className={css.tableWrap} role='region' aria-label={t('tab.schedule')} tabIndex={0}>
            <table className={css.scheduleTable} aria-label={t('tab.schedule')}>
              <colgroup>
                {COLUMN_WIDTHS.map((_, index) => <col key={index} span={1} className={css[`scheduleCol${index + 1}`]} />)}
              </colgroup>
              <thead>
                <tr>
                  {HEADERS.map(header => (
                    <th key={header.labelKey} scope='col'>
                      <span>{t(header.labelKey)}</span>
                      {header.subKey !== undefined && <small className={css.headerSub}>{t(header.subKey)}</small>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr className={css.scheduleEmptyRow}><td colSpan={12}>{t('schedule.empty')}</td></tr>
                )}
                {publishedGroup.length > 0 && (
                  <tr
                    className={css.scheduleToggleRow}
                    role='button'
                    tabIndex={0}
                    aria-expanded={publishedExpanded || undefined}
                    aria-label={publishedExpanded ? t('schedule.fold.collapse') : t('schedule.fold.expand', { count: publishedGroup.length })}
                    onClick={() => { setPublishedExpanded(value => !value) }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setPublishedExpanded(value => !value)
                      }
                    }}
                  >
                    <td colSpan={12}>
                      {publishedExpanded ? t('schedule.fold.collapse') : t('schedule.fold.expand', { count: publishedGroup.length })}
                    </td>
                  </tr>
                )}
                {publishedExpanded && [...publishedGroup].sort(comparePublishDate).map(row => (
                  <ScheduleRowView
                    key={row.rowId}
                    row={row}
                    state={rowStates[row.rowId]}
                    deleteInFlight={deleteBusy}
                    focusRowId={focusRowId}
                    focusRef={focusRef}
                    publishedRow
                    striped={false}
                    t={t}
                    onEditCell={editCell}
                    onBlurCell={handleBlur}
                    onImmediate={handleImmediate}
                    onPlatformToggle={handlePlatformToggle}
                    onDelete={rowId => { setDeleteTarget(rowId) }}
                    onRetry={retryRow}
                    onDiscard={discardRow}
                    onRefresh={() => { if (scheduleAccountId !== null) void loadRows(scheduleAccountId) }}
                  />
                ))}
                {sortedUnpublished.map((row, index) => (
                  <ScheduleRowView
                    key={row.rowId}
                    row={row}
                    state={rowStates[row.rowId]}
                    deleteInFlight={deleteBusy}
                    focusRowId={focusRowId}
                    focusRef={focusRef}
                    publishedRow={false}
                    striped={index % 2 === 1}
                    t={t}
                    onEditCell={editCell}
                    onBlurCell={handleBlur}
                    onImmediate={handleImmediate}
                    onPlatformToggle={handlePlatformToggle}
                    onDelete={rowId => { setDeleteTarget(rowId) }}
                    onRetry={retryRow}
                    onDiscard={discardRow}
                    onRefresh={() => { if (scheduleAccountId !== null) void loadRows(scheduleAccountId) }}
                  />
                ))}
                {sortedUnpublished.length === 0 && publishedGroup.length > 0 && !publishedExpanded && (
                  <tr className={css.scheduleEmptyRow}><td colSpan={12}>{t('schedule.allPublished')}</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>

          <div className={css.scheduleAccountBar} aria-label={t('schedule.accounts')}>
            <span className={css.scheduleAccountLabel}>{t('schedule.accounts')}</span>
            {hasAccounts
              ? props.accounts.map(account => {
                  const avatar = safeHttpUrl(account.avatar)
                  return (
                    <button
                      key={account.accountId}
                      type='button'
                      className={css.scheduleAccountChip}
                      aria-pressed={account.accountId === scheduleAccountId}
                      disabled={!canSwitch && account.accountId !== scheduleAccountId}
                      onClick={() => { switchAccount(account.accountId) }}
                    >
                      {avatar !== null
                        ? <img className={css.accountChipAvatar} src={avatar} alt='' loading='lazy' referrerPolicy='no-referrer' />
                        : <span className={css.accountChipFallback} aria-hidden='true'>{avatarFallbackChar(account.nickname ?? account.accountId)}</span>}
                      <span className={css.accountChipText}>
                        <span className={css.accountChipName}>{account.nickname ?? account.accountId}</span>
                        <span className={css.accountChipMeta}>
                          {account.fanCount !== null ? t('schedule.account.fans', { count: formatCount(account.fanCount) }) : t('schedule.account.valid')}
                        </span>
                      </span>
                    </button>
                  )
                })
              : (
                <span className={css.accountChipMeta}>
                  {props.accountsState === 'loading' ? t('schedule.accountsLoading') : t('schedule.accountsEmpty')}
                </span>
                )}
          </div>
        </DataState>
      )}

      {deleteTarget !== null && (
        <Modal
          open
          onClose={() => { if (!deleteBusy) setDeleteTarget(null) }}
          title={t('schedule.deleteTitle')}
          closeLabel={t('dialog.close')}
          description={t('schedule.deleteContent', { content: deleteTargetContent })}
          footer={(
            <>
              <Button variant='ghost' size='sm' disabled={deleteBusy} onClick={() => { setDeleteTarget(null) }}>{t('schedule.cancel')}</Button>
              <Button
                variant='primary'
                size='sm'
                className={css.dangerButton}
                disabled={deleteBusy}
                aria-busy={deleteBusy || undefined}
                onClick={() => { void performDelete(deleteTarget) }}
              >
                {deleteBusy ? t('schedule.deleteBusy') : t('schedule.deleteConfirm')}
              </Button>
            </>
          )}
        >
          <p className={css.inlineHint}>{t('schedule.deleteBody')}</p>
        </Modal>
      )}
    </div>
  )
}

/** 单行渲染（12 列；受控 value 必配 onChange；conflict/unknown/delete 在途只读）。 */
function ScheduleRowView(props: {
  row: ScheduleUiRow
  state: RowState | undefined
  deleteInFlight: boolean
  focusRowId: string | null
  focusRef: React.RefObject<HTMLTextAreaElement>
  publishedRow: boolean
  striped: boolean
  t: Translate
  onEditCell: (rowId: string, field: keyof ScheduleUiRow, value: unknown) => void
  onBlurCell: (rowId: string, field: keyof ScheduleUiRow, value: unknown) => void
  onImmediate: (rowId: string, field: keyof ScheduleUiRow, value: unknown) => void
  onPlatformToggle: (rowId: string, platform: string, checked: boolean) => void
  onDelete: (rowId: string) => void
  onRetry: (rowId: string) => void
  onDiscard: (rowId: string) => void
  onRefresh: () => void
}): ReactNode {
  const t = props.t
  const row = props.row
  const state = props.state
  const status = state?.status ?? 'idle'
  const locked = status === 'conflict' || status === 'unknown' || (status === 'saving' && state?.operation === 'delete')
  const rowClass = status === 'saving' || status === 'queued'
    ? css.scheduleRowSaving
    : status === 'failed' || status === 'conflict' || status === 'unknown'
      ? css.scheduleRowError
      : props.publishedRow
        ? css.scheduleRowPublished
        : props.striped
          ? css.scheduleRowStriped
          : undefined
  const inputProps = (field: keyof ScheduleUiRow) => ({
    disabled: locked,
    onChange: (event: { target: { value: string } }) => { props.onEditCell(row.rowId, field, event.target.value) },
    onBlur: (event: { target: { value: string } }) => { props.onBlurCell(row.rowId, field, event.target.value) },
  })
  return (
    <tr className={rowClass} data-row-id={row.rowId}>
      <td className={css.cellNum} title={t('schedule.indexTitle')}>{row.rowId}</td>
      <td>
        <Input
          type='date'
          value={row.shootingDate}
          disabled={locked}
          aria-label={t('schedule.col.shootingDate')}
          onChange={event => { props.onImmediate(row.rowId, 'shootingDate', event.target.value) }}
        />
      </td>
      <td>
        <textarea
          className={css.cellTextarea}
          rows={1}
          value={row.videoContent}
          aria-label={t('schedule.col.videoContent')}
          disabled={locked}
          maxLength={2000}
          {...(props.focusRowId === row.rowId ? { ref: props.focusRef } : {})}
          onChange={event => { props.onEditCell(row.rowId, 'videoContent', event.target.value) }}
          onBlur={event => { props.onBlurCell(row.rowId, 'videoContent', event.target.value) }}
        />
      </td>
      <td className={css.cellCheck}>
        <Checkbox
          checked={row.shootingStatus}
          disabled={locked}
          label={t('schedule.col.shootingStatus')}
          onChange={checked => { props.onImmediate(row.rowId, 'shootingStatus', checked) }}
        />
      </td>
      <td className={css.cellCheck}>
        <Checkbox
          checked={row.published}
          disabled={locked}
          label={t('schedule.col.published')}
          onChange={checked => { props.onImmediate(row.rowId, 'published', checked) }}
        />
      </td>
      <td>
        <Input
          type='url'
          value={row.assetLink}
          placeholder={t('schedule.col.assetLink')}
          maxLength={2048}
          aria-label={t('schedule.col.assetLink')}
          {...inputProps('assetLink')}
        />
      </td>
      <td>
        <textarea
          className={css.cellTextarea}
          rows={1}
          value={row.note}
          aria-label={t('schedule.col.note')}
          disabled={locked}
          maxLength={2000}
          onChange={event => { props.onEditCell(row.rowId, 'note', event.target.value) }}
          onBlur={event => { props.onBlurCell(row.rowId, 'note', event.target.value) }}
        />
      </td>
      <td>
        <Input
          type='date'
          value={row.publishDate}
          disabled={locked}
          aria-label={t('schedule.col.publishDate')}
          onChange={event => { props.onImmediate(row.rowId, 'publishDate', event.target.value) }}
        />
      </td>
      <td>
        <div className={css.platformGroup}>
          {SCHEDULE_PLATFORMS.map(platform => (
            <Checkbox
              key={platform}
              checked={row.publishPlatforms.includes(platform)}
              disabled={locked}
              label={t(`schedule.platform.${platform}` as 'schedule.platform.douyin')}
              onChange={checked => { props.onPlatformToggle(row.rowId, platform, checked) }}
            />
          ))}
        </div>
      </td>
      <td>
        <Input type='text' value={row.shootingOwner} maxLength={128} aria-label={t('schedule.col.shootingOwner')} {...inputProps('shootingOwner')} />
      </td>
      <td>
        <Input type='text' value={row.editingOwner} maxLength={128} aria-label={t('schedule.col.editingOwner')} {...inputProps('editingOwner')} />
      </td>
      <td className={css.cellActions}>
        <Button
          variant='ghost'
          size='sm'
          className={css.dangerButton}
          disabled={!deleteAllowed(state, props.deleteInFlight)}
          aria-label={t('schedule.deleteAria', { id: row.rowId })}
          onClick={() => { props.onDelete(row.rowId) }}
        >
          {t('schedule.delete')}
        </Button>
        {(status === 'failed' || status === 'unknown') && (
          <Button variant='ghost' size='sm' onClick={() => { props.onRetry(row.rowId) }}>
            {state?.operation === 'delete' ? t('schedule.row.retryDelete') : t('schedule.row.retry')}
          </Button>
        )}
        {status === 'failed' && (
          <Button variant='ghost' size='sm' onClick={() => { props.onDiscard(row.rowId) }}>{t('schedule.row.discard')}</Button>
        )}
        {(status === 'failed' || status === 'conflict' || status === 'unknown') && (
          <Button variant='ghost' size='sm' onClick={props.onRefresh}>{t('schedule.row.refresh')}</Button>
        )}
        {state?.lastServerError != null && (
          <p className={css.rowError} role='alert'>{domainErrorText('schedule', state.lastServerError, t)}</p>
        )}
      </td>
    </tr>
  )
}
