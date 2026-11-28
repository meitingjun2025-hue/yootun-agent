/**
 * client 组件测试（jsdom）：键集、三 tab 布局契约、爆款仿写页区域、上传拦截
 * 与表单保留行为、稳定码覆盖、样式红线。与 wx-page.test.tsx 同款底盘。
 */
// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { apply, createWorkbenchLocaleSeat, type WorkbenchPageProps } from '../../src/client/index.ts'
import { en, zh, type XhsLocaleKey } from '../../src/client/locales.ts'
// 与 src/client/index.ts 同构：显式引入模块增强，补全 ClientContext 的合并面
// （包入口在门禁程序里以产物 d.ts 身份参与，d.ts 生成会丢掉这组空导入）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

const apiMock = vi.hoisted(() => ({
  hostAction: vi.fn(),
  startUploadSession: vi.fn(),
  sendUploadBytes: vi.fn(),
  pollUploadStatus: vi.fn(),
}))

vi.mock('../../src/client/api.ts', () => apiMock)

afterEach(cleanup)

beforeEach(() => {
  apiMock.hostAction.mockReset()
  apiMock.startUploadSession.mockReset()
  apiMock.sendUploadBytes.mockReset()
  apiMock.pollUploadStatus.mockReset()
  apiMock.hostAction.mockImplementation(async (action: string) => {
    if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
    throw new Error(`unexpected action ${action}`)
  })
  // jsdom 缺 objectURL：预览 URL 断言只需稳定字符串。
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock-preview', writable: true, configurable: true })
})

const t = (key: XhsLocaleKey, values?: Record<string, string | number>): string => {
  const text = en[key] ?? key
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
}

function makeFile(name: string, mime: string): File {
  return new File(['bytes'], name, { type: mime })
}

async function pickFiles(kind: 'image' | 'video', files: File[]): Promise<void> {
  const label = kind === 'image' ? en['material.addImage'] : en['material.addVideo']
  fireEvent.click(screen.getByRole('button', { name: label }))
  const input = document.querySelector('input[type="file"][accept^="' + (kind === 'image' ? 'image' : 'video') + '"]') as HTMLInputElement
  expect(input).not.toBeNull()
  const first = files[0]
  if (first === undefined) throw new Error('no file')
  // 新链路（流程 b）：先选文件，后建会话（manager.start 内部 pick-file → 字节流）。
  Object.defineProperty(input, 'files', {
    value: Object.assign(files, { item: (index: number) => files[index] ?? null, length: files.length }),
    configurable: true,
  })
  fireEvent.change(input)
  await waitFor(() => expect(apiMock.startUploadSession).toHaveBeenCalled())
}

/** locale 座位假件：快照对象只建一次（引用稳定）；active 与用例 kit 文案口径一致（en）。 */
const localeSnapshot = { active: 'en' }
const locale = {
  subscribe: () => () => undefined,
  getSnapshot: () => localeSnapshot,
}

describe('词典键集', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('R2：路由层拒绝原因（forbidden/unknown_action/method_not_allowed）显示 kit 2.6 文案', async () => {
    const { reasonText } = await import('../../src/client/format.ts')
    const t = (key: XhsLocaleKey): string => en[key] ?? key
    expect(reasonText('forbidden', t)).toBe(`${en['reason.forbidden']}（forbidden）`)
    expect(reasonText('unknown_action', t)).toBe(`${en['reason.unknown_action']}（unknown_action）`)
    expect(reasonText('method_not_allowed', t)).toBe(`${en['reason.method_not_allowed']}（method_not_allowed）`)
  })
})

