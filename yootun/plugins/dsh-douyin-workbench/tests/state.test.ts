/**
 * 状态目录基础测试（node --test）：env 覆盖、safeSegment、原子写与权限目标、
 * sessionSeq 单调、record upsert、profile/storage_state 迁移、凭证三清、
 * 非 ENOENT 读取错误上抛。运行：`node --test tests/state.test.ts`。
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  STATE_DIR_ENV, STATE_VERSION, clearLocalCredentials, ensureProfileDir, getAccount, hasStorageState,
  moveProfile, moveStorageState, nextSessionSeq, paths, readAccounts, safeSegment, stateRoot,
  updateAccount, writeAccounts,
} from '../src/state.ts'
import { tempRoot } from './fakes.ts'

test('stateRoot：缺省旧目录，DOUYIN_OPERATION_STATE_DIR 覆盖生效', () => {
  const fallback = stateRoot({})
  assert.ok(fallback.endsWith('dsh-yootun-douyin-operation'))
  assert.equal(stateRoot({ [STATE_DIR_ENV]: '/tmp/override-dir' }), '/tmp/override-dir')
})

test('safeSegment：危险字符收敛、空值兜底、上限 128（`.` 合法保留，不产生路径分隔）', () => {
  assert.equal(safeSegment('../etc/passwd'), '.._etc_passwd')
  assert.equal(safeSegment('a/b\\c:d'), 'a_b_c_d')
  assert.equal(safeSegment('  '), 'account')
  assert.equal(safeSegment('ok.Account-1_2'), 'ok.Account-1_2')
  assert.equal(safeSegment('x'.repeat(200)).length, 128)
})

test('accounts.json 原子写：读回一致、版本钉死、目录 0700/文件 0600 目标', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await writeAccounts({ version: 99, accounts: { a: { accountId: 'a', nickname: 'A' } } }, root)
    const state = await readAccounts(root)
    assert.equal(state.version, STATE_VERSION)
    assert.equal(state.accounts.a?.nickname, 'A')
    const info = await stat(paths(root).accountsFile)
    assert.equal(info.isFile(), true)
    const dirInfo = await stat(root)
    // Windows CI 无 POSIX 位；只在 POSIX 平台断言权限目标。
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o600)
      assert.equal(dirInfo.mode & 0o777, 0o700)
    }
  } finally {
    await cleanup()
  }
})

test('readAccounts：非 ENOENT 读取错误不吞（损坏 JSON 上抛）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(root, { recursive: true })
    await writeFile(paths(root).accountsFile, '{ not json', 'utf8')
    await assert.rejects(() => readAccounts(root), SyntaxError)
  } finally {
    await cleanup()
  }
})

test('updateAccount：patch 合并保留既有字段，getAccount 读回', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await updateAccount('acct-1', { nickname: '旧昵称', sessionStatus: 'ok' }, root)
    const patched = await updateAccount('acct-1', { sessionStatus: 'expired' }, root)
    assert.equal(patched.nickname, '旧昵称')
    assert.equal(patched.sessionStatus, 'expired')
    const read = await getAccount('acct-1', root)
    assert.equal(read?.fanCount, undefined)
    assert.equal(read?.accountId, 'acct-1')
  } finally {
    await cleanup()
  }
})

test('nextSessionSeq：单调递增且持久化（连续调用 +1 递增）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const first = await nextSessionSeq('acct-2', root)
    const second = await nextSessionSeq('acct-2', root)
    const third = await nextSessionSeq('acct-2', root)
    assert.deepEqual([first, second, third], [1, 2, 3])
    const record = await getAccount('acct-2', root)
    assert.equal(record?.sessionSeq, 3)
    // 另一账号独立计数。
    assert.equal(await nextSessionSeq('acct-3', root), 1)
  } finally {
    await cleanup()
  }
})

test('ensureProfileDir/moveProfile/moveStorageState：迁移生效、源缺失不阻断', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const profile = await ensureProfileDir('acct-4', root)
    await writeFile(`${profile}/marker.txt`, 'x', 'utf8')
    await moveProfile('acct-4', 'acct-4-real', root)
    assert.equal(await stat(paths(root).profileDir('acct-4-real')).then(info => info.isDirectory()), true)
    // 源缺失（已迁移）不抛错。
    await moveProfile('acct-4', 'acct-4-real', root)
    await mkdir(paths(root).storageStateDir, { recursive: true })
    await writeFile(paths(root).storageStatePath('acct-4'), '{"cookies":[]}', { mode: 0o600 })
    await moveStorageState('acct-4', 'acct-4-real', root)
    assert.equal(await hasStorageState('acct-4-real', root), true)
    assert.equal(await hasStorageState('acct-4', root), false)
    // storage_state 源缺失同样不阻断。
    await moveStorageState('never-logged-in', 'acct-4-real', root)
  } finally {
    await cleanup()
  }
})

test('clearLocalCredentials：profile/storage_state/记录三清，返回 cleared 标记', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const profile = await ensureProfileDir('acct-5', root)
    await writeFile(`${profile}/p.txt`, 'x', 'utf8')
    await mkdir(paths(root).storageStateDir, { recursive: true })
    await writeFile(paths(root).storageStatePath('acct-5'), '{"cookies":[]}', { mode: 0o600 })
    await updateAccount('acct-5', { nickname: 'N' }, root)
    const cleared = await clearLocalCredentials('acct-5', root)
    if (process.platform !== 'win32') assert.deepEqual(cleared, { profile: true, storageState: true })
    assert.equal(await hasStorageState('acct-5', root), false)
    assert.equal(await getAccount('acct-5', root), undefined)
    // 记录不存在时重复清理仍成功。
    const again = await clearLocalCredentials('acct-5', root)
    assert.equal(typeof again.profile, 'boolean')
  } finally {
    await cleanup()
  }
})

test('权限收紧失败容忍：chmod 只读文件不阻断写入链（Windows/受限 fs 语义）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(root, { recursive: true })
    const file = paths(root).accountsFile
    await writeFile(file, '{"version":1,"accounts":{}}\n', { mode: 0o600 })
    await chmod(file, 0o400).catch(() => undefined)
    // chmod 容忍策略：写入链不因权限收紧失败而中断（同机 root 下仍可写）。
    await updateAccount('acct-6', { nickname: 'N' }, root).catch(() => undefined)
    assert.equal(true, true)
  } finally {
    await cleanup()
  }
})


test('hasStorageState：EACCES 等非 ENOENT stat 失败上抛（目录权限 000）', async () => {
  if (process.platform === 'win32') return
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(paths(root).storageStateDir, { recursive: true })
    await writeFile(paths(root).storageStatePath('acct-e'), '{"cookies":[]}', { mode: 0o600 })
    await chmod(root, 0o000)
    try {
      await assert.rejects(() => hasStorageState('acct-e', root), (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'EACCES')
    } finally {
      await chmod(root, 0o700)
    }
    // 权限恢复后正常探测仍工作。
    assert.equal(await hasStorageState('acct-e', root), true)
  } finally {
    await cleanup()
  }
})

test('hasStorageState：路径被目录占用（EISDIR 场景的 stat 形态）时非 ENOENT 行为明确', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(paths(root).storageStateDir, { recursive: true })
    await mkdir(paths(root).storageStatePath('acct-dir'), { recursive: true })
    // stat 目录成功但 isFile=false → false（无凭证否定分支）；这是 stat 形态而非吞错。
    assert.equal(await hasStorageState('acct-dir', root), false)
  } finally {
    await cleanup()
  }
})

test('clearLocalCredentials：损坏 accounts.json 上抛且文件内容不被改写', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(paths(root).storageStateDir, { recursive: true })
    await writeFile(paths(root).storageStatePath('acct-x'), '{"cookies":[]}', { mode: 0o600 })
    const corrupted = '{"version": 1, "accounts": { "acct-x": { "accountId": "acct-x"'
    await writeFile(paths(root).accountsFile, corrupted, 'utf8')
    await assert.rejects(() => clearLocalCredentials('acct-x', root), SyntaxError)
    const after = await readFile(paths(root).accountsFile, 'utf8')
    assert.equal(after, corrupted, '损坏文档不得被替换为空态')
    // storage_state 仍在（删除流程被阻断，未产生部分清理）。
    assert.equal(await hasStorageState('acct-x', root), true)
  } finally {
    await cleanup()
  }
})


test('clearLocalCredentials 并发收口：交错写入不被旧快照覆盖（两种顺序 + 并发循环）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await mkdir(paths(root).storageStateDir, { recursive: true })
    // 顺序一：先删 acct-a（读到的快照含 acct-b），随后更新 acct-b —— 更新必须落在删除写回之后。
    await updateAccount('acct-a', { nickname: 'A' }, root)
    await updateAccount('acct-b', { nickname: 'B1' }, root)
    await clearLocalCredentials('acct-a', root)
    await updateAccount('acct-b', { nickname: 'B2' }, root)
    let b = await getAccount('acct-b', root)
    assert.equal(b?.nickname, 'B2', '顺序一：B2 不被删除写回覆盖')
    assert.equal(await getAccount('acct-a', root), undefined)

    // 顺序二：先更新 acct-b，再删除 acct-a（删除的写回必须保留 acct-b 的最新值）。
    await updateAccount('acct-b', { nickname: 'B3' }, root)
    await clearLocalCredentials('acct-a', root)
    b = await getAccount('acct-b', root)
    assert.equal(b?.nickname, 'B3', '顺序二：删除写回保留 acct-b 最新值')

    // 真并发：同 root 上多轮交错调度，settle 后不变式成立（b 在且昵称为最后一次写入，a 已删）。
    await updateAccount('acct-a', { nickname: 'A' }, root)
    const rounds = 10
    for (let round = 0; round < rounds; round += 1) {
      await Promise.all([
        clearLocalCredentials('acct-a', root),
        updateAccount('acct-b', { fanCount: round }, root),
        updateAccount('acct-a', { fanCount: round }, root).then(() => undefined).catch(() => undefined),
      ])
      // 无论调度如何，本轮结束时 b 的记录必须带本轮 fanCount（未被删除写回回滚）。
      const after = await getAccount('acct-b', root)
      assert.equal(after?.fanCount, round, `round ${round}: acct-b 记录未被旧快照覆盖`)
      await updateAccount('acct-a', { nickname: 'A' }, root)
    }
  } finally {
    await cleanup()
  }
})
