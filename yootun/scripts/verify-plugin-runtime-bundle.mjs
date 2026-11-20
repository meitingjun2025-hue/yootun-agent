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
].includes(manifest.name) && !manifest.files?.includes('lib/*.js')) {
  failures.push('package files must publish every generated lib/*.js Host chunk')
}

if (failures.length > 0) {
  console.error(`verify-plugin-runtime-bundle: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('verify-plugin-runtime-bundle: runtime imports and chunks complete')
