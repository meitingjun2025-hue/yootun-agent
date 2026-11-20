/**
 * Runtime-bundle closure verifier for yootun Host plugins. It runs from a
 * package directory after tsdown and rejects two installer-only failures:
 * TypeScript sources retained under node_modules (Node refuses type stripping
 * there) and dynamic chunks omitted by the package manifest.
 * @module
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

const packageDir = process.cwd()
const libDir = join(packageDir, 'lib')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const failures = []

if (!existsSync(libDir) || !statSync(libDir).isDirectory()) {
  failures.push('lib/ build output is missing')
} else {
  const files = readdirSync(libDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => join(libDir, entry.name))
  if (files.length === 0) failures.push('lib/ contains no JavaScript build output')
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (/(?:from|import)\s+["'][^"']*\/src\/[^"']+\.ts["']/u.test(source)) {
      failures.push(`${file} retains a runtime TypeScript import under node_modules`)
    }
    for (const match of source.matchAll(/(?:from|import\()\s*["'](\.\/[^"']+\.js)["']/gu)) {
      if (!existsSync(join(dirname(file), match[1]))) {
        failures.push(`${file} imports missing chunk ${match[1]}`)
      }
    }
  }
}

if ([
  '@yootun/dsh-managed-mcp',
  '@yootun/dsh-workbench-mcp',
  '@yootun/dsh-wx-channels-workbench',
  '@yootun/dsh-xhs-workbench',
].includes(manifest.name) && !manifest.files?.includes('lib/*.js')) {
  failures.push('package files must publish every generated lib/*.js Host chunk')
}

// 声明的 types 入口必须真实存在：exports 的 types 路径缺失会让 tarball 消费方
// 类型断裂（publint 报错形态）。glob 形路径（lib/types/**/*.d.ts）不逐文件校验，
// 只校验精确文件路径；同一路径去重避免重复报错。
const missingTypesPaths = [...new Set(declaredTypesPaths(manifest))]
  .filter(typesPath => !existsSync(join(packageDir, typesPath)))
for (const typesPath of missingTypesPaths) {
  failures.push(`declared types entry is missing from the build output: ${typesPath}`)
}

function declaredTypesPaths(manifest) {
  const paths = []
  if (typeof manifest.types === 'string') paths.push(manifest.types.replace(/^\.\//u, ''))
  const exports = manifest.exports
  if (typeof exports === 'string') return paths
  if (exports && typeof exports === 'object') {
    for (const entry of Object.values(exports)) {
      if (typeof entry === 'string') continue
      if (entry && typeof entry === 'object' && typeof entry.types === 'string') {
        paths.push(entry.types.replace(/^\.\//u, ''))
      }
    }
  }
  return paths
}

if (failures.length > 0) {
  console.error(`verify-plugin-runtime-bundle: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('verify-plugin-runtime-bundle: runtime imports and chunks complete')
