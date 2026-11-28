/**
 * 承接卡片 client 行为测试（jsdom，假同源路由 = 全局 fetch 桩）：
 * 实施单附录 B.2 C1–C9——渲染与空态、uploadStart 头契约、1s 状态轮询、
 * done 收起、failed 原因映射与重选、取消重试、可见性轮询、pending 对账、
 * 折叠计数、词典键集与无硬编码文案红线。
 * 运行：`pnpm --filter @yootun/dsh-media-upload test`（vitest 段）。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HandoffCard } from '../../src/client/handoff-card.tsx'
import { en, zh, type HandoffLocaleKey } from '../../src/client/locales.ts'
import type { PendingUploadSession } from '../../src/client/upload-api.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

beforeEach(() => {
  vi.useFakeTimers()
})

/** 测试用翻译（镜像框架 t 的模板插值口径）。 */
const t = (key: HandoffLocaleKey, params?: Record<string, unknown>): string => {
  const text = en[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** 一个 waiting 态的 pending 投影。 */
function session(uploadId: string, overrides: Partial<PendingUploadSession> = {}): PendingUploadSession {
  return {
    uploadId,
    kind: 'image',
    state: 'waiting',
    progress: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/** JSON 响应体。 */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

type FetchHandler = (path: string, init: RequestInit | undefined) => Response

/** fetch 调用记录（path + init）。 */
const fetchCalls: Array<{ path: string; init: RequestInit | undefined }> = []

/** 把全局 fetch 换成按路径分发/记录的桩。 */
function stubFetch(handler: FetchHandler): void {
  fetchCalls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = typeof input === 'string' ? input : String(input)
    fetchCalls.push({ path, init })
    return handler(path, init)
  }))
}

/** 冲刷微任务、到期定时器与 React 状态更新（fake timers 下的异步衔接）。 */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** 三个上传会话的 pending 桩（多数用例共用）。 */
function stubPendingOnly(sessions: PendingUploadSession[]): void {
  stubFetch(path => path === '/_dsh/uploader/pending' ? jsonResponse({ sessions }) : jsonResponse({}, 404))
}

describe('C1 渲染与空态', () => {
  it('pending 空集合不渲染；出现 waiting 会话后渲染卡片与「选择文件」', async () => {
    stubPendingOnly([])
    const { container } = render(<HandoffCard t={t} />)
    await flush()
    expect(container.querySelector('article')).toBeNull()
    stubPendingOnly([session('u-1')])
    await flush(3000)
    expect(screen.getByText(en['handoff.title'])).not.toBeNull()
    expect(screen.getByRole('button', { name: en['handoff.pick'] })).not.toBeNull()
    expect(screen.getByText(en['handoff.hint'])).not.toBeNull()
  })
})

describe('C2 上传链路', () => {
  it('选中文件调 uploadStart 且头携带 uploadId/文件名/类型/大小，随后按 1s 轮询状态', async () => {
    let statusPolls = 0
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') return jsonResponse({ sessions: [session('u-2')] })
      if (path === '/_dsh/uploader/uploadStart') return jsonResponse({ uploadId: 'u-2', name: 'photo.png', size: 3, contentType: 'image/png' })
      if (path === '/_dsh/uploader/uploadStatus') {
        statusPolls += 1
        return jsonResponse({ status: 'uploading', progress: statusPolls * 10, bytesSent: 1, bytesTotal: 3 })
      }
      return jsonResponse({}, 404)
    })
    render(<HandoffCard t={t} />)
    await flush()
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    expect(input?.getAttribute('accept')).toBe('.jpg,.jpeg,.png,.webp')
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } })
    await flush()
    const start = fetchCalls.find(call => call.path === '/_dsh/uploader/uploadStart')
    expect(start).toBeDefined()
    expect(start?.init?.headers).toMatchObject({
      'x-yootun-upload-id': 'u-2',
      'x-yootun-filename': 'photo.png',
      'x-yootun-content-type': 'image/png',
      'x-yootun-size': '3',
    })
    await flush(1000)
    expect(statusPolls).toBe(1)
    expect(screen.getByText(t('handoff.picking', { progress: 10 }))).not.toBeNull()
    await flush(1000)
    expect(statusPolls).toBe(2)
  })
})

describe('C3 done 收起', () => {
  it('状态 done 显示「已上传」且不展示 URL，2000ms 后移除', async () => {
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') return jsonResponse({ sessions: [session('u-3')] })
      if (path === '/_dsh/uploader/uploadStart') return jsonResponse({ uploadId: 'u-3' })
      if (path === '/_dsh/uploader/uploadStatus') return jsonResponse({ status: 'done', url: 'https://media.example.test/public.png' })
      return jsonResponse({}, 404)
    })
    const { container } = render(<HandoffCard t={t} />)
    await flush()
    const file = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } })
    await flush(1000)
    expect(screen.getByText(en['handoff.done'])).not.toBeNull()
    expect((container.textContent ?? '').includes('https://')).toBe(false)
    expect(screen.queryByRole('button', { name: en['handoff.cancel'] })).toBeNull()
    await flush(2000)
    expect(container.querySelector('article')).toBeNull()
  })
})

