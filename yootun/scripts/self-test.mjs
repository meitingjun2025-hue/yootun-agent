/**
 * yootun 分区自有自检（node --test，不进官方 vitest scope）：品牌单一来源结构、
 * bundle patch 层序、生成产物规格、品牌环境出口。运行：`node --test yootun/scripts/self-test.mjs`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const brandRoot = join(repositoryRoot, 'yootun', 'brand')
const brandConfig = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'))

test('brand.json 承载全部品牌身份定案值', () => {
  assert.equal(brandConfig.name, 'Yootun-Agent')
  assert.equal(brandConfig.appId, 'ai.yootun.agent')
  assert.equal(brandConfig.artifactPrefix, 'Yootun-Agent')
  assert.equal(brandConfig.validationVersion, 1)
  assert.equal(brandConfig.palette.ink, '#0F172A')
  assert.match(brandConfig.palette.primary, /^#[0-9A-F]{6}$/u)
})

test('brand.json 素材引用与派生产物都在库', () => {
  for (const name of ['appIconSource', 'sidebarMark', 'heroMark']) {
    readFileSync(join(brandRoot, brandConfig.artwork[name]))
  }
  for (const name of ['icon-windows.png', 'icon-macos.png', 'tray-windows.ico', 'installer-windows.ico']) {
    readFileSync(join(brandRoot, 'assets', name))
  }
  for (const name of ['brand.png', 'brand-2x.png', 'brand-dark.png', 'brand-dark-2x.png', 'uninstaller-sidebar.png']) {
    readFileSync(join(brandRoot, 'assets', 'installer', name))
  }
  readFileSync(join(brandRoot, 'assets', 'welcome', 'welcome-brand.svg'))
})

test('yootun bundle patch 关官方品牌包并插入自有包', () => {
  const patch = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-bundle-yootun', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: ui-brand-official\n\s+disabled: true\n/u)
  assert.match(patch, /- id: yootun-ui-brand\n\s+name: '@yootun\/dsh-client-ui-brand'\n/u)
})

test('bundle patch 收口企业模型路由且保留官方模型设置页（批次 4，分册 03 B/决策点 10）', () => {
  const patch = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-bundle-yootun', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: llm-deepseek\n\s+config:\n\s+apiKeyEnv: MODELS_API_KEY\n\s+baseURL: https:\/\/ixicai\.cn\/api\/v1\n/u)
  assert.match(patch, /- id: agent-default-model\n\s+config:\n\s+provider: deepseek-official\n\s+model: deepseek-v4-flash\n/u)
  assert.match(patch, /- id: yootun-access\n\s+name: '@yootun\/dsh-client-ui-access'\n/u)
  // 决策点 10：ui-settings-models 不 disable（无 disabled 行），显式注释声明零动作。
  assert.match(patch, /ui-settings-models 保持官方默认/u)
  assert.doesNotMatch(patch, /- id: ui-settings-models\n\s+disabled/u)
  // managed MCP patch 格式定稿（D 部分）：样例为注释、含凭证模板与租户头。
  assert.match(patch, /Authorization: \$\{credential:MODELS_API_KEY\}/u)
  assert.match(patch, /X-Company-Code: yootun/u)
})

test('激活契约版本单一来源：brand.json → 环境出口 → client 构建内联 → access 生成常量（分册 03 C）', () => {
  const brandEnvironment = readFileSync(join(repositoryRoot, 'yootun', 'scripts', 'brand-environment.mjs'), 'utf8')
  assert.match(brandEnvironment, /YOOTUN_BRAND_VALIDATION_VERSION: String\(brandConfig\.validationVersion\)/u)
  const tsdownClient = readFileSync(join(repositoryRoot, 'packages', 'client', 'tsdown.client.ts'), 'utf8')
  assert.match(tsdownClient, /'process\.env\.YOOTUN_BRAND_VALIDATION_VERSION': JSON\.stringify\(process\.env\.YOOTUN_BRAND_VALIDATION_VERSION \?\? '1'\)/u)
  const generated = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-client-ui-access', 'src', 'access-constants.ts'), 'utf8')
  assert.match(generated, /export const VALIDATION_VERSION = process\.env\.YOOTUN_BRAND_VALIDATION_VERSION \?\? '1'/u)
  assert.match(generated, /export const TENANT_ID = '/u)
})

test('access 包 host 半暴露 yootun-access namespace 与同源激活路由', () => {
  const host = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-client-ui-access', 'src', 'index.ts'), 'utf8')
  assert.match(host, /setupComplete: z\.boolean\(\)\.default\(false\)\.volatile\(\)/u)
  assert.match(host, /validationVersion: z\.number\(\)\.default\(0\)\.volatile\(\)/u)
  assert.match(host, /path: '\/api\/desktop\/dofe\/validate'/u)
  assert.match(host, /path: '\/api\/desktop\/dofe\/models'/u)
})

test('品牌包素材被 access 包按官方 asset 契约持有副本且生成链覆盖', () => {
  const generated = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-client-ui-access', 'scripts', 'generate-access-constants.mjs'), 'utf8')
  assert.match(generated, /copyFileSync\(join\(brandRoot, brandConfig\.artwork\.sidebarMark\)/u)
  readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-client-ui-access', 'src', 'client', 'assets', 'sidebar-mark.png'))
})

test('桌面 profile bundles 与打包闭包都接入 yootun bundle', () => {
  const projectManager = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'src', 'project-manager.ts'), 'utf8')
  assert.match(projectManager, /DESKTOP_BUNDLES = \[\.\.\.WEB_PROFILE\.bundles, '@yootun\/dsh-bundle-yootun'\]/u)
  const packageSet = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'prepare-package-set.ts'), 'utf8')
  assert.match(packageSet, /YOOTUN_BUNDLE_PACKAGE = '@yootun\/dsh-bundle-yootun'/u)
})

test('官方打包脚本按「品牌环境 ?? 官方缺省」收口', () => {
  const builderConfig = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs'), 'utf8')
  assert.match(builderConfig, /env\.YOOTUN_BRAND_PRODUCT_NAME \?\? 'DeepSeek Harness'/u)
  assert.match(builderConfig, /env\.YOOTUN_BRAND_ICON_MACOS \?\?/u)
  // 分册 06 问题 1/2/7 的扩展收口：安装器图标、产物后缀、欢迎窗展示图。
  assert.match(builderConfig, /env\.YOOTUN_BRAND_ARTIFACT_SUFFIX \?\? output\.suffix/u)
  assert.match(builderConfig, /env\.YOOTUN_BRAND_INSTALLER_ICON/u)
  assert.match(builderConfig, /env\.YOOTUN_BRAND_WELCOME_ASSETS/u)
  assert.match(builderConfig, /installerIcon: brandInstallerIcon, uninstallerIcon: brandInstallerIcon/u)
  const installerScript = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'prepare-windows-installer.ps1'), 'utf8')
  assert.match(installerScript, /env:YOOTUN_BRAND_INSTALLER_ASSETS/u)
  assert.match(installerScript, /Join-Path \$assetSource "\$asset\.png"/u)
  const updateEnvironment = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'desktop-auto-update-environment.mjs'), 'utf8')
  assert.match(updateEnvironment, /process\.env\.YOOTUN_BRAND_FEED_ORIGIN \?\? 'https:\/\/download\.deepseek\.com'/u)
  const clientEnvironment = readFileSync(join(repositoryRoot, 'scripts', 'client-build-environment.ts'), 'utf8')
  assert.match(clientEnvironment, /process\.env\.YOOTUN_BRAND_TITLE \?\? 'DeepSeek Harness'/u)
  // 分册 06 问题 3：首页空态标语键集。
  assert.match(clientEnvironment, /process\.env\.YOOTUN_BRAND_TAGLINE_ZH \?\? '探索未至之境'/u)
  assert.match(clientEnvironment, /process\.env\.YOOTUN_BRAND_TAGLINE_EN \?\? 'Into the Unknown'/u)
  const conversationLocales = readFileSync(join(repositoryRoot, 'packages', 'client', 'ui-conversation', 'src', 'client', 'locales.ts'), 'utf8')
  // 分册 06 第二轮「供给端直通」定案：headline 直接消费 YOOTUN_BRAND_TAGLINE_* define（八语言档同型，缺省为各语言官方标语）。
  assert.equal(conversationLocales.match(/process\.env\.YOOTUN_BRAND_TAGLINE_ZH \?\?/gu)?.length, 1)
  assert.equal(conversationLocales.match(/process\.env\.YOOTUN_BRAND_TAGLINE_EN \?\?/gu)?.length, 7)
})

test('品牌环境出口覆盖全部收口键且不含未定稿 feed', async () => {
  const { resolveBrandEnvironment } = await import('./brand-environment.mjs')
  const environment = resolveBrandEnvironment()
  for (const name of ['YOOTUN_BRAND_PRODUCT_NAME', 'YOOTUN_BRAND_ARTIFACT_PREFIX', 'YOOTUN_BRAND_PROTOCOL_NAME', 'YOOTUN_BRAND_TITLE', 'YOOTUN_BRAND_APP_ID', 'YOOTUN_BRAND_ICON_MACOS', 'YOOTUN_BRAND_ICON_WINDOWS', 'YOOTUN_BRAND_TRAY_ICON', 'YOOTUN_BRAND_TAGLINE_ZH', 'YOOTUN_BRAND_TAGLINE_EN', 'YOOTUN_BRAND_INSTALLER_ASSETS', 'YOOTUN_BRAND_INSTALLER_ICON', 'YOOTUN_BRAND_WELCOME_ASSETS']) {
    assert.equal(typeof environment[name], 'string', name)
    assert.ok(environment[name].length > 0, name)
  }
  // 分册 06 问题 7：产物后缀品牌覆盖为空串（自有 feed 的 unsigned 产物无混淆风险）。
  assert.equal(environment.YOOTUN_BRAND_ARTIFACT_SUFFIX, '')
  assert.equal(environment.YOOTUN_BRAND_FEED_ORIGIN, undefined)
})

test('tray ICO 帧清单与编码形态对齐官方', () => {
  const ico = readFileSync(join(brandRoot, 'assets', 'tray-windows.ico'))
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  const count = ico.readUInt16LE(4)
  assert.deepEqual(
    Array.from({ length: count }, (_, index) => ico[6 + index * 16]),
    brandConfig.artwork.trayFrames,
  )
  for (let index = 0; index < count; index += 1) {
    const offset = ico.readUInt32LE(6 + index * 16 + 12)
    assert.deepEqual(
      [...ico.subarray(offset, offset + 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    )
  }
})

test('安装器位图规格逐项对齐官方素材与安装器 ICO 帧清单', () => {
  const officialAssets = join(repositoryRoot, 'apps', 'desktop', 'installer', 'assets')
  for (const name of ['brand.png', 'brand-2x.png', 'brand-dark.png', 'brand-dark-2x.png', 'uninstaller-sidebar.png']) {
    const official = readFileSync(join(officialAssets, name))
    const branded = readFileSync(join(brandRoot, 'assets', 'installer', name))
    // PNG 宽高在 IHDR 头（字节 16-23）；品牌产物尺寸必须与官方同名素材一致。
    assert.deepEqual([...branded.subarray(16, 24)], [...official.subarray(16, 24)], name)
  }
  const installerIco = readFileSync(join(brandRoot, 'assets', 'installer-windows.ico'))
  const count = installerIco.readUInt16LE(4)
  // ICO 目录项宽度为 1 字节，256 帧按规范存 0。
  assert.deepEqual(
    Array.from({ length: count }, (_, index) => {
      const byte = installerIco[6 + index * 16]
      return byte === 0 ? 256 : byte
    }),
    brandConfig.artwork.installer.iconFrames,
  )
  const welcomeSvg = readFileSync(join(brandRoot, 'assets', 'welcome', 'welcome-brand.svg'), 'utf8')
  assert.match(welcomeSvg, /viewBox="0 0 472 40"/u)
  assert.match(welcomeSvg, /data:image\/png;base64,/u)
})
