/**
 * yootun 分区自有自检（node --test，不进官方 vitest scope）：品牌单一来源结构、
 * bundle patch 层序、生成产物规格、品牌环境出口、测试类型门禁的文本检查用例。
 * 运行：`node --test yootun/scripts/self-test.mjs`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { reviewFileText } from './typecheck-tests.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const brandRoot = join(repositoryRoot, 'yootun', 'brand')
const brandConfig = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'))

/** Count PowerShell grouping parentheses outside strings and comments. */
function countPowerShellParentheses(source) {
  let depth = 0
  let minimumDepth = 0
  let state = 'code'
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (character === '<' && next === '#') {
        state = 'block-comment'
        index += 1
      } else if (character === '#') {
        state = 'line-comment'
      } else if (character === "'") {
        state = 'single-quote'
      } else if (character === '"') {
        state = 'double-quote'
      } else if (character === '(') {
        depth += 1
      } else if (character === ')') {
        depth -= 1
        minimumDepth = Math.min(minimumDepth, depth)
      }
    } else if (state === 'block-comment') {
      if (character === '#' && next === '>') {
        state = 'code'
        index += 1
      }
    } else if (state === 'line-comment') {
      if (character === '\n') state = 'code'
    } else if (state === 'single-quote') {
      if (character === "'" && next === "'") index += 1
      else if (character === "'") state = 'code'
    } else if (state === 'double-quote') {
      if (character === '`') index += 1
      else if (character === '"' && next === '"') index += 1
      else if (character === '"') state = 'code'
    }
  }
  return { depth, minimumDepth }
}

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
  // 2026-11-14 协议定案：网关只服务 OpenAI 兼容协议，企业路由经 llm-pi-ai
  // 预置 provider（openai_response），llm-deepseek 收口撤除（恢复 base 默认）。
  assert.match(patch, /- id: llm-pi-ai\n\s+config:\n\s+providers:\n\s+yootun:\n\s+displayName: Yootun\n\s+apiKeyEnv: MODELS_API_KEY\n\s+api: openai-responses\n\s+baseURL: https:\/\/ixicai\.cn\/api\/v1/u)
  assert.match(patch, /- id: agent-default-model\n\s+config:\n\s+provider: yootun\n\s+model: deepseek-v4-flash\n/u)
  assert.match(patch, /- id: yootun-access\n\s+name: '@yootun\/dsh-client-ui-access'\n/u)
  // 决策点 10：ui-settings-models 不 disable（无 disabled 行），显式注释声明零动作。
  assert.match(patch, /ui-settings-models 保持官方默认/u)
  assert.doesNotMatch(patch, /- id: ui-settings-models\n\s+disabled/u)
  // managed MCP patch 格式定稿（D 部分）：样例为注释、含凭证模板与租户头。
  assert.match(patch, /Authorization: Bearer \$\{credential:MODELS_API_KEY\}/u)
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
  const updateEnvironment = readFileSync(join(repositoryRoot, 'apps', 'desktop-publisher', 'src', 'desktop-auto-update-environment.mjs'), 'utf8')
  assert.match(updateEnvironment, /env\.YOOTUN_BRAND_FEED_ORIGIN !== undefined/u)
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

test('Windows 安装器准备脚本保持可解析的分组括号', () => {
  const installerScript = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'prepare-windows-installer.ps1'), 'utf8')
  const balance = countPowerShellParentheses(installerScript)
  assert.equal(balance.depth, 0)
  assert.ok(balance.minimumDepth >= 0)
  // The Windows argument-parsing chain consumes the quotes in `/DNAME=L"value"` before cl sees the macro.
  // Generate a forced-include header instead so the C++ token is always L"value".
  assert.doesNotMatch(installerScript, /\/DINSTALLER_PRODUCT_NAME=/u)
  assert.match(installerScript, /\$productHeader = Join-Path \$output 'installer-product\.h'/u)
  assert.match(installerScript, /#define INSTALLER_PRODUCT_NAME L"/u)
  assert.match(installerScript, /\$productInclude = '\/FI"\{0\}"' -f \$productHeader/u)
  assert.match(installerScript, /'cl \/nologo[^\r\n]*\{4\} "\{0\}"[^\r\n]*\$productInclude\)\)/u)
})

