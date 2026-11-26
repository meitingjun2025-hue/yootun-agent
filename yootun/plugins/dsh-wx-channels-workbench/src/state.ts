/**
 * 设备端本地状态（移植旧 state.js 全语义）：每账号独立 Chrome profile、
 * storage_state（0600）、会话序号单调递增、accounts.json 按 root 串行读写。
 * 目录沿用旧路径（升级免重扫）；Cookie 与 storage_state 只留设备端，绝不进入
 * 响应、日志、tools 参数或审计。
 * @module
 */
import { access, chmod, constants, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { atomicWriteJson, runInRootQueue } from '@yootun/dsh-workbench-host-kit'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 状态文件结构版本。 */
export const STATE_VERSION = 1
/** 状态目录环境覆盖（沿用旧名，升级免迁移）。 */
export const STATE_DIR_ENV = 'WX_CHANNELS_OPERATION_STATE_DIR'

/**
 * Resolve the state root: env override (absolute) or the legacy home path.
 * @param env - environment (test injection).
 * @returns the absolute state root directory.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV]
  if (override) return resolve(override)
  return join(homedir(), '.dofe', 'dsh-yootun-wx-channels-operation')
}

/** State layout for one root. */
export interface StatePaths {
  root: string
  accountsFile: string
  profilesDir: string
  storageStateDir: string
  runsFile: string
  profileDir: (accountId: string) => string
  storageStatePath: (accountId: string) => string
  /** vault:// 不透明引用（tools 只收到它，绝不收到真实路径）。 */
  vaultRef: (accountId: string) => string
}

/**
 * Build the state layout for one root.
 * @param root - state root directory.
 * @returns the layout.
 */
export function paths(root: string): StatePaths {
  return {
    root,
    accountsFile: join(root, 'accounts.json'),
    profilesDir: join(root, 'profiles'),
    storageStateDir: join(root, 'storage-state'),
    runsFile: join(root, 'runs.json'),
    profileDir: accountId => join(root, 'profiles', safeSegment(accountId)),
    storageStatePath: accountId => join(root, 'storage-state', `${safeSegment(accountId)}.json`),
    vaultRef: accountId => `vault://wx-channels/${accountId}`,
  }
}

/**
 * Collapse an account id (untrusted charset from the platform side) into a
 * safe path segment before touching the disk.
 * @param value - raw account id.
 * @returns the sanitized segment.
 */
export function safeSegment(value: string): string {
  const cleaned = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return cleaned || 'account'
}

async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch (error: unknown) {
    // Windows 上 chmod 语义有限，忽略。
    void error
  }
}

/** One locally known account record (legacy accounts.json shape; never contains cookies). */
export interface AccountRecord {
  accountId: string
  nickname?: string | undefined
  avatar?: string | undefined
  feedCount?: number | undefined
  followerTotalCount?: number | undefined
  sessionStatus?: string | undefined
  sessionCheckedAt?: string | undefined
  sessionSeq?: number | undefined
  heartbeatSeq?: number | undefined
  runAttemptId?: string | undefined
  runId?: string | undefined
  lastCollectedAt?: string | undefined
  lastLoginAt?: string | undefined
  promotedFrom?: string | undefined
  vaultRef?: string | undefined
  isMasterFinder?: boolean | undefined
}

/** The persisted accounts document. */
export interface AccountsState {
  version: number
  accounts: Record<string, AccountRecord>
}

function emptyState(): AccountsState {
  return { version: STATE_VERSION, accounts: {} }
}

/**
 * Read accounts.json (legacy-compatible): a missing file is an empty state; an
 * unreadable/corrupt file is preserved untouched and surfaces as a recoverable
 * error (never rewritten by the reader).
 * @param root - state root directory.
 * @returns the parsed state.
 * @throws the raw read/parse error for corrupt files (caller projects it).
 */
export async function readAccounts(root: string = stateRoot()): Promise<AccountsState> {
  const file = paths(root).accountsFile
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(parsed as { accounts?: unknown }).accounts) {
      return emptyState()
    }
    return { version: STATE_VERSION, accounts: (parsed as { accounts: Record<string, AccountRecord> }).accounts }
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

/**
 * Persist the whole accounts document (0700 dirs, file under the guarded root).
 * @param state - the document to write.
 * @param root - state root directory.
 */
