/**
 * 源码层契约（source plane，始终运行）：kit 样式表装载清单与构建脚本容器名
 * 配置。bundle 产物侧的样式表元数据断言在 `pnpm run build` 的收尾脚本
 * `tests/client/verify-bundle-stylesheets.mjs` 执行（artifact plane，明确依赖
 * 构建；两个 plane 不互相替代）。与 wx-bundle.test.ts 同款守护。
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

describe('稳定码 → 词典键覆盖（源码层，防新增稳定码漏文案）', () => {
  it('REASON_KEYS 覆盖 Host STABLE_ERROR_CODES 全集', async () => {
    const { STABLE_ERROR_CODES } = await import('../../src/errors.ts')
    const { COVERED_REASON_KEYS, reasonText } = await import('../../src/client/format.ts')
    const zh = (await import('../../src/client/locales.ts')).zh
    for (const code of STABLE_ERROR_CODES) {
      // REASON_KEYS 已类型穷尽（缺键 build 失败）；这里锁定值指向的词典键确有文案。
      const key = (COVERED_REASON_KEYS as Record<string, string>)[code]
      expect(key, `missing reason key for ${code}`).toBe(`reason.${code}`)
      expect(key in zh, `missing zh copy for ${code}`).toBe(true)
    }
    // 未知码走通用文案并保留原码（含上传 machine 归一形态）。
    const withValues = (key: string, values?: Record<string, string | number>): string =>
      values === undefined ? key : `${key}:${String(values.code ?? '')}`
    expect(reasonText('not_found_unknown', withValues)).toContain('not_found_unknown')
    // 连接器鉴权投影与 Host 收敛码的口径（分册 08 §5.2 / 实施单 2.7）。
    expect(reasonText('UNAUTHORIZED', withValues)).toBe('reason.UNAUTHORIZED（UNAUTHORIZED）')
    expect(reasonText('host_unreachable', withValues)).toBe('reason.host_unreachable（host_unreachable）')
  })
})
