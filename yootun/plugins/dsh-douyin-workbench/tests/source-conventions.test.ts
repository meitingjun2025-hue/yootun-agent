/**
 * 包级源码约定测试（node --test）：本包 src/ 与 tests/ 剔除注释后禁止
 * `as unknown[]` / `as unknown` / `<unknown>` / `as never` 断言（no-new-
 * unknown-assertions 规则的包级锁；守卫式投影替代，见 parse.ts
 * recordRowsLike 与 schema.ts recordOf）。
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

test('本包 src/ 与 tests/ 无 unknown/never 类型断言（守卫式投影替代）', () => {
  // `\bas unknown` 只匹配断言形态（"has unknown" 等普通文本不命中）；
  // `<unknown>` 排除泛型位置（Promise<unknown>/Set<...> 的 < 前是单词字符）。
  const banned = new RegExp(String.raw`\bas\s+unknown\b|(?<![\w$>])<unknown>|\bas\s+never\b`, 'u')
  const offenders: string[] = []
  const files = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'tests'))]
    // 本测试自身的规则文本含匹配字面量，自排除。
    .filter(path => !path.endsWith('tests/source-conventions.test.ts'))
  for (const path of files) {
    if (stripComments(readFileSync(path, 'utf8')).match(banned) !== null) offenders.push(path)
  }
  assert.deepEqual(offenders, [], '发现禁用断言，改为类型守卫或 schema 投影（recordOf 同款）')
})
