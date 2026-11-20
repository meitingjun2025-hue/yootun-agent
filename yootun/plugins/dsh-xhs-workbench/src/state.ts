/**
 * 设备端本地状态（迁移旧 state.js 全语义）：每账号独立 Chrome Profile、
 * storage_state 备份、采集快照。凭证与数据边界：Cookie 与 storage_state 只留
 * 设备端（0600），永不进入响应体、日志、tools 参数或审计；采集结果只落设备端
 * 本地快照文件（0600），不入库、不经 MCP 上报（Q10）；目录权限 0700/0600。
 * 目录沿用旧插件：`~/.dofe/dsh-yootun-xhs-operation`（env `XHS_OPERATION_STATE_DIR`）。
 * @module
 */
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 状态 schema 版本（与旧一致；无法识别的版本保留原样并报可恢复错误）。 */
export const STATE_VERSION = 1
/** 旧目录 env 覆盖名。 */
export const STATE_DIR_ENV = 'XHS_OPERATION_STATE_DIR'

/**
 * Resolve the state root: env override first, then the legacy plugin directory.
 * @param env - process environment (test seam).
 * @returns the absolute state root path.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[STATE_DIR_ENV]
  if (override) return resolve(override)
  return join(homedir(), '.dofe', 'dsh-yootun-xhs-operation')
}

/** 单账号全部本地路径。 */
export interface StatePaths {
  root: string
  accountsFile: string
  profilesDir: string
  storageStateDir: string
  dataDir: string
  profileDir(accountId: string): string
  storageStatePath(accountId: string): string
  snapshotsDir(accountId: string): string
  snapshotPath(accountId: string, stamp: string): string
}

/**
 * Enumerate every local path for one state root.
 * @param root - the state root directory.
 * @returns the path table.
 */
export function paths(root: string): StatePaths {
  return {
    root,
    accountsFile: join(root, 'accounts.json'),
    profilesDir: join(root, 'profiles'),
    storageStateDir: join(root, 'storage-state'),
    dataDir: join(root, 'data'),
    profileDir: accountId => join(root, 'profiles', safeSegment(accountId)),
    storageStatePath: accountId => join(root, 'storage-state', `${safeSegment(accountId)}.json`),
    snapshotsDir: accountId => join(root, 'data', safeSegment(accountId)),
    snapshotPath: (accountId, stamp) => join(root, 'data', safeSegment(accountId), `notes-${stamp}.json`),
  }
}

/**
 * 账号 ID 落盘前收敛为安全目录名（账号 ID 来自小红书侧，不信任其字符集）：
 * 非法字符 → `%xx` 可逆转义（不同账号不碰撞）、160 上限；`.`/`..` 显式拒绝
 * （叠加递归删除会穿越整库）。
 * @param value - raw account id.
 * @returns the filesystem-safe segment.
 */
export function safeSegment(value: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, ch => `%${ch.codePointAt(0)!.toString(16).toLowerCase().padStart(2, '0')}`)
    .slice(0, 160)
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'account'
  return cleaned
}

/** 单账号本地记录（accounts.json 行）。 */
export interface AccountRecord {
  accountId: string
  sessionSeq?: number
  sessionStatus?: 'ok' | 'expired' | 'unknown'
  sessionCheckedAt?: string
  lastLoginAt?: string
  lastCollectedAt?: string
  nickname?: string | null
  avatar?: string | null
  [key: string]: unknown
}

/** accounts.json 顶层结构。 */
export interface AccountsState {
  version: number
  accounts: Record<string, AccountRecord>
}

const emptyState = (): AccountsState => ({ version: STATE_VERSION, accounts: {} })

async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode })
  try {
    await chmod(dir, mode)
  } catch (error) {
    void error // Windows 上 chmod 语义有限，忽略。
  }
}

/**
 * Read accounts.json. A missing file yields the empty state; an unrecognized
 * structure yields the empty state too (旧口径：不识别不报错、不改写原文件).
 * @param root - the state root directory.
 * @returns the parsed accounts state.
 */
export async function readAccounts(root: string): Promise<AccountsState> {
  const file = paths(root).accountsFile
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !(parsed as { accounts?: unknown }).accounts) return emptyState()
    const accounts = (parsed as { accounts: Record<string, AccountRecord> }).accounts
    return { version: STATE_VERSION, accounts }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

