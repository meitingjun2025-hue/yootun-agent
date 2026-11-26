/**
 * 登录/探测/采集流程测试（旧 session.js/collector.js 行为锁定）：Cookie 轮询、
 * 验证码即失败、资料缺失落 unknown、user/info 探测主口径与登录页兜底、
 * 显式重登复用账号 Profile、签名缺失 fail-loud、翻页终止与截断。
 * 运行：`node --test tests/session.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectNotes, CollectError, mapNote, parsePostedPage, summarizeSnapshot } from '../src/collector.ts'
import { createProfileLocks } from '@yootun/dsh-workbench-host-kit'
import {
  confirmSessionOnPage, loginWithQrCode, probeSession, readAccountProfileWithRetry,
  removeLocalAccount, waitForSessionCookie, isPendingAccountId,
} from '../src/session.ts'
import { hasStorageState, readAccounts } from '../src/state.ts'
import { createFakeChrome, postedPage, sessionCookie, userInfoPayload } from './fakes.ts'

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-session-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

async function seedStorageState(root: string, accountId: string): Promise<void> {
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', `${accountId}.json`), '{"cookies":[]}\n', { mode: 0o600 })
}

test('waitForSessionCookie：Cookie 命中即成功；验证码即失败；超时/中止退出', async () => {
  const root = await tempRoot()
  const { state, context, page } = createFakeChrome()
  state.url = 'https://creator.xiaohongshu.com/login'
  state.cookies = sessionCookie()
  const hit = await waitForSessionCookie(context, page, { timeoutMs: 1000 })
  assert.equal(hit.loggedIn, true)
  assert.equal(hit.cookieName, 'customerClientId')
  // 验证码出现：loggedIn=false + captcha=true。
  state.cookies = []
  state.captchaVisible = true
  const captcha = await waitForSessionCookie(context, page, { timeoutMs: 1000 })
  assert.equal(captcha.loggedIn, false)
  assert.equal(captcha.captcha, true)
  // 超时：deadline 先于下一次 sleep 命中。
  state.captchaVisible = false
  const timeout = await waitForSessionCookie(context, page, { timeoutMs: 1, intervalMs: 1 })
  assert.equal(timeout.loggedIn, false)
  assert.equal(timeout.captcha, false)
  // 中止：立即退出不等待。
  const controller = new AbortController()
  controller.abort()
  const aborted = await waitForSessionCookie(context, page, { timeoutMs: 1000, signal: controller.signal })
  assert.equal(aborted.loggedIn, false)
  await rm(root, { recursive: true, force: true })
})

test('waitForSessionCookie：新版创作者平台 web_session 签名命中（2026-11-20 live 校准）', async () => {
  const { state, context, page } = createFakeChrome()
  state.url = 'https://creator.xiaohongshu.com/login'
  // 新版登录只落根域 web_session/id_token（预登录阶段两者均不出现，无假阳性）。
  state.cookies = sessionCookie('web_session')
  const hit = await waitForSessionCookie(context, page, { timeoutMs: 1000 })
  assert.equal(hit.loggedIn, true)
  assert.equal(hit.cookieName, 'web_session')
  state.cookies = sessionCookie('id_token')
  const tokenHit = await waitForSessionCookie(context, page, { timeoutMs: 1000 })
  assert.equal(tokenHit.loggedIn, true)
  assert.equal(tokenHit.cookieName, 'id_token')
})

test('loginWithQrCode：pending 登录迁移到正式账号（Profile/备份/记录三落位）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.cookies = sessionCookie()
  fake.state.profileJson = userInfoPayload('real-9', '甲', 'https://cdn.example/9.png')
  const result = await loginWithQrCode({ root, chromeFactory: fake.factory, timeoutMs: 1000 })
  assert.equal(result.status, 'ok')
  assert.ok(result.status === 'ok')
  assert.equal(result.accountId, 'real-9')
  assert.equal(result.profilePending, false)
  // Profile 目录迁移 + 备份 + 账号记录。
  assert.ok(await hasStorageState('real-9', root))
  const accounts = await readAccounts(root)
  assert.equal(accounts.accounts['real-9']?.sessionStatus, 'ok')
  assert.equal(accounts.accounts['real-9']?.nickname, '甲')
  // 占位目录清理。
  const { readdir } = await import('node:fs/promises')
  const leftovers = (await readdir(join(root, 'profiles'))).filter(name => name.startsWith('pending-'))
  assert.deepEqual(leftovers, [])
  await rm(root, { recursive: true, force: true })
})

test('loginWithQrCode：Cookie 命中但资料不可读 → sessionStatus 落 unknown（不假成功）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.cookies = sessionCookie()
  fake.state.profileJson = null
  const result = await loginWithQrCode({ root, chromeFactory: fake.factory, timeoutMs: 1000 })
  assert.ok(result.status === 'ok')
  assert.equal(result.profilePending, true)
  const accounts = await readAccounts(root)
  assert.equal(accounts.accounts['real-9'], undefined)
  // 占位 ID 落账号记录（resolvedId 回退 tempId），状态 unknown。
  const entries = Object.values(accounts.accounts)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.sessionStatus, 'unknown')
  await rm(root, { recursive: true, force: true })
})

test('loginWithQrCode：超时关闭窗口且不写账号记录', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  const result = await loginWithQrCode({ root, chromeFactory: fake.factory, timeoutMs: 1 })
  assert.equal(result.status, 'timeout')
  assert.ok(fake.state.closeCount >= 1)
  assert.deepEqual(Object.keys((await readAccounts(root)).accounts), [])
  await rm(root, { recursive: true, force: true })
})

test('loginWithQrCode：验证码出现置 failed(CAPTCHA_DETECTED)，绝不绕过', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  // 无会话 Cookie 且验证码特征可见：轮询先于超时命中验证码（Cookie 命中优先的
  // 路径已由其他用例覆盖）。
  fake.state.cookies = []
  fake.state.captchaVisible = true
  const result = await loginWithQrCode({ root, chromeFactory: fake.factory, timeoutMs: 1000 })
  assert.equal(result.status, 'failed')
  assert.ok(result.status === 'failed')
  assert.equal(result.reason, 'CAPTCHA_DETECTED')
  await rm(root, { recursive: true, force: true })
})

test('loginWithQrCode：显式重登直接复用该账号 Profile（不迁移）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.cookies = sessionCookie()
  fake.state.profileJson = userInfoPayload('acc-re', null, null)
  const result = await loginWithQrCode({ accountId: 'acc-re', root, chromeFactory: fake.factory, timeoutMs: 1000 })
  assert.ok(result.status === 'ok')
  assert.equal(result.accountId, 'acc-re')
  // 备份落正式账号名下；无 pending 残留。
  assert.ok(await hasStorageState('acc-re', root))
  const { readdir } = await import('node:fs/promises')
  const leftovers = (await readdir(join(root, 'profiles'))).filter(name => name.startsWith('pending-'))
  assert.deepEqual(leftovers, [])
  await rm(root, { recursive: true, force: true })
})

test('loginWithQrCode：resolvedId 被占用时丢弃成果返回 PROFILE_BUSY（竞态防御）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.cookies = sessionCookie()
  fake.state.profileJson = userInfoPayload('real-busy', null, null)
  const locks = createProfileLocks()
  const release = locks.acquireProfileLock('real-busy')
  const result = await loginWithQrCode({
    root, chromeFactory: fake.factory, timeoutMs: 1000,
    isResolvedBusy: isProfileLockedInjectee,
  })
  release()
  assert.equal(result.status, 'failed')
  assert.ok(result.status === 'failed')
  assert.equal(result.reason, 'PROFILE_BUSY')
  assert.ok(fake.state.closeCount >= 1)
  // 既有正式账号记录未被本次扫码写入。
  assert.deepEqual(Object.keys((await readAccounts(root)).accounts), [])
  await rm(root, { recursive: true, force: true })
  function isProfileLockedInjectee(accountId: string): boolean {
    // 与 handlers 注入口径一致：real-busy 恒忙。
    return accountId === 'real-busy'
  }
})

test('loginWithQrCode：abort 中止等待并清理临时凭证', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  const controller = new AbortController()
  const run = loginWithQrCode({ root, chromeFactory: fake.factory, timeoutMs: 60_000, signal: controller.signal })
  controller.abort()
  const result = await run
  assert.equal(result.status, 'failed')
  assert.ok(result.status === 'failed')
  assert.equal(result.reason, 'login_aborted')
  const { readdir } = await import('node:fs/promises')
  let profiles: string[] = []
  try {
    profiles = await readdir(join(root, 'profiles'))
  } catch {
    profiles = []
  }
  assert.deepEqual(profiles.filter(name => name.startsWith('pending-')), [])
  await rm(root, { recursive: true, force: true })
})

test('probeSession：备份缺失不开浏览器直接 expired(storage_state_missing)', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  const result = await probeSession({ accountId: 'acc-none', root, chromeFactory: fake.factory })
  assert.equal(result.status, 'expired')
  assert.equal(result.reason, 'storage_state_missing')
  assert.equal(fake.state.closeCount, 0)
  await rm(root, { recursive: true, force: true })
})

test('probeSession：user/info 探测 ok 回写状态并刷新备份', async () => {
  const root = await tempRoot()
  await seedStorageState(root, 'acc-1')
  const fake = createFakeChrome()
  fake.state.profileJson = userInfoPayload('acc-1', '昵称', null)
  const result = await probeSession({ accountId: 'acc-1', root, chromeFactory: fake.factory })
  assert.equal(result.status, 'ok')
  assert.equal(result.profile?.accountId, 'acc-1')
  const accounts = await readAccounts(root)
  assert.equal(accounts.accounts['acc-1']?.sessionStatus, 'ok')
  assert.equal(accounts.accounts['acc-1']?.sessionSeq, 1)
  assert.ok(fake.storageWrites.length >= 1)
  await rm(root, { recursive: true, force: true })
})

test('probeSession：user/info 失败 → 登录页兜底 expired；无登录特征 → unknown', async () => {
  const root = await tempRoot()
  await seedStorageState(root, 'acc-exp')
  const fake = createFakeChrome()
  fake.state.profileJson = null
  fake.state.creatorRedirectsToLogin = true
  const expired = await probeSession({ accountId: 'acc-exp', root, chromeFactory: fake.factory })
  assert.equal(expired.status, 'expired')
  assert.equal(expired.reason, 'login_page_detected')
  // 无登录特征：unknown（不猜测）。
  await seedStorageState(root, 'acc-unk')
  const fake2 = createFakeChrome()
  fake2.state.profileJson = null
  const unknown = await probeSession({ accountId: 'acc-unk', root, chromeFactory: fake2.factory })
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.reason, 'user_info_unavailable')
  await rm(root, { recursive: true, force: true })
})

test('confirmSessionOnPage：ok 时资料回写账号（昵称/头像）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.url = 'https://creator.xiaohongshu.com/'
  fake.state.profileJson = userInfoPayload('acc-1', '甲', 'https://cdn.example/a.png')
  const verdict = await confirmSessionOnPage(fake.page, { accountId: 'acc-1', root })
  assert.equal(verdict.status, 'ok')
  assert.equal(verdict.profile?.nickname, '甲')
  const accounts = await readAccounts(root)
  assert.equal(accounts.accounts['acc-1']?.nickname, '甲')
  assert.equal(accounts.accounts['acc-1']?.avatar, 'https://cdn.example/a.png')
  await rm(root, { recursive: true, force: true })
})

test('readAccountProfileWithRetry：SPA 未就绪短重试后返回资料', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.evaluateError = new Error('spa not ready')
  const first = await readAccountProfileWithRetry(fake.page, { attempts: 2, delayMs: 1 })
  assert.equal(first, null)
  fake.state.evaluateError = null
  fake.state.profileJson = userInfoPayload('acc-1', null, null)
  const second = await readAccountProfileWithRetry(fake.page, { attempts: 2, delayMs: 1 })
  assert.equal(second?.accountId, 'acc-1')
  await rm(root, { recursive: true, force: true })
})

test('collectNotes：签名缺失 fail-loud（COLLECT_FAILED），绝不静默空采', async () => {
  const root = await tempRoot()
  await seedStorageState(root, 'acc-1')
  const fake = createFakeChrome()
  fake.state.signFunctionVisible = false
  await assert.rejects(
    () => collectNotes({ accountId: 'acc-1', root, chromeFactory: fake.factory }),
    (error: unknown) => (error as CollectError).code === 'COLLECT_FAILED',
  )
  await rm(root, { recursive: true, force: true })
})

test('collectNotes：翻页推进与空页终止；缺口不补 0', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  // collected_count 缺失 → 记缺口不补 0。
  fake.state.postedResponses.push(postedPage([{ id: 'n1', display_title: '一', view_count: 5, likes: 1, comments_count: 0, shared_count: 0, visible_time: 1700000000, type: 'video', images_list: [{ url: 'https://img.example/1.jpg' }] }], 1))
  fake.state.postedResponses.push(postedPage([], null))
  const result = await collectNotes({ accountId: 'acc-1', root, chromeFactory: fake.factory, sleepFn: async () => {} })
  assert.equal(result.pagesDone, 2)
  assert.equal(result.notesTotal, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.summary.totals.plays, 5)
  assert.equal(result.summary.totals.collects, 0)
  assert.equal(result.summary.gaps.collects, 1)
  // 快照落盘且 lastCollectedAt 回写。
  const accounts = await readAccounts(root)
  assert.ok(accounts.accounts['acc-1']?.lastCollectedAt)
  assert.ok(result.snapshotPath.startsWith(join(root, 'data', 'acc-1')))
  await rm(root, { recursive: true, force: true })
})

test('collectNotes：会话失效（登录框可见）抛 SESSION_EXPIRED', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.loginBoxVisible = true
  await assert.rejects(
    () => collectNotes({ accountId: 'acc-1', root, chromeFactory: fake.factory }),
    (error: unknown) => (error as CollectError).code === 'SESSION_EXPIRED',
  )
  await rm(root, { recursive: true, force: true })
})

test('collectNotes：页数上限触达且还有下一页 → truncated 可辨', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  // 每页都返回下一页号，2 页上限在第 2 页后截断。
  fake.state.postedResponses.push(postedPage([{ id: 'n1', display_title: '' }], 1))
  fake.state.postedResponses.push(postedPage([{ id: 'n2', display_title: '' }], 2))
  const result = await collectNotes({ accountId: 'acc-1', root, chromeFactory: fake.factory, maxPages: 2, sleepFn: async () => {} })
  assert.equal(result.truncated, true)
  assert.equal(result.pagesDone, 2)
  await rm(root, { recursive: true, force: true })
})

test('collectNotes：posted 业务码非 0 显式失败', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.postedResponses.push(JSON.stringify({ code: -1, data: { notes: [] } }))
  await assert.rejects(
    () => collectNotes({ accountId: 'acc-1', root, chromeFactory: fake.factory }),
    (error: unknown) => (error as CollectError).code === 'COLLECT_FAILED',
  )
  await rm(root, { recursive: true, force: true })
})

test('removeLocalAccount：幂等清除并披露 hadRecord', async () => {
  const root = await tempRoot()
  const first = await removeLocalAccount({ accountId: 'ghost', root })
  assert.equal(first.hadRecord, false)
  assert.equal(first.cleared.profile, true)
  await rm(root, { recursive: true, force: true })
})

test('parse/map/summarize 行为再锁定（collector 纯函数层）', () => {
  const row = mapNote({ id: '7', display_title: 't', likes: 2, comments_count: '3', sticky: true })
  assert.deepEqual(row?.metrics, { likes: 2, comments: 3 })
  const page = parsePostedPage({ code: 0, data: { notes: [{ id: '1' }], page: 2 } })
  assert.equal(page.nextPage, 2)
  const summary = summarizeSnapshot({ notes: [row], capturedAt: null })
  assert.equal(summary.totals.likes, 2)
  assert.equal(summary.capturedAt, null)
})

test('isPendingAccountId：pending 前缀识别', () => {
  assert.equal(isPendingAccountId('pending-123'), true)
  assert.equal(isPendingAccountId('acc-1'), false)
})
