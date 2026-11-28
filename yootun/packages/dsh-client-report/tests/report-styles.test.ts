/**
 * 报表页样式守护（附录 B P14）：TSX 里引用的每个 css 类都在 report.module.css
 * 里有定义；样式表不含 `!important`、字面色值与 kit 或官方的类名（样式隔离，
 * 颜色只映射官方 token 或集中语义变量）；花括号配平，规则只出现在顶层或
 * `@media`、`@container` 块内。
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
      const cls = match[1]
      if (cls === undefined) throw new Error(`css. 引用缺少捕获组: ${match[0]}`)
      const bucket = refs.get(cls) ?? new Set<string>()
      bucket.add(name)
      refs.set(cls, bucket)
    }
  }
  return refs
}

/** 样式表中定义的类名（剥注释后提取，注释里的 `.module.css` 等字样不计）。 */
function definedClasses(cssText: string): Set<string> {
  const source = cssText.replace(/\/\*[\s\S]*?\*\//gu, '')
  return new Set([...source.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/gu)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined))
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
    expect(cssText).toContain('@container yootun-kit-page (max-width: 879px)')
    expect(cssText).toContain('@container yootun-kit-page (max-width: 639px)')
    // 视口断点禁用；@media (hover: hover) 与 @media (prefers-reduced-motion: reduce)
    // 不是断点，是迁移前样式表既有的行悬停与动效降级规则，随类复制保留。
    expect(cssText).not.toMatch(/@media[^{]*(min|max)-(width|height)/u)
    expect(cssText).toContain('@media (hover: hover)')
    expect(cssText).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('KPI 行列数三档（容器查询）：880 及以上六列、640–879 两列、小于 640 单列', () => {
    expect(cssText).toMatch(/\.kpiRow\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/u)
    expect(cssText).toMatch(/@container yootun-kit-page \(max-width: 879px\)\s*\{\s*\.kpiRow\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/u)
    expect(cssText).toMatch(/@container yootun-kit-page \(max-width: 639px\)\s*\{\s*\.kpiRow\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u)
  })

  it('详情分区间距为相邻一级分区 20px；表格样式只服务 dataTable（并写带入的 workTable/scheduleTable/colAction/axisSvg 不再出现）', () => {
    expect(cssText).toMatch(/\.reportBody\s*\{[^}]*gap:\s*20px/u)
    expect(cssText).toMatch(/\.cellAction\s*\{[^}]*max-width:\s*96px/u)
    expect(cssText).not.toMatch(/\.(workTable|scheduleTable|axisSvg)\b/u)
    expect(cssText).not.toMatch(/\.colAction\b/u)
  })

  it('花括号配平，规则只出现在顶层或 @media、@container 块内（不使用原生嵌套规则）', () => {
    // 去注释后逐字符扫描：`{` 入栈当前块的选择器，`}` 出栈，`;` 结束一条声明并清空
    // 选择器缓存。栈非空且栈顶不是 @ 规则时再遇 `{`，说明规则被嵌进了普通选择器块，
    // 其选择器会带上祖先限定：一个多余的未闭合 `{` 曾让 `.reportBody { gap: 20px }`
    // 及其后所有规则失效，而按文本匹配的断言照常通过。
    const source = cssText.replace(/\/\*[\s\S]*?\*\//gu, '')
    const stack: string[] = []
    const nested: string[] = []
    let prelude = ''
    for (const ch of source) {
      if (ch === '{') {
        const parent = stack[stack.length - 1]
        if (parent !== undefined && !parent.startsWith('@')) nested.push(`${parent.trim()} { ${prelude.trim()}`)
        stack.push(prelude.trim())
        prelude = ''
      } else if (ch === '}') {
        stack.pop()
        prelude = ''
      } else if (ch === ';') {
        prelude = ''
      } else {
        prelude += ch
      }
    }
    expect(stack).toEqual([])
    expect(nested).toEqual([])
  })
})