/**
 * Write accounts.json atomically (tmp + rename), 0600.
 * @param state - the state to persist.
 * @param root - the state root directory.
 */
export async function writeAccounts(state: AccountsState, root: string): Promise<void> {
  await ensureDir(root)
  const file = paths(root).accountsFile
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: STATE_VERSION, accounts: state.accounts }, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  try {
    await chmod(file, 0o600)
  } catch (error) {
    void error // 同上：Windows 忽略。
  }
}

/**
 * Read one account's local record.
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns the record, or null when absent.
 */
export async function getAccount(accountId: string, root: string): Promise<AccountRecord | null> {
  const state = await readAccounts(root)
  return state.accounts[accountId] ?? null
}

/**
 * Upsert one account's local record; an empty patch only ensures presence.
 * @param accountId - the account id.
 * @param patch - fields to merge.
 * @param root - the state root directory.
 * @returns the merged record.
 */
export async function updateAccount(accountId: string, patch: Partial<AccountRecord>, root: string): Promise<AccountRecord> {
  const state = await readAccounts(root)
  const current = state.accounts[accountId] ?? { accountId, sessionSeq: 0, sessionStatus: 'unknown' as const }
  const next: AccountRecord = { ...current, ...patch, accountId }
  state.accounts[accountId] = next
  await writeAccounts(state, root)
  return next
}

/**
 * Allocate the next monotonically increasing session seq (本地状态用途).
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns the new seq.
 */
export async function nextSessionSeq(accountId: string, root: string): Promise<number> {
  const state = await readAccounts(root)
  const current = state.accounts[accountId] ?? { accountId, sessionSeq: 0 }
  const seq = Number(current.sessionSeq ?? 0) + 1
  state.accounts[accountId] = { ...current, accountId, sessionSeq: seq }
  await writeAccounts(state, root)
  return seq
}

/**
 * 账号的本地 Profile 目录（按需创建，权限 0700）。登录/探测/采集共用。
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns the profile directory path.
 */
export async function ensureProfileDir(accountId: string, root: string): Promise<string> {
  const dir = paths(root).profileDir(accountId)
  await ensureDir(paths(root).profilesDir)
  await ensureDir(dir)
  return dir
}

/**
 * 登录成功后把占位 Profile 迁移到正式账号 ID 名下；目标已存在时绝不覆盖
 * （先删后改名会清掉正在使用的会话），跳过迁移即可。
 * @param fromAccountId - the source (pending) account id.
 * @param toAccountId - the resolved account id.
 * @param root - the state root directory.
 * @returns the target profile directory path.
 */
export async function moveProfile(fromAccountId: string, toAccountId: string, root: string): Promise<string> {
  const from = paths(root).profileDir(fromAccountId)
  const to = paths(root).profileDir(toAccountId)
  if (from === to) return to
  const targetExists = await existsDir(to)
  if (targetExists) return to
  await rm(to, { recursive: true, force: true })
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return to
    throw error
  }
  return to
}

/**
 * 把 storage_state 备份从占位账号名下迁移到正式账号名下；目标已存在时绝不
 * 删除既有备份（扫码刚写入的备份不能被占位迁移清掉）。
 * @param fromAccountId - the source (pending) account id.
 * @param toAccountId - the resolved account id.
 * @param root - the state root directory.
 * @returns the target backup path.
 */
export async function moveStorageState(fromAccountId: string, toAccountId: string, root: string): Promise<string> {
  const from = paths(root).storageStatePath(fromAccountId)
  const to = paths(root).storageStatePath(toAccountId)
  if (from === to) return to
  if (await hasStorageState(toAccountId, root)) return to
  await rm(to, { recursive: true, force: true })
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return to
    throw error
  }
  try {
    await chmod(to, 0o600)
  } catch (error) {
    void error // Windows 忽略。
  }
  return to
}

/** Context shape needed to persist a storage_state backup (playwright BrowserContext subset). */
export interface StorageStateSource {
  storageState(options: { path: string }): Promise<unknown>
}

/**
 * 保存 storage_state 备份（运行时会话以 Profile 为准）；权限 0600，永不外发。
 * @param accountId - the account id.
 * @param context - the browser context to snapshot.
 * @param root - the state root directory.
 * @returns the backup file path.
 */
