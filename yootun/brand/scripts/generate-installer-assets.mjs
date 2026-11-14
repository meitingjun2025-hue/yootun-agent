/**
 * 从品牌素材派生安装器与欢迎窗的打包 UI 素材（提交到 assets/，CI 零生成成本）：
 * 安装器五张位图（brand/brand-2x/brand-dark/brand-dark-2x 同构白圆徽章横幅、
 * uninstaller-sidebar 圆角卡竖图，尺寸逐项对齐官方 `apps/desktop/installer/assets/`）、
 * `installer-windows.ico`（16–256 七帧）与欢迎窗展示图 `welcome/welcome-brand.svg`
 * （472x40 viewBox 内嵌位图 mark，沿用官方文件名以命中 WelcomePage 的既有引用）。
 *
 * 布局为官方同构的纯图形形态（无文字，规避生成端字体依赖）：亮/暗横幅同图——
 * 官方脚本转 BMP 时按文件名铺白底或深底，白圆徽章在两种底色上均成立。
 * 运行：`node yootun/brand/scripts/generate-installer-assets.mjs`；sharp 复用
 * apps/desktop 的 devDependency（分区不入 workspace）。
 */

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const brandRoot = resolve(scriptsRoot, '..')
const brandConfig = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'))

// sharp 声明在 apps/desktop（workspace 成员）的 devDependencies；本脚本仅本地再生成时运行。
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
const sharp = require('sharp')

const artwork = brandConfig.artwork
const assetsRoot = join(brandRoot, 'assets')
const installerRoot = join(assetsRoot, 'installer')

/** 读取彩色吉祥物源图（透明底 RGBA）。 */
async function loadMark() {
  return readFileSync(join(brandRoot, artwork.heroMark))
}

/** 圆角矩形图形的 SVG buffer（生成端只渲染图形，无文字）。 */
function roundedRectSvg(width, height, radius, fill, stroke) {
  const strokeAttributes = stroke === undefined ? '' : ` stroke="${stroke.color}" stroke-width="${stroke.width}"`
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${stroke === undefined ? 0 : stroke.width / 2}" y="${stroke === undefined ? 0 : stroke.width / 2}"` +
    ` width="${width - (stroke === undefined ? 0 : stroke.width)}" height="${height - (stroke === undefined ? 0 : stroke.width)}"` +
    ` rx="${radius}" fill="${fill}"${strokeAttributes}/></svg>`)
}

/**
 * 安装器横幅：透明画布中央白圆徽章，徽章内居中彩色吉祥物。
 * @param {number} width - Canvas width (600 at 1x, 1200 at 2x).
 * @param {number} height - Canvas height (196 at 1x, 392 at 2x).
 * @param {Buffer} mark - The colored mascot source PNG.
 * @returns {Promise<Buffer>} Banner PNG.
 */