describe('顶级导航（12 册 §2：只有爆款仿写 / 账号管理 / 车衣爆款看板三个 tab）', () => {
  it('tab 数量为 3，顺序固定，默认选中爆款仿写', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    // 顶级导航 tablist 以 panel 名标注；素材区子 tab 是另一个 tablist，不混入。
    const navTabs = screen.getAllByRole('tab').filter(tab => tab.closest('[role="tablist"]')?.getAttribute('aria-label') === en.panel)
    expect(navTabs.length).toBe(3)
    expect(navTabs.map(tab => tab.textContent)).toEqual([en['tab.rewrite'], en['tab.accounts'], en['tab.hotboard']])
    expect(navTabs[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('「素材」「发布」「创作」等泛化命名不是顶级 tab（布局契约铁律）', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.queryByRole('tab', { name: zh['material.title'] })).toBeNull()
    for (const banned of ['素材', '发布', '创作', '看板']) {
      expect(zh['tab.rewrite'] === banned || zh['tab.accounts'] === banned || zh['tab.hotboard'] === banned).toBe(false)
    }
    // 词典不提供泛化 tab 键。
    expect('tab.material' in zh).toBe(false)
    expect('tab.publish' in zh).toBe(false)
  })

  it('切到账号管理显示账号页（添加账号按钮可达，无新增顶级页面）', async () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    fireEvent.click(screen.getByRole('tab', { name: en['tab.accounts'] }))
    await waitFor(() => expect(screen.getByRole('button', { name: en['accounts.add'] })).not.toBeNull())
  })
})

describe('爆款仿写页区域（12 册 §3 ↔ 旧 client.js Overlay 仿写区）', () => {
  it('素材区（图片/视频 子 tab、添加、计数上限文案）、对标区、提交行、右栏空态全部可达', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.getByRole('region', { name: en['material.title'] })).not.toBeNull()
    expect(screen.getByRole('region', { name: en['reference.title'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['material.addImage'] })).not.toBeNull()
    expect(screen.getByText(t('material.imageHint', { count: 0 }))).not.toBeNull()
    expect(screen.getByLabelText(en['material.theme'])).not.toBeNull()
    expect(screen.getByLabelText(en['material.direction'])).not.toBeNull()
    expect(screen.getByLabelText(en['reference.note'])).not.toBeNull()
    expect(screen.getByLabelText(en['reference.account'])).not.toBeNull()
    expect(screen.getByRole('button', { name: en['action.submit'] })).not.toBeNull()
    expect(screen.getByRole('button', { name: en['action.cancelTask'] })).not.toBeNull()
    expect(screen.getByText(en['result.empty'])).not.toBeNull()
  })

  it('视频子 tab 显示理解视频开关（仅视频）', () => {
    render(<WorkbenchPage t={t} locale={locale} />)
    expect(screen.queryByRole('switch', { name: en['material.understandVideo'] })).toBeNull()
    fireEvent.click(screen.getByText(en['material.tab.video']))
    expect(screen.getByRole('switch', { name: en['material.understandVideo'] })).not.toBeNull()
  })
})

