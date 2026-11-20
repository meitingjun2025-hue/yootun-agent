/**
 * 测试夹具：假 Chrome factory / 假 creator 中心页面 / 假会话上下文，供
 * session/collector/handlers 测试注入。只实现 XhsPage / XhsBrowserContext
 * 结构子集，不依赖 playwright。
 */
import { writeFile } from 'node:fs/promises'
import { LOGIN_URL, USER_INFO_PATH, CREATOR_ORIGIN, type XhsBrowserContext, type XhsPage } from '../src/session.ts'
import { NOTE_MANAGER_URL } from '../src/collector.ts'
import type { ChromeFactory } from '../src/chrome.ts'
import type { XhsWorkbenchFace } from '../src/workbench.ts'

/** 带稳定码的 Workbench 业务失败（WorkbenchMcpError 形态：payload.error.code）。 */
export class FakeWorkbenchError extends Error {
  readonly payload: { error: { code: string } }

  constructor(code: string) {
    super(JSON.stringify({ error: { code } }))
    this.name = 'WorkbenchMcpError'
    this.payload = { error: { code } }
  }
}

/** 假 Workbench face：记录调用并按脚本应答。 */
export function createFakeWorkbench(script: {
  outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }>
} = {}): { face: XhsWorkbenchFace; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = []
  const face: XhsWorkbenchFace = {
    async callTool(_caller, _domain, name, args) {
      calls.push({ name, args })
      const next = script.outcomes?.shift() ?? { structuredContent: {} }
      if (next.throwCode !== undefined) throw new FakeWorkbenchError(next.throwCode)
      return { structuredContent: next.structuredContent ?? {}, content: null }
    },
  }
  return { face, calls }
}

/** 假页面与假上下文共享的可变状态。 */
export interface FakeCreatorState {
  url: string
  cookies: Array<{ name: string; value: string }>
  closed: boolean
  closeCount: number
  loginBoxVisible: boolean
  captchaVisible: boolean
  profileJson: unknown
  /** 会话失效重定向：goto 创作者中心时 302 到 /login（未登录形态）。 */
  creatorRedirectsToLogin: boolean
  /** 笔记管理页 evaluate 的出队响应（每次 evaluate 取一条）。 */
  postedResponses: string[]
  postedCalls: string[]
  signFunctionVisible: boolean
  evaluateError: Error | null
}

/** Create one mutable fake creator state. */
export function createFakeState(): FakeCreatorState {
  return {
    url: LOGIN_URL,
    cookies: [],
    closed: false,
    closeCount: 0,
    loginBoxVisible: false,
    captchaVisible: false,
    profileJson: null,
    creatorRedirectsToLogin: false,
    postedResponses: [],
    postedCalls: [],
    signFunctionVisible: true,
    evaluateError: null,
  }
}

/** creator 中心 user/info 成功响应体。 */
export function userInfoPayload(accountId: string, nickname: string | null, avatar: string | null): unknown {
  return { data: { userId: accountId, userName: nickname, userImage: avatar } }
}

/** creator 中心会话 Cookie 命中形态。 */
export function sessionCookie(name = 'customerClientId'): Array<{ name: string; value: string }> {
  return [{ name, value: 'stub-value' }]
}

/** 一组绑定的假页面 + 假上下文 + factory seam。 */
export interface FakeChrome {
  state: FakeCreatorState
  page: XhsPage
  context: XhsBrowserContext
  storageWrites: string[]
  factory: ChromeFactory
}

/**
 * Create one bound fake chrome fixture. 页面按当前 url 分派行为：登录/创作者
 * 中心页把 evaluate 交给注入的 user/info 断言；笔记管理页出队 posted 响应。
 */
export function createFakeChrome(state: FakeCreatorState = createFakeState()): FakeChrome {
  const storageWrites: string[] = []
  const closeListeners: Array<() => void> = []
  let contextRef: XhsBrowserContext | null = null
  const page: XhsPage = {
    async goto(url, _options) {
      state.url = url
      // 会话失效重定向（真机：未登录访问创作者中心任意页面 302 到 /login）。
      if (state.creatorRedirectsToLogin && url.includes('creator.xiaohongshu.com')) state.url = LOGIN_URL
      return null
    },
    async evaluate(fn, arg) {
      if (state.evaluateError !== null) throw state.evaluateError
      if (state.url === NOTE_MANAGER_URL) {
        state.postedCalls.push(arg)
        return state.postedResponses.shift() ?? '{}'
      }
      // user/info 同源 fetch 由宿主状态直接应答（测试内不发起真实网络请求）。
      if (arg === USER_INFO_PATH) {
        return { status: state.profileJson === null ? 0 : 200, json: state.profileJson }
      }
      return await (fn as (target: string) => Promise<unknown>)(arg)
    },
    async isVisible(selector) {
      if (selector.includes('login-box')) return state.loginBoxVisible
      if (selector.includes('captcha')) return state.captchaVisible
      return false
    },
    url() {
      return state.url
    },
    async reload(_options) {
      return null
    },
    isClosed() {
      return state.closed
    },
    async waitForFunction(_fn, _options) {
      if (state.signFunctionVisible) return null
      throw new Error('waitForFunction timeout')
    },
    context(): XhsBrowserContext {
      if (contextRef === null) throw new Error('fake context not bound yet')
      return contextRef
    },
  }
  const context: XhsBrowserContext = {
    async cookies() {
      return state.cookies
    },
    async newPage() {
      return page
    },
    pages() {
      return [page]
    },
    async close() {
      state.closed = true
      state.closeCount += 1
      for (const listener of closeListeners.splice(0)) listener()
    },
    once(event, listener) {
      if (event === 'close') closeListeners.push(listener)
      return context
    },
    async storageState(options) {
      storageWrites.push(options.path)
      // 与 playwright 同语义：真实落盘备份文件（state.ts 只负责 chmod）。
      await writeFile(options.path, `${JSON.stringify({ cookies: state.cookies })}\n`, { mode: 0o600 })
      return { cookies: state.cookies }
    },
  }
  contextRef = context
  const factory: ChromeFactory = async () => ({ context })
  return { state, page, context, storageWrites, factory }
}

/** 采集单页 posted 响应体。 */
export function postedPage(notes: Array<Record<string, unknown>>, nextPage: number | null): string {
  return JSON.stringify({ code: 0, data: { notes, page: nextPage } })
}
