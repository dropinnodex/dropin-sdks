import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // composite:false only for tsup's isolated DTS rollup — a multi-file entry
  // (index → store) hits TS6307 under the shared composite:true base, exactly as
  // @dropinnodex/react does. Does not affect tsc -b.
  dts: { compilerOptions: { composite: false } },
  clean: true,
  outDir: 'dist',
  target: 'es2020',
  sourcemap: true,
})
