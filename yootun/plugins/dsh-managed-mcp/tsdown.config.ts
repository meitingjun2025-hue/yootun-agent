import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    alwaysBundle: [/^@yootun\/dsh-client-ui-access(?:\/.*)?$/u],
  },
  clean: false,
  fixedExtension: false,
  dts: true,
} satisfies UserConfig