describe('上传拦截与表单保留（铁律 3：上传失败不丢表单；failed/无 URL 不进创建）', () => {
  // 模块级单例跨页面开关保留（旧 overlay 同型）：完整时序走单用例。
  function taskCreateCalls(): Array<[string, Record<string, unknown>]> {
    return apiMock.hostAction.mock.calls.filter(([action]) => action === 'task.create') as Array<[string, Record<string, unknown>]>
  }

  it('上传中拦截提交 → failed 不进创建且表单保留 → 移除后新素材完成可创建', async () => {
    apiMock.startUploadSession.mockResolvedValue({ uploadId: 'up-1', accept: ['jpg'], maxBytes: 500_000_000 })
    apiMock.sendUploadBytes.mockResolvedValue(true)
    apiMock.pollUploadStatus.mockResolvedValue({ status: 'uploading', progress: 20, bytesSent: 2, bytesTotal: 5, attempt: 0 })
    render(<WorkbenchPage t={t} locale={locale} />)
    await pickFiles('image', [makeFile('a.jpg', 'image/jpeg')])
    // 上传中：素材组内拦截——按钮可点但置灰，点击出提示，不调 task.create。
    await waitFor(() => expect(screen.getByText('20%')).not.toBeNull(), { timeout: 4000 })
    fireEvent.change(screen.getByLabelText(en['material.theme']), { target: { value: '保留主题' } })
    fireEvent.click(screen.getByRole('button', { name: en['action.submit'] }))
    expect(await screen.findByText(en['material.uploadingBlock'])).not.toBeNull()
    expect(taskCreateCalls()).toHaveLength(0)
    expect((screen.getByLabelText(en['material.theme']) as HTMLInputElement).value).toBe('保留主题')
    // 上传落 failed：提交提示 failed/无 URL，仍不调 task.create，表单保留。
    apiMock.pollUploadStatus.mockResolvedValue({ status: 'failed' })
    await waitFor(() => expect(screen.getAllByText(en['material.uploadFailed']).length).toBeGreaterThan(0), { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: en['action.submit'] }))
    expect(taskCreateCalls()).toHaveLength(0)
    expect((screen.getByLabelText(en['material.theme']) as HTMLInputElement).value).toBe('保留主题')
    // 移除 failed 素材 → 新素材上传直达 done（公网 URL）→ 可创建。
    fireEvent.click(screen.getAllByRole('button', { name: en['material.remove'] })[0] as HTMLButtonElement)
    apiMock.pollUploadStatus.mockResolvedValue({ status: 'done', url: 'https://cdn.example.com/media/b.jpg' })
    apiMock.hostAction.mockImplementation(async (action: string) => {
      if (action === 'browser.status') return { status: 'ready', chromeAvailable: true, driverAvailable: true, platform: 'linux' }
      if (action === 'task.create') {
        return { status: 'created', taskId: 'xhst-test', idempotencyKey: 'k', mediaType: 'images', versionCount: 1, taskStatus: 'queued' }
      }
      if (action === 'task.status') return { status: 'ready', taskId: 'xhst-test', taskStatus: 'running', currentStep: 'copywriting' }
      throw new Error(`unexpected action ${action}`)
    })
    fireEvent.click(screen.getByRole('button', { name: en['material.addImage'] }))
    const input = document.querySelector('input[type="file"][accept^="image"]') as HTMLInputElement
    const file = makeFile('b.jpg', 'image/jpeg')
    Object.defineProperty(input, 'files', { value: Object.assign([file], { item: () => file, length: 1 }), configurable: true })
    fireEvent.change(input)
    await waitFor(() => {
      const submit = screen.getByRole('button', { name: en['action.submit'] })
      expect(submit.getAttribute('aria-disabled')).not.toBe('true')
    }, { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: en['action.submit'] }))
    await waitFor(() => {
      const calls = taskCreateCalls()
      expect(calls).toHaveLength(1)
      const args = calls[0]?.[1] as Record<string, unknown>
      // versionCount 是 Host 侧定案（固定 1），client→Host 契约不携带该字段。
      expect(args.versionCount).toBeUndefined()
      expect(args.imageUrls).toEqual(['https://cdn.example.com/media/b.jpg'])
      expect(typeof args.idempotencyKey).toBe('string')
      expect((args.idempotencyKey as string).length).toBeGreaterThan(0)
    }, { timeout: 4000 })
  })
})

describe('样式红线', () => {
  const srcDir = join(process.cwd(), 'src', 'client')
  it('无 !important、无全局选择器、无字面色', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css')) continue
      const source = readFileSync(join(srcDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(source).not.toMatch(/!important/u)
      expect(source).not.toMatch(/@tailwind|@apply/u)
      expect(source).not.toMatch(/(^|[}\n,{])(\s*)(body|html|:root|\*)\s*[,{]/u)
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
      expect(source).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/u)
    }
  })

  it('无 yxh-* 旧类名迁移、无 <style> 注入、无旧 inline style 技术', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css') && !name.endsWith('.tsx')) continue
      const source = readFileSync(join(srcDir, name), 'utf8')
      expect(source).not.toMatch(/\byxh-/u)
      expect(source).not.toMatch(/dangerouslySetInnerHTML|document\.createElement\('style'\)/u)
    }
  })

  it('断点与 reduced-motion 覆盖（640 / 880 / 1120 容器档）与两栏布局', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('yootun-kit-page')
    expect(css).toContain('max-width: 1119px')
    expect(css).toContain('max-width: 879px')
    expect(css).toContain('max-width: 639px')
    expect(css).toContain('prefers-reduced-motion')
    // 12 册 §6：宽于 1120 两栏按原比例（旧 yxh-body minmax 比例）。
    expect(css).toContain('minmax(460px, 1.15fr) minmax(420px, 0.85fr)')
    expect(css).toContain('minmax(0, 1.15fr) minmax(0, 0.85fr)')
  })

  it('容器查询依赖 PluginPageShell（容器名对齐）', () => {
    const kitDir = join(process.cwd(), '..', '..', 'packages', 'dsh-client-ui-kit', 'src')
    expect(existsSync(join(kitDir, 'page-shell.module.css'))).toBe(true)
  })
})

