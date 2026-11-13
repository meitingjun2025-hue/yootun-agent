/**
 * 从品牌源素材派生 Electron 壳所需的三件图标产物（提交到 assets/，CI 零生成成本）：
 * `icon-windows.png`（1024 满幅）、`icon-macos.png`（1024 画布 824 artwork 居中）、
 * `tray-windows.ico`（7 帧全 PNG 编码，帧清单对齐官方 tray-windows.ico）。
 *
 * 派生算法精简自旧桌面 dsh-plugin-desktop/scripts/generate-brand-assets.mjs 与
 * generate-windows-app-icon.mjs：任意尺寸 JPEG 源 → contain 缩放至透明正方形画布 →
 * 边缘连通近白像素 flood-fill 去除（保留图形内部白色细节）→ 内容包围盒居中 → 各产物。
 * 运行：`node yootun/brand/scripts/generate-brand-icons.mjs`；sharp 复用 apps/desktop
 * 的 devDependency（分区不入 workspace），产物入库后打包链直接读文件。
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsRoot = dirname(fileURLToPath(import.meta.url))
const brandRoot = resolve(scriptsRoot, '..')
const brandConfig = JSON.parse(readFileSync(join(brandRoot, 'brand.json'), 'utf8'))

// sharp 声明在 apps/desktop（workspace 成员）的 devDependencies；本脚本仅本地再生成时运行。
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))
const sharp = require('sharp')

const artwork = brandConfig.artwork
const size = artwork.iconSize
const threshold = artwork.whiteThreshold

/** 读取源图并缩放至透明正方形画布，返回原始 RGBA 像素。 */
async function loadSquareCanvas() {
  const sourcePath = join(brandRoot, artwork.appIconSource)
  const { data, info } = await sharp(sourcePath, { failOn: 'warning' })
    .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, info }
}

/** 从画布边缘 flood-fill，把连通的近白外延像素置为全透明；图形内部的白色细节不受影响。 */
function removeExteriorWhite({ data, info }) {
  const nearWhite = offset => data[offset] >= threshold && data[offset + 1] >= threshold && data[offset + 2] >= threshold
  const visited = new Uint8Array(info.width * info.height)
  const queue = new Uint32Array(info.width * info.height)
  let head = 0
  let tail = 0
  const enqueue = pixel => {
    if (visited[pixel] === 1) return
    const offset = pixel * info.channels
    if (data[offset + 3] === 0 || nearWhite(offset)) {
      visited[pixel] = 1
      queue[tail++] = pixel
    }
  }
  for (let x = 0; x < info.width; x += 1) {
    enqueue(x)
    enqueue((info.height - 1) * info.width + x)
  }
  for (let y = 0; y < info.height; y += 1) {
    enqueue(y * info.width)
    enqueue(y * info.width + info.width - 1)
  }
  while (head < tail) {
    const pixel = queue[head++]
    const x = pixel % info.width
    const y = Math.floor(pixel / info.width)
    if (x > 0) enqueue(pixel - 1)
    if (x + 1 < info.width) enqueue(pixel + 1)
    if (y > 0) enqueue(pixel - info.width)
    if (y + 1 < info.height) enqueue(pixel + info.width)
  }
  for (let pixel = 0; pixel < visited.length; pixel += 1) {
    if (visited[pixel] !== 1) continue
    const offset = pixel * info.channels
    data[offset] = 0
    data[offset + 1] = 0
    data[offset + 2] = 0
    data[offset + 3] = 0
  }
  return { data, info }
}

/** 按存活像素的包围盒把内容平移到画布正中，保证对称视觉边距；取整保持产物确定性。 */
function centerContent({ data, info }) {
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels
      if (data[offset + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('generate-brand-icons: 白边去除后没有可见图形，请检查源素材')
  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  const shiftX = Math.floor((info.width - contentWidth) / 2) - minX
  const shiftY = Math.floor((info.height - contentHeight) / 2) - minY
  if (shiftX === 0 && shiftY === 0) return { data, info }
  const centered = Buffer.alloc(data.length)
  for (let y = minY; y <= maxY; y += 1) {
    const sourceStart = (y * info.width + minX) * info.channels
    const targetStart = ((y + shiftY) * info.width + (minX + shiftX)) * info.channels
    data.copy(centered, targetStart, sourceStart, sourceStart + contentWidth * info.channels)
  }
  return { data: centered, info }
}

/** 把 raw RGBA 主图编码为 8-bit PNG（官方桌面图标的入库规格）。 */
function encodePng(master) {
  return sharp(master.data, { raw: { width: master.info.width, height: master.info.height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer()
}

/**
 * 生成 Windows 托盘 ICO：每帧为主图 Lanczos 缩放后的 PNG 编码（官方 tray-windows.ico
 * 即全 PNG 帧），小帧做轻锐化补偿高频细节损失。
 * @param {Buffer} masterPng - 1024 主图 PNG。
 * @returns {Promise<Buffer>} 完整 ICO 文件。
 */
async function encodeTrayIco(masterPng) {
  const frames = await Promise.all(artwork.trayFrames.map(async frameSize => {
    let pipeline = sharp(masterPng).resize({ width: frameSize, height: frameSize, fit: 'fill', kernel: sharp.kernel.lanczos3 }).ensureAlpha()
    if (frameSize <= 32) pipeline = pipeline.sharpen({ sigma: 0.5 })
    const data = await pipeline.png({ compressionLevel: 9 }).toBuffer()
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

const canvas = centerContent(removeExteriorWhite(await loadSquareCanvas()))
const masterPng = await encodePng(canvas)
const masterSquare = sharp(masterPng)

const macCanvas = artwork.macIcon.canvas
const macArtwork = artwork.macIcon.artwork
const iconMacos = await sharp({
  create: { width: macCanvas, height: macCanvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: await masterSquare.resize({ width: macArtwork, height: macArtwork, fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer(), left: (macCanvas - macArtwork) / 2, top: (macCanvas - macArtwork) / 2 }])
  .png({ compressionLevel: 9 })
  .toBuffer()

writeFileSync(join(brandRoot, 'assets', 'icon-windows.png'), masterPng)
writeFileSync(join(brandRoot, 'assets', 'icon-macos.png'), iconMacos)
writeFileSync(join(brandRoot, 'assets', 'tray-windows.ico'), await encodeTrayIco(masterPng))
console.log(`generate-brand-icons: 已写出 icon-windows.png / icon-macos.png / tray-windows.ico（主图 ${canvas.info.width}x${canvas.info.height}）`)
