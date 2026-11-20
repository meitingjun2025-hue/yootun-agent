/**
 * 构建产物契约（artifact plane）：插件 client bundle 的 stylesheet 安装元数据。
 * 页面壳的 `container: yootun-kit-page / inline-size` 必须随 bundle 元数据真实
 * 安装（P0 布局缺陷：kit 样式表未进 meta，页面壳 container 落空，全部
 * `@container` 规则失效、布局退化为单列）。本测试消费 `lib/client.js` 构建产物
 * ——先执行 `pnpm --filter @yootun/dsh-wx-channels-workbench run build`，产物缺
 * 失时显式跳过。computed-layout 的浏览器实测由 .ui-review/ 证据脚本承担。
 * @module
 */
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = join(process.cwd(), 'lib', 'client.js')
const hasBundle = (() => {
  try { readFileSync(bundlePath); return true } catch { return false }
})()

describe.skipIf(!hasBundle)('client bundle stylesheet 安装元数据', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  const metaStart = bundle.indexOf('stylesheets:{')
  const metaText = metaStart < 0 ? '' : bundle.slice(metaStart, metaStart + 400_000)

  it('kit 页面壳样式表进入 bundle 的 meta.stylesheets（随插件模块记录安装）', () => {
    expect(metaStart).toBeGreaterThanOrEqual(0)
    expect(metaText).toContain('"node_modules/@yootun/dsh-client-ui-kit/src/page-shell.module.css":{text:')
    expect(metaText).toContain('"src/client/workbench.module.css":{text:')
  })

  it('容器名稳定共享：container 声明与全部 @container 规则使用同一个未哈希的 yootun-kit-page', () => {
    expect(metaText).toContain('container:yootun-kit-page/inline-size')
    const containerRules = metaText.match(/@container ([\w-]+)[^{]*\{/g) ?? []
    expect(containerRules.length).toBeGreaterThan(0)
    expect(containerRules.every(rule => rule.startsWith('@container yootun-kit-page '))).toBe(true)
  })

  it('无逐文件哈希的容器名残留（历史缺陷形态：tsuz_W_yootun-kit-page 等）', () => {
    expect(metaText).not.toMatch(/@container [\w-]+_yootun-kit-page/u)
  })

  it('kit 冻结类名映射与安装文本一致（组件消费的类名在样式表中有规则）', () => {
    for (const mapName of ['page_shell_module_css_default', 'plugin_header_module_css_default', 'data_state_module_css_default', 'kpi_card_module_css_default']) {
      const mapMatch = bundle.match(new RegExp(`${mapName}\\s*=\\s*\\{([^}]*)\\}`))
      expect(mapMatch, `${mapName} class map inlined`).not.toBeNull()
      const names = [...(mapMatch![1] as string).matchAll(/`(\w+)`/g)].map(match => match[1])
      expect(names.length, `${mapName} has class entries`).toBeGreaterThan(0)
      // 映射里的编译类名必须出现在安装文本中（规则或属性选择器紧随形式）。
      for (const name of names) {
        expect(metaText.includes(name), `${mapName} class ${name} present in installed css`).toBe(true)
      }
    }
  })
})