describe('locale 座位工厂（P2/F：生产接线守卫）', () => {
  it('createWorkbenchLocaleSeat：类实例 face 解构后可用、快照引用稳定；apply 经工厂注入', () => {
    class FakeLocaleFace {
      snapshot = { active: 'zh-CN' }
      readonly listeners = new Set<() => void>()
      // 读 this 的方法形态（生产 ctx.locale 即类实例）：工厂不保 this 就会在此抛错。
      getSnapshot(): { active: string } { return this.snapshot }
      subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      }
      publish(next: { active: string }): void {
        this.snapshot = next
        this.listeners.forEach(fn => fn())
      }
    }
    const face = new FakeLocaleFace()
    // 解构即生产现场（useSyncExternalStore(locale.subscribe, locale.getSnapshot)）。
    const { subscribe, getSnapshot } = createWorkbenchLocaleSeat(face)
    let notified = 0
    const unsubscribe = subscribe(() => { notified += 1 })
    const first = getSnapshot()
    expect(first).toBe(face.snapshot)
    face.publish({ active: 'en' })
    expect(notified).toBe(1)
    expect(getSnapshot()).not.toBe(first)
    expect(getSnapshot().active).toBe('en')
    unsubscribe()
    face.publish({ active: 'zh-CN' })
    expect(notified).toBe(1)
    // 源码级兜底：apply 的座位必须经工厂（防改回内联对象或 undefined）。
    const indexSource = readFileSync(join(process.cwd(), 'src', 'client', 'index.ts'), 'utf8')
    expect(indexSource).toContain('const locale = createWorkbenchLocaleSeat(ctx.locale)')
    expect(indexSource).toContain('export function createWorkbenchLocaleSeat')
  })
  it('apply 经 slot 注入的 locale 是基于 ctx.locale 的座位，t 走 bind（接线守卫）', () => {
    class FakeLocaleFace {
      snapshot = { active: 'zh-CN' }
      readonly listeners = new Set<() => void>()
      bind(): (key: XhsLocaleKey, values?: Record<string, string | number>) => string {
        return (key, values) => {
          const text = en[key] ?? key
          if (values === undefined) return text
          return text.replace(/\{(\w+)\}/gu, (_match, token: string) => String(values[token] ?? `{${token}}`))
        }
      }
      register(): () => void { return () => undefined }
      getSnapshot(): { active: string } { return this.snapshot }
      subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      }
      publish(next: { active: string }): void {
        this.snapshot = next
        this.listeners.forEach(fn => fn())
      }
    }
    const localeFace = new FakeLocaleFace()
    const registered: Array<{ name: string; spec: Record<string, unknown> }> = []
    type ApplyCtx = Parameters<typeof apply>[0]
    const applyUnderTest = apply as (ctx: Partial<Record<keyof ApplyCtx, unknown>>) => void
    applyUnderTest({
      locale: localeFace,
      slots: {
        inject: (_name: string, factory: () => unknown) => factory(),
        register: (spec: { name: string }, _component: unknown) => {
          registered.push({ name: String(spec.name), spec })
          return () => undefined
        },
      },
      effect: (fn: () => unknown) => fn(),
    })
    const mainSpec = registered.find(entry => entry.name === 'main')
    expect(mainSpec).toBeDefined()
    const injected = mainSpec !== undefined ? (mainSpec.spec.inject as () => WorkbenchPageProps)() : undefined
    expect(injected).toBeDefined()
    const { t, locale } = injected!
    // (a) locale 基于 ctx.locale：快照同引用，face 发布即通知座位订阅者。
    const first = locale.getSnapshot()
    expect(first).toBe(localeFace.snapshot)
    let notified = 0
    const unsubscribe = locale.subscribe(() => { notified += 1 })
    localeFace.publish({ active: 'en' })
    expect(notified).toBe(1)
    expect(locale.getSnapshot().active).toBe('en')
    unsubscribe()
    // (b) t 经 bind 读词典。
    expect(t('panel')).toBe(en['panel'])
  })
})
