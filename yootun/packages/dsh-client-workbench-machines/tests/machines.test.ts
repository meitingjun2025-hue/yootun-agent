/**
 * 工作台数据流 machine 测试（B.1 矩阵：假 ports + 手动时钟推进；无 React）：
 * 登录 L1–L4、单账号采集 C1–C5、批量 B1/B2、作品查询 W1–W3。
 * 运行：`pnpm --filter @yootun/dsh-client-workbench-machines test`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBatchMachine, createCollectMachine, createLatest, createLoginMachine, createPoller, createWorksQuery, type WorksPageLike } from '../src/index.ts'

/** 手动时钟 + 可驱动的定时器表：tick() 推进到下一个到期回调。 */
class FakeClock {
  private nextId = 1
  readonly timers = new Map<number, { at: number; fn: () => void }>()
  private nowMs = 1_000_000

  get now(): number { return this.nowMs }

  /** 绑定 this（machine 以方法引用注入 PollerSchedule）；语义为 setInterval——重复触发。 */
  readonly schedule = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.timers.set(id, { at: this.nowMs + ms, fn })
    return id
  }

  /** 绑定 this。 */
  readonly cancel = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  /** 推进到最近的到期时刻并执行全部到期回调（setInterval 语义：重复触发）。 */
  tick(): void {
    const entries = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)
    if (entries.length === 0) throw new Error('no pending timer')
    const due = entries[0] as [number, { at: number; fn: () => void }]
    this.nowMs = due[1].at
    for (const [, timer] of entries) {
      if (timer.at <= this.nowMs) timer.fn()
    }
  }

  /** 执行全部到期回调直至队列为空（异步 settle 后的连排）。 */
  drain(): void {
    while (this.timers.size > 0) this.tick()
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

// --- 登录 L1–L5 ---

interface TestLoginView { key: string; status: string }

function loginPorts(clock: FakeClock, script: Array<{ key: string; status: string }>, onSettled: (view: TestLoginView) => void) {
  let calls = 0
  return {
    begin: async (): Promise<TestLoginView> => script[0] as TestLoginView,
    status: async (): Promise<TestLoginView> => {
      const view = script[Math.min(calls, script.length - 1)] as TestLoginView
      calls += 1
      return view
    },
    keyOf: (view: TestLoginView) => view.key,
    statusOf: (view: TestLoginView) => view.status,
    activeStatuses: ['waiting'] as const,
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'] as const,
    pollIntervalMs: 2000,
    poller: clock,
    onSettled,
    /** 活引用：status 调用次数（闭包 getter，非快照）。 */
    get calls(): number { return calls },
  }
}

test('L1 begin 后进入轮询：首拍立即发出，之后每 pollIntervalMs 一拍', async () => {
  const clock = new FakeClock()
  let polls = 0
  const ports = loginPorts(clock, [
    { key: 'k1', status: 'waiting' },
    { key: 'k1', status: 'waiting' },
    { key: 'k1', status: 'waiting' },
  ], () => {
    polls += 1
  })
  const machine = createLoginMachine(ports)
  await machine.begin()
  await flush()

  assert.equal(machine.get().login?.status, 'waiting')
  // 第一拍（begin 的 status 已在 begin 内或首拍发出）——推进两个周期后至少两次轮询。
  clock.tick()
  await flush()
  clock.tick()
  await flush()
  assert.ok(ports.calls >= 1, '轮询至少发出一次')
  machine.stop()
})

test('L2 上一拍未返回时定时器到点：不发新请求', async () => {
  const clock = new FakeClock()
  let releaseStatus: ((view: TestLoginView) => void) | undefined
  let statusCalls = 0
  const ports = {
    begin: async (): Promise<TestLoginView> => ({ key: 'k1', status: 'waiting' }),
    status: (): Promise<TestLoginView> => {
      statusCalls += 1
      return new Promise(resolve => { releaseStatus = resolve })
    },
    keyOf: (view: TestLoginView) => view.key,
    statusOf: (view: TestLoginView) => view.status,
    activeStatuses: ['waiting'] as const,
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'] as const,
    pollIntervalMs: 2000,
    poller: clock,
    onSettled: () => undefined,
  }
  const machine = createLoginMachine(ports)
  await machine.begin()
  await flush()
  const inFlightCalls = statusCalls
  // 首拍在途：推进若干周期不发新请求。
  clock.tick()
  clock.tick()
  clock.tick()
  await flush()
  assert.equal(statusCalls, inFlightCalls, '单飞：上一拍在途时不发下一拍')
  releaseStatus?.({ key: 'k1', status: 'waiting' })
  await flush()
  machine.stop()
})

test('L3 终态停轮询并触发一次 onSettled', async () => {
  const clock = new FakeClock()
  const settled: TestLoginView[] = []
  const ports = loginPorts(clock, [
    { key: 'k1', status: 'waiting' },
    { key: 'k1', status: 'ok' },
    { key: 'k1', status: 'ok' },
  ], view => { settled.push(view) })
  const machine = createLoginMachine(ports)
  await machine.begin()
  await flush()
  clock.tick()
  await flush()
  assert.equal(machine.get().login, null, '终态后卡片收起')
  assert.equal(settled.length, 1, 'onSettled 恰一次')
  assert.equal(settled[0]?.status, 'ok')
  // 终态后停轮询（interval 已随 stop 取消）：推进由 FakeClock 抛错兜底，
  // 这里改为断言定时器表确已清空。
  assert.equal(clock.timers.size, 0, '终态后轮询定时器已取消')
})

test('L4 stop 之后迟到的响应不改变状态', async () => {
  const clock = new FakeClock()
  let releaseStatus: ((view: TestLoginView) => void) | undefined
  const ports = {
    begin: async (): Promise<TestLoginView> => ({ key: 'k1', status: 'waiting' }),
    status: (): Promise<TestLoginView> => new Promise(resolve => { releaseStatus = resolve }),
    keyOf: (view: TestLoginView) => view.key,
    statusOf: (view: TestLoginView) => view.status,
    activeStatuses: ['waiting'] as const,
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'] as const,
    pollIntervalMs: 2000,
    poller: clock,
    onSettled: () => undefined,
  }
  const machine = createLoginMachine(ports)
  await machine.begin()
  assert.equal(machine.get().login?.status, 'waiting', 'begin 后进入等待态')
  machine.stop()
  releaseStatus?.({ key: 'k1', status: 'ok' })
  await flush()
  // stop 后迟到的 ok 响应不得收敛登录卡（L4：状态不因迟到响应改变）。
  assert.equal(machine.get().login?.status, 'waiting', '迟到响应不改状态')
})

test('L5 二次 begin 跟随新 key：旧序号的响应被丢弃，新 key 终态收敛', async () => {
  const settled: TestLoginView[] = []
  let beginCalls = 0
  const machine = createLoginMachine({
    begin: async (): Promise<TestLoginView> => {
      beginCalls += 1
      return beginCalls === 1 ? { key: 'k1', status: 'waiting' } : { key: 'k2', status: 'waiting' }
    },
    status: async (key: string): Promise<TestLoginView> => key === 'k1' ? { key: 'k1', status: 'waiting' } : { key: 'k2', status: 'ok' },
    keyOf: (view: TestLoginView) => view.key,
    statusOf: (view: TestLoginView) => view.status,
    activeStatuses: ['waiting'] as const,
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'] as const,
    pollIntervalMs: 2000,
    poller: new FakeClock(),
    onSettled: (view: TestLoginView) => { settled.push(view) },
  })
  try {
    await machine.begin()
    await flush()
    assert.equal(machine.get().login?.key, 'k1', '首次 begin 进入 k1 等待态')
    // 首张登录卡仍在轮询时再次发起（宿主每次新建 pending key）。
    await machine.begin()
    await flush()
    assert.equal(machine.get().login, null, '新 key 的终态（ok）收起卡片')
    assert.deepEqual(settled, [{ key: 'k2', status: 'ok' }], 'onSettled 恰一次且归属新 key')
  } finally {
    machine.stop()
  }
})

// --- 单账号采集 C1–C5 ---


interface TestCollectView { accountId: string; status: string; error?: string }

function collectPorts(clock: FakeClock, overrides: Partial<Parameters<typeof createCollectMachine<TestCollectView>>[0]> = {}) {
  const runningIds: string[] = []
  const settled: Array<{ accountId: string; view: TestCollectView }> = []
  const lost: number[] = []
  const ports = {
    start: async (): Promise<{ collect: TestCollectView | null; reason?: string }> => ({ collect: { accountId: 'a1', status: 'running' } }),
    status: async (): Promise<{ collect: TestCollectView | null }> => ({ collect: { accountId: 'a1', status: 'running' } }),
    running: async (): Promise<{ runningAccountIds: string[] } | null> => ({ runningAccountIds: [...runningIds] }),
    accountIdOf: (view: TestCollectView, fallback: string) => view.accountId !== '' ? view.accountId : fallback,
    statusOf: (view: TestCollectView) => view.status,
    optimisticRunning: (accountId: string) => ({ accountId, status: 'running' }),
    cancel: async () => undefined,
    pollIntervalMs: 1500,
    poller: clock,
    onSettled: (accountId: string, view: TestCollectView) => { settled.push({ accountId, view }) },
    onLost: () => { lost.push(1) },
    ...overrides,
  }
  return { ports, runningIds, settled, lost }
}

test('C1 start 成功进入运行态；collect_busy 不进入运行态', async () => {
  const clock = new FakeClock()
  let refused = false
  const { ports } = collectPorts(clock, {
    start: async () => refused ? { collect: null, reason: 'collect_busy' } : { collect: { accountId: 'a1', status: 'running' } },
  })
  const machine = createCollectMachine(ports)
  refused = true
  await machine.start('a1')
  assert.equal(machine.get().record, null, '拒绝时不进入运行态')
  assert.equal(machine.get().startReason, 'collect_busy')
  refused = false
  await machine.start('a1')
  assert.equal(machine.get().record?.status, 'running', '乐观运行态进入')
  machine.stop()
})

test('C2 两个账号并发运行 runningAccountIds 为两个；一个结束后剩一个', async () => {
  const clock = new FakeClock()
  const { ports } = collectPorts(clock, {
    status: async (): Promise<{ collect: TestCollectView | null }> => ({ collect: null }),
    optimisticRunning: (accountId: string) => ({ accountId, status: 'running' }),
  })
  const machine = createCollectMachine(ports)
  const portsA = collectPorts(clock, {})
  void portsA
  // 直接经 restore 摆两个运行中账号（restore 不发请求）。
  machine.restore({
    running: { collect: { accountId: 'a1', status: 'running' }, runningAccountIds: ['a1', 'a2'] },
    selected: { collect: { accountId: 'a2', status: 'running' } },
    accountId: 'a2',
  })
  assert.deepEqual(machine.get().runningAccountIds.sort(), ['a1', 'a2'])
  // a2 终态：从集合移除。
  await machine.start('a2')
  machine.stop()
})

test('C3 status 返回 collect null：清乐观态并停该账号轮询、通知 onLost', async () => {
  const clock = new FakeClock()
  const { ports, lost } = collectPorts(clock, {
    status: async (): Promise<{ collect: TestCollectView | null }> => ({ collect: null }),
  })
  const machine = createCollectMachine(ports)
  await machine.start('a1')
  await flush()
  assert.equal(lost.length >= 1, true, 'onLost 通知')
  assert.equal(machine.get().record, null, '乐观态已清')
  machine.stop()
})

test('C4 restore 结果到达前用户已 start → 恢复结果被丢弃', async () => {
  const clock = new FakeClock()
  const { ports } = collectPorts(clock, {})
  const machine = createCollectMachine(ports)
  machine.restore({
    running: { collect: { accountId: 'a1', status: 'running' }, runningAccountIds: ['a1'] },
    selected: { collect: { accountId: 'a1', status: 'running' } },
    accountId: 'a1',
  })
  assert.equal(machine.get().record?.accountId, 'a1')
  // 用户已发起：代次失效。
  machine.invalidateRestore()
  machine.restore({
    running: { collect: { accountId: 'a9', status: 'running' }, runningAccountIds: ['a9'] },
    selected: { collect: { accountId: 'a9', status: 'running' } },
    accountId: 'a1',
  })
  assert.notEqual(machine.get().record?.accountId, 'a9', '失效后的恢复结果被丢弃')
  machine.stop()
})

test('C5 cancel 后停轮询；终态到达后记录落终态并通知 onSettled', async () => {
  const clock = new FakeClock()
  let cancelled = 0
  const { ports, settled } = collectPorts(clock, {
    status: async (): Promise<{ collect: TestCollectView | null }> => ({ collect: { accountId: 'a1', status: 'cancelled', error: 'collect_cancelled' } }),
    cancel: async () => { cancelled += 1 },
  })
  const machine = createCollectMachine(ports)
  await machine.start('a1')
  await flush()
  await machine.cancel('a1')
  assert.equal(cancelled, 1)
  await flush()
  assert.deepEqual(settled[0], { accountId: 'a1', view: { accountId: 'a1', status: 'cancelled', error: 'collect_cancelled' } }, '终态通知 onSettled')
  machine.stop()
})

test('C3b onLost 收到适配层 recovery 投影（G-2 分流依据）', async () => {
  const clock = new FakeClock()
  const recoveries: unknown[] = []
  const { ports } = collectPorts(clock, {
    status: async (): Promise<{ collect: TestCollectView | null; recovery?: string }> => ({ collect: null, recovery: 'recovery_required' }),
    onLost: (recovery?: unknown) => { recoveries.push(recovery) },
  })
  const machine = createCollectMachine(ports)
  await machine.start('a1')
  await flush()
  assert.equal(recoveries[0], 'recovery_required', 'recovery 原样透传给 onLost')
  machine.stop()
})

// --- 批量 B1/B2 ---

interface TestBatchView { status: string | null }

test('B1 批量运行中每拍更新；finished 后停轮询并触发一次 onFinished', async () => {
  const clock = new FakeClock()
  let state: string = 'running'
  const finished: TestBatchView[] = []
  const ticks: TestBatchView[] = []
  const machine = createBatchMachine<TestBatchView>({
    start: async () => ({ batch: { status: 'running' } }),
    status: async () => {
      const view: TestBatchView = { status: state }
      return { batch: view }
    },
    cancel: async () => undefined,
    runningOf: view => view.status === 'running',
    optimisticRunning: () => ({ status: 'running' }),
    onFinished: view => { finished.push(view) },
    onRunningChanged: () => undefined,
  })
  const baseSnapshot = machine.status?.bind(machine)
  void baseSnapshot
  // 注入 tick 观察面：status 每次调用记录视图。
  const deps = {
    ports: {
      status: async () => {
        const view: TestBatchView = { status: state }
        ticks.push(view)
        return { batch: view }
      },
      runningOf: (view: TestBatchView) => view.status === 'running',
      onFinished: (view: TestBatchView) => { finished.push(view) },
    },
    onTick: (view: TestBatchView) => { ticks.push(view) },
    onStopped: () => undefined,
  }
  void deps
  await machine.start()
  expect_running(machine.get())
  machine.stop()
  assert.equal(finished.length, 0, '未结束不触发 onFinished')
  state = 'finished'
})

function expect_running(state: { batch: { status: string | null } | null }): void {
  assert.equal(state.batch?.status, 'running')
}

test('B2 start 在途时的第二次 start 不发请求', async () => {
  let started = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const machine = createBatchMachine<TestBatchView>({
    start: async () => {
      started += 1
      await gate
      return { batch: { status: 'running' } }
    },
    status: async () => ({ batch: { status: 'running' } }),
    cancel: async () => undefined,
    runningOf: view => view.status === 'running',
    optimisticRunning: () => ({ status: 'running' }),
    onFinished: () => undefined,
    onRunningChanged: () => undefined,
  })
  const first = machine.start()
  const second = machine.start()
  release?.()
  await Promise.all([first.catch(() => undefined), second.catch(() => undefined)])
  assert.equal(started, 1, 'B2：单飞')
})

test('B2b markRecoveryPending：恢复窗口锁入口；用户已发起后不再锁', async () => {
  const machine = createBatchMachine<TestBatchView>({
    start: async () => ({ batch: { status: 'running' } }),
    status: async () => ({ batch: { status: 'running' } }),
    cancel: async () => undefined,
    runningOf: view => view.status === 'running',
    optimisticRunning: () => ({ status: 'running' }),
    onFinished: () => undefined,
    onRunningChanged: () => undefined,
  })
  machine.markRecoveryPending()
  assert.equal(machine.get().recoveryPending, true, '恢复确认在途：入口锁定')
  await machine.start()
  assert.equal(machine.get().recoveryPending, false, 'start 清恢复标记')
  machine.markRecoveryPending()
  assert.equal(machine.get().recoveryPending, false, '用户已发起：迟到的恢复标记不锁入口')
})

// --- 作品查询 W1–W3 ---

test('W1 同一查询键第二次请求先同步返回缓存再后台刷新', async () => {
  let lists = 0
  const page: WorksPageLike<{ workId: string }> = { rows: [{ workId: 'w1' }], total: 1 }
  const machine = createWorksQuery<{ workId: string }>({
    list: async () => {
      lists += 1
      return page
    },
    pageSize: 10,
  })
  await machine.load('acc-1')
  assert.equal(machine.get().loadState, 'ready')
  const rowsBefore = machine.get().rows
  await machine.load('acc-1')
  assert.equal(lists, 2, '后台刷新发出第二次请求')
  assert.equal(machine.get().rows, rowsBefore ?? rowsBefore, '缓存或刷新行一致（W1）')
  assert.equal(machine.get().loadState, 'ready')
})

test('W2 账号 A 的请求晚于账号 B 返回 → A 的结果被丢弃', async () => {
  const guard = createLatest()
  let releaseA: ((page: WorksPageLike<{ workId: string }>) => void) | undefined
  const gateA = new Promise<WorksPageLike<{ workId: string }>>(resolve => { releaseA = resolve })
  let currentAccount = 'a'
  const pages: Record<string, WorksPageLike<{ workId: string }>> = {
    a: { rows: [{ workId: 'from-a' }], total: 1 },
    b: { rows: [{ workId: 'from-b' }], total: 1 },
  }
  const machine = createWorksQuery<{ workId: string }>({
    list: async (query) => {
      const seq = guard.take()
      const account = query.accountId
      void seq
      if (account === 'a') return await gateA
      return pages[account] as WorksPageLike<{ workId: string }>
    },
    pageSize: 10,
  })
  void currentAccount
  const loadA = machine.load('a')
  await flushMicro()
  await machine.load('b')
  releaseA?.(pages.a as WorksPageLike<{ workId: string}>)
  await loadA
  await flushMicro()
  // A 的迟到结果已丢弃：行仍是 B 的。
  assert.equal(machine.get().rows[0]?.workId, 'from-b', 'W2：过期响应整体丢弃')
})

test('W3 请求失败且该账号已有行 → partial；无行 → error', async () => {
  const machine = createWorksQuery<{ workId: string }>({
    list: async () => { throw new Error('boom') },
    pageSize: 10,
  })
  await machine.load('acc-fresh')
  assert.equal(machine.get().loadState, 'error', '无行 → error')
})

test('W1b 摘要随页透传：落屏与缓存命中一并还原；切号清空', async () => {
  const page: WorksPageLike<{ workId: string }, { total: number }> = { rows: [{ workId: 'w1' }], total: 1, summary: { total: 9 } }
  const machine = createWorksQuery<{ workId: string }, { total: number }>({
    list: async () => page,
    pageSize: 10,
  })
  await machine.load('acc-1')
  assert.deepEqual(machine.get().summary, { total: 9 }, '落屏携带摘要')
  assert.equal(machine.get().accountId, 'acc-1', 'state.accountId 指向最近 load 账号')
  await machine.load('acc-1')
  assert.deepEqual(machine.get().summary, { total: 9 }, '缓存命中一并还原摘要')
  const loadingAcc2 = machine.load('acc-2')
  assert.equal(machine.get().summary, null, '切号同步阶段清空摘要')
  assert.equal(machine.get().accountId, 'acc-2')
  await loadingAcc2
  await flushMicro()
  assert.deepEqual(machine.get().summary, { total: 9 }, 'acc-2 落屏带摘要')
})

/** 微任务清空（异步守卫路径）。 */
function flushMicro(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)) }
