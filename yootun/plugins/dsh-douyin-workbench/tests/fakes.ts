/**
 * 测试夹具：假 Workbench face / 假浏览器探测 / 结构化假宿主 context，供
 * route、host、dispose 测试注入。全部夹具直接满足导出的结构化接口，
 * 不使用类型断言；不启动真实 Chrome，不访问任何生产 endpoint。
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDouyinHostDeps, type DouyinHostContext, type DouyinHandlerDeps } from '../src/index.ts'
import type { RouteRequest, RouteResponse } from '../src/route.ts'
import type { WorkbenchFace } from '../src/workbench.ts'

/** 带稳定码的 Workbench 业务失败（WorkbenchMcpError 形态：payload.error.code）。 */
export class FakeWorkbenchError extends Error {
  /** The server's stable envelope（Tools contract shape）. */
  readonly payload: { error: { code: string } }

  constructor(code: string) {
    super(JSON.stringify({ error: { code } }))
    this.name = 'WorkbenchMcpError'
    this.payload = { error: { code } }
  }
}

/** One recorded fake Workbench invocation. */
export interface FakeWorkbenchCall {
  caller: string
  domain: string
  name: string
  args: unknown
}

/**
 * 假 Workbench face：记录调用并按脚本应答；本地 action 不经它发出调用。
 * @param script.outcomes - 每次调用的应答脚本（structuredContent 或抛码）。
 * @returns the fake face and the recorded calls.
 */
export function createFakeWorkbench(script: {
  outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }>
} = {}): { face: WorkbenchFace; calls: FakeWorkbenchCall[] } {
  const calls: FakeWorkbenchCall[] = []
  const face: WorkbenchFace = {
    async callTool(caller, domain, name, args) {
      calls.push({ caller, domain, name, args })
      const next = script.outcomes?.shift() ?? { structuredContent: {} }
      if (next.throwCode !== undefined) throw new FakeWorkbenchError(next.throwCode)
      return { structuredContent: next.structuredContent ?? {}, content: null }
    },
  }
  return { face, calls }
}

/**
 * One isolated temp state root (per-test).
 * @returns the root path and its cleanup function.
 */
export async function tempRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'douyin-d1-test-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/**
 * 组装带假 Workbench 与假浏览器探测的 Host deps（绑定一个独立临时 root）。
 * @param options.workbench - fake face（缺省无调用的空 face）。
 * @returns the deps, the recorded calls, and the root cleanup.
 */
export async function testDeps(options: { workbench?: ReturnType<typeof createFakeWorkbench> } = {}): Promise<{
  deps: DouyinHandlerDeps
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const chosen = options.workbench ?? createFakeWorkbench()
  const { root, cleanup } = await tempRoot()
  const deps = createDouyinHostDeps({
    root,
    workbenchFace: chosen.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }),
    logger: { warn: () => undefined },
  })
  return { deps, calls: chosen.calls, cleanup }
}

/** 假 webServer 的登记条目。 */
export interface FakeRouteRegistration {
  path: string
  dispose: () => void
}

/** 结构化假宿主 context（直接满足 DouyinHostContext，无类型断言）。 */
export interface FakeHostContext extends DouyinHostContext {
  /** 登记记录（dispose 后清空，供生命周期断言）。 */
  readonly registrations: FakeRouteRegistration[]
}

/**
 * 假宿主 context：收集 effect disposer，dispose 时逆序执行；webServer 登记
 * 记录可观察（apply/dispose 生命周期测试用）。
 * @returns the fake context, its registrations, and the dispose closure.
 */
export function createFakeContext(): { ctx: FakeHostContext; dispose: () => Promise<void> } {
  const disposers: Array<() => void | Promise<void>> = []
  const registrations: FakeRouteRegistration[] = []
  const fake = createFakeWorkbench()
  const ctx: FakeHostContext = {
    registrations,
    logger: { warn: () => undefined },
    webServer: {
      register(input: { kind: 'exact'; path: string; handler: (req: RouteRequest, res: RouteResponse) => Promise<void> }) {
        const registration: FakeRouteRegistration = { path: input.path, dispose: () => undefined }
        registration.dispose = () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
        registrations.push(registration)
        disposers.push(registration.dispose)
        return { dispose: registration.dispose }
      },
      getOrigin: () => 'http://127.0.0.1:41111',
    },
    yootunWorkbench: fake.face,
    effect(fn: () => unknown) {
      const result = fn()
      if (typeof result === 'function') disposers.push(result as () => void | Promise<void>)
      return result
    },
  }
  return {
    ctx,
    dispose: async () => {
      for (const disposer of disposers.reverse()) await disposer()
    },
  }
}
