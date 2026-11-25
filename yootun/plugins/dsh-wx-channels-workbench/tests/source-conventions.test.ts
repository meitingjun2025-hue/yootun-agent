/**
 * 包级源码约定测试（node --test）：分区不持有 Workbench 工具清单与计数——
 * src/ 不出现 Workbench 工具数量字面量，域门 whitelist.ts（dsh-workbench-mcp）
 * 不含具体工具名字面量。工具清单唯一来源是 tools 仓 docs/1116/yootun-mcp.md。
 * 运行：`node --test tests/source-conventions.test.ts`。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname

/** 递归收集 .ts/.tsx 源文件。 */
function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
      continue
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(path)
  }
  return files
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')
}

test('src/ 无 Workbench 工具数量字面量（工具清单唯一来源在 tools 仓）', () => {
  // Workbench 面规模（当前 95）与全业务面规模（当前 134）不进入插件代码。
  const banned = new RegExp(String.raw`\b(?:9[0-9]|1[0-3][0-9])\s*个\s*(?:Workbench|workbench|工具)|workbench\s*工具\s*(?:总数|数量)`, 'u')
  const offenders: string[] = []
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const text = stripComments(readFileSync(path, 'utf8'))
    if (text.match(banned) !== null) offenders.push(path)
  }
  assert.deepEqual(offenders, [], '插件不得持有 Workbench 工具数量（docs/1116/yootun-mcp.md 是唯一来源）')
})

test('域门 whitelist.ts 不出现 Workbench 工具名字面量（只持 caller → 域名映射）', () => {
  // whitelist.ts（plugins/dsh-workbench-mcp）的 CALLER_DOMAINS 只持有 caller
  // → 域名映射；具体工具名由 tools 仓广播（未广播 → workbench_tool_unavailable）。
  const whitelistPath = join(ROOT, '..', 'dsh-workbench-mcp', 'src', 'whitelist.ts')
  const whitelist = stripComments(readFileSync(whitelistPath, 'utf8'))
  assert.match(whitelist, /CALLER_DOMAINS/u)
  assert.doesNotMatch(whitelist, /workbench_wx_accounts_overview/u)
})
