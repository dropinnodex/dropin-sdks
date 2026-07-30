import { defineConfig } from 'vitest/config'

// Two projects, mirroring the monorepo's split: react needs jsdom, client and server need
// node. The monorepo additionally disables Oxc and installs the swc plugin so NestJS
// decorator metadata survives — none of that applies here. The SDKs have no decorators.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/index.ts'],
    },
    projects: [
      {
        test: {
          name: 'react',
          include: ['packages/react/**/*.test.tsx'],
          environment: 'jsdom',
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'node',
          include: ['packages/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', 'packages/react/**'],
          environment: 'node',
          passWithNoTests: true,
        },
      },
    ],
  },
})