export async function saveStorageState(accountId: string, context: StorageStateSource, root: string): Promise<string> {
  const target = paths(root).storageStatePath(accountId)
  await ensureDir(dirname(target))
  await context.storageState({ path: target })
  try {
    await chmod(target, 0o600)
  } catch (error) {
    void error // Windows 忽略。
  }
  return target
}

/**
 * Whether the account has a non-empty storage_state backup.
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns true when a non-empty backup file exists.
 */
export async function hasStorageState(accountId: string, root: string): Promise<boolean> {
  try {
    const info = await stat(paths(root).storageStatePath(accountId))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/**
 * 清除账号的本地凭证与本地数据（移除本地账号：Profile/storage_state/采集快照/
 * accounts 记录）。幂等：源不存在也视为已清除。
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns per-item removal outcomes.
 */
export async function clearLocalCredentials(accountId: string, root: string): Promise<{ profile: boolean; storageState: boolean; data: boolean }> {
  const files = paths(root)
  const removed = { profile: false, storageState: false, data: false }
  try {
    await rm(files.profileDir(accountId), { recursive: true, force: true })
    removed.profile = true
  } catch {
    removed.profile = false
  }
  try {
    await rm(files.storageStatePath(accountId), { force: true })
    removed.storageState = true
  } catch {
    removed.storageState = false
  }
  try {
    await rm(files.snapshotsDir(accountId), { recursive: true, force: true })
    removed.data = true
  } catch {
    removed.data = false
  }
  const state = await readAccounts(root)
  if (state.accounts[accountId] !== undefined) {
    delete state.accounts[accountId]
    await writeAccounts(state, root)
  }
  return removed
}

async function existsDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** 采集快照行（字段缺失不补值，绝不编造）。 */
export interface SnapshotNote {
  contentId: string
  title: string
  noteType?: string
  publishedAt?: string
  metrics?: { plays?: number; likes?: number; collects?: number; comments?: number; shares?: number }
  coverUrl?: string
  sticky?: boolean
}

/** 采集快照文件结构（schemaVersion 1，与旧一致）。 */
export interface CollectSnapshot {
  schemaVersion: 1
  accountId: string
  capturedAt: string
  source: 'creator-web'
  notes: SnapshotNote[]
  truncated?: true
}

/** 采集快照文件名时间戳：本地时间可读格式 + 随机后缀防同秒覆盖。 */
function snapshotStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 采集快照落盘（0600）；不入库、不经 MCP（Q10）。latestSnapshot 按文件名字典序
 * 取最新，时间戳取自真实时钟；同秒多次保存由随机后缀保证不覆盖但顺序不保证。
 * @param accountId - the account id.
 * @param snapshot - the snapshot to persist.
 * @param root - the state root directory.
 * @param options - now seam（测试注入确定时钟；缺省真实时钟）。
 * @returns the snapshot file path.
 */
export async function saveSnapshot(accountId: string, snapshot: CollectSnapshot, root: string, options: { now?: () => Date } = {}): Promise<string> {
  const dir = paths(root).snapshotsDir(accountId)
  await ensureDir(dir)
  const target = paths(root).snapshotPath(accountId, snapshotStamp(options.now?.() ?? new Date()))
  await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  try {
    await chmod(target, 0o600)
  } catch (error) {
    void error // Windows 忽略。
  }
  return target
}

/**
 * 读取账号最新一份采集快照（无快照或损坏返回 null）；供页面本地聚合六项统计。
 * @param accountId - the account id.
 * @param root - the state root directory.
 * @returns the latest snapshot, or null.
 */
export async function latestSnapshot(accountId: string, root: string): Promise<CollectSnapshot | null> {
  const dir = paths(root).snapshotsDir(accountId)
  let names: string[] = []
  try {
    names = (await readdir(dir)).filter(name => /^notes-.+\.json$/.test(name)).sort()
  } catch {
    return null
  }
  const latest = names.at(-1)
  if (latest === undefined) return null
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, latest), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { notes?: unknown }).notes)) {
      return parsed as CollectSnapshot
    }
    return null
  } catch {
    return null
  }
}