export async function writeAccounts(state: AccountsState, root: string = stateRoot()): Promise<void> {
  return runInRootQueue(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    await atomicWriteJson(file, state)
  })
}

/**
 * Read one account record.
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns the record, or undefined when absent.
 */
export async function getAccount(accountId: string, root: string = stateRoot()): Promise<AccountRecord | undefined> {
  const state = await readAccounts(root)
  return state.accounts[accountId]
}

/**
 * Patch one account record (read-modify-write under the root lock).
 * @param accountId - account id.
 * @param patch - fields to merge.
 * @param root - state root directory.
 * @returns the patched record.
 */
export async function updateAccount(accountId: string, patch: Partial<AccountRecord>, root: string = stateRoot()): Promise<AccountRecord> {
  return runInRootQueue(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    let state = emptyState()
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { accounts?: unknown }).accounts) {
        state = { version: STATE_VERSION, accounts: (parsed as { accounts: Record<string, AccountRecord> }).accounts }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = state.accounts[accountId] ?? { accountId }
    const merged: AccountRecord = { ...previous, ...patch, accountId }
    state.accounts[accountId] = merged
    await atomicWriteJson(file, state)
    return merged
  })
}

/**
 * Bump the account's session sequence (monotonic; server rejects regressions).
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns the new sequence number.
 */
export async function bumpSessionSeq(accountId: string, root: string = stateRoot()): Promise<number> {
  // 单次持锁完成读-改-写（内部不得再调 updateAccount 等持锁入口，否则同 root 死锁）。
  return runInRootQueue(root, async () => {
    const file = paths(root).accountsFile
    let accounts: Record<string, AccountRecord> = {}
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { accounts?: unknown }).accounts) {
        accounts = (parsed as { accounts: Record<string, AccountRecord> }).accounts
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = accounts[accountId] ?? { accountId }
    const next = Number(previous.sessionSeq ?? 0) + 1
    accounts[accountId] = { ...previous, sessionSeq: next, accountId }
    await atomicWriteJson(file, { version: STATE_VERSION, accounts })
    return next
  })
}

/**
 * Next session sequence without persisting (for callers that persist together
 * with another patch).
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns the next sequence number.
 */
export async function nextSessionSeq(accountId: string, root: string = stateRoot()): Promise<number> {
  const record = await getAccount(accountId, root).catch(() => undefined)
  return Number(record?.sessionSeq ?? 0) + 1
}

/**
 * Bump the sequence while applying a profile patch in the same locked write
 * (login/promote: 两次 RMW 会让 seq 回退，定序与资料必须同锁)；`floor` 下限对齐
 * 多设备远端 seq。
 * @param accountId - account id.
 * @param patch - profile patch applied together with the sequence bump.
 * @param floor - minimum sequence (remote floor).
 * @param root - state root directory.
 * @returns the patched record and the new sequence.
 */
