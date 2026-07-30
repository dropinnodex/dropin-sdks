// Compile-only: proves feed().get() returns a typed Page<Activity<T>> so it can be handed
// to @dropinnodex/react's useFeed initialData verbatim (the SSR hydration flow). Not shipped
// (tsup entry is index.ts only; files:["dist"]).
import type { Activity, Page } from '@dropinnodex/client'
import { DropInServer } from './index.js'

async function _check(s: DropInServer) {
  const page: Page<Activity<{ title: string }>> = await s.feed('user', 'u').get<{ title: string }>()
  const title: string = page.results[0]!.custom.title
  void title
  // default generic stays Record<string, unknown>
  const def = await s.feed('user', 'u').get()
  const c: Record<string, unknown> = def.results[0]!.custom
  void c
}
void _check
