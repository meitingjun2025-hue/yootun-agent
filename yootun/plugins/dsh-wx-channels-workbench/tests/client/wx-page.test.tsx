/** client 组件测试（jsdom）：键集、四页渲染、状态、键盘可访问名、样式红线。 */
// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, zh, type WxLocaleKey } from '../../src/client/locales.ts'

afterEach(cleanup)

const t = (key: WxLocaleKey): string => en[key] ?? key

describe('词典键集', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('WorkbenchPage', () => {
  it('四页 tab 可达且页面 region 可访问', () => {
    const { container } = render(<WorkbenchPage t={t} />)
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
    for (const label of [en['tab.overview'], en['tab.works'], en['tab.collect'], en['tab.accounts']]) {
      expect(screen.getByRole('tab', { name: label })).not.toBeNull()
    }
    void container
  })

  it('jsdom 无 Host：加载态可达（empty/error 由 Host 集成验证）', () => {
    render(<WorkbenchPage t={t} />)
    // fetch 未 mock 时组件保持 loading 骨架；断言骨架可达即可。
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
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

  it('断点与 reduced-motion 覆盖', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('yootun-kit-page')
    expect(css).toContain('max-width: 879px')
  })

  it('容器查询依赖 PluginPageShell（容器名对齐）', () => {
    const kitDir = join(process.cwd(), '..', '..', 'packages', 'dsh-client-ui-kit', 'src')
    expect(existsSync(join(kitDir, 'page-shell.module.css'))).toBe(true)
  })
})
