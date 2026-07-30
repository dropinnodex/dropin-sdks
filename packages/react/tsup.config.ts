import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // composite:false only for tsup's isolated DTS rollup — its multi-file entry (index → hooks/provider)
  // hits TS6307 under the shared composite:true base. Does not affect tsc -b.
  dts: { compilerOptions: { composite: false } },
  clean: true,
  outDir: 'dist',
  target: 'es2020',
  sourcemap: true,
  external: ['react', 'react-dom', 'react/jsx-runtime', '@dropinnodex/client'],
})
