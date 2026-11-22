/**
 * D2 行为测试（node --test）：登录链路（假 Chrome factory + 假 workbench）、
 * accounts.list 合并/墓碑/pending、probe 三态与序号、删除两步与阻断、采集
 * 互斥与 runs.json 恢复。不启动真实 Chrome、不访问生产 endpoint。
 * 运行：`node --test tests/d2.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { FakeWorkbenchError, createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import type { WorkbenchFace } from '../src/workbench.ts'

/** 组装 D2 deps（可脚本 workbench；Chrome factory 走缺省——本文件不触发登录）。 */
async function d2Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  deps: ReturnType<typeof createDouyinHostDeps>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({
    root,
    workbenchFace: fake.face,
    logger: { warn: () => undefined },
  })
  return { deps, calls: fake.calls, cleanup }
}

test('accounts.list：本地+远端合并、本地优先、墓碑过滤、pending 标记', async () => {
  const { deps, calls, cleanup } = await d2Deps({ outcomes: [{ structuredContent: { accounts: [
    { account_id: 'acc-1', nickname: '远端名', owner_name: '张三', fan_count: 100, session_status: 'ok', session_checked_at: '2026-11-01T00:00:00Z', last_collected_at: '2026-11-02T00:00:00Z' },
    { account_id: 'ghost', nickname: '墓碑', delete_state: 'remote_deleted' },
    { account_id: 'remote-only', nickname: '只在远端' },
  ] } }] })
  try {
    await deps.callTool === undefined
    const handlers = buildRouteHandlers(deps)
    // 本地写一条 acc-1（昵称空，验证远端兜底）与一条 pending。
    const { writeAccounts } = await import('../src/state.ts')
    await writeAccounts({ version: 1, accounts: {
      'acc-1': { accountId: 'acc-1' },
      'pending-123': { accountId: 'pending-123', sessionStatus: 'unknown' },
    } }, deps.root)
    const payload = await handlers['accounts.list']({})
    assert.equal(payload.status, 'ready')
    const accounts = payload.accounts as Array<Record<string, unknown>>
    const ids = accounts.map(row => row.accountId)
    assert.deepEqual(ids.sort(), ['acc-1', 'pending-123', 'remote-only'])
    const acc1 = accounts.find(row => row.accountId === 'acc-1')
    assert.equal(acc1?.nickname, '远端名')
    assert.equal(acc1?.ownerName, '张三')
    assert.equal(acc1?.local, true)
    const pending = accounts.find(row => row.accountId === 'pending-123')
    assert.equal(pending?.isPending, true)
    assert.ok(!ids.includes('ghost'), '墓碑账号不得进入可用列表')
    assert.ok(JSON.stringify(payload).indexOf('storage_state') === -1, '响应不得含 storage_state 字样')
    assert.equal(calls[0]?.name, 'workbench_douyin_account_list')
  } finally {
    await cleanup()
  }
})

test('accounts.list：远端失败不整体失败，remoteError 透出', async () => {
  const face: WorkbenchFace = {
    async callTool() { throw new FakeWorkbenchError('workbench_network_error') },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: face })
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['accounts.list']({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.remoteError, 'workbench_network_error')
    assert.deepEqual(payload.accounts, [])
  } finally {
    await cleanup()
  }
})

test('account.loginStatus：无 run 回 idle；终态读取一次即清理', async () => {
  const { deps, cleanup } = await d2Deps()
  try {
    const handlers = buildRouteHandlers(deps)
    const idle = await handlers['account.loginStatus']({ accountId: 'nobody' })
    assert.equal((idle.login as Record<string, unknown>).status, 'idle')
    // 手工注入终态 run 验证读后即删。
    const { loginRuns } = deps
    loginRuns.set('k1', { key: 'k1', status: 'timeout', accountId: null, error: 'login_timeout', saveError: null, startedAt: new Date().toISOString() })
    const first = await handlers['account.loginStatus']({ accountId: 'k1' })
    assert.equal((first.login as Record<string, unknown>).status, 'timeout')
    const second = await handlers['account.loginStatus']({ accountId: 'k1' })
    assert.equal((second.login as Record<string, unknown>).status, 'idle')
  } finally {
    await cleanup()
  }
})

test('sessionSeq 单调递增；bumpSessionSeqWith 远端 floor 对齐后再 +1', async () => {
  const { deps, cleanup } = await d2Deps()
  try {
    const { nextSessionSeq, bumpSessionSeqWith } = await import('../src/state.ts')
    const seq1 = await nextSessionSeq('acc-seq', deps.root)
    const seq2 = await nextSessionSeq('acc-seq', deps.root)
    assert.ok(seq2 > seq1, 'seq 单调递增')
    // 远端 seq 更高时先对齐再 +1（多设备 stale 防线）。
    const { seq } = await bumpSessionSeqWith('acc-seq', { sessionStatus: 'ok' }, seq2 + 5, deps.root)
    assert.equal(seq, seq2 + 6)
  } finally {
    await cleanup()
  }
})