export async function bumpSessionSeqWith(
  accountId: string,
  patch: Partial<AccountRecord>,
  floor = 0,
  root: string = stateRoot(),
): Promise<{ record: AccountRecord; seq: number }> {
  return runInRootQueue(root, async () => {
    const file = paths(root).accountsFile
    let accounts: Record<string, AccountRecord> = {}
    try {
      const raw = await readFile(file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { accounts?: unknown }).accounts) {
        accounts = (parsed as { accounts: Record<string, AccountRecord> }).accounts
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = accounts[accountId] ?? { accountId }
    const previousSeq = Number(previous.sessionSeq ?? 0)
    const seq = Math.max(previousSeq, floor) + 1
    const record: AccountRecord = { ...previous, ...patch, sessionSeq: seq, accountId }
    accounts[accountId] = record
    await atomicWriteJson(file, { version: STATE_VERSION, accounts })
    return { record, seq }
  })
}

/**
 * Ensure the account's private Chrome profile directory (0700).
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns the profile directory path.
 */
export async function ensureProfileDir(accountId: string, root: string = stateRoot()): Promise<string> {
  const dir = paths(root).profileDir(accountId)
  await ensureDir(dir)
  return dir
}

/** Copy a directory tree recursively (profile move). */
async function copyTree(from: string, to: string): Promise<void> {
  await ensureDir(to)
  const entries = await readdirSafe(from)
  for (const entry of entries) {
    const source = join(from, entry)
    const target = join(to, entry)
    const info = await stat(source)
    if (info.isDirectory()) await copyTree(source, target)
    else await copyFile(source, target, info.mode)
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await import('node:fs').then(fs => fs.readdirSync(dir))
  } catch (error: unknown) {
    // 目录不存在/不可读：视为空（profile 尚未创建是正常态）。
    void error
    return []
  }
}

/**
 * Rename (or copy across devices) one account's profile dir to another id.
 * @param fromAccountId - source account id.
 * @param toAccountId - target account id.
 * @param root - state root directory.
 */
export async function moveProfile(fromAccountId: string, toAccountId: string, root: string = stateRoot()): Promise<void> {
  const layout = paths(root)
  const from = layout.profileDir(fromAccountId)
  const to = layout.profileDir(toAccountId)
  try {
    await access(from, constants.X_OK)
  } catch (error: unknown) {
    // 源不存在：无可迁移（与旧版 ENOENT 分支一致）。
    void error
    return
  }
  // 目标已存在（对已有账号重新扫码/重试 promote）：备份→迁移→失败回滚
  // （旧 state.js P3-24：POSIX rename 到非空目录抛 ENOTEMPTY，直接抛会让登录
  // 半途失败并遗留 pending 目录）。
  const backup = `${to}.bak-${String(Date.now())}`
  let moved = false
  try {
    try {
      await access(to, constants.X_OK)
      await rename(to, backup)
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw backupError
    }
    try {
      await rename(from, to)
      moved = true
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyTree(from, to)
        await rm(from, { recursive: true, force: true })
        moved = true
      } else {
        throw moveError
      }
    }
  } finally {
    if (moved) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    else await rename(backup, to).catch(() => undefined) // 回滚：保留原账号 profile。
  }
}

/**
 * Rename (or copy across devices) one account's storage_state file.
 * @param fromAccountId - source account id.
 * @param toAccountId - target account id.
 * @param root - state root directory.
 */
export async function moveStorageState(fromAccountId: string, toAccountId: string, root: string = stateRoot()): Promise<void> {
  const layout = paths(root)
  const from = layout.storageStatePath(fromAccountId)
  const to = layout.storageStatePath(toAccountId)
  try {
    await ensureDir(dirname(to))
    await rename(from, to)
    await chmod(to, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(from, to)
      await chmod(to, 0o600)
      await rm(from, { force: true })
      return
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Persist the browser context's storage_state (0600) after a login/collect.
 * @param accountId - account id.
 * @param context - the Playwright BrowserContext (storageState() available).
 * @param root - state root directory.
 */
export async function saveStorageState(accountId: string, context: { storageState(): Promise<unknown> }, root: string = stateRoot()): Promise<void> {
  const file = paths(root).storageStatePath(accountId)
  await ensureDir(dirname(file))
  const state: unknown = await context.storageState()
  await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

/**
 * Whether the account has a local storage_state (delete-flow precondition).
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns whether the file exists.
 */
export async function hasStorageState(accountId: string, root: string = stateRoot()): Promise<boolean> {
  try {
    const info = await stat(paths(root).storageStatePath(accountId))
    return info.isFile() && info.size > 0
  } catch (error: unknown) {
    // 不存在即无凭证（删除前置检查的否定分支）。
    void error
    return false
  }
}

/**
 * Remove every local credential trace for the account: storage_state file,
 * profile dir, and its accounts.json record. Cookie/storage_state never leave
 * the device — this is the delete-flow step that must complete before any
 * remote deletion.
 * @param accountId - account id.
 * @param root - state root directory.
 */
export async function clearLocalCredentials(accountId: string, root: string = stateRoot()): Promise<void> {
  const layout = paths(root)
  // 逐项 force 删除；单项失败不阻断其余清理与记录删除（P2-3：避免「storage 已删、
  // profile 残留但记录仍在」的漂移——hasStorageState=false 时记录必须已同步移除）。
  await rm(layout.storageStatePath(accountId), { force: true })
  await rm(layout.profileDir(accountId), { recursive: true, force: true }).catch(() => undefined)
  await runInRootQueue(root, async () => {
    const state = await readAccounts(root).catch(() => emptyState())
    if (state.accounts[accountId] === undefined) return
    delete state.accounts[accountId]
    await atomicWriteJson(layout.accountsFile, state)
  })
}
