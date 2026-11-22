/**
 * 设备端本地状态（分册 15 §5 冻结的旧 state.js 全语义）：每账号独立 Chrome
 * profile、storage_state（0600）、会话序号单调递增、accounts.json 按 root 串行
 * 原子写。目录沿用旧路径（升级免重扫）；Cookie 与 storage_state 只留设备端，
 * 绝不进入响应、日志、tools 参数或审计；tools 只收到 vault:// 不透明引用。
 * @module
 */
import { access, chmod, constants, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Storage-state 来源（Playwright BrowserContext 的最小投影）。 */
export interface StorageStateSource {
  /** Serialize the context's cookies + origins. */
  storageState(): Promise<unknown>
}

/** 状态文件结构版本（分册 15 §5：恒 1）。 */
export const STATE_VERSION = 1
/** 状态目录环境覆盖（沿用旧名，升级免迁移）。 */
export const STATE_DIR_ENV = 'DOUYIN_OPERATION_STATE_DIR'

/**
 * Resolve the state root: env override (absolute) or the legacy home path.
 * @param env - environment (test injection).
 * @returns the absolute state root directory.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV]
  if (override) return resolve(override)
  return join(homedir(), '.dofe', 'dsh-yootun-douyin-operation')
}

/** State layout for one root. */
export interface StatePaths {
  root: string
  accountsFile: string
  profilesDir: string
  storageStateDir: string
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
    profileDir: accountId => join(root, 'profiles', safeSegment(accountId)),
    storageStatePath: accountId => join(root, 'storage-state', `${safeSegment(accountId)}.json`),
    vaultRef: accountId => `vault://douyin/${safeSegment(accountId)}`,
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

/**
 * Atomic 0600 write: tmp(pid+rand) in the same directory → rename → chmod.
 * 同机多实例并发写时固定 tmp 名会被交错覆盖（wx P3-1 同款），pid+rand 隔离；
 * rename 保证半截文件永不出现在最终路径；chmod 失败容忍（Windows 语义有限）。
 */
async function atomicWrite0600(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => undefined)
}

async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch (error: unknown) {
    // Windows 上 chmod 语义有限，忽略（旧实现同口径）。
    void error
  }
}

/** One locally known account record (legacy accounts.json shape; never contains cookies). */
export interface AccountRecord {
  accountId: string
  sessionSeq?: number | undefined
  sessionStatus?: string | undefined
  sessionCheckedAt?: string | undefined
  nickname?: string | undefined
  avatar?: string | undefined
  fanCount?: number | undefined
  promotedFrom?: string | undefined
  lastLoginAt?: string | undefined
  vaultRef?: string | undefined
}

/** The persisted accounts document. */
export interface AccountsState {
  version: number
  accounts: Record<string, AccountRecord>
}

function emptyState(): AccountsState {
  return { version: STATE_VERSION, accounts: {} }
}

/** Per-root write queue: concurrent login/probe/report writes must not clobber sessionSeq ordering. */
const rootQueues = new Map<string, Promise<unknown>>()

/** Serialize a read-modify-write task per root. */
function withRootLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve()
  const current = previous.then(task, task)
  const release = current.catch(() => undefined).then(() => {
    // 空闲即回收 Map entry，避免动态 root 累积；新任务仍排在 release 之后，顺序不变。
    if (rootQueues.get(root) === release) rootQueues.delete(root)
  })
  rootQueues.set(root, release)
  return current
}

/** Parse a stored accounts document, tolerating only shape drift (never swallow I/O failures). */
function parseAccounts(raw: string): AccountsState {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(parsed as { accounts?: unknown }).accounts) {
    return emptyState()
  }
  return { version: STATE_VERSION, accounts: (parsed as { accounts: Record<string, AccountRecord> }).accounts }
}

/**
 * Read accounts.json (legacy-compatible): a missing file is an empty state; an
 * unreadable/corrupt file surfaces as a recoverable error and is never
 * rewritten by the reader（分册 15 §5：解析失败不得静默改成新空态）.
 * @param root - state root directory.
 * @returns the parsed state.
 * @throws the raw read/parse error for corrupt files (caller projects it).
 */
export async function readAccounts(root: string = stateRoot()): Promise<AccountsState> {
  const file = paths(root).accountsFile
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  return parseAccounts(raw)
}

/**
 * Persist the whole accounts document (0700 dirs, file 0600 under the guarded root).
 * @param state - the document to write.
 * @param root - state root directory.
 */
