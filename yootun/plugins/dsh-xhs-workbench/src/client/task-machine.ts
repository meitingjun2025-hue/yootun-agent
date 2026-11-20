/**
 * 小红书仿写任务状态机（迁移旧 client.js createTaskMachine 全行为，纯逻辑无
 * React/浏览器依赖）：创建 → 轮询 → 读结果 → 终态；暂态失败按间隔重试；stop
 * 停止轮询不取消任务；resume 恢复（含终态补读结果与跨页面开关的失败详情保留）；
 * requestCancel 先停轮询再调取消，成功即本地置 cancelled（服务端是「请求取消」，
 * Driver 在安全点落 cancelled，前端成功后停止轮询避免空转）。期望版本数以创建时
 * versionCount 为准（单版可编辑定案=1）。
 * @module
 */

/** 任务创建入参（旧路由 task.create 契约）。 */
export interface TaskCreateInput {
  mediaType: 'images' | 'video'
  idempotencyKey: string
  theme?: string
  direction?: string
  refNote?: string
  refAccount?: string
  imageUrls?: string[]
  videoUrl?: string
  videoUnderstanding?: boolean
}

/** 当前任务投影（machine 内部持有）。 */
export interface MachineTask {
  taskId: string
  idempotencyKey: string
  taskStatus: string
  mediaType: 'images' | 'video'
  input: TaskCreateInput
  currentStep?: string | undefined
}

