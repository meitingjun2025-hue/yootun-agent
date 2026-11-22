/**
 * 抖音工作台 client 测试（jsdom，独立于官方 vitest scope）。
 * 完整 test 脚本（package.json）：10 个 host `node --test` 文件（host/state/
 * route/dispose/d2/d3/d4d5/parse/recovery/abort）之后接 `vitest run`（本配置，
 * tests/client/**）。单条 package test 合计 183 项（host 112 + vitest 71）。
 * 单独运行：`npx vitest run`。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const primitivesSrc = join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages/client/ui-primitives/src')

export default defineConfig({
  resolve: {
    alias: [
      {
        // 测试把官方 primitives 桶指到受控桶文件，避免拖入 shiki/katex 全图。
        find: /^@deepseek-ai\/dsh-client-ui-primitives$/u,
        replacement: fileURLToPath(new URL('./tests/primitives-shim.ts', import.meta.url)),
      },
      { find: '@deepseek-ai/dsh-client-ui-primitives/src', replacement: primitivesSrc },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/client/**/*.test.{ts,tsx}'],
  },
})
