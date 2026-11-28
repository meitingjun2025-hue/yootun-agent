/** 样式红线与主题变量静态扫描：全局 CSS、!important、字面色、断点与动效守卫。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { YT_CHART_VARS } from '../src/tokens.ts'
import { en, zh } from '../src/locales.ts'

// vitest 以包目录为 cwd（pnpm run test），src 静态扫描直接读盘。
const srcDir = join(process.cwd(), 'src')

function cssFiles(): string[] {
  return readdirSync(srcDir).filter(name => name.endsWith('.module.css')).map(name => join(srcDir, name))
}

describe('样式红线', () => {
  it('不使用 !important、全局选择器与 Tailwind 指令', () => {
    for (const file of cssFiles()) {
      // 先剥离注释，避免把说明文案里的普通词当选择器。
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(source, file).not.toMatch(/!important/u)
      expect(source, file).not.toMatch(/@tailwind|@apply/u)
      expect(source, file).not.toMatch(/(^|[}\n,{])(\s*)(body|html|:root|\*)\s*[,{]/u)
    }
  })

  it('不出现字面颜色（hex 与 rgb/hsl/oklch 族），颜色一律 var() 引用', () => {
    for (const file of cssFiles()) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
      expect(source, file).not.toMatch(/\b(rgba?|hsla?|oklch|oklab|color)\(/u)
    }
  })

  it('交互控件提供 :focus-visible 焦点路径', () => {
    const withControls = ['filter-bar.module.css', 'assistant-dock.module.css']
    for (const name of withControls) {
      const source = readFileSync(join(srcDir, name), 'utf8')
      expect(source, name).toContain(':focus-visible')
    }
  })
})

describe('响应式与动效', () => {
  it('页面壳以容器查询覆盖 640 / 880 / 1120 三档边界', () => {
    const shell = readFileSync(join(srcDir, 'page-shell.module.css'), 'utf8')
    expect(shell).toContain('container: yootun-kit-page')
    expect(shell).toContain('max-width: 879px')
    expect(shell).toContain('max-width: 639px')
    const dock = readFileSync(join(srcDir, 'assistant-dock.module.css'), 'utf8')
    expect(dock).toContain('max-width: 1119px')
  })

  it('Dock 动效声明 prefers-reduced-motion 降级', () => {
    const dock = readFileSync(join(srcDir, 'assistant-dock.module.css'), 'utf8')
    expect(dock).toContain('prefers-reduced-motion')
  })
})

describe('语义 token', () => {
  it('图表语义变量全部映射官方 token，无字面色', () => {
    for (const value of Object.values(YT_CHART_VARS)) {
      expect(value.startsWith('var(--dsw-'), value).toBe(true)
    }
  })

  it('组件样式只消费 --yt-*/--dsw-* 变量，不引入第二套色板', () => {
    for (const file of cssFiles()) {
      const source = readFileSync(file, 'utf8')
      const colorVars = [...source.matchAll(/var\((--[a-z-]+)/gu)]
        .map(match => match[1])
        .filter((name): name is string => name !== undefined)
      for (const name of colorVars) {
        expect(name.startsWith('--yt-') || name.startsWith('--dsw-') || name.startsWith('--ds-'), `${file}: ${name}`).toBe(true)
      }
    }
  })

  it('词典键集与 en 全量同步（重申组件库词表契约）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
