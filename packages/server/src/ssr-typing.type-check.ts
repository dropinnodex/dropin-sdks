// Compile-only: proves feed().get() returns a typed Page<Activity<T>> so it can be handed
// to @dropinnodex/react's useFeed initialData verbatim (the SSR hydration flow). Not shipped
// (tsup entry is index.ts only; files:["dist"]).
import type { Activity, Page } from '@dropinnodex/client'
import { DropInServer } from './index.js'
// Every type this package HANDS BACK must be nameable from this package alone. Imported
// from './index.js', not from @dropinnodex/client: that is the whole point — a backend
// that only installed @dropinnodex/server must not need a second, undeclared dependency
// to annotate a variable. Deleting a name from the re-export list breaks this file.
import type {
  Activity as ServerActivity, ErrorCode, FeedPage, FollowStats, Page as ServerPage,
} from './index.js'

async function _reexports(s: DropInServer) {
  const a: ServerActivity = await s.feed('user', 'u').addActivity({ verb: 'post', object: 'w:1' })
  const page: ServerPage<ServerActivity> = await s.feed('user', 'u').get()
  const stats: FollowStats = await s.feed('user', 'u').followStats()
  const feedPage: FeedPage = page as FeedPage
  const code: ErrorCode = 'RATE_LIMITED'
  void a; void stats; void feedPage; void code
}
void _reexports

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
