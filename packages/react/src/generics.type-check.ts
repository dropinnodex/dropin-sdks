// Compile-only type assertions for the TCustom generic. Checked via `pnpm typecheck`
// (tsc -b) — vitest's --typecheck does not fire for plain .test.tsx files in this repo's
// node/react projects (see Task 1 report). Mirrors packages/client/src/generics.type-check.ts.
import { useFeed, useFeedActions } from './hooks.js'

function _typecheckUseFeed() {
  const feed = useFeed<{ title: string }>('user', 'alice')
  const custom: { title: string } = feed.activities[0]!.custom
  // @ts-expect-error - custom is narrowed to {title:string}, not an arbitrary shape —
  // this reads THROUGH useFeed, so it fails if .custom silently degrades to Record/any
  const bad: { nope: number } = feed.activities[0]!.custom

  const def = useFeed('user', 'alice')
  const defaultCustom: Record<string, unknown> = def.activities[0]!.custom

  void feed.addActivity({ verb: 'post', object: 'w:1', custom: { title: 'x' } })
  // @ts-expect-error - custom must fit TCustom, not arbitrary keys
  void feed.addActivity({ verb: 'post', object: 'w:1', custom: { nope: 1 } })

  void custom
  void bad
  void defaultCustom
}

function _typecheckUseFeedActions() {
  const actions = useFeedActions<{ title: string }>('user', 'alice')
  void actions.addActivity({ verb: 'post', object: 'w:1', custom: { title: 'x' } })
  // @ts-expect-error - custom must fit TCustom, not arbitrary keys
  void actions.addActivity({ verb: 'post', object: 'w:1', custom: { nope: 1 } })
}

void _typecheckUseFeed
void _typecheckUseFeedActions
