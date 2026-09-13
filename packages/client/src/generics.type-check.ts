// Compile-only type assertions for the TCustom generic. No runtime behavior; excluded
// from coverage/build output semantics by being pure types. Checked via `pnpm typecheck`
// (tsc -b) since vitest's --typecheck does not fire for plain .test.ts files in this repo's
// swc-transformed node project (see index.test.ts history / Task 1 report).
import type { Activity, DropInClient, Page, RemovedActivities } from './index.js'

// Activity<TCustom> narrows `custom`; the default keeps existing callers compiling.
type CustomFit = Activity<{ title: string }>
const custom: CustomFit['custom'] = { title: 'hello' }
// @ts-expect-error - narrowed custom must not accept arbitrary keys
const badCustom: CustomFit['custom'] = { nope: 1 }

type DefaultFit = Activity['custom']
const defaultCustom: DefaultFit = { anything: 1 }

// Page<Activity<T>> composes correctly (the shape `feed().get<T>()` returns).
type CustomPage = Page<Activity<{ title: string }>>
const page: CustomPage = { results: [{ ...({} as Activity<{ title: string }>) }], next: null }

// actor_user.custom stays the untyped Record — must NOT be narrowed by TCustom.
type ActorUserCustom = NonNullable<Activity<{ title: string }>['actor_user']>['custom']
const actorUserCustom: ActorUserCustom = { anything: 'goes' }

void custom
void badCustom
void defaultCustom
void page
void actorUserCustom

// refs is a plain inline-literal field on feed().addActivity — not a workaround, not a
// cast. The wire API has always accepted it (v1.yaml ActivityInput); this asserts the
// SDK type does too. Never invoked — see the file header.
async function _checkAddActivityRefs(c: DropInClient) {
  await c.feed('user', 'alice').addActivity({
    verb: 'post',
    object: 'session:1234',
    custom: { anything: 1 },
    refs: ['session:1234'],
  })
}
void _checkAddActivityRefs

// removeActivity overloads: the id form resolves nothing; the foreign_id form reports what it removed.
declare const removeClient: DropInClient
async function _removeActivityForms() {
  const feed = removeClient.feed('user', 'alice')
  const byId: void = await feed.removeActivity('a-1')
  const byRef: RemovedActivities = await feed.removeActivity({ foreign_id: 'fid', time: '2026-09-13T10:00:00.000Z' })
  const ids: string[] = byRef.removed
  // @ts-expect-error - the id form has no `removed` to read
  void (await feed.removeActivity('a-1')).removed
  // @ts-expect-error - a ref needs foreign_id
  await feed.removeActivity({ time: '2026-09-13T10:00:00.000Z' })
  void byId
  void ids
}
void _removeActivityForms
