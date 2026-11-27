/**
 * 状态文件写入测试（node --test；实施单 workbench-host-kit 附录 B.1 H7–H8）：
 * atomicWriteJson 的 tmp 命名与原子性、runInRootQueue 的同 root 串行 / 跨 root
 * 并行 / 失败后队列继续 / 空闲回收。运行：`node --test tests/state-store.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { atomicWriteJson, rootQueues, runInRootQueue } from '../src/state-store.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-host-kit-state-'))
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

test('H7 atomicWriteJson：tmp 名含 pid 与随机段；rename 前目标不被改写', async () => {
  const root = await tempRoot()
  try {
    // 目标路径放一个目录使 rename 必然失败：留下的 tmp 文件名可直接断言，
    // 且「目标」目录内容不被改写（rename 前目标保持原状的可观察形态）。
    const target = join(root, 'accounts.json')
    const sentinel = join(target, 'sentinel.txt')
    await mkdir(target)
    await writeFile(sentinel, 'untouched')

    await assert.rejects(atomicWriteJson(target, { a: 1 }))
    const names = await readdir(root)
    const tmpName = names.find(name => name.startsWith('accounts.json.tmp-'))
    assert.ok(tmpName !== undefined, `应留下 tmp 文件，实际目录项：${names.join(',')}`)
    assert.match(tmpName, /^accounts\.json\.tmp-\d+-[0-9a-z]{6}$/u, 'tmp 名应为 <file>.tmp-<pid>-<随机 6 位>')
    assert.match(tmpName, new RegExp(`tmp-${String(process.pid)}-`), 'tmp 名应含进程 pid')
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched', 'rename 前目标保持原状')
    const tmpContent = JSON.parse(await readFile(join(root, tmpName), 'utf8')) as { a: number }
    assert.deepEqual(tmpContent, { a: 1 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H7 atomicWriteJson：成功路径落盘 0600、格式为两空格缩进 + 结尾换行、无 tmp 残留', async () => {
  const root = await tempRoot()
  try {
    const file = join(root, 'state.json')
    await atomicWriteJson(file, { version: 1, items: ['a'] })
    const names = await readdir(root)
    assert.deepEqual(names, ['state.json'], '不应残留 tmp 文件')
    const raw = await readFile(file, 'utf8')
    assert.equal(raw, '{\n  "version": 1,\n  "items": [\n    "a"\n  ]\n}\n')
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      const info = await stat(file)
      assert.equal(info.mode & 0o777, 0o600, '状态文件权限应为 0600')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('H8 runInRootQueue：同 root 串行（读改写不交错）；不同 root 并行', async () => {
  const root = join(await tempRoot(), 'unused')
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  const t1 = runInRootQueue(root, async () => {
    events.push('t1-start')
    await gate.promise
    events.push('t1-end')
  })
  const t2 = runInRootQueue(root, async () => { events.push('t2') })
  await tick()
  assert.deepEqual(events, ['t1-start'], '同 root 后续任务必须等待前序')
  assert.equal(typeof rootQueues.get(root)?.then, 'function', '进行中的 root 在队列表中')
  gate.resolve()
  await Promise.all([t1, t2])
  assert.deepEqual(events, ['t1-start', 't1-end', 't2'])

  const parallelRoot1 = join(await tempRoot(), 'r1')
  const parallelRoot2 = join(await tempRoot(), 'r2')
  const gate2 = Promise.withResolvers<void>()
  const q1 = runInRootQueue(parallelRoot1, async () => { await gate2.promise })
  const q2 = runInRootQueue(parallelRoot2, async () => 'done')
  await tick()
  assert.equal(await q2, 'done', '不同 root 不得互相阻塞')
  gate2.resolve()
  await q1
})

test('H8 任务抛错后队列继续；空闲后 entry 回收', async () => {
  const root = join(await tempRoot(), 'root')
  await assert.rejects(runInRootQueue(root, async () => { throw new Error('boom') }), /boom/)
  const next = await runInRootQueue(root, async () => 'after-failure')
  assert.equal(next, 'after-failure')
  await runInRootQueue(root, async () => undefined)
  // 队列排空后给回收微任务一帧，再断言 entry 已删。
  await tick()
  assert.equal(rootQueues.has(root), false, '空闲 root 的队列 entry 应被回收')
})
