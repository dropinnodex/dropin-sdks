// Compile-only type assertions for the TCustom generic. Checked via `pnpm typecheck`
// (tsc -b) — vitest's --typecheck does not fire for plain .test.tsx files in this repo's
// node/react projects (see Task 1 report). Mirrors packages/client/src/generics.type-check.ts.
import { useFeed, useFeedActions, resolveRefs } from './hooks.js'
import { useInfiniteFeed } from './infinite.js'

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

// refs is a plain inline-literal field on addActivity, on BOTH useFeed's own addActivity
// and useFeedActions' — not a workaround, not a cast. The wire API has always accepted it
// (v1.yaml ActivityInput); this asserts the SDK type does too.
function _typecheckAddActivityRefs() {
  const feed = useFeed('user', 'alice')
  void feed.addActivity({
    verb: 'post', object: 'session:1234', custom: { anything: 1 }, refs: ['session:1234'],
  })

  const actions = useFeedActions('user', 'alice')
  void actions.addActivity({
    verb: 'post', object: 'session:1234', custom: { anything: 1 }, refs: ['session:1234'],
  })
}

// useInfiniteFeed spreads useFeed's return, which is exactly where a generic silently
// widens to Record<string, unknown> — the wrapper must forward TCustom, not swallow it.
function _typecheckUseInfiniteFeed() {
  const feed = useInfiniteFeed<{ title: string }>('user', 'alice')
  const custom: { title: string } = feed.activities[0]!.custom
  // @ts-expect-error - custom is narrowed to {title:string}, not an arbitrary shape
  const bad: { nope: number } = feed.activities[0]!.custom

  void feed.addActivity({ verb: 'post', object: 'w:1', custom: { title: 'x' } })
  // @ts-expect-error - custom must fit TCustom, not arbitrary keys
  void feed.addActivity({ verb: 'post', object: 'w:1', custom: { nope: 1 } })

  void custom
  void bad
}

// The objects sidecar threads TCustom through TWO layers — Record<string, DropInObject<T>>
// — which is exactly the shape that degrades to Record<string, unknown> if any link in the
// chain forgets to forward the parameter. Reading .custom off a map value is the assertion
// that catches it.
function _typecheckUseFeedObjects() {
  const feed = useFeed<{ title: string }>('user', 'alice')
  const custom: { title: string } = feed.objects['session:1']!.custom
  // @ts-expect-error - object custom is narrowed to TCustom, not an arbitrary shape
  const bad: { nope: number } = feed.objects['session:1']!.custom

  // resolveRefs must carry TCustom out of the map, not flatten it.
  const resolved = resolveRefs(feed.activities[0]!, feed.objects)
  const resolvedCustom: { title: string } = resolved[0]!.custom
  // @ts-expect-error - resolveRefs preserves TCustom
  const resolvedBad: { nope: number } = resolved[0]!.custom

  const def = useFeed('user', 'alice')
  const defaultObjectCustom: Record<string, unknown> = def.objects['session:1']!.custom

  void custom
  void bad
  void resolvedCustom
  void resolvedBad
  void defaultObjectCustom
}

// updateActivity resolves to the SERVER's activity, so its custom must stay narrowed —
// a widened return here would push a cast onto every caller reading back edited_at.
async function _typecheckUpdateActivity() {
  const feed = useFeed<{ title: string }>('user', 'alice')
  const updated = await feed.updateActivity('a1', { set: { 'custom.title': 'x' } })
  // Optional because the onError contract resolves undefined after a rollback.
  const title: string | undefined = updated?.custom.title
  const editedAt: string | null | undefined = updated?.edited_at
  const refs: string[] | undefined = updated?.refs

  void title
  void editedAt
  void refs
}

void _typecheckUseFeed
void _typecheckUseFeedActions
void _typecheckUseInfiniteFeed
void _typecheckUseFeedObjects
void _typecheckUpdateActivity
void _typecheckAddActivityRefs