test('删除顺序：removeLocal 成功（runs 同步清理）后才允许 removeRemote；半清理失败 cleanup_failed 阻断远端', async () => {
  const { deps, calls, cleanup } = await d2Deps()
  try {
    const handlers = buildRouteHandlers(deps)
    const { updateRun } = await import('../src/runs.ts')
    await updateRun(deps.root, 'del-acc', 'attempt-1', { status: 'completed' })
    const local = await handlers['account.removeLocal']({ accountId: 'del-acc' })
    assert.equal(local.status, 'ready')
    assert.equal(local.localCleared, true)
    const { readRuns } = await import('../src/runs.ts')
    assert.deepEqual(await readRuns(deps.root), {}, 'runs.json 该账号记录随 removeLocal 清理')
    const remote = await handlers['account.removeRemote']({ accountId: 'del-acc' })
    assert.equal(remote.status, 'ready')
    assert.equal(calls[calls.length - 1]?.name, 'workbench_douyin_account_remove')
    // 半清理失败：storage_state 路径被目录占位（rm 文件语义失败）→ removed=false
    // → cleanup_failed 阻断远端删除。
    const { paths } = await import('../src/state.ts')
    const { mkdir } = await import('node:fs/promises')
    const storageDir = join(deps.root, 'storage-state')
    await mkdir(storageDir, { recursive: true })
    await mkdir(paths(deps.root).storageStatePath('del-acc2'))
    const blocked = await handlers['account.removeLocal']({ accountId: 'del-acc2' })
    assert.equal(blocked.status, 'error')
    assert.equal(blocked.reason, 'cleanup_failed')
    assert.equal(calls.filter(call => call.name === 'workbench_douyin_account_remove' && call.args !== undefined && (call.args as Record<string, unknown>).accountId === 'del-acc2').length, 0, '半清理失败不得发起远端删除')
  } finally {
    await cleanup()
  }
})

test('collect.start：无 storage_state 拒绝 session_required，不建 run 不发远端调用', async () => {
  const { deps, calls, cleanup } = await d2Deps()
  try {
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['collect.start']({ accountId: 'no-cred' })
    assert.equal(payload.status, 'error')
    assert.equal(payload.reason, 'session_required')
    assert.equal(calls.length, 0)
  } finally {
    await cleanup()
  }
})

test('G-2 run 恢复：running 记录重启后标 interrupted；collect.status 给 recovery_required 而非伪造 running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'douyin-g2-'))
  try {
    const { updateRun } = await import('../src/runs.ts')
    await updateRun(root, 'g2-acc', 'attempt-g2', { status: 'running', runId: 'run-9', publishSince: '2026-05-31T16:00:00Z' })
    const { recoverInterruptedRuns, readRuns } = await import('../src/runs.ts')
    const marked = await recoverInterruptedRuns(root)
    assert.equal(marked, 1)
    const runs = await readRuns(root)
    assert.equal(runs['attempt-g2']?.status, 'interrupted')
    // runs.json 不含 Cookie / storage_state / profile 路径。
    const raw = await readFile(join(root, 'runs.json'), 'utf8')
    for (const banned of ['cookie', 'storage_state', 'profiles/']) {
      assert.ok(raw.toLowerCase().indexOf(banned) === -1, `runs.json 不得含 ${banned}`)
    }
    // collect.status（内存态丢失）投影 recovery。
    const fake = createFakeWorkbench()
    const deps = createDouyinHostDeps({ root, workbenchFace: fake.face })
    const handlers = buildRouteHandlers(deps)
    const status = await handlers['collect.status']({ accountId: 'g2-acc' })
    assert.equal(status.status, 'ready')
    assert.equal(status.recovery, 'recovery_required')
    assert.equal((status.lastRun as Record<string, unknown>).runId, 'run-9')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G-1：ACTION_TOOL_MAP 无 collect_run_cancel 绑定（采集取消只经内部 abort）', async () => {
  const { ACTION_TOOL_MAP } = await import('../src/route.ts')
  for (const binding of Object.values(ACTION_TOOL_MAP)) {
    if (binding.kind !== 'remote') continue
    assert.ok(!binding.tools.includes('workbench_douyin_collect_run_cancel'), 'cancel 不得绑定 action')
  }
})
