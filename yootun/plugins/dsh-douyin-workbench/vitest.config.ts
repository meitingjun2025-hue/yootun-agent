/**
 * 抖音工作台 client 测试（jsdom，独立于官方 vitest scope）：
 * `pnpm --filter @yootun/dsh-douyin-workbench test`（vitest 段）。
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
