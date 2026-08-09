// Compile-only type assertions for the server feed() TCustom generics — parity with
// packages/client/src/generics.type-check.ts. No runtime behavior; checked via
// `pnpm typecheck` (tsc -b picks up src/**/* non-test files), same mechanism as
// ssr-typing.type-check.ts. Not shipped (tsup entry is index.ts only; files:["dist"]).
import type { Activity, Page } from '@dropinnodex/client'
import { DropInServer, type DropInObject } from './index.js'

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

  // refs is a plain inline-literal field on addActivity — not a workaround, not a cast.
  // The wire API has always accepted it (v1.yaml ActivityInput); this asserts the SDK
  // type does too.
  await f.addActivity({
    verb: 'post',
    object: 'session:1234',
    custom: { anything: 1 },
    refs: ['session:1234'],
  })

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

  // objects: typed custom flows IN (upsert/patch input) and OUT (get/upsert/patch return).
  const obj: DropInObject<{ spots_left: number }> = await s.objects.upsert<{ spots_left: number }>(
    'session', '1234', { spots_left: 2 },
  )
  const spotsLeft: number = obj.custom.spots_left
  void spotsLeft

  const patchedObj: DropInObject<{ spots_left: number }> = await s.objects.patch<{ spots_left: number }>(
    'session', '1234', { set: { 'custom.spots_left': 1 } },
  )
  void patchedObj.custom.spots_left

  const gotObj: DropInObject<{ spots_left: number }> = await s.objects.get<{ spots_left: number }>('session', '1234')
  void gotObj.custom.spots_left

  // getMany carries the same custom generic through, keyed by ref. Indexing yields
  // `| undefined` — a ref with no stored object is absent from the map, never a hole.
  const manyObjs = await s.objects.getMany<{ spots_left: number }>(['session:1234'])
  void manyObjs['session:1234']?.custom.spots_left

  // Mismatched custom shape must not compile.
  await s.objects.upsert<{ spots_left: number }>(
    'session', '1234',
    // @ts-expect-error - narrowed custom must not accept arbitrary keys
    { nope: 1 },
  )

  // Default generic stays Record<string, unknown> — existing callers compile unchanged.
  const defObj = await s.objects.upsert('session', '1234', { anything: 1 })
  const defObjCustom: Record<string, unknown> = defObj.custom
  void defObjCustom

  // activities.patch returns a typed Activity<TCustom>, same composition as addActivity.
  const patchedActivity: Activity<{ title: string }> = await s.activities.patch<{ title: string }>(
    'a1', { set: { 'custom.title': 'fixed' } },
  )
  void patchedActivity.custom.title

  // batch.objects stays untyped (spec §4, parity with batch.activities) — custom is a
  // plain record, and it is REQUIRED (object writes are replace-semantics).
  await s.batch.objects([{ type: 'session', id: '1234', custom: { anything: 1 } }])
}
void _check
