/**
 * 报表页样式守护（附录 B P14）：TSX 里引用的每个 css 类都在 report.module.css
 * 里有定义；样式表不含 `!important`、字面色值与 kit 或官方的类名（样式隔离，
 * 颜色只映射官方 token 或集中语义变量）。
 * @module
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// vitest 以包目录为 cwd（pnpm run test），src 静态扫描直接读盘。
const srcDir = join(process.cwd(), 'src')
const kitSrcDir = join(process.cwd(), '..', 'dsh-client-ui-kit', 'src')
const primitivesSrcDir = join(process.cwd(), '..', '..', '..', 'packages', 'client', 'ui-primitives', 'src')

/** 源文件里 css.Xxx 形式的类引用（不含声明文件）。 */
function referencedClasses(): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
    const source = readFileSync(join(srcDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const match of source.matchAll(/\bcss\.([A-Za-z0-9_]+)/gu)) {
      const bucket = refs.get(match[1]) ?? new Set<string>()
      bucket.add(name)
      refs.set(match[1], bucket)
    }
  }
  return refs
}

/** 样式表中定义的类名（剥注释后提取，注释里的 `.module.css` 等字样不计）。 */
function definedClasses(cssText: string): Set<string> {
  const source = cssText.replace(/\/\*[\s\S]*?\*\//gu, '')
  return new Set([...source.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/gu)].map(match => match[1]))
}

describe('P14 报表样式守护', () => {
  const cssText = readFileSync(join(srcDir, 'report.module.css'), 'utf8')

  it('TSX 引用的每个 css 类都在 report.module.css 中有定义', () => {
    const defined = definedClasses(cssText)
    const undefinedRefs = [...referencedClasses()].filter(([cls]) => !defined.has(cls))
    expect(undefinedRefs.map(([cls, files]) => `${cls}（${[...files].join('、')}）`)).toEqual([])
  })

  it('样式表不使用 !important 与字面色值（hex 与 rgb/hsl/oklch 族）', () => {
    const source = cssText.replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(source).not.toMatch(/!important/u)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(source).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/u)
  })

  it('样式表不含 kit 或官方 primitives 的类名（样式隔离）', () => {
    const foreign = new Set<string>()
    for (const dir of [kitSrcDir, primitivesSrcDir]) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.module.css')) continue
        for (const cls of definedClasses(readFileSync(join(dir, name), 'utf8'))) foreign.add(cls)
      }
    }
    const collisions = [...definedClasses(cssText)].filter(cls => foreign.has(cls)).sort()
    expect(collisions).toEqual([])
  })

  it('响应式断点挂 kit 页面容器（yootun-kit-page）；hover 与 reduced-motion 沿用迁移前的 @media 形态', () => {
    expect(cssText).toContain('@container yootun-kit-page (max-width: 1119px)')
    expect(cssText).toContain('@container yootun-kit-page (max-width: 639px)')
    // 视口断点禁用；@media (hover: hover) 与 @media (prefers-reduced-motion: reduce)
    // 不是断点，是迁移前样式表既有的行悬停与动效降级规则，随类复制保留。
    expect(cssText).not.toMatch(/@media[^{]*(min|max)-(width|height)/u)
    expect(cssText).toContain('@media (hover: hover)')
    expect(cssText).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
