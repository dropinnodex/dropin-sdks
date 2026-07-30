import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

describe('dependency direction is the security boundary', () => {
  it('@dropinnodex/client never imports @dropinnodex/server', () => {
    for (const file of walk('packages/client/src')) {
      const src = readFileSync(file, 'utf8')
      expect(src, `${file} imports @dropinnodex/server`).not.toMatch(/@dropin\/server/)
    }
  })

  it('@dropinnodex/client declares no dependencies at all', () => {
    const pkg = JSON.parse(readFileSync('packages/client/package.json', 'utf8')) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('@dropinnodex/client imports no node: builtins — it must run in a browser', () => {
    for (const file of walk('packages/client/src')) {
      if (file.endsWith('.test.ts')) continue
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]node:/)
    }
  })

  it('@dropinnodex/react never imports @dropinnodex/server', () => {
    for (const file of walk('packages/react/src')) {
      expect(readFileSync(file, 'utf8'), `${file} imports @dropinnodex/server`).not.toMatch(/@dropin\/server/)
    }
  })

  it('@dropinnodex/server declares NO browser field — a browser bundler must fail loudly', () => {
    const pkg = JSON.parse(readFileSync('packages/server/package.json', 'utf8')) as { browser?: unknown }
    expect(pkg.browser).toBeUndefined()
  })

  it('@dropinnodex/server imports node:crypto so a browser bundle cannot resolve it', () => {
    expect(readFileSync('packages/server/src/index.ts', 'utf8')).toMatch(/from ['"]node:crypto['"]/)
  })
})
