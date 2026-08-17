import { defineConfig } from 'tsdown'

/**
 * The desktop shell's only build artifact is the preload bundle: the
 * Electron main process runs from source through tsx (`pnpm run start`), but
 * a sandboxed preload cannot ride the tsx hook — Electron loads it directly,
 * so it must be a plain CommonJS file. `format: ['cjs']` under
 * `"type": "module"` emits `lib/preload.cjs`, which `src/main.ts` references.
 */
export default defineConfig({
  entry: ['src/preload.ts'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  deps: {
    neverBundle: ['electron'],
  },
})