/** 查询状态投影。 */
export interface TaskStatusSnapshot {
  taskStatus: string
  currentStep?: string | undefined
  nextStep?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

/** 结果版本（Host 白名单投影）。 */
export interface TaskVersion {
  version: string
  title: string
  body: string
  tags: string[]
  coverCopy: string
  leadGuide: string
  issues?: string[]
  pages?: Array<{ pageIndex: number; copy: string }>
}

/** 失败详情（受控错误码/原因短语 + 失败步骤，供界面映射引导）。 */
export interface TaskFailure {
  step: string
  errorCode: string
  errorMessage: string
}

/** machine 级错误键（UI 文案映射；非 Host 稳定码）。 */
export type TaskMachineError = '' | 'pollFailed' | 'resultFailed' | 'createFailed' | 'failed' | 'cancelled' | 'cancelFailed'

/** machine 快照。 */
export interface TaskMachineSnapshot {
  task: MachineTask | null
  versions: TaskVersion[] | null
  error: TaskMachineError
  failure: TaskFailure | null
}

/** machine 注入面（测试以假路由/假定时器替换）。 */
export interface TaskMachinePorts {
  createTask(input: TaskCreateInput): Promise<{ taskId: string; taskStatus?: string }>
  queryStatus(taskId: string): Promise<TaskStatusSnapshot>
  queryResult(taskId: string): Promise<{ versions: TaskVersion[] }>
  cancelTask(taskId: string, idempotencyKey: string): Promise<unknown>
  intervalMs?: number
  schedule?: ((fn: () => void) => unknown) | undefined
  clearSchedule?: ((id: unknown) => void) | undefined
  onChange?: (() => void) | undefined
}

export interface TaskMachine {
  submit(input: TaskCreateInput): Promise<void>
  resume(): Promise<void>
  stop(): void
  requestCancel(): Promise<void>
  get(): TaskMachineSnapshot
}

const DEFAULT_POLL_INTERVAL_MS = 15_000

const isTerminal = (status: string): boolean => status === 'succeeded' || status === 'failed' || status === 'cancelled'

/**
 * Create the rewrite-task machine.
 * @param ports - injected route adapters and timers.
 * @returns the machine.
 */
export function createTaskMachine(ports: TaskMachinePorts): TaskMachine {
  const intervalMs = ports.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const schedule = ports.schedule ?? ((fn: () => void) => setTimeout(fn, intervalMs))
  const clearSchedule = ports.clearSchedule ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout))

  let snapshot: TaskMachineSnapshot = { task: null, versions: null, error: '', failure: null }
  let timer: unknown = null
  let generation = 0
  let submission = 0
  let active = true

  const update = (next: TaskMachineSnapshot): void => {
    snapshot = next
    ports.onChange?.()
  }
  const cancelScheduled = (): void => {
    generation += 1
    if (timer !== null) {
      clearSchedule(timer)
      timer = null
    }
  }

  async function loadResult(taskId: string, gen: number): Promise<void> {
    let versions: TaskVersion[] | null = null
    let error: TaskMachineSnapshot['error'] = ''
    try {
      const result = await ports.queryResult(taskId)
      // 单版可编辑定案：结果必须恰好 1 套（versionCount 由 Host 固定传 1）。
      const expected = 1
      if (result !== null && Array.isArray(result.versions) && result.versions.length === expected) versions = result.versions
      else error = 'resultFailed'
    } catch {
      error = 'resultFailed'
    }
    if (gen !== generation) return
    update({ ...snapshot, versions, error })
  }

  async function poll(): Promise<void> {
    const gen = generation
    const task = snapshot.task
    if (task === null || task.taskId === '') return
    // 已终态：succeeded 补读结果；failed/cancelled 展示失败/取消提示。
    if (isTerminal(task.taskStatus)) {
      if (task.taskStatus === 'succeeded') {
        if (snapshot.versions === null) await loadResult(task.taskId, gen)
      } else {
        update({ ...snapshot, error: task.taskStatus === 'cancelled' ? 'cancelled' : 'failed' })
      }
      return
    }
    try {
      const status = await ports.queryStatus(task.taskId)
      if (gen !== generation) return
      const next: MachineTask = { ...task, taskStatus: status.taskStatus, currentStep: status.currentStep ?? status.nextStep ?? '' }
      update({ ...snapshot, task: next, error: '' })
      if (status.taskStatus === 'succeeded') {
        await loadResult(task.taskId, gen)
        return
      }
      if (status.taskStatus === 'failed' || status.taskStatus === 'cancelled') {
        update({
          ...snapshot,
          task: next,
          error: status.taskStatus === 'cancelled' ? 'cancelled' : 'failed',
          // 失败详情（受控错误码/原因短语 + 失败步骤）供界面映射引导。
          failure: status.taskStatus === 'failed'
            ? { step: next.currentStep ?? '', errorCode: status.errorCode ?? '', errorMessage: status.errorMessage ?? '' }
            : null,
        })
        return
      }
      timer = schedule(poll)
    } catch {
      if (gen !== generation) return
      update({ ...snapshot, error: 'pollFailed' })
      timer = schedule(poll)
    }
  }

  async function submit(input: TaskCreateInput): Promise<void> {
    const submissionId = ++submission
    cancelScheduled()
    update({ task: snapshot.task, versions: null, error: '', failure: null })
    let created: { taskId: string; taskStatus?: string }
    try {
      created = await ports.createTask(input)
    } catch {
      if (submissionId === submission) update({ ...snapshot, error: 'createFailed' })
      return
    }
    if (submissionId !== submission) return
    // 创建期间允许页面开关：始终保存最新任务，只有页面当前激活时才开始轮询。
    update({
      task: { taskId: created.taskId, idempotencyKey: input.idempotencyKey, taskStatus: created.taskStatus ?? 'queued', mediaType: input.mediaType, input },
      versions: null,
      error: '',
      failure: null,
    })
    if (!active) return
    await poll()
  }

  const resume = async (): Promise<void> => {
    active = true
    await poll()
  }
  const stop = (): void => {
    active = false
    cancelScheduled()
  }

  // 取消当前任务：先停止轮询，再调取消接口；成功后本地置终态 cancelled。
  async function requestCancel(): Promise<void> {
    const task = snapshot.task
    if (task === null || task.taskId === '' || isTerminal(task.taskStatus)) return
    cancelScheduled()
    const gen = generation
    try {
      await ports.cancelTask(task.taskId, task.idempotencyKey)
    } catch {
      if (gen !== generation) return
      update({ ...snapshot, error: 'cancelFailed' })
      if (active) timer = schedule(poll)
      return
    }
    if (gen !== generation) return
    update({ ...snapshot, task: { ...task, taskStatus: 'cancelled' }, error: 'cancelled' })
  }

  return {
    submit,
    resume,
    stop,
    requestCancel,
    get: () => snapshot,
  }
}
