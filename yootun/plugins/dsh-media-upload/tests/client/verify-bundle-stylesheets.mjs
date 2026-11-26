/**
 * 构建产物收尾校验（artifact plane，由包构建脚本在 tsdown 之后执行）：client
 * bundle 的 stylesheet 安装元数据契约。卡片样式以 lightningcss 编译进 bundle
 * 的 `meta.stylesheets`，若类名映射内联而安装文本缺失，卡片将以无样式形态
 * 渲染；这里在构建期拦住该形态。源码层样式红线见 handoff-card.test.tsx。
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
check(metaText.includes('"src/client/handoff.module.css":{text:'), '插件自身样式表未进入 meta.stylesheets')

for (const mapName of ['handoff_module_css_default']) {
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