test('品牌环境出口覆盖全部收口键（批次 5 起含 feed 定稿四键）', async () => {
  const { resolveBrandEnvironment } = await import('./brand-environment.mjs')
  const environment = resolveBrandEnvironment()
  for (const name of ['YOOTUN_BRAND_PRODUCT_NAME', 'YOOTUN_BRAND_ARTIFACT_PREFIX', 'YOOTUN_BRAND_PROTOCOL_NAME', 'YOOTUN_BRAND_TITLE', 'YOOTUN_BRAND_APP_ID', 'YOOTUN_BRAND_ICON_MACOS', 'YOOTUN_BRAND_ICON_WINDOWS', 'YOOTUN_BRAND_TRAY_ICON', 'YOOTUN_BRAND_TAGLINE_ZH', 'YOOTUN_BRAND_TAGLINE_EN', 'YOOTUN_BRAND_INSTALLER_ASSETS', 'YOOTUN_BRAND_INSTALLER_ICON', 'YOOTUN_BRAND_WELCOME_ASSETS']) {
    assert.equal(typeof environment[name], 'string', name)
    assert.ok(environment[name].length > 0, name)
  }
  // 分册 06 问题 7：产物后缀品牌覆盖为空串（自有 feed 的 unsigned 产物无混淆风险）。
  assert.equal(environment.YOOTUN_BRAND_ARTIFACT_SUFFIX, '')
  // 批次 5 feed 定稿（决策点 5）：TOS 直连 origin 无路径 + 放行前缀 keyPrefix + 打包链部署键。
  assert.equal(environment.YOOTUN_BRAND_FEED_ORIGIN, 'https://dofe-public.tos-cn-beijing.volces.com')
  assert.equal(environment.YOOTUN_BRAND_FEED_KEY_PREFIX, 'yootun-agent/releases')
  assert.equal(environment.DSH_DESKTOP_AUTO_UPDATE_ENV, 'production')
  assert.equal(environment.DSH_DESKTOP_UPDATE_CHANNEL, 'stable')
})

test('unsigned 品牌包生成更新 feed 且 keyPrefix 落在 TOS 放行前缀（批次 5 配合项）', () => {
  const builderConfig = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs'), 'utf8')
  // update 条件：品牌 feed 环境在（YOOTUN_BRAND_FEED_ORIGIN）时 unsigned 也解析 update。
  assert.match(builderConfig, /unsigned && env\.YOOTUN_BRAND_FEED_ORIGIN === undefined\s*\n\s*\? undefined/u)
  // mac 侧：品牌 unsigned 加 zip 更新目标并放开 dmg update info（stable-mac.yml 产物来源）。
  assert.match(builderConfig, /target: unsigned && env\.YOOTUN_BRAND_FEED_ORIGIN === undefined \? \['dmg'\] : \['dmg', 'zip'\]/u)
  assert.match(builderConfig, /writeUpdateInfo: unsigned && env\.YOOTUN_BRAND_FEED_ORIGIN !== undefined/u)
  const updateEnvironment = readFileSync(join(repositoryRoot, 'apps', 'desktop-publisher', 'src', 'desktop-auto-update-environment.mjs'), 'utf8')
  // keyPrefix 品牌可覆盖（读函数参数 env，与函数内其他键同源），官方 dsh-desk 缺省；
  // feed URL = origin/prefix/feeds/<target>/（平台子目录）。
  assert.match(updateEnvironment, /env\.YOOTUN_BRAND_FEED_KEY_PREFIX \?\? 'dsh-desk'/u)
  assert.match(updateEnvironment, /httpsOrigin\(env\.YOOTUN_BRAND_FEED_ORIGIN, 'YOOTUN_BRAND_FEED_ORIGIN'\)/u)
  assert.match(updateEnvironment, /`\$\{releasePrefix\}\/feeds\/\$\{target\}`/u)
  assert.match(updateEnvironment, /publicUrl: `\$\{origin\}\/\$\{keyPrefix\}\/`/u)
  // 内联 #8：mac 本地打包环境仅品牌 feed 态透传更新部署键，且 appId 品牌可覆盖。
  const packageEnvironment = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'scripts', 'desktop-package-environment.mjs'), 'utf8')
  assert.match(packageEnvironment, /environment\.YOOTUN_BRAND_APP_ID \?\? 'com\.deepseek\.harness'/u)
  assert.match(packageEnvironment, /environment\.YOOTUN_BRAND_FEED_ORIGIN !== undefined && environment\.DSH_DESKTOP_AUTO_UPDATE_ENV !== undefined/u)
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

