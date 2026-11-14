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
const brandAssetsRoot = join(repositoryRoot, 'yootun', 'brand', 'assets')

/** 品牌环境映射；值不含换行，可直接追加进 GITHUB_ENV。 */
export function resolveBrandEnvironment() {
  const iconPath = name => join(brandAssetsRoot, name)
  const environment = {
    YOOTUN_BRAND_PRODUCT_NAME: brandConfig.name,
    YOOTUN_BRAND_ARTIFACT_PREFIX: brandConfig.artifactPrefix,
    YOOTUN_BRAND_PROTOCOL_NAME: brandConfig.protocolName,
    YOOTUN_BRAND_TITLE: brandConfig.name,
    YOOTUN_BRAND_APP_ID: brandConfig.appId,
    // Client 构建环境键：官方 define 按 DSH_CLIENT_ 前缀从流程环境透传进产物
    // （scripts/client-build-environment.ts），品牌名与空态标语由此进入 client 产物。
    DSH_CLIENT_PRODUCT_NAME: brandConfig.name,
    DSH_CLIENT_TAGLINE_ZH: brandConfig.mission.zh,
    DSH_CLIENT_TAGLINE_EN: brandConfig.mission.en,
    YOOTUN_BRAND_EYEBROW: brandConfig.eyebrow,
    // 激活契约版本（分册 03 C 部分）：门禁判定与写入同源的唯一字面量，构建期 define 进 access 包产物。
    YOOTUN_BRAND_VALIDATION_VERSION: String(brandConfig.validationVersion),
    YOOTUN_BRAND_ICON_MACOS: iconPath('icon-macos.png'),
    YOOTUN_BRAND_ICON_WINDOWS: iconPath('icon-windows.png'),
    YOOTUN_BRAND_TRAY_ICON: iconPath('tray-windows.ico'),
    // 首页空态标语（分册 06 问题 3）：官方构建键集 DSH_CLIENT_TAGLINE_ZH/EN 的品牌值。
    YOOTUN_BRAND_TAGLINE_ZH: brandConfig.mission.zh,
    YOOTUN_BRAND_TAGLINE_EN: brandConfig.mission.en,
    // 安装器位图素材源目录与 NSIS 安装器/卸载器图标（分册 06 问题 1）。
    YOOTUN_BRAND_INSTALLER_ASSETS: join(brandAssetsRoot, 'installer'),
    YOOTUN_BRAND_INSTALLER_ICON: iconPath('installer-windows.ico'),
    // 欢迎窗展示图覆盖目录（分册 06 问题 2）：目录内 welcome-brand.svg 覆盖拷入安装包。
    YOOTUN_BRAND_WELCOME_ASSETS: join(brandAssetsRoot, 'welcome'),
    // 产物后缀置空（分册 06 问题 7）：自有 feed 分发 unsigned 产物，无与官方签名产物混淆的风险。
    YOOTUN_BRAND_ARTIFACT_SUFFIX: '',
  }
  if (brandConfig.feedOrigin !== null) environment.YOOTUN_BRAND_FEED_ORIGIN = brandConfig.feedOrigin
  return environment
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  for (const [name, value] of Object.entries(resolveBrandEnvironment())) {
    process.stdout.write(`${name}=${value}\n`)
  }
}
