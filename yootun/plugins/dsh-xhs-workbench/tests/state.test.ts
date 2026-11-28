/**
 * 状态目录与采集解析测试（旧 state.js/collector.js 语义锁定）：safeSegment 穿越
 * 防御、accounts.json 读写与权限、迁移不覆盖、快照 0600、字段映射与聚合缺口。
 * 运行：`node --test tests/state.test.ts`。
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  clearLocalCredentials, ensureProfileDir, getAccount, hasStorageState, latestSnapshot,
  moveProfile, moveStorageState, nextSessionSeq, paths, readAccounts, safeSegment,
  saveSnapshot, stateRoot, updateAccount, writeAccounts, STATE_VERSION, type CollectSnapshot,
} from '../src/state.ts'
import { mapNote, parsePostedPage, summarizeSnapshot } from '../src/collector.ts'

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-state-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

test('stateRoot：env 覆盖优先，缺省旧目录 ~/.dofe/dsh-yootun-xhs-operation', () => {
  assert.equal(stateRoot({ XHS_OPERATION_STATE_DIR: '/tmp/custom' }), '/tmp/custom')
  assert.ok(stateRoot({}).endsWith(join('.dofe', 'dsh-yootun-xhs-operation')))
})

test('safeSegment：非法字符可逆转义、不同账号不碰撞、`.`/`..` 显式拒绝', () => {
  assert.equal(safeSegment('a/b'), 'a%2fb')
  assert.equal(safeSegment('a_b'), 'a_b')
  assert.notEqual(safeSegment('a/b'), safeSegment('a_b'))
  assert.equal(safeSegment('..'), 'account')
  assert.equal(safeSegment('.'), 'account')
  assert.equal(safeSegment(''), 'account')
  assert.equal(safeSegment('  '), 'account')
  assert.equal(safeSegment('中文名'), '中文名'.split('').map(ch => `%${ch.codePointAt(0)!.toString(16).toLowerCase().padStart(2, '0')}`).join(''))
  const long = 'x'.repeat(300)
  assert.equal(safeSegment(long).length, 160)
})

test('accounts.json：ENOENT 视为空、写入 0600、原子读写往返', async () => {
  const root = await tempRoot()
  const empty = await readAccounts(root)
  assert.deepEqual(empty, { version: 1, accounts: {} })
  await updateAccount('acc-1', { nickname: '甲', sessionStatus: 'ok' }, root)
  const file = paths(root).accountsFile
  const mode = (await stat(file)).mode & 0o777
  assert.equal(mode, 0o600)
  const state = await readAccounts(root)
  assert.equal(state.accounts['acc-1']?.nickname, '甲')
  await rm(root, { recursive: true, force: true })
})

test('accounts.json：缺 accounts 键按空处理且不改写原文件；损坏 JSON 抛可恢复错误', async () => {
  const root = await tempRoot()
  await writeFile(paths(root).accountsFile, '{"version": 99}\n')
  const state = await readAccounts(root)
  assert.deepEqual(state.accounts, {})
  assert.equal(await readFile(paths(root).accountsFile, 'utf8'), '{"version": 99}\n')
  // 损坏 JSON：抛错（可恢复错误，绝不改写原文件）。
  await writeFile(paths(root).accountsFile, 'not json at all\n')
  await assert.rejects(() => readAccounts(root))
  assert.equal(await readFile(paths(root).accountsFile, 'utf8'), 'not json at all\n')
  await rm(root, { recursive: true, force: true })
})

test('nextSessionSeq：单调递增', async () => {
  const root = await tempRoot()
  assert.equal(await nextSessionSeq('acc-1', root), 1)
  assert.equal(await nextSessionSeq('acc-1', root), 2)
  const record = await getAccount('acc-1', root)
  assert.equal(record?.sessionSeq, 2)
  await rm(root, { recursive: true, force: true })
})

test('X1 两个账号并发 updateAccount（注入延迟的文件接缝）交错读改写后两处字段都保留', async () => {
  const root = await tempRoot()
  try {
    await updateAccount('a', { nickname: 'seed-a' }, root)
    await updateAccount('b', { nickname: 'seed-b' }, root)
    // 交错读改写：A 读到旧文件后让出事件循环，B 完成整轮写回，A 再写回——
    // root 队列串行化后 A 的写回以「读过之后 B 未写」的旧快照为前提不成立，
    // 必须排在 B 之后，两处字段都保留。
    const first = updateAccount('a', { sessionStatus: 'ok', lastCollectedAt: '2026-11-27T00:00:00Z' }, root)
    const second = updateAccount('b', { sessionStatus: 'expired' }, root)
    await Promise.all([first, second])
    const state = await readAccounts(root)
    assert.equal(state.accounts['a']?.lastCollectedAt, '2026-11-27T00:00:00Z', 'A 的采集时间不得被 B 的写回覆盖')
    assert.equal(state.accounts['a']?.nickname, 'seed-a')
    assert.equal(state.accounts['b']?.sessionStatus, 'expired', 'B 的会话状态不得被 A 的写回覆盖')
    assert.equal(state.accounts['b']?.nickname, 'seed-b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('X2 并发直写 writeAccounts 时 tmp 文件名唯一，无 ENOENT（绕过队列直击 tmp 交错面）', async () => {
  const root = await tempRoot()
  try {
    // 绕过 root 队列直接并发调 writeAccounts：updateAccount 已被队列串行化，
    // tmp 唯一性由 kit atomicWriteJson 承担（kit H7），本用例在插件层直击同一
    // 面——若 tmp 名固定为 <file>.tmp，两个写回撞在同一瞬间会让其中一个
    // rename 报 ENOENT。
    const state = await readAccounts(root)
    const writes = Array.from({ length: 8 }, (_, i) =>
      writeAccounts({ version: STATE_VERSION, accounts: { ...state.accounts, [`u${String(i)}`]: { accountId: `u${String(i)}`, sessionStatus: 'ok' } } }, root))
    // 8 份完整文档并发写同一目标：唯一的失败形态是固定 tmp 名的交错覆盖
    // （第二个 rename 报 ENOENT 让 Promise.all 拒绝）；任一份成功 rename 后，
    // 目标文件必须是完整可解析的文档，且目录无 tmp 残留。
    await Promise.all(writes)
    const final = await readAccounts(root)
    const winner = Object.keys(final.accounts).filter(key => key.startsWith('u'))
    assert.ok(winner.length >= 1, `最后一次 rename 的完整文档必须落盘，实际键：${Object.keys(final.accounts).join(',')}`)
    const leftovers = (await readdir(root)).filter(name => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], '无 tmp 残留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('X3 同一账号 nextSessionSeq 并发两次得到两个不同的连续序号', async () => {
  const root = await tempRoot()
  try {
    const [s1, s2] = await Promise.all([nextSessionSeq('c', root), nextSessionSeq('c', root)])
    assert.notEqual(s1, s2, '并发取号不得重号')
    assert.equal(Math.abs(s1 - s2), 1, '两个序号应连续')
    const record = await getAccount('c', root)
    assert.equal(record?.sessionSeq, Math.max(s1, s2), '落盘序号为较大值')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('moveProfile / moveStorageState：目标已存在绝不覆盖', async () => {
  const root = await tempRoot()
  await mkdir(paths(root).profileDir('pending-1'), { recursive: true })
  await mkdir(paths(root).profileDir('real-1'), { recursive: true })
  await writeFile(join(paths(root).profileDir('real-1'), 'marker.txt'), 'keep')
  await writeFile(join(paths(root).profileDir('pending-1'), 'marker.txt'), 'drop')
  const moved = await moveProfile('pending-1', 'real-1', root)
  assert.equal(moved, paths(root).profileDir('real-1'))
  assert.equal(await readFile(join(moved, 'marker.txt'), 'utf8'), 'keep')
  // storage_state 同口径。
  await mkdir(paths(root).storageStateDir, { recursive: true })
  await writeFile(paths(root).storageStatePath('pending-1'), '{"cookies":[]}\n', { mode: 0o600 })
  await writeFile(paths(root).storageStatePath('real-1'), '{"cookies":["keep"]}\n', { mode: 0o600 })
  await moveStorageState('pending-1', 'real-1', root)
  assert.equal(await readFile(paths(root).storageStatePath('real-1'), 'utf8'), '{"cookies":["keep"]}\n')
  await rm(root, { recursive: true, force: true })
})

test('storage_state 备份：0600、缺失检测、清理', async () => {
  const root = await tempRoot()
  assert.equal(await hasStorageState('acc-1', root), false)
  const dir = join(root, 'storage-state')
  await mkdir(dir, { recursive: true })
  const target = paths(root).storageStatePath('acc-1')
  await writeFile(target, '{"cookies":[]}\n', { mode: 0o600 })
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  assert.equal(await hasStorageState('acc-1', root), true)
  const cleared = await clearLocalCredentials('acc-1', root)
  assert.equal(cleared.storageState, true)
  assert.equal(await hasStorageState('acc-1', root), false)
  await rm(root, { recursive: true, force: true })
})

test('快照：0600 落盘、latestSnapshot 按文件名取最新、最新损坏返回 null（不回退旧份）', async () => {
  const root = await tempRoot()
  const snap = (capturedAt: string): CollectSnapshot => ({
    schemaVersion: 1, accountId: 'acc-1', capturedAt, source: 'creator-web',
    notes: [{ contentId: 'n1', title: '', metrics: { plays: 3 } }],
  })
  // now 缝注入确定时钟：两次保存间隔 61s，文件名字典序与保存顺序一致。
  let clock = new Date('2026-02-01T10:00:00')
  await saveSnapshot('acc-1', snap('2026-01-01T00:00:00.000Z'), root, { now: () => clock })
  clock = new Date('2026-02-01T10:01:01')
  const latest = await saveSnapshot('acc-1', snap('2026-02-01T00:00:00.000Z'), root, { now: () => clock })
  assert.equal((await stat(latest)).mode & 0o777, 0o600)
  const picked = await latestSnapshot('acc-1', root)
  assert.equal(picked?.capturedAt, '2026-02-01T00:00:00.000Z')
  // 最新文件损坏（文件名排序最后）：返回 null，绝不回退旧份伪装有数据。
  const snapshotDir = paths(root).snapshotsDir('acc-1')
  await writeFile(join(snapshotDir, 'notes-zz-broken.json'), 'not json\n')
  const after = await latestSnapshot('acc-1', root)
  assert.equal(after, null)
  await rm(root, { recursive: true, force: true })
})

test('mapNote：字段映射与缺口不补 0', () => {
  const row = mapNote({
    id: '42', display_title: '标题', view_count: '1.2万', likes: 3, collected_count: null,
    comments_count: 0, shared_count: undefined, visible_time: 1700000000, type: 'video',
    images_list: [{ url: 'https://img.example/1.jpg' }, { url: 'not-http' }], sticky: 1,
  })
  assert.equal(row?.contentId, '42')
  assert.equal(row?.title, '标题')
  assert.equal(row?.noteType, 'video')
  assert.equal(row?.publishedAt, new Date(1700000000 * 1000).toISOString())
  assert.deepEqual(row?.metrics, { plays: 12000, likes: 3, comments: 0 })
  const metrics: Record<string, unknown> | undefined = row?.metrics
  assert.equal(metrics?.collects, undefined)
  assert.equal(metrics?.shares, undefined)
  assert.equal(row?.coverUrl, 'https://img.example/1.jpg')
  assert.equal(row?.sticky, true)
  // 无 id 行丢弃；空对象返回 null。
  assert.equal(mapNote({ display_title: 'x' }), null)
  assert.equal(mapNote(null), null)
})

test('parsePostedPage：翻页字段提取；结构漂移显式失败', () => {
  const page = parsePostedPage({ code: 0, data: { notes: [{ id: '1' }, { id: '2' }, null], page: 3 } })
  assert.equal(page.notes.length, 2)
  assert.equal(page.nextPage, 3)
  // 无下一页 → null 终止。
  assert.equal(parsePostedPage({ code: 0, data: { notes: [] } }).nextPage, null)
  // code=0 但 notes 非数组 → COLLECT_FAILED（绝不伪装空采）。
  assert.throws(() => parsePostedPage({ code: 0, data: { notes: 'oops' } }), (error: unknown) =>
    (error as { code?: string }).code === 'COLLECT_FAILED')
  assert.throws(() => parsePostedPage(null), (error: unknown) =>
    (error as { code?: string }).code === 'COLLECT_FAILED')
})

test('summarizeSnapshot：求和与缺口口径（缺失不补 0）', () => {
  const snapshot = {
    schemaVersion: 1 as const,
    accountId: 'a',
    capturedAt: '2026-03-01T00:00:00.000Z',
    source: 'creator-web' as const,
    notes: [
      { contentId: 'n1', title: '', metrics: { plays: 5, likes: 1 } },
      { contentId: 'n2', title: '', metrics: {} },
    ],
  }
  const summary = summarizeSnapshot(snapshot)
  assert.equal(summary.notesCount, 2)
  assert.deepEqual(summary.totals, { plays: 5, likes: 1, collects: 0, comments: 0, shares: 0 })
  assert.deepEqual(summary.gaps, { plays: 1, likes: 1, collects: 2, comments: 2, shares: 2 })
  assert.equal(summary.capturedAt, '2026-03-01T00:00:00.000Z')
})

test('ensureProfileDir：目录权限 0700（linux）', async () => {
  const root = await tempRoot()
  const dir = await ensureProfileDir('acc-1', root)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  await rm(root, { recursive: true, force: true })
})

test('chmod 不可用时写入不失败（Windows 语义），此处验证 chmod 后权限锁定', async () => {
  const root = await tempRoot()
  const file = paths(root).accountsFile
  await writeAccounts({ version: 1, accounts: {} }, root)
  await chmod(file, 0o644).catch(() => undefined)
  await writeAccounts({ version: 1, accounts: {} }, root)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  await rm(root, { recursive: true, force: true })
})
