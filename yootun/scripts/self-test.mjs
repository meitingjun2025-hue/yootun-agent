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
  for (const name of ['icon-windows.png', 'icon-macos.png', 'tray-windows.ico']) {
    readFileSync(join(brandRoot, 'assets', name))
  }
})

test('yootun bundle patch 关官方品牌包并插入自有包', () => {
  const patch = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-bundle-yootun', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: ui-brand-official\n\s+disabled: true\n/u)
  assert.match(patch, /- id: yootun-ui-brand\n\s+name: '@yootun\/dsh-client-ui-brand'\n/u)
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
  const updateEnvironment = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'desktop-auto-update-environment.mjs'), 'utf8')
  assert.match(updateEnvironment, /process\.env\.YOOTUN_BRAND_FEED_ORIGIN \?\? 'https:\/\/download\.deepseek\.com'/u)
  const clientEnvironment = readFileSync(join(repositoryRoot, 'scripts', 'client-build-environment.ts'), 'utf8')
  assert.match(clientEnvironment, /process\.env\.YOOTUN_BRAND_TITLE \?\? 'DeepSeek Harness'/u)
})

test('品牌环境出口覆盖全部收口键且不含未定稿 feed', async () => {
  const { resolveBrandEnvironment } = await import('./brand-environment.mjs')
  const environment = resolveBrandEnvironment()
  for (const name of ['YOOTUN_BRAND_PRODUCT_NAME', 'YOOTUN_BRAND_ARTIFACT_PREFIX', 'YOOTUN_BRAND_PROTOCOL_NAME', 'YOOTUN_BRAND_TITLE', 'YOOTUN_BRAND_APP_ID', 'YOOTUN_BRAND_ICON_MACOS', 'YOOTUN_BRAND_ICON_WINDOWS', 'YOOTUN_BRAND_TRAY_ICON']) {
    assert.equal(typeof environment[name], 'string', name)
    assert.ok(environment[name].length > 0, name)
  }
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