async function brandBanner(width, height, mark) {
  const badge = Math.round(height * (176 / 196))
  const markSize = Math.round(badge * (120 / 176))
  const scaledMark = await sharp(mark).resize({ width: markSize, height: markSize, fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer()
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: roundedRectSvg(badge, badge, badge / 2, '#FFFFFF', { color: 'rgba(15, 23, 42, 0.06)', width: 2 }), left: Math.round((width - badge) / 2), top: Math.round((height - badge) / 2) },
      { input: scaledMark, left: Math.round((width - markSize) / 2), top: Math.round((height - markSize) / 2) },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * 卸载器侧边竖图：浅灰圆角卡居中，卡上居中彩色吉祥物。
 * @param {Buffer} mark - The colored mascot source PNG.
 * @returns {Promise<Buffer>} Sidebar PNG.
 */
async function uninstallerSidebar(mark) {
  const { width, height } = artwork.installer.uninstallerSidebar
  const card = artwork.installer.uninstallerSidebar.card
  const markSize = Math.round(card.width * 0.8)
  const scaledMark = await sharp(mark).resize({ width: markSize, height: markSize, fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer()
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: roundedRectSvg(card.width, card.height, card.radius, '#F4F4F5'), left: Math.round((width - card.width) / 2), top: Math.round((height - card.height) / 2) },
      { input: scaledMark, left: Math.round((width - markSize) / 2), top: Math.round((height - markSize) / 2) },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * 安装器图标 ICO：与 tray ICO 同一 PNG 帧编码（帧清单扩展到 256 供资源管理器大图标）。
 * @param {Buffer} masterPng - 1024 主图 PNG（icon-windows.png）。
 * @returns {Promise<Buffer>} 完整 ICO 文件。
 */
async function encodeInstallerIco(masterPng) {
  const frames = await Promise.all(artwork.installer.iconFrames.map(async frameSize => {
    const data = await sharp(masterPng).resize({ width: frameSize, height: frameSize, fit: 'fill', kernel: sharp.kernel.lanczos3 }).png({ compressionLevel: 9 }).toBuffer()
    return { size: frameSize, data }
  }))
  const headerSize = 6 + frames.length * 16
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let dataOffset = headerSize
  for (const [index, frame] of frames.entries()) {
    const entry = 6 + index * 16
    header[entry] = frame.size & 0xff
    header[entry + 1] = frame.size & 0xff
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frame.data.length, entry + 8)
    header.writeUInt32LE(dataOffset, entry + 12)
    dataOffset += frame.data.length
  }
  return Buffer.concat([header, ...frames.map(frame => frame.data)])
}

/**
 * 欢迎窗展示图 SVG：472x40 viewBox 中央内嵌位图 mark（沿用官方文件名与画框，
 * WelcomePage 的既有引用与 472x40 展示尺寸不变）。
 * @param {Buffer} mark - The colored mascot source PNG.
 * @returns {string} SVG document text.
 */
function welcomeBrandSvg(mark) {
  const [viewWidth, viewHeight] = artwork.welcomeBrand.viewBox
  const markSize = artwork.welcomeBrand.mark
  const encoded = mark.toString('base64')
  return `<svg width="${viewWidth}" height="${viewHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}" fill="none" xmlns="http://www.w3.org/2000/svg">\n` +
    `<image x="${(viewWidth - markSize) / 2}" y="${(viewHeight - markSize) / 2}" width="${markSize}" height="${markSize}" href="data:image/png;base64,${encoded}"/>\n` +
    `</svg>\n`
}

const mark = await loadMark()
mkdirSync(installerRoot, { recursive: true })
mkdirSync(join(assetsRoot, 'welcome'), { recursive: true })
const banner = await brandBanner(artwork.installer.banner.width, artwork.installer.banner.height, mark)
const banner2x = await brandBanner(artwork.installer.banner.width * 2, artwork.installer.banner.height * 2, mark)
const sidebar = await uninstallerSidebar(mark)
const masterPng = readFileSync(join(assetsRoot, 'icon-windows.png'))

writeFileSync(join(installerRoot, 'brand.png'), banner)
writeFileSync(join(installerRoot, 'brand-2x.png'), banner2x)
// 亮/暗横幅同图：转 BMP 时的铺底由官方脚本按文件名决定，白圆徽章两种底色均成立。
writeFileSync(join(installerRoot, 'brand-dark.png'), banner)
writeFileSync(join(installerRoot, 'brand-dark-2x.png'), banner2x)
writeFileSync(join(installerRoot, 'uninstaller-sidebar.png'), sidebar)
writeFileSync(join(assetsRoot, 'installer-windows.ico'), await encodeInstallerIco(masterPng))
writeFileSync(join(assetsRoot, 'welcome', 'welcome-brand.svg'), welcomeBrandSvg(mark))
console.log('generate-installer-assets: 已写出安装器五张位图、installer-windows.ico 与 welcome/welcome-brand.svg')