// ---------------------------------------------------------------------------
// P1 桌面共用基础设施（2026-11-16）：插件分区与包验收的自检入口。这里的
// 静态断言零依赖；各包的行为测试由各包 test 脚本承载（见 P1 批次验收报告），
// 通过 `pnpm --filter '@yootun/*' test` 分批执行。

test('插件分区 workspace 登记与 bundle 插入对齐 P1 交付面', () => {
  const workspace = readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /- yootun\/packages\/\*/u)
  assert.match(workspace, /- yootun\/plugins\/\*/u, 'inline #1 扩展的插件分区 glob')
  const patch = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-bundle-yootun', 'cordis.patch.yml'), 'utf8')
  // P1 插入的三个 Host 基础插件。
  for (const name of ['@yootun/dsh-managed-mcp', '@yootun/dsh-workbench-mcp', '@yootun/dsh-media-upload']) {
    assert.ok(patch.includes(`name: '${name}'`), `bundle patch 插入 ${name}`)
  }
  // P2 视频号工作台已插入（2026-11-17）；P3 小红书工作台已插入（2026-11-20）；
  // P4 抖音工作台已插入（D9 集成批次，2026-11-22）；Catalog 仍不插。
  assert.ok(patch.includes(`name: '@yootun/dsh-wx-channels-workbench'`), 'P2 bundle 插入视频号工作台')
  assert.ok(patch.includes(`name: '@yootun/dsh-xhs-workbench'`), 'P3 bundle 插入小红书工作台')
  assert.ok(patch.includes(`name: '@yootun/dsh-douyin-workbench'`), 'P4 bundle 插入抖音工作台')
  assert.ok(!patch.includes('yootun-catalog'), 'bundle 不插入 yootun-catalog')
  const wxManifest = JSON.parse(readFileSync(join(repositoryRoot, 'yootun', 'plugins', 'dsh-wx-channels-workbench', 'package.json'), 'utf8'))
  assert.equal(Array.isArray(wxManifest.dsh?.client?.inject), true, 'wx 包 dsh.client.inject 声明存在')
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-bundle-yootun', 'package.json'), 'utf8'))
  // bare 插件必须出现在 resolver manifest 的 dependencies（加载器解析面）。
  for (const dependency of ['@yootun/dsh-managed-mcp', '@yootun/dsh-workbench-mcp', '@yootun/dsh-media-upload', '@yootun/dsh-wx-channels-workbench', '@yootun/dsh-xhs-workbench', '@yootun/dsh-douyin-workbench']) {
    assert.equal(manifest.dependencies[dependency], 'workspace:*', `bundle dependencies 含 ${dependency}`)
  }
})

test('yootun Host 插件包发布完整运行时 JavaScript 产物', () => {
  const runtimePlugins = [
    'dsh-managed-mcp',
    'dsh-workbench-mcp',
    'dsh-wx-channels-workbench',
    'dsh-xhs-workbench',
    'dsh-douyin-workbench',
  ]
  for (const plugin of runtimePlugins) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'yootun', 'plugins', plugin, 'package.json'), 'utf8'))
    assert.ok(manifest.files?.includes('lib/*.js'), `${plugin} files 覆盖动态 Host chunk`)
    assert.match(manifest.scripts.build, /node \.\.\/\.\.\/scripts\/verify-plugin-runtime-bundle\.mjs/u, `${plugin} build 校验运行时闭包`)
  }
  for (const plugin of ['dsh-managed-mcp', 'dsh-workbench-mcp']) {
    const config = readFileSync(join(repositoryRoot, 'yootun', 'plugins', plugin, 'tsdown.config.ts'), 'utf8')
    assert.ok(
      config.includes('alwaysBundle: [/^@yootun\\/dsh-client-ui-access(?:\\/.*)?$/u'),
      `${plugin} 内联接入层生成常量`,
    )
  }
})

// ---------------------------------------------------------------------------
// 测试类型门禁的护栏（2026-11-28）：流程步骤与护栏文档清单不可删除。规范
// 全文见 yootun/docs/test-type-safety-standard.md。

