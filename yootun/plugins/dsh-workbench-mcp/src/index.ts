/**
 * yootun Workbench 面私有 MCP 连接器（`ctx.yootunWorkbench`，Service 插件）。
 * 三个工作台 Host 与媒体上传插件共享；不注册 `ctx.tools`，普通会话不可见。
 * 每次调用内部执行：调用方分组与白名单校验 → 激活门禁 → credential 解析 →
 * 连接与 tools/list 缓存（精确 90 校验）→ tools/call（显式超时/取消）→
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
import { callTool, closeWorkbench, connectWorkbench, type ToolCallOutcome, type WorkbenchConnection } from './client.ts'
import { allowedToolsFor, CALLER_DOMAINS, WORKBENCH_GROUP_TOOLS, type WorkbenchCaller, type WorkbenchDomain } from './whitelist.ts'

export { WorkbenchMcpError, serverErrorCodeOf, type WorkbenchErrorCode } from './errors.ts'
export { workbenchUrl, WORKBENCH_SERVER_NAME, ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from './constants.ts'
export {
  allowedToolsFor, CALLER_DOMAINS, WORKBENCH_GROUP_TOOLS, WORKBENCH_TOOL_WHITELIST,
  CATALOG_TOOL_NAMES, type WorkbenchCaller, type WorkbenchDomain,
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

/** One caller-supplied signal wrapped with the call budget. */
interface InFlight {
  controller: AbortController
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
  private readonly callerTools = new Map<WorkbenchCaller, ReadonlySet<string>>()
  private stopped = false

  /**
   * @param ctx - the service context.
   * @param config - resolved configuration.
   */
  constructor(ctx: Context, config: WorkbenchConfig) {
    super(ctx, 'yootunWorkbench')
    this.config = config
  }

  /**
   * Track the credential namespace: any update invalidates the cached
   * connection (next call re-resolves and reconnects). Teardown closes the
   * connection and aborts every in-flight call.
   */
  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    const owner = this.ctx
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
   * @param domain - the tool's group; must be one of the caller's domains.
   * @param name - exact tool name; must be inside the 90-name whitelist.
   * @param args - tool arguments (passed through; the server owns validation).
   * @param signal - caller cancellation for this call.
   * @returns the tool's output projection (structuredContent preferred).
   * @throws {WorkbenchMcpError} stable projections; see {@link WorkbenchErrorCode}.
   */
  async callTool(caller: WorkbenchCaller, domain: WorkbenchDomain, name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallOutcome> {
    if (this.stopped) throw new WorkbenchMcpError('workbench_unavailable', 'the workbench connector is disposed')
    // 1. 调用方分组与白名单：组外或白名单外一律拒绝，不发起调用。
    let allowed = this.callerTools.get(caller)
    if (allowed === undefined) {
      allowed = allowedToolsFor(caller) ?? new Set<string>()
      this.callerTools.set(caller, allowed)
    }
    if (!CALLER_DOMAINS[caller].includes(domain) || !WORKBENCH_GROUP_TOOLS[domain].has(name) || !allowed.has(name)) {
      throw new WorkbenchMcpError('workbench_tool_denied', `workbench tool "${name}" is outside ${caller}'s whitelist`)
    }
    // 2. 激活门禁。
    const activated = await isActivated(activationServices(this.ctx))
    if (!activated) throw new WorkbenchMcpError('workbench_not_activated', 'yootun access is not activated')
    // 3. 连接与缓存（credential 解析仅发生在连接建立时）。
    const connection = await this.ensureConnection()
    // 连接在途期间发生失效/卸载：本次调用作废，调用方带新状态重试。
    if (this.stopped) throw new WorkbenchMcpError('workbench_unavailable', 'the workbench connector was disposed during connect')
    // 4. 调用：显式超时 + 调用方取消。
    const inFlight: InFlight = { controller: new AbortController() }
    this.inFlight.add(inFlight)
    const callerSignal = signal === undefined
      ? inFlight.controller.signal
      : AbortSignal.any([signal, inFlight.controller.signal])
    try {
      return await callTool(connection, name, args, this.config.callTimeoutMs, callerSignal)
    } finally {
      this.inFlight.delete(inFlight)
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
    for (const entry of [...this.inFlight]) entry.controller.abort()
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
    const resolved = await credentials.resolve(credentialRef(ACCESS_CREDENTIAL_REF))
    if (resolved === undefined || resolved.value === '') throw new WorkbenchMcpError('workbench_not_activated', 'MODELS_API_KEY is not configured')
    const connection = await connectWorkbench(resolved.value, { timeoutMs: this.config.callTimeoutMs })
    if (this.stopped || generation !== this.generation) {
      await closeWorkbench(connection).catch(() => undefined)
      throw new WorkbenchMcpError('workbench_unavailable', 'connection invalidated during open')
    }
    this.connection = connection
    return connection
  }
}
