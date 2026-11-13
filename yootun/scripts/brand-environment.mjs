/**
 * 品牌环境单一出口：读 `yootun/brand/brand.json`，产出打包链与 workflow 消费的环境变量
 * 映射。官方脚本一律「品牌环境值 ?? 官方缺省」，本脚本不注入时官方身份原样生效。
 *
 * 直接运行打印 `KEY=VALUE` 行（由调用方追加进 GITHUB_ENV 或 shell 环境）；feed origin
 * 未定稿（`feedOrigin: null`）时不输出，批次 5 定稿后自动生效。
 * 运行：`node yootun/scripts/brand-environment.mjs`。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const brandConfig = JSON.parse(readFileSync(join(repositoryRoot, 'yootun', 'brand', 'brand.json'), 'utf8'))

/** 品牌环境映射；值不含换行，可直接追加进 GITHUB_ENV。 */
export function resolveBrandEnvironment() {
  const iconPath = name => join(repositoryRoot, 'yootun', 'brand', 'assets', name)
  const environment = {
    YOOTUN_BRAND_PRODUCT_NAME: brandConfig.name,
    YOOTUN_BRAND_ARTIFACT_PREFIX: brandConfig.artifactPrefix,
    YOOTUN_BRAND_PROTOCOL_NAME: brandConfig.protocolName,
    YOOTUN_BRAND_TITLE: brandConfig.name,
    YOOTUN_BRAND_APP_ID: brandConfig.appId,
    YOOTUN_BRAND_ICON_MACOS: iconPath('icon-macos.png'),
    YOOTUN_BRAND_ICON_WINDOWS: iconPath('icon-windows.png'),
    YOOTUN_BRAND_TRAY_ICON: iconPath('tray-windows.ico'),
  }
  if (brandConfig.feedOrigin !== null) environment.YOOTUN_BRAND_FEED_ORIGIN = brandConfig.feedOrigin
  return environment
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  for (const [name, value] of Object.entries(resolveBrandEnvironment())) {
    process.stdout.write(`${name}=${value}\n`)
  }
}
