import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node20',
  sourcemap: true,
  // jose@6 is ESM-only. Bundle it in so the CJS build doesn't emit a runtime
  // `require("jose")`, which throws ERR_REQUIRE_ESM on Node 20.0–20.18 (require(esm)
  // was only backported in 20.19). Keeps `require('@dropinnodex/server')` working across the
  // whole declared `engines: >=20` range — the point of shipping CJS at all.
  noExternal: ['jose'],
})
