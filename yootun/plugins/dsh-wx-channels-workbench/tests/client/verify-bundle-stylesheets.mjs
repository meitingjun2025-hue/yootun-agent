/**
 * 构建产物收尾校验（artifact plane，由包构建脚本在 tsdown 之后执行）：client
 * bundle 的 stylesheet 安装元数据契约。背景缺陷：kit 以编译产物内联、其样式
 * 表文本未进 bundle 的 `meta.stylesheets`，页面壳 `container` 声明从未安装，
 * 全部 `@container` 规则失效、作品页退化为上下堆叠；lightningcss css-modules
 * 默认逐文件哈希 `@container` 名，跨文件永不相配。源码层对应守护见
 * wx-bundle.test.ts；computed layout 浏览器实测由 .ui-review/ 证据脚本承担。
 * @module
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const bundlePath = join(process.cwd(), 'lib', 'client.js')
const bundle = readFileSync(bundlePath, 'utf8')
const metaStart = bundle.indexOf('stylesheets:{')
const metaText = metaStart < 0 ? '' : bundle.slice(metaStart, metaStart + 400_000)

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

check(metaStart >= 0, 'bundle 缺少 meta.stylesheets 安装元数据')
check(
  metaText.includes('"node_modules/@yootun/dsh-client-ui-kit/src/page-shell.module.css":{text:'),
  'kit 页面壳样式表未进入 bundle 的 meta.stylesheets',
)
check(metaText.includes('"src/client/workbench.module.css":{text:'), '插件自身样式表未进入 meta.stylesheets')
check(metaText.includes('container:yootun-kit-page/inline-size'), '页面壳容器名声明缺失或被哈希')

const containerRules = metaText.match(/@container ([\w-]+)[^{]*\{/g) ?? []
check(containerRules.length > 0, '安装文本中没有任何 @container 规则')
check(
  containerRules.every(rule => rule.startsWith('@container yootun-kit-page ')),
  `容器名未统一为 yootun-kit-page：${containerRules.filter(rule => !rule.startsWith('@container yootun-kit-page ')).slice(0, 3).join('、')}`,
)
check(!/@container [\w-]+_yootun-kit-page/u.test(metaText), '存在逐文件哈希的容器名残留')

for (const mapName of ['page_shell_module_css_default', 'plugin_header_module_css_default', 'data_state_module_css_default', 'kpi_card_module_css_default']) {
  const mapMatch = bundle.match(new RegExp(`${mapName}\\s*=\\s*\\{([^}]*)\\}`))
  check(mapMatch !== null, `${mapName} 类名映射未内联`)
  if (mapMatch === null) continue
  for (const name of [...mapMatch[1].matchAll(/`(\w+)`/g)].map(entry => entry[1])) {
    check(metaText.includes(name), `${mapName} 冻结类名 ${name} 在安装文本中无规则`)
  }
}

if (failures.length > 0) {
  console.error(`verify-bundle-stylesheets: ${failures.length} 项失败`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('verify-bundle-stylesheets: stylesheet 安装元数据契约通过')
