import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    alwaysBundle: [/^@yootun\/dsh-client-ui-access(?:\/.*)?$/u, /^@yootun\/dsh-workbench-host-kit$/u],
  },
  clean: false,
  fixedExtension: false,
  dts: true,
} satisfies UserConfig
