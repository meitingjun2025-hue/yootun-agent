/**
 * yootun Workbench 面私有 MCP 连接器（`ctx.yootunWorkbench`，Service 插件）。
 * 三个工作台 Host 与媒体上传插件共享；不注册 `ctx.tools`，普通会话不可见。
 * 每次调用内部执行：caller×domain 域门 → 激活门禁 → credential 解析 → 连接
 * （serverName 校验）→ 服务端广播可用性检查 → tools/call（显式超时/取消）→
 * 稳定错误投影。凭证更新即失效连接缓存；卸载关闭全部连接与 in-flight 请求。
 * @module @yootun/dsh-workbench-mcp
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ACCESS_CREDENTIAL_REF } from './constants.ts'
import { activationServices, isActivated } from './gate.ts'
import { WorkbenchMcpError } from './errors.ts'
import { callTool, closeWorkbench, connectWorkbench, refreshToolNames, type ToolCallOutcome, type WorkbenchConnection } from './client.ts'
import { isAllowedFor, type WorkbenchCaller, type WorkbenchDomain } from './whitelist.ts'

export { WorkbenchMcpError, classifyTransportError, serverErrorCodeOf, type WorkbenchErrorCode } from './errors.ts'
export { workbenchUrl, WORKBENCH_SERVER_NAME, ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from './constants.ts'
export {
  CALLER_DOMAINS, CATALOG_TOOL_NAMES, domainOf, isAllowedFor, WORKBENCH_TOOL_PREFIX,
  type WorkbenchCaller, type WorkbenchDomain,
} from './whitelist.ts'
export { readAccessSnapshot, isActivated, activationServices, type AccessSnapshot } from './gate.ts'
export type { ToolCallOutcome, WorkbenchConnection } from './client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The yootun Workbench MCP connector. */
    yootunWorkbench: YootunWorkbenchMcp
  }
}

/** Service configuration; the only deployment-varying knob is the call budget. */
export interface WorkbenchConfig {
  /** Explicit per-call timeout budget in milliseconds (§5.4, default 60s). */
  callTimeoutMs: number
}

/**
 * 工具广播刷新窗口（分册 08 §5.2）：距上次成功 `tools/list` 满窗后才在
 * 「未广播」路径上再刷一次，避免对真正不存在的工具反复打扰服务端。
 */
const TOOL_LIST_REFRESH_INTERVAL_MS = 60_000

/** One caller-supplied signal wrapped with the call budget, plus its settle handle. */
interface InFlight {
  controller: AbortController
  /** Resolves when the call leaves the pipeline (success, projection, or abort). */
  done: Promise<void>
}

/**
 * The shared private Workbench MCP connector.
 */
export default class YootunWorkbenchMcp extends Service {
  /** Schema for {@link Config}; Settings exposes it if the entry declares volatile fields. */
  static Config = z.object({
    callTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  }) as z<Partial<WorkbenchConfig>, WorkbenchConfig>

  /** The resolved configuration. */
  readonly config: WorkbenchConfig

  private connection: WorkbenchConnection | undefined
  private connecting: Promise<WorkbenchConnection> | undefined
  /** 世代号：每次 invalidate/teardown 递增，open 产物据此自检。 */
  private generation = 0
  private readonly inFlight = new Set<InFlight>()
  private stopped = false
  /** 刷新窗口与剩余预算共用的墙钟；测试注入可控时钟，生产为 Date.now。 */
  private readonly now: () => number

  /**
   * @param ctx - the service context.
   * @param config - resolved configuration.
   * @param now - wall clock for the tools/list refresh window and remaining call budget; test seam (production `Date.now`).
   */
  constructor(ctx: Context, config: WorkbenchConfig, now: () => number = Date.now) {
    super(ctx, 'yootunWorkbench')
    this.config = config
    this.now = now
  }

