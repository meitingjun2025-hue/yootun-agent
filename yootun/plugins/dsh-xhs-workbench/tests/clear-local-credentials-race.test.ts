/**
 * clearLocalCredentials 与队列内写入并发不丢更新的回归（node --test；验收轮 1
 * 发现 F1 转正）：clearLocalCredentials（removeLocal 底层）的 accounts.json
 * 读-删-写已进入按 root 串行队列——与队列内 updateAccount 并发时（账号 A 采集
 * 收尾写 lastCollectedAt 的同时移除账号 B），任何一方的写回不得覆盖另一方。
 * 修复前本用例 40/40 次复现丢更新/复活已删账号；运行：
 * `node --test tests/clear-local-credentials-race.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clearLocalCredentials, readAccounts, updateAccount, type AccountsState } from '../src/state.ts'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'xhs-clearlocal-race-'))
}

async function seedTwoAccounts(root: string): Promise<void> {
  const state: AccountsState = {
    version: 1,
    accounts: {
      a: { accountId: 'a', sessionSeq: 1, sessionStatus: 'unknown', nickname: 'seed-a' },
      b: { accountId: 'b', sessionSeq: 1, sessionStatus: 'unknown', nickname: 'seed-b' },
    },
  }
  await writeFile(join(root, 'accounts.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

test('X4 clearLocalCredentials（root 队列内）与 updateAccount 并发不丢更新、不复活已删账号', async () => {
  const iterations = 40
  const corruptions: string[] = []
  for (let i = 0; i < iterations; i++) {
    const root = await tempRoot()
    try {
      await seedTwoAccounts(root)
      // 生产可达：A 采集收尾（collector.ts updateAccount lastCollectedAt）与
      // B 的 removeLocal（handlers tryWithProfileLock(B) → clearLocalCredentials）
      // 持不同 profile 锁，真实并发。
      await Promise.all([
        updateAccount('a', { sessionStatus: 'ok', lastCollectedAt: '2026-11-27T00:00:00Z' }, root),
        clearLocalCredentials('b', root),
      ])
      const state = await readAccounts(root)
      if (state.accounts['a']?.lastCollectedAt !== '2026-11-27T00:00:00Z') {
        corruptions.push(`#${i}: A 的 lastCollectedAt 被覆盖为 ${String(state.accounts['a']?.lastCollectedAt)}`)
      }
      if (state.accounts['b'] !== undefined) {
        corruptions.push(`#${i}: 已删除的账号 b 复活（sessionStatus=${String(state.accounts['b']?.sessionStatus)}）`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  assert.equal(corruptions.length, 0, `并发 ${iterations} 次中出现 ${corruptions.length} 次损坏（丢更新/复活已删账号）:\n${corruptions.slice(0, 5).join('\n')}`)
})
