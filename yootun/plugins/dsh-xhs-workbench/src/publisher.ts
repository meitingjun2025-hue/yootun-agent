/**
 * 创作者中心发布页打开（迁移旧 publisher.js 全语义；发布降级版）：
 * 不做自动录入与自动存草稿——有头打开该账号 Chrome 的创作者中心发布页：
 * 会话校验（user/info 接口 + 登录页兜底，与 probe 同口径）→ 验证码检测 →
 * 导航到发布页，到此为止。内容由用户在发布页手动粘贴文案、上传素材、手动
 * 发布；宿主不触碰发布页 DOM，不使用 CDP。
 *
 * 浏览器生命周期（红线口径）：context 创建后任何结局（completed/failed）都
 * 保持打开由用户关闭；profile 互斥锁随该 context 的 close 事件释放（handlers
 * 的 onContext 钩子），发布流程自身不释放。唯一例外是启动超预算：Chrome 启动
 * 受 `launchTimeoutMs` 预算，超时抛 PublishError('PUBLISH_FAILED', 'launch
 * timeout')（锁由调用方 finally 释放）；迟到的启动结果仍经 onContext 挂钩后
 * 立即关闭（promise 交 trackCleanup 登记，close 事件照常释放锁）。
 * @module
 */
import { DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS, browserCloseTimeoutMessage, closeContext, launchChrome, launchWithTimeout, type ChromeFactory } from './chrome.ts'
import { confirmSessionOnPage, detectCaptcha, type BrowserCloseBudget, type XhsBrowserContext } from './session.ts'
import { ensureProfileDir, stateRoot } from './state.ts'

/** 发布页地址（stage0 真机口径：from=menu&target=image|video）。 */
export const PUBLISH_URL_BASE = 'https://creator.xiaohongshu.com/publish/publish'

/**
 * Build the creator-center publish URL for one target tab.
 * @param target - `image` or `video`（其他值按 image 收口）。
 * @returns the publish page URL.
 */
export function publishUrl(target: string): string {
  return `${PUBLISH_URL_BASE}?from=menu&target=${target === 'video' ? 'video' : 'image'}`
}

/** 打开发布页的导航超时（单次 goto；不含用户在页面上停留的时间）。 */
export const OPEN_TIMEOUT_MS = 60_000

/** 带 code 的发布失败（PublishError.code ∈ 稳定本地码）。 */
export class PublishError extends Error {
  /** 稳定错误码（SESSION_EXPIRED / CAPTCHA_DETECTED / PUBLISH_FAILED）。 */
  readonly code: string

  /**
   * @param code - stable public code.
   * @param message - diagnostic detail for logs.
   */
  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'PublishError'
    this.code = code
  }
}

/** 发布打开结果（context 保持打开，由用户关闭）。 */
export interface PublishDraftResult {
  status: 'completed'
  context: XhsBrowserContext
}

/**
 * 有头打开该账号的创作者中心发布页（发布降级主流程）。Profile 互斥锁由调用
 * 方持有并随 context close 释放（本函数任何结局都不关闭 context、不释放锁；
 * 启动超预算的失败与迟到结果清理除外——见模块注释）。
 * @param options - accountId/target/root/chrome factory/会话判定注入/步骤与
 *   context 钩子。
 * @returns the completed publish outcome（context 保持打开）。
 * @throws {PublishError} SESSION_EXPIRED / CAPTCHA_DETECTED / PUBLISH_FAILED。
 */
export async function publishDraft(options: {
  accountId: string
  target?: 'image' | 'video'
  root?: string
  chromeFactory?: ChromeFactory | undefined
  confirmSessionFn?: typeof confirmSessionOnPage
  onStep?: ((step: 'prepare' | 'open' | 'done') => void) | null
  onContext?: ((context: XhsBrowserContext) => void) | null
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传；缺省 60000）。 */
  launchTimeoutMs?: number | undefined
  /** 迟到启动结果清理 promise 的登记接缝（dispose 等待）。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
} & BrowserCloseBudget): Promise<PublishDraftResult> {
  const target = options.target ?? 'image'
  const root = options.root ?? stateRoot()
  const step = (name: 'prepare' | 'open' | 'done'): void => { options.onStep?.(name) }
  if (options.accountId === '') throw new PublishError('PUBLISH_FAILED', 'accountId required')
  const closeTimeoutMs = options.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS

  // ---- prepare：参数校验 + 账号 Profile 目录就绪 ----
  step('prepare')
  const profileDir = await ensureProfileDir(options.accountId, root)
  const chromeFactory = options.chromeFactory ?? launchChrome
  let context: XhsBrowserContext
  try {
    ;({ context } = await launchWithTimeout(() => chromeFactory({ headless: false, profileDir }), options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS, result => {
      // 迟到成功：仍走 onContext 挂钩（锁随该 context 的 close 事件释放），
      // 随后立即关闭；promise 同步交登记表（dispose 等待）。
      options.onContext?.(result.context)
      const cleanup = closeContext(result.context, closeTimeoutMs, () => {
        options.onBrowserCloseTimeout?.(browserCloseTimeoutMessage(options.accountId))
      }).catch(() => undefined)
      options.trackCleanup?.(cleanup)
      return cleanup
    }))
  } catch (error) {
    if (error instanceof Error && error.name === 'BrowserLaunchTimeoutError') {
      throw new PublishError('PUBLISH_FAILED', 'launch timeout')
    }
    throw error
  }
  // 宿主生命周期钩子：互斥锁随该 context 的 close 事件释放——run 终态后窗口
  // 保持打开，锁必须保持到用户真正关闭浏览器。
  options.onContext?.(context)
  // 注意：从这一步起 context 在任何结局下都保持打开，由用户关闭。

  try {
    // ---- open：直接导航发布页（未登录会 302 到 /login，进入会话判定）----
    step('open')
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(publishUrl(target), { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    // 会话校验与 probe 同口径：ok 时顺带回写账号状态与 storage_state 备份。
    const session = await (options.confirmSessionFn ?? confirmSessionOnPage)(page, { accountId: options.accountId, root })
    if (session.status === 'expired') {
      throw new PublishError('SESSION_EXPIRED', 'login page detected on publish open')
    }
    if (session.status !== 'ok') {
      throw new PublishError('PUBLISH_FAILED', `session check: ${String(session.reason ?? 'unknown').slice(0, 64)}`)
    }
    // 验证码检测（红线）：出现即失败提示人工处理，绝不绕过；浏览器保持打开。
    if (await detectCaptcha(page)) throw new PublishError('CAPTCHA_DETECTED', 'captcha on publish page')

    // ---- done：浏览器保持打开，内容由用户手动粘贴/上传/发布 ----
    step('done')
    return { status: 'completed', context }
  } catch (error) {
    // 失败时浏览器仍保持打开（红线口径：任何结局都不 close）；异常仅向上投影。
    void error
    throw error
  }
}