test('桌面流程保留测试类型门禁步骤，且位于构建 yootun 包之后、打包之前', () => {
  const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'yootun-desktop-package.yml'), 'utf8')
  const buildStep = workflow.indexOf('- name: Build yootun packages')
  const gateStep = workflow.indexOf('- name: Run yootun test type gate')
  const packageStep = workflow.indexOf('- name: Package unsigned installer')
  assert.notEqual(buildStep, -1, 'Build yootun packages 步骤存在')
  assert.notEqual(gateStep, -1, '测试类型门禁步骤不可删除（规范 docs/test-type-safety-standard.md）')
  assert.notEqual(packageStep, -1, 'Package unsigned installer 步骤存在')
  assert.ok(gateStep > buildStep, '门禁步骤必须在构建之后：被引用项目要读已生成的声明文件')
  assert.ok(gateStep < packageStep, '门禁步骤必须在打包之前：坏测试不应进入打包闭包')
  const gateBlock = workflow.slice(gateStep, packageStep)
  assert.match(gateBlock, /run: node yootun\/scripts\/typecheck-tests\.mjs(?:\s|$)/u, '门禁步骤运行 typecheck-tests.mjs')
})

test('护栏文档清单含测试类型安全规范的链接', () => {
  const overview = readFileSync(join(repositoryRoot, 'yootun', 'OVERVIEW.md'), 'utf8')
  assert.match(overview, /\[docs\/test-type-safety-standard\.md\]\(docs\/test-type-safety-standard\.md\)/u, 'OVERVIEW.md 护栏文档清单链接 docs/test-type-safety-standard.md')
})

// ---------------------------------------------------------------------------
// 测试类型门禁的文本检查用例（2026-11-28）：门禁模块导出的纯函数 reviewFileText
// 按表驱动样例自测，每个检查项都有「必须报出」与「不得误报」两类样例。导入门禁
// 模块只定义函数，不触发 tsc，也不依赖构建产物。