describe('C4 failed 与重选', () => {
  it('状态 failed 显示映射后的原因与「重新选择」；重新选择合法文件后成功', async () => {
    let oversized = true
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') return jsonResponse({ sessions: [session('u-4')] })
      if (path === '/_dsh/uploader/uploadStart') {
        if (oversized) return jsonResponse({ error: 'file_too_large' }, 400)
        return jsonResponse({ uploadId: 'u-4' })
      }
      if (path === '/_dsh/uploader/uploadStatus') return jsonResponse({ status: 'uploading', progress: 40 })
      return jsonResponse({}, 404)
    })
    render(<HandoffCard t={t} />)
    await flush()
    const big = new File([new Uint8Array([1, 2, 3, 4])], 'big.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [big] } })
    await flush()
    expect(screen.getByText(t('handoff.failed', { reason: en['handoff.reason.file_too_large'] }))).not.toBeNull()
    // 重新选择合法文件：uploadStart 受理，状态轮询接管。
    oversized = false
    fireEvent.click(screen.getByRole('button', { name: en['handoff.retry'] }))
    const good = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [good] } })
    await flush(1000)
    expect(screen.getByText(t('handoff.picking', { progress: 40 }))).not.toBeNull()
  })
})

describe('C5 取消', () => {
  it('点「取消」调 cancel；请求失败保留卡片并自动重试一次，成功后移除', async () => {
    let cancelCalls = 0
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') return jsonResponse({ sessions: [session('u-5')] })
      if (path === '/_dsh/uploader/cancel') {
        cancelCalls += 1
        return cancelCalls === 1 ? jsonResponse({}, 500) : jsonResponse({ cancelled: true })
      }
      return jsonResponse({}, 404)
    })
    const { container } = render(<HandoffCard t={t} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: en['handoff.cancel'] }))
    await flush()
    expect(cancelCalls).toBe(2)
    expect(container.querySelector('article')).toBeNull()

    // 两次都失败：卡片保留（等 pending 对账收敛）。
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') return jsonResponse({ sessions: [session('u-5b')] })
      if (path === '/_dsh/uploader/cancel') return jsonResponse({}, 503)
      return jsonResponse({}, 404)
    })
    await flush(3000)
    expect(container.querySelector('article')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['handoff.cancel'] }))
    await flush()
    expect(container.querySelector('article')).not.toBeNull()
  })
})

describe('C6 可见性轮询', () => {
  it('hidden 停止轮询；恢复 visible 立即拉取一次', async () => {
    let pendingCalls = 0
    stubFetch((path) => {
      if (path === '/_dsh/uploader/pending') {
        pendingCalls += 1
        return jsonResponse({ sessions: [] })
      }
      return jsonResponse({}, 404)
    })
    render(<HandoffCard t={t} />)
    await flush()
    expect(pendingCalls).toBe(1)
    await flush(3000)
    expect(pendingCalls).toBe(2)
    const setHidden = (state: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    setHidden('hidden')
    await flush(9000)
    expect(pendingCalls).toBe(2)
    setHidden('visible')
    await flush()
    expect(pendingCalls).toBe(3)
    await flush(3000)
    expect(pendingCalls).toBe(4)
  })
})

describe('C7 服务端集合对账', () => {
  it('pending 不再包含某本地 waiting 条目 → 该条目立即移除', async () => {
    let sessions = [session('u-7a'), session('u-7b')]
    stubFetch(path => path === '/_dsh/uploader/pending' ? jsonResponse({ sessions }) : jsonResponse({}, 404))
    const { container } = render(<HandoffCard t={t} />)
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(2)
    sessions = [session('u-7b')]
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(1)
    expect((container.textContent ?? '').includes('u-7a')).toBe(false)
  })

  it('pending 暂态失败（非 2xx / 载荷不合法）不等于服务端已清空：本地条目保留，恢复后继续对账', async () => {
    let mode: 'ok' | 'unavailable' | 'malformed' | 'empty' = 'ok'
    stubFetch(path => {
      if (path !== '/_dsh/uploader/pending') return jsonResponse({}, 404)
      if (mode === 'unavailable') return jsonResponse({ error: 'uploader_not_configured' }, 503)
      if (mode === 'malformed') return jsonResponse({ sessions: 'not-a-list' })
      return jsonResponse({ sessions: mode === 'empty' ? [] : [session('u-7c')] })
    })
    const { container } = render(<HandoffCard t={t} />)
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(1)
    mode = 'unavailable'
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(1)
    mode = 'malformed'
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(1)
    // 服务端明确返回空集合才是事实源：条目移除。
    mode = 'empty'
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(0)
  })
})

describe('C8 折叠计数', () => {
  it('超过 3 个待处理会话显示 3 张卡片与折叠计数', async () => {
    stubPendingOnly([session('u-8a'), session('u-8b'), session('u-8c'), session('u-8d')])
    const { container } = render(<HandoffCard t={t} />)
    await flush(3000)
    expect(container.querySelectorAll('article').length).toBe(3)
    expect(screen.getByText(t('handoff.more', { count: 1 }))).not.toBeNull()
  })
})

describe('C9 词典与文案红线', () => {
  it('zh / en 键集一致且全量成对', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh)) {
      expect(en[key as HandoffLocaleKey].length).toBeGreaterThan(0)
      expect(zh[key as HandoffLocaleKey].length).toBeGreaterThan(0)
    }
  })

  it('组件与 API 层无硬编码文案（词典是唯一中文文案源；注释先剥离）', () => {
    for (const name of ['handoff-card.tsx', 'upload-api.ts', 'index.ts']) {
      const source = readFileSync(join(process.cwd(), 'src', 'client', name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        // `//` 注释行（`://` 协议分隔不受影响）。
        .replace(/(^|[^:"'])\/\/[^\n]*$/gmu, '$1')
      expect(source).not.toMatch(/[一-鿿]/u)
    }
  })

  it('样式红线：无字面色值、无 !important、无全局选择器', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'client', 'handoff.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(source).not.toMatch(/!important/u)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(source).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/u)
    expect(source).not.toMatch(/(^|[}\n,{])(\s*)(body|html|:root|\*)\s*[,{]/u)
  })
})
