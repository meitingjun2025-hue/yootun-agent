/**
 * 源码层契约（source plane，始终运行）：kit 样式表装载清单与构建脚本容器名
 * 配置。bundle 产物侧的样式表元数据断言在 `pnpm run build` 的收尾脚本
 * `tests/client/verify-bundle-stylesheets.mjs` 执行（artifact plane，明确依赖
 * 构建；两个 plane 不互相替代）。
 *
 * 背景缺陷形态：kit 以编译产物内联进插件 bundle，类名映射冻结在 kit 构建时，
 * 样式表文本必须经 client/kit-styles.ts 的逐张 import 进入 bundle 的
 * `meta.stylesheets` 才会被安装；`@container` 名在 lightningcss css-modules
 * 下默认逐文件哈希，构建脚本必须以 `container: false` 保持
 * `yootun-kit-page` 跨文件稳定。
 * @module
 */
// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = process.cwd()
const clientDir = join(packageDir, 'src', 'client')
const kitSrc = join(packageDir, '..', '..', 'packages', 'dsh-client-ui-kit', 'src')
const presetSource = readFileSync(join(packageDir, '..', '..', '..', 'packages', 'client', 'tsdown.client.ts'), 'utf8')

/** 无样式表的 kit 导出名（locale / 翻译 / provider / 类型）。 */
const NO_STYLESHEET_EXPORTS = new Set([
  'createKitTranslate', 'KitLocaleProvider', 'useKitLocale', 'NS', 'en', 'zh',
  'LOCALE_PLACEHOLDERS', 'YtKitLocaleKey', 'YT_CHART_VARS', 'ytChartStyle',
  'YtChartColor', 'YtChartColorExport', 'ChartTooltipRow', 'KpiDeltaDirection',
  'ReasonButton', 'ReasonButtonProps', 'isOnInteractiveTarget', 'GestureEventLike',
])

/** 组件名 → 样式表文件的登记例外（其余按 kit 文件命名 kebab-case 推导）。 */
const IRREGULAR_FILES: Readonly<Record<string, string>> = {
  PluginPageShell: 'page-shell.module.css',
}

/** kebab-case 组件名 → kit 样式表文件名。 */
function stylesheetFileOf(component: string): string {
  return IRREGULAR_FILES[component] ?? `${component.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}.module.css`
}

/** client 源码里从 kit 桶导入的组件名集合（扫描全部 client 源文件，防新文件漏扫）。 */
function consumedKitComponents(): Set<string> {
  const names = new Set<string>()
  for (const file of readdirSync(clientDir).sort()) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue
    if (file === 'kit-styles.ts') continue
    const source = readFileSync(join(clientDir, file), 'utf8')
    for (const match of source.matchAll(/import \{([^}]+)\} from '@yootun\/dsh-client-ui-kit'/gu)) {
      for (const raw of match[1].split(',')) {
        // 取导入原名（剥 `X as 别名` 与 `type`），别名不代表新组件。
        const name = raw.trim().split(/\s+as\s+/u)[0]?.trim().replace(/^type /u, '') ?? ''
        if (name !== '' && !NO_STYLESHEET_EXPORTS.has(name)) names.add(name)
      }
    }
  }
  return names
}

describe('kit 样式表装载清单（源码层，防新增组件漏样式）', () => {
  const declared = [...readFileSync(join(clientDir, 'kit-styles.ts'), 'utf8').matchAll(/'@yootun\/dsh-client-ui-kit\/src\/([\w-]+\.module\.css)'/gu)]
    .map(match => match[1] as string)

  it('清单与本插件消费的 kit 组件一一对应，无缺漏、无冗余', () => {
    const expected = [...consumedKitComponents()].map(stylesheetFileOf).sort()
    expect(expected.length, '客户端至少消费一个带样式的 kit 组件').toBeGreaterThan(0)
    expect([...declared].sort()).toEqual(expected)
  })

  it('清单里每张样式表在 kit 源码中真实存在', () => {
    expect(declared.length).toBeGreaterThan(0)
    for (const file of declared) {
      expect(existsSync(join(kitSrc, file)), `${file} exists`).toBe(true)
    }
  })
})

describe('构建脚本容器名配置（源码层，防哈希化回退）', () => {
  it('tsdown.client.ts 两处 cssModules 均声明 container: false', () => {
    const sites = presetSource.match(/cssModules: \{ pattern: '\[hash\]_\[local\]', container: false \}/gu) ?? []
    expect(sites.length).toBeGreaterThanOrEqual(2)
    // 任何未带 container: false 的 module.css 编译点都是回退。
    expect(presetSource.match(/cssModules: \{ pattern: '\[hash\]_\[local\]' \}/gu)).toBeNull()
  })
})
