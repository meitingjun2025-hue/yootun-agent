/**
 * accounts-machine 挂载恢复接线回归（P0 审查建议修 #5）：冷启动 init 只发
 * 一次 accounts.list；恢复查询在途时选中账号切换 → 结果丢弃。
 * 运行：`node --test tests/accounts-machine-init.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountsMachine, type AccountsMachinePorts } from '../src/client/accounts-machine.ts'

/** 假 ports：可编程 listAccounts / collectStatus；其余动作不参与本组用例。 */
function fakePorts(overrides: Partial<AccountsMachinePorts> = {}): AccountsMachinePorts {
  return {
    listAccounts: async () => ({ accounts: [] }),
    beginLogin: async () => ({}),
    loginStatus: async () => ({}),
    probe: async () => ({}),
    removeLocal: async () => undefined,
    startCollect: async () => ({}),
    collectStatus: async () => ({ collect: null }),
    cancelCollect: async () => ({}),
    browserStatus: async () => ({ chromeAvailable: true }),
    ...overrides,
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('冷启动 init 只发一次 accounts.list（挂载恢复复用同一刷新 promise）', async () => {
  let listCalls = 0
  const machine = createAccountsMachine(fakePorts({
    listAccounts: async () => {
      listCalls += 1
      return { accounts: [{ accountId: 'a1', nickname: 'A1' }] }
    },
  }))
  machine.init()
  try {
    await flush()
    await flush()
    assert.equal(listCalls, 1, '冷启动恰好一次 accounts.list')
    assert.equal(machine.get().selectedId, 'a1')
  } finally {
    // 断言失败也必须停轮询，不留活定时器挂住进程。
    machine.stop()
  }
})

test('恢复查询在途时选中账号切换：迟到的恢复结果丢弃', async () => {
  let releaseCollect: ((value: { status?: string; collect?: Record<string, unknown> | null }) => void) | undefined
  const gate = new Promise<{ status?: string; collect?: Record<string, unknown> | null }>(resolve => { releaseCollect = resolve })
  const machine = createAccountsMachine(fakePorts({
    listAccounts: async () => ({ accounts: [{ accountId: 'a1', nickname: 'A1' }, { accountId: 'a2', nickname: 'A2' }] }),
    collectStatus: async input => {
      assert.ok(!('collectId' in input), '恢复查询按账号发起')
      return await gate
    },
  }))
  machine.init()
  try {
    await flush()
    assert.equal(machine.get().selectedId, 'a1')
    // 查询在途：用户切到 a2。
    machine.select('a2')
    releaseCollect?.({ status: 'running', collect: { accountId: 'a1', collectStatus: 'running', progress: {} } })
    await flush()
    await flush()
    assert.equal(machine.get().selectedId, 'a2')
    assert.equal(machine.get().collect, null, 'a1 的迟到恢复结果不得写进采集态')
  } finally {
    // 断言失败也必须停轮询，不留活定时器挂住进程（563 秒教训）。
    machine.stop()
  }
})
