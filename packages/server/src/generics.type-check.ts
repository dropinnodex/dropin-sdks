// Compile-only type assertions for the server feed() TCustom generics — parity with
// packages/client/src/generics.type-check.ts. No runtime behavior; checked via
// `pnpm typecheck` (tsc -b picks up src/**/* non-test files), same mechanism as
// ssr-typing.type-check.ts. Not shipped (tsup entry is index.ts only; files:["dist"]).
import type { Activity, Page } from '@dropinnodex/client'
import { DropInServer } from './index.js'

async function _check(s: DropInServer) {
  const f = s.feed('user', 'alice')

  // Typed custom flows IN (input `custom` is TCustom) and OUT (returned activity.custom).
  const created: Activity<{ title: string }> = await f.addActivity<{ title: string }>({
    verb: 'post',
    object: 'workout:1',
    custom: { title: 'hello' },
  })
  const title: string = created.custom.title
  void title

  // Mismatched custom shape must not compile.
  await f.addActivity<{ title: string }>({
    verb: 'post',
    object: 'workout:1',
    // @ts-expect-error - narrowed custom must not accept arbitrary keys
    custom: { nope: 1 },
  })

  // Default generic stays Record<string, unknown> — existing callers compile unchanged.
  const def = await f.addActivity({ verb: 'post', object: 'workout:1', custom: { anything: 1 } })
  const defCustom: Record<string, unknown> = def.custom
  void defCustom

  // get<TCustom> returns Page<Activity<TCustom>> (composes the same way as the client).
  const page: Page<Activity<{ title: string }>> = await f.get<{ title: string }>()
  const pageTitle: string = page.results[0]!.custom.title
  void pageTitle

  // batch.activities stays untyped (spec §4) — activity is a plain record.
  await s.batch.activities([
    { feed: 'user:alice', activity: { verb: 'post', object: 'workout:1', custom: { anything: 1 } } },
  ])
}
void _check