test('门禁文本检查对禁止写法的表驱动样例逐条报出', () => {
  const flagged = [
    { name: '@ts-nocheck 首行', file: 'tests/a.test.ts', code: '// @ts-nocheck\nconst bad: number = "s"\n', pattern: /@ts-nocheck 禁止使用/u },
    { name: '@ts-nocheck 非首行', file: 'tests/a.test.ts', code: '// 版权头注释\n// @ts-nocheck\nconst bad: number = "s"\n', pattern: /@ts-nocheck 禁止使用/u },
    { name: '@ts-ignore', file: 'tests/a.test.ts', code: '// @ts-ignore\nconst bad: number = "s"\n', pattern: /@ts-ignore 禁止使用/u },
    { name: 'as any', file: 'tests/a.test.ts', code: 'const x = v as any\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: ': any 注解', file: 'tests/a.test.ts', code: 'const x: any = 1\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: '<any>x 断言', file: 'tests/a.test.ts', code: 'const x = <any>v\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: 'Array<any>', file: 'tests/a.test.ts', code: 'const x: Array<any> = []\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: 'Record<string, any>', file: 'tests/a.test.ts', code: 'const x: Record<string, any> = {}\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: 'any[]', file: 'tests/a.test.ts', code: 'const x: any[] = []\nexport { x }\n', pattern: /any 类型禁止使用/u },
    { name: '@ts-expect-error 在 tests/types/ 之外', file: 'tests/a.test.ts', code: '// @ts-expect-error -- 原因\nconst bad: number = "s"\n', pattern: /只在 tests\/types\//u },
    { name: '@ts-expect-error 的 -- 之后无原因', file: 'tests/types/route-types.ts', code: '// @ts-expect-error --\nconst bad: number = "s"\n', pattern: /-- 之后必须写明原因/u },
    { name: '.tsx 里同样判定 as any', file: 'tests/c/a.test.tsx', code: 'const el = <div>ok</div>\nconst x = el as any\nexport { el, x }\n', pattern: /any 类型禁止使用/u },
    { name: '@ts-ignore 在顶层语句之间', file: 'tests/a.test.ts', code: 'const a = 1\n// @ts-ignore\nconst bad: number = "s"\nexport { a, bad }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '@ts-ignore 在回调体内', file: 'tests/a.test.ts', code: 'test("x", () => {\n  // @ts-ignore\n  const bad: number = "s"\n})\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '@ts-ignore 在实参列表内', file: 'tests/a.test.ts', code: 'foo(\n  // @ts-ignore\n  1,\n)\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '@ts-expect-error 在数组字面量内', file: 'tests/a.test.ts', code: 'const a: number[] = [\n  // @ts-expect-error -- reason\n  "text",\n]\nexport { a }\n', pattern: /只在 tests\/types\//u },
    { name: '@ts-ignore 在 JSX 属性之间', file: 'tests/c/a.test.tsx', code: 'const el = <div\n  // @ts-ignore\n  title={1}\n/>\nexport { el }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '@ts-ignore 在多行语句右侧', file: 'tests/a.test.ts', code: 'let n: string\nn = // @ts-ignore\n  1\nexport { n }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '@ts-nocheck 在函数体内', file: 'tests/a.test.ts', code: 'function f() {\n  // @ts-nocheck\n  const bad: number = "s"\n}\nexport { f }\n', pattern: /@ts-nocheck 禁止使用/u },
    { name: '@ts-expect-error 在 tests/types/ 之外的回调体内', file: 'tests/a.test.ts', code: 'test("x", () => {\n  // @ts-expect-error -- 原因\n  const bad: number = "s"\n})\n', pattern: /只在 tests\/types\//u },
    { name: '@ts-expect-error 在 tests/types/ 内的嵌套位置且 -- 后无原因', file: 'tests/types/route-types.ts', code: 'const f = () => {\n  // @ts-expect-error --\n  const bad: number = "s"\n}\nvoid f\n', pattern: /-- 之后必须写明原因/u },
    { name: '顶层上一行的块注释 @ts-ignore', file: 'tests/a.test.ts', code: '/* @ts-ignore */\nconst bad: number = "s"\nexport { bad }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '顶层上一行的 JSDoc 形态 @ts-ignore', file: 'tests/a.test.ts', code: '/** @ts-ignore */\nconst bad: number = "s"\nexport { bad }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '实参列表内的块注释 @ts-ignore', file: 'tests/a.test.ts', code: 'foo(\n  /* @ts-ignore */\n  1,\n)\n', pattern: /@ts-ignore 禁止使用/u },
    { name: 'JSX 子节点的块注释 @ts-ignore', file: 'tests/c/a.test.tsx', code: 'const el = <div>\n  {/* @ts-ignore */}\n  ok\n</div>\nexport { el }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: 'JSX 子节点的 JSDoc 形态 @ts-expect-error', file: 'tests/c/a.test.tsx', code: 'const el = <div>\n  {/** @ts-expect-error */}\n  ok\n</div>\nexport { el }\n', pattern: /只在 tests\/types\//u },
    { name: 'JSX 属性之间的块注释 @ts-ignore', file: 'tests/c/a.test.tsx', code: 'const el = <div\n  /* @ts-ignore */\n  title={1}\n/>\nexport { el }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: 'tests/types/ 之外的块注释 @ts-expect-error', file: 'tests/a.test.ts', code: '/* @ts-expect-error */\nconst bad: number = "s"\nexport { bad }\n', pattern: /只在 tests\/types\//u },
    { name: '前缀匹配的 @ts-ignored', file: 'tests/a.test.ts', code: '// @ts-ignored\nconst bad: number = "s"\nexport { bad }\n', pattern: /@ts-ignore 禁止使用/u },
    { name: '前缀匹配的 @ts-expect-errors（块注释）', file: 'tests/a.test.ts', code: '/* @ts-expect-errors */\nconst bad: number = "s"\nexport { bad }\n', pattern: /只在 tests\/types\//u },
    { name: '@ts-expect-error 在 tests/types/ 内的嵌套块注释且 -- 后无原因', file: 'tests/types/route-types.ts', code: 'const f = () => {\n  /** @ts-expect-error -- */\n  const bad: number = "s"\n}\nvoid f\n', pattern: /-- 之后必须写明原因/u },
    { name: '@ts-expect-error 在 tests/types/ 内的嵌套块注释且无 --', file: 'tests/types/route-types.ts', code: 'const f = () => {\n  /** @ts-expect-error */\n  const bad: number = "s"\n}\nvoid f\n', pattern: /-- 之后必须写明原因/u },
    { name: '多行块注释的 -- 写在指令之前的行', file: 'tests/types/route-types.ts', code: '/* -- 假装写了原因\n@ts-expect-error */\nconst bad: number = "s"\n', pattern: /-- 之后必须写明原因/u },
  ]
  for (const { name, file, code, pattern } of flagged) {
    const { violations } = reviewFileText(file, code)
    assert.ok(violations.some(line => pattern.test(line)), `必须报出「${name}」，实际：${JSON.stringify(violations)}`)
  }
})

test('门禁文本检查对合法写法不误报', () => {
  const clean = [
    { name: '字符串里的 // @ts-ignore 字样', file: 'tests/a.test.ts', code: 'const s = "// @ts-ignore"\nexport { s }\n' },
    { name: '块注释里不在开头的 @ts-nocheck 字样', file: 'tests/a.test.ts', code: '/* 见 @ts-nocheck 的说明 */\nconst ok: number = 1\nexport { ok }\n' },
    { name: 'JSDoc 中间行的 @ts-expect-error 字样', file: 'tests/types/route-types.ts', code: '/**\n * reason 码在 tsc 下报错（@ts-expect-error 未命中会反过来报错）。\n */\nexport type T = 1\n' },
    { name: '测试标题里的英文单词 any', file: 'tests/a.test.ts', code: 'test("works with any config", () => {})\n' },
    { name: '值位置的 any 标识符', file: 'tests/a.test.ts', code: 'const any = 1\nexport { any }\n' },
    { name: '属性名 any', file: 'tests/a.test.ts', code: 'const o = { any: 1 }\nexport { o }\n' },
    { name: '正则字面量里的 @ts-ignore 字样', file: 'tests/a.test.ts', code: 'const re = /@ts-ignore/\nexport { re }\n' },
    { name: 'JSX 文本里的指令字样', file: 'tests/c/a.test.tsx', code: 'const el = <p>http://x 与 @ts-ignore</p>\nexport { el }\n' },
    { name: 'tests/types/ 内带原因的 @ts-expect-error', file: 'tests/types/route-types.ts', code: '// @ts-expect-error -- reason 必须是登记的稳定码白名单成员\nconst bad: number = "s"\n' },
    { name: 'tests/types/ 内嵌套块注释带原因的 @ts-expect-error', file: 'tests/types/route-types.ts', code: 'const f = () => {\n  /** @ts-expect-error -- reason 必须是登记的稳定码白名单成员 */\n  const bad: number = "s"\n}\nvoid f\n' },
    { name: '回调体内块注释里不在开头的 @ts-nocheck 字样', file: 'tests/a.test.ts', code: 'test("x", () => {\n  /* 见 @ts-nocheck 的说明 */\n  const ok: number = 1\n})\n' },
    { name: '回调体内 JSDoc 中间行的 @ts-expect-error 字样', file: 'tests/types/route-types.ts', code: 'test("x", () => {\n  /**\n   * 见 @ts-expect-error 的说明。\n   */\n  const ok: number = 1\n})\n' },
    { name: '函数体内字符串里的指令字样', file: 'tests/a.test.ts', code: 'function f() {\n  const s = "// @ts-ignore"\n  return s\n}\nvoid f\n' },
    { name: '函数体内模板字符串里的指令字样', file: 'tests/a.test.ts', code: 'function f() {\n  const t = `x @ts-ignore`\n  return t\n}\nvoid f\n' },
    { name: '函数体内行注释里指令字样不在开头', file: 'tests/a.test.ts', code: 'function f() {\n  // 见 @ts-ignore 的说明\n  const ok: number = 1\n}\nvoid f\n' },
    { name: '顶层块注释里指令字样不在开头', file: 'tests/a.test.ts', code: '/* 见 @ts-ignore 的说明 */\nconst ok: number = 1\nexport { ok }\n' },
    { name: '大写 @TS-IGNORE 的块注释', file: 'tests/a.test.ts', code: '/* @TS-IGNORE */\nconst ok: number = 1\nexport { ok }\n' },
    { name: '函数体内正则字面量里的指令字样', file: 'tests/a.test.ts', code: 'function f() {\n  const re = /@ts-ignore/\n  return re\n}\nvoid f\n' },
    { name: '嵌套 JSX 文本里的指令字样', file: 'tests/c/a.test.tsx', code: 'const el = <div>\n  <span>@ts-ignore</span>\n</div>\nexport { el }\n' },
  ]
  for (const { name, file, code } of clean) {
    const { violations } = reviewFileText(file, code)
    assert.deepEqual(violations, [], `不得误报「${name}」`)
  }
})

test('门禁文本检查的基线计数按语法节点统计', () => {
  const counted = [
    { name: 'as never 计一处', file: 'tests/a.test.ts', code: 'const x = v as never\nexport { x }\n', counts: { 'as never': 1, '两段式断言': 0 } },
    { name: 'as unknown as 计一处', file: 'tests/a.test.ts', code: 'const x = v as unknown as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '单独 as unknown 不计两段式断言', file: 'tests/a.test.ts', code: 'const x = v as unknown\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: 'as {} as 计一处', file: 'tests/a.test.ts', code: 'const x = (v as {}) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: 'as object as 计一处', file: 'tests/a.test.ts', code: 'const x = (v as object) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '尖括号内层 (<unknown>x) as 计一处', file: 'tests/a.test.ts', code: 'const x = (<unknown>v) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '尖括号内层 <{}>x as 计一处', file: 'tests/a.test.ts', code: 'const x = <{}>v as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '尖括号外层 <T>(x as unknown) 计一处', file: 'tests/a.test.ts', code: 'const x = <number>(v as unknown)\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '联合含桥类型 {} | null 计一处', file: 'tests/a.test.ts', code: "const x = ('text' as {} | null) as number\nexport { x }\n", counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '括号内联合含桥类型 {} | undefined 计一处', file: 'tests/a.test.ts', code: "const x = ('text' as ({} | undefined)) as number\nexport { x }\n", counts: { 'as never': 0, '两段式断言': 1 } },
    { name: '<never>x 计一处', file: 'tests/a.test.ts', code: 'const x = <never>v\nexport { x }\n', counts: { 'as never': 1, '两段式断言': 0 } },
    { name: '单独 as {} 不计两段式断言', file: 'tests/a.test.ts', code: 'const x = v as {}\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '单独 as object 不计两段式断言', file: 'tests/a.test.ts', code: 'const x = v as object\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '内层 any 不计两段式断言', file: 'tests/a.test.ts', code: 'const x = (v as any) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '非空 TypeLiteral 内层不计两段式断言', file: 'tests/a.test.ts', code: 'const x = (v as { a: string }) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '联合无桥类型 string | null 不计两段式断言', file: 'tests/a.test.ts', code: 'declare const s: string | null\nconst x = (s as string | null) as number\nexport { x }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '正则字面量后同行 as never 计一处', file: 'tests/a.test.ts', code: 'const re = /https?:\\/\\//; const x = v as never\nexport { re, x }\n', counts: { 'as never': 1, '两段式断言': 0 } },
    { name: 'JSX 文本后同行 as never 计一处', file: 'tests/c/a.test.tsx', code: 'const el = <p>http://x</p>; const x = el as never\nexport { el, x }\n', counts: { 'as never': 1, '两段式断言': 0 } },
    { name: '模板插值里的真实 as never 计一处', file: 'tests/a.test.ts', code: 'const s = `${v as never} 中`\nexport { s }\n', counts: { 'as never': 1, '两段式断言': 0 } },
    { name: '模板字符串纯文本 as never 计零', file: 'tests/a.test.ts', code: 'const s = `as never`\nexport { s }\n', counts: { 'as never': 0, '两段式断言': 0 } },
    { name: '注释里的 as never 计零', file: 'tests/a.test.ts', code: 'const q = 4 / 2 // 注释 as never\nexport { q }\n', counts: { 'as never': 0, '两段式断言': 0 } },
  ]
  for (const { name, file, code, counts } of counted) {
    assert.deepEqual(reviewFileText(file, code).counts, counts, name)
  }
})

test('门禁文本检查对真实文件 route-types.ts 的指令判定覆盖嵌套位置', () => {
  const source = readFileSync(join(repositoryRoot, 'yootun', 'packages', 'dsh-workbench-host-kit', 'tests', 'types', 'route-types.ts'), 'utf8')
  // 两处 @ts-expect-error 分别在箭头函数体与对象字面量内（嵌套位置，历史上漏判）。
  const outside = reviewFileText('tests/x.ts', source)
  assert.equal(outside.violations.length, 2)
  assert.ok(outside.violations.every(line => line.includes('@ts-expect-error')))
  // 去掉两处 -- 原因后，按 tests/types/ 判定报「-- 之后必须写明原因」。
  const stripped = source.replace(/^ *\/\/ @ts-expect-error -- .*$/gmu, '  // @ts-expect-error')
  const missingReason = reviewFileText('tests/types/route-types.ts', stripped)
  assert.equal(missingReason.violations.length, 2)
  assert.ok(missingReason.violations.every(line => line.includes('-- 之后必须写明原因')))
  // 原样按 tests/types/ 判定合规（两处指令都在 tests/types/ 内且带原因）。
  const allowed = reviewFileText('tests/types/route-types.ts', source)
  assert.deepEqual(allowed.violations, [])
})
