/**
 * yootun UI kit 组件测试（jsdom，独立于官方 vitest scope）：
 * `pnpm --filter @yootun/dsh-client-ui-kit test`。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const primitivesSrc = join(fileURLToPath(new URL('../../..', import.meta.url)), 'packages/client/ui-primitives/src')

export default defineConfig({
  resolve: {
    alias: [
      {
        // 测试把官方 primitives 桶指到受控桶文件，避免拖入 shiki/katex 全图；
        // 桶内子路径 import 直连官方 src。
        find: /^@deepseek-ai\/dsh-client-ui-primitives$/u,
        replacement: fileURLToPath(new URL('./tests/primitives-shim.ts', import.meta.url)),
      },
      { find: '@deepseek-ai/dsh-client-ui-primitives/src', replacement: primitivesSrc },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