export async function writeAccounts(state: AccountsState, root: string = stateRoot()): Promise<void> {
  return withRootLock(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    await atomicWrite0600(file, `${JSON.stringify(state, null, 2)}\n`)
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
  return withRootLock(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    let state = emptyState()
    try {
      state = parseAccounts(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = state.accounts[accountId] ?? { accountId }
    const merged: AccountRecord = { ...previous, ...patch, accountId }
    state.accounts[accountId] = merged
    await atomicWrite0600(file, `${JSON.stringify(state, null, 2)}\n`)
    return merged
  })
}

/**
 * Allocate the account's next monotonic session sequence（旧 state.js 语义：
 * 设备端持久化自增，只增不减；上报给 tools 的 sessionSeq 天然拒绝乱序覆盖）.
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns the new sequence number.
 */
export async function nextSessionSeq(accountId: string, root: string = stateRoot()): Promise<number> {
  // 单次持锁完成读-改-写（锁内不得再调 updateAccount 等持锁入口，否则同 root 死锁）。
  return withRootLock(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    let state = emptyState()
    try {
      state = parseAccounts(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = state.accounts[accountId] ?? { accountId }
    const seq = Number(previous.sessionSeq ?? 0) + 1
    state.accounts[accountId] = { ...previous, sessionSeq: seq, accountId }
    await atomicWrite0600(file, `${JSON.stringify(state, null, 2)}\n`)
    return seq
  })
}

/**
 * Bump the session sequence while applying one profile patch in the same
 * locked write（旧 session.js markSessionOk 语义：序号与资料一次 RMW，两次
 * 分离写会让 seq 回退）；`floor` 把多设备推高的远端序号对齐为本地下限后再 +1
 * （不对齐则本地 ok 上报会被服务端按旧序号拒绝）。
 * @param accountId - account id.
 * @param patch - profile patch applied together with the bump.
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
  return withRootLock(root, async () => {
    const file = paths(root).accountsFile
    await ensureDir(dirname(file))
    let state = emptyState()
    try {
      state = parseAccounts(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previous: AccountRecord = state.accounts[accountId] ?? { accountId }
    const seq = Math.max(Number(previous.sessionSeq ?? 0), floor) + 1
    const record: AccountRecord = { ...previous, ...patch, sessionSeq: seq, accountId }
    state.accounts[accountId] = record
    await atomicWrite0600(file, `${JSON.stringify(state, null, 2)}\n`)
    return { record, seq }
  })
}

/**
 * Persist the context's storage_state backup (0600 file under 0700 dir).
 * 备份只在登录/探活仍持有登录态时写（上下文关闭后 Cookie 即不可得）。
 * @param accountId - account id.
 * @param context - the still-open browser context.
 * @param root - state root directory.
 */
export async function saveStorageState(accountId: string, context: StorageStateSource, root: string = stateRoot()): Promise<void> {
  const file = paths(root).storageStatePath(accountId)
  await ensureDir(dirname(file))
  const state: unknown = await context.storageState()
  await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
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

/**
 * Move one account's profile dir to another id（旧 state.js 语义：目标已存在先删，
 * 源缺失视为已迁移不阻断 pending- 升级）.
 * @param fromAccountId - source account id.
 * @param toAccountId - target account id.
 * @param root - state root directory.
 */
export async function moveProfile(fromAccountId: string, toAccountId: string, root: string = stateRoot()): Promise<void> {
  const layout = paths(root)
  const from = layout.profileDir(fromAccountId)
  const to = layout.profileDir(toAccountId)
  if (from === to) return
  // 目标清理失败必须上抛（不覆盖既有 profile，也不静默当作已迁移）。
  await rm(to, { recursive: true, force: true })
  try {
    await rename(from, to)
  } catch (error) {
    // 源目录不存在（pending- 占位的 profile 已被清理）：升级不阻断（旧 ENOENT 分支）。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Move one account's storage_state file to another id（旧 state.js 语义）.
 * @param fromAccountId - source account id.
 * @param toAccountId - target account id.
 * @param root - state root directory.
 */
export async function moveStorageState(fromAccountId: string, toAccountId: string, root: string = stateRoot()): Promise<void> {
  const layout = paths(root)
  const from = layout.storageStatePath(fromAccountId)
  const to = layout.storageStatePath(toAccountId)
  if (from === to) return
  try {
    await ensureDir(dirname(to))
    await rm(to, { force: true })
    await rename(from, to)
    await chmod(to, 0o600).catch(() => undefined)
  } catch (error) {
    // 源文件不存在（该账号从未落过登录态）：视为已迁移，不阻断升级（旧 ENOENT 分支）。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Whether the account has a local storage_state（删除流程/采集前置的否定分支）.
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns whether the file exists and is non-empty.
 */
export async function hasStorageState(accountId: string, root: string = stateRoot()): Promise<boolean> {
  try {
    const info = await stat(paths(root).storageStatePath(accountId))
    return info.isFile() && info.size > 0
  } catch (error) {
    // 仅 ENOENT 表示无凭证；EACCES/EISDIR 等其余 stat 失败一律上抛，不吞。
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Remove every local credential trace for the account: profile dir,
 * storage_state file, and its accounts.json record（删除状态机第 1 步；任一残留
 * 意味着设备上仍有可用登录态，返回的 cleared 布尔对是「本地清理失败阻断远端
 * 删除」的判定输入）. Cookie/storage_state never leave the device.
 * @param accountId - account id.
 * @param root - state root directory.
 * @returns which traces were cleared（旧 handleRemoveLocal 的 cleanup_failed 判据）.
 */
export async function clearLocalCredentials(accountId: string, root: string = stateRoot()): Promise<{ profile: boolean; storageState: boolean }> {
  const layout = paths(root)
  // 读取、删除账号记录与写回在同一个 root 锁内完成：锁互斥保证删除写回不会
  // 覆盖并发账号写入；非 ENOENT 读取错误或解析错误在锁内上抛——此时 profile
  // 与 storage_state 的物理删除尚未执行，损坏文档绝不替换为空态。
  await withRootLock(root, async () => {
    const state = await readAccounts(root)
    if (state.accounts[accountId] === undefined) return
    delete state.accounts[accountId]
    await ensureDir(dirname(layout.accountsFile))
    await atomicWrite0600(layout.accountsFile, `${JSON.stringify(state, null, 2)}\n`)
  })
  const cleared = { profile: false, storageState: false }
  try {
    await rm(layout.profileDir(accountId), { recursive: true, force: true })
    cleared.profile = true
  } catch {
    cleared.profile = false
  }
  try {
    await rm(layout.storageStatePath(accountId), { force: true })
    cleared.storageState = true
  } catch {
    cleared.storageState = false
  }
  return cleared
}

/** Accessibility probe seam kept for parity with the wx/xhs layout (profile availability). */
export async function pathAccessible(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK)
    return true
  } catch {
    return false
  }
}