  /**
   * Track the credential namespace: any update invalidates the cached
   * connection (next call re-resolves and reconnects). Teardown closes the
   * connection and aborts every in-flight call.
   */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    const owner = this.ctx
    // Teardown 顺序：停新调用 → abort 已接调用 → 等 in-flight 稳定 settle →
    // 关闭底层连接（dispose 的 Promise 在这一切完成后才 resolve）。
    yield async () => {
      this.stopped = true
      await this.invalidate()
    }
    owner.on('credentials/reference-updated', (ref) => {
      if (ref === ACCESS_CREDENTIAL_REF) void this.invalidate()
    })
  }

  /**
   * Call one Workbench tool as this Host's own identity.
   *
   * Rejection projects stable codes only; the server's stable business-error
   * envelope rides `WorkbenchMcpError.payload`. Network failures never retry
   * (writes must not double-fire; reads re-invoke explicitly), and idempotency
   * conflicts or unknown outcomes project as-is.
   * @param caller - the calling Host's identity; gates its reachable domains.
   * @param _domain - the tool's group; kept for Host call-signature compatibility and not consulted.
   * @param name - exact tool name; must parse as `workbench_<domain>_<rest>` with `<domain>` inside the caller's domains, and the server must advertise it.
   * @param args - tool arguments (passed through; the server owns validation).
   * @param signal - caller cancellation for this call.
   * @returns the tool's output projection (structuredContent preferred).
   * @throws {WorkbenchMcpError} stable projections; see {@link WorkbenchErrorCode}.
   */
  async callTool(caller: WorkbenchCaller, _domain: WorkbenchDomain, name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallOutcome> {
    if (this.stopped) throw new WorkbenchMcpError('workbench_unavailable', 'the workbench connector is disposed')
    // 1. caller×domain 域门：名称形如 workbench_<domain>_<rest> 且 domain 属于
    //    caller 的域，否则拒绝、不发起调用。caller 运行时可能越出类型面（JS
    //    调用方），未知 caller 一并拒绝。
    if (!isAllowedFor(caller, name)) {
      throw new WorkbenchMcpError('workbench_tool_denied', `workbench tool "${name}" is outside ${caller}'s domains`)
    }
    // 2. 激活门禁。
    const activated = await isActivated(activationServices(this.ctx))
    if (!activated) throw new WorkbenchMcpError('workbench_not_activated', 'yootun access is not activated')
    // 3. 连接与缓存（credential 解析仅发生在连接建立时）。
    const connection = await this.ensureConnection()
    // 连接在途期间发生失效/卸载：本次调用作废，调用方带新状态重试。
    if (this.stopped) throw new WorkbenchMcpError('workbench_unavailable', 'the workbench connector was disposed during connect')
    // 本次调用的预算起点：刷新与调用共享同一份预算（剩余量递减）。
    const startedAt = this.now()
    const remainingBudget = (): number => Math.max(1, this.config.callTimeoutMs - (this.now() - startedAt))
    // 4. 服务端广播可用性：通过域门但服务端未广播（未部署该版本或已移除）→
    //    距上次成功 tools/list 满窗先刷一次再判定；窗口内已刷过的直接稳定投影，
    //    不发 tools/call。刷新与调用走同一条失效规则（catch）。刷新在途时连接
    //    被失效或插件卸载：本次调用以 workbench_unavailable 结束、不盖
    //    refreshedAt、不发 tools/call（与 open() 的在途失效口径一致）。
    const connectionStillCurrent = (): boolean => !this.stopped && this.connection === connection
    try {
      if (!connection.toolNames.has(name) && this.now() - connection.refreshedAt >= TOOL_LIST_REFRESH_INTERVAL_MS) {
        await refreshToolNames(connection, remainingBudget(), signal)
        if (!connectionStillCurrent()) throw new WorkbenchMcpError('workbench_unavailable', 'connection invalidated during tools/list refresh')
        connection.refreshedAt = this.now()
      }
      if (!connection.toolNames.has(name)) {
        throw new WorkbenchMcpError('workbench_tool_unavailable', `workbench tool "${name}" is not advertised by the workbench server`)
      }
    } catch (error: unknown) {
      // 刷新在途的失效/卸载会把传输层失败换成不可信投影（多为 network_error）：
      // 先作废本次调用，再走既有失效重连判定。
      if (!connectionStillCurrent()) throw new WorkbenchMcpError('workbench_unavailable', 'connection invalidated during tools/list refresh')
      this.invalidateAfterTransportRejection(error)
      throw error
    }
    // 5. 调用：显式超时 + 调用方取消；鉴权失效与端点下线后失效连接缓存，下次
    //    调用重连（写操作不自动重试，世代号自检保证在途 open 产物不进缓存）。
    const settle = Promise.withResolvers<void>()
    const inFlight: InFlight = { controller: new AbortController(), done: settle.promise }
    this.inFlight.add(inFlight)
    const callerSignal = signal === undefined
      ? inFlight.controller.signal
      : AbortSignal.any([signal, inFlight.controller.signal])
    try {
      return await callTool(connection, name, args, remainingBudget(), callerSignal)
    } catch (error: unknown) {
      this.invalidateAfterTransportRejection(error)
      throw error
    } finally {
      this.inFlight.delete(inFlight)
      settle.resolve()
    }
  }

  /**
   * 鉴权失效与端点下线（404 / 410）后失效连接缓存，下一次调用重新连接
   * （服务端为无状态 Streamable HTTP，重连无副作用；写操作不自动重试）。
   * 连接阶段的刷新与调用共用本判定；世代号自检保证在途 open 产物不进缓存。
   */
  private invalidateAfterTransportRejection(error: unknown): void {
    if (error instanceof WorkbenchMcpError
      && (error.code === 'workbench_unauthorized'
        || (error.code === 'workbench_protocol_error' && (error.status === 404 || error.status === 410)))) {
      void this.invalidate()
    }
  }

  /**
   * Close the cached connection and abort in-flight calls; the next call
   * reconnects. Bumping the generation also voids any in-flight `open()`:
   * its product self-checks and closes itself instead of being cached.
   */
  private async invalidate(): Promise<void> {
    this.generation += 1
    const current = this.connection
    const opening = this.connecting
    this.connection = undefined
    this.connecting = undefined
    // 先中止已接调用并等它们稳定 settle，再关闭底层连接。
    for (const entry of [...this.inFlight]) entry.controller.abort()
    await Promise.allSettled([...this.inFlight].map(entry => entry.done))
    if (current !== undefined) await closeWorkbench(current).catch(() => undefined)
    // 在途 open 的产物自检关闭；这里再兜底等待其结束，避免卸载后悬挂。
    if (opening !== undefined) await opening.catch(() => undefined)
    const late = this.connection
    if (late !== undefined && this.connecting === undefined) {
      this.connection = undefined
      await closeWorkbench(late).catch(() => undefined)
    }
  }

  /** Reuse the cached connection or build one; a failed attempt leaves nothing cached. */
  private async ensureConnection(): Promise<WorkbenchConnection> {
    const existing = this.connection
    if (existing !== undefined) return existing
    if (this.connecting === undefined) {
      this.connecting = this.open().finally(() => {
        this.connecting = undefined
      })
    }
    return await this.connecting
  }

  /** Resolve the credential, connect, and cache the validated connection. */
  private async open(): Promise<WorkbenchConnection> {
    // 世代快照：open 在途发生失效/卸载时，产物自检关闭而不是进入缓存。
    const generation = this.generation
    const { credentials } = activationServices(this.ctx)
    if (credentials === undefined) throw new WorkbenchMcpError('workbench_not_activated', 'no credentials provider in this composition')
    let resolved
    try {
      resolved = await credentials.resolve(credentialRef(ACCESS_CREDENTIAL_REF))
    } catch {
      // provider 存储层异常：稳定投影，原始错误不进入 message。
      throw new WorkbenchMcpError('workbench_credential_unavailable', 'the credential provider failed to resolve MODELS_API_KEY')
    }
    if (resolved === undefined || resolved.value === '') throw new WorkbenchMcpError('workbench_not_activated', 'MODELS_API_KEY is not configured')
    const connection = await connectWorkbench(resolved.value, { timeoutMs: this.config.callTimeoutMs })
    if (this.stopped || generation !== this.generation) {
      await closeWorkbench(connection).catch(() => undefined)
      throw new WorkbenchMcpError('workbench_unavailable', 'connection invalidated during open')
    }
    // 连接时的 tools/list 计入刷新窗口起点（用本服务的时钟，测试可注入）。
    connection.refreshedAt = this.now()
    this.connection = connection
    return connection
  }
}
