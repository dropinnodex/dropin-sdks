# @dropinnodex/client

Isomorphic, **zero-dependency** client SDK for [dropin-activity](https://github.com/) — a
GetStream-shaped activity feed as a service. Runs in the browser or Node, over `fetch`.

```bash
npm i @dropinnodex/client
```

## Usage

```ts
import { DropInClient } from '@dropinnodex/client'

const client = new DropInClient({
  apiKey: 'acme-public-key',
  // Called on init and again on a 401 — fetch a token from YOUR backend (@dropinnodex/server).
  tokenProvider: () => fetchTokenFromYourBackend(),
})

const feed = client.feed('user', 'user-123')
await feed.addActivity({ verb: 'post', object: 'hello world' })

const page = await feed.get({ limit: 20 })          // keyset pagination
const more = await feed.get({ next: page.next ?? undefined })

await feed.follow('user', 'user-456')
const reaction = await client.reactions.add('like', activityId)
const me = await client.users.me()
```

### Pointing somewhere else

`url` defaults to `https://api.getnodex.cloud`. Override it for staging, a proxy, or local
development:

```ts
const client = new DropInClient({
  apiKey: 'acme-public-key',
  url: 'http://localhost:3000',
  tokenProvider: () => fetchTokenFromYourBackend(),
})
```

No trailing slash.

### Reactions

```ts
const reaction = await client.reactions.add('like', activityId)   // → Reaction { id, kind, ... }

// List who reacted, newest first (paginated). Optional `kind` filters server-side.
const page = await client.reactions.list(activityId, { limit: 20 })
page.results    // Reaction[]
page.next       // string | null — pass back as { next } for the next page
const likes = await client.reactions.list(activityId, { kind: 'like' })

// Canonical, GetStream-parity delete: by reaction id (from add()/list()).
await client.reactions.delete(reaction.id)

// Convenience: remove YOUR OWN reaction of a kind from an activity — no id needed.
await client.reactions.unreact(activityId, 'like')
```

The `Reaction` type is exported: `import type { Reaction } from '@dropinnodex/client'`.

`reactions.delete(reactionId)` is the GetStream-parity primitive. `reactions.unreact(activityId, kind)`
is sugar for the common "un-react by kind" case and does not require holding onto the
reaction id. **Breaking rename:** earlier previews had `reactions.delete(kind, activityId)`
do what `unreact` now does — `delete` is now strictly delete-by-id.

### Custom fields — nested under `custom` (differs from GetStream)

Your own activity fields live under a typed **`custom`** object, not spread onto the
activity root:

```ts
const feed = client.feed<{ title: string; location: string }>('user', 'user-123')
await feed.addActivity({
  verb: 'attend', object: 'session:42',
  custom: { title: 'Played a match', location: 'Amsterdam Zuid' },
})

const [a] = (await feed.get()).results
a.verb            // 'attend'         — reserved field
a.custom.title    // 'Played a match' — YOUR field, typed
```

**Coming from GetStream?** GetStream spreads custom keys onto the activity root
(`activity.title`). We deliberately nest them under `activity.custom` instead. Two reasons:

- **Typed.** `client.feed<TCustom>(…)` makes `activity.custom` a real typed shape end to
  end (SSR, hooks, enrichment) — no `any`.
- **No collisions.** A custom field named `verb`, `id`, or `time` can never clobber a
  reserved one; the reserved/custom boundary is unambiguous.

This is the one intentional divergence from GetStream's activity shape. Reach for
`activity.custom.yourField` rather than `activity.yourField`.

The token is cached until a 401, then refetched once and the request replays — never
per-request. Errors throw `DropInApiError` with `{ code, message, status, requestId }`.

### Follow counts

```ts
const stats = await client.feed('user', 'user-123').followStats()
stats.follower_count    // how many feeds follow user:user-123
stats.following_count   // how many feeds user:user-123 follows (usually 0 for a `user` feed)
```

**Two-call profile pattern.** Follow edges go **from `timeline:<id>` to `user:<other>`**
, so a profile screen needs both feed kinds to get "followers" and "following"
right:

```ts
const followers = await client.feed('user', 'user-123').followStats()      // .follower_count
const following = await client.feed('timeline', 'user-123').followStats() // .following_count
```

`followStats('user', uid)` counts who follows this person; `followStats('timeline', uid)`
counts who this person follows. Calling `followStats` on the wrong feed kind returns a
real number, just not the one you want (e.g. `user:<id>`'s `following_count` is normally 0,
since nothing follows *from* a `user` feed).

Both counts are **denormalized**: bumped in the **same transaction** as the
follow/unfollow write — so on the server they're always exactly consistent with the edges —
never computed with a realtime `COUNT(*)`. Client-side they're display data: your cached
copy is only as fresh as your last read, so `refresh()` after a follow to re-pull. Fine for
a profile header; don't use them as a source of truth for access control.

### Follow suggestions

Who a feed should follow — `user:` feeds it doesn't already follow, ranked by mutual
overlap (feeds followed by feeds it follows — friends-of-friends), then topped up by
global popularity for a cold-start feed with a thin graph.

```ts
const { results } = await client.feed('timeline', 'user-123').suggestions({ limit: 25 })
results  // [{ group: 'user', id: 'anna', mutuals: 3 }, …] — best first
```

`mutuals` is how many of the caller's follows also follow this suggestion; a
popularity-fill suggestion has `mutuals: 0`. Call it on the **`timeline:<id>`** feed —
following happens from the timeline feed, so that's the graph the 2-hop walks.
This is a **capped top-N, not a page**: `limit` defaults to 25 (max 50), there's no cursor
and no `next`. Reads are open within a tenant, so a server token can fetch suggestions for
any feed.

### Notifications

A **flat** notification feed, private to the caller. It fills when someone **follows you**
or **reacts to an activity you authored** (GetStream's "flat notifications" — no
aggregation, no grouping).

```ts
const page = await client.notifications.get({ limit: 20 })
page.results   // Notification[] — newest first
page.unseen    // count of not-yet-seen notifications
page.unread    // count of not-yet-read notifications
page.next      // keyset cursor, or null

await client.notifications.markSeen()          // no ids → mark ALL seen
await client.notifications.markSeen(['n1'])    // or specific ids
await client.notifications.markRead(['n1'])    // read is tracked independently of seen
await client.notifications.markRead()          // mark all read
```

Each `Notification` is `{ id, verb, actor, object, reaction_kind, created_at, seen_at,
read_at, actor_user }`. `verb` is `'follow'` or `'react'`; `actor` is the acting user ref
(e.g. `'user:bob'`) enriched into `actor_user` (`{ id, custom }`) when it resolves to a
known user; `object` is the followed feed ref (follow) or the reacted activity id (react).

Notes:
- **You are never notified about your own actions** (following yourself, reacting to your
  own post) — the server skips self-actions.
- `seen` and `read` are **independent** (marking read does not mark seen), matching
  GetStream. Counts are denormalized like follow counts — server-authoritative,
  moved only when a row actually changed. Re-read to refresh a cached copy.
- Removing a reaction leaves the notification in place; a repeat follow collapses into the
  single existing "X follows you" row.

## Cancellation

Every method takes an optional `RequestOptions` as its **last** argument:

```ts
const ctrl = new AbortController()
const page = client.timeline('alice').get({ limit: 20 }, { signal: ctrl.signal })
ctrl.abort() // the request is dropped
```

An aborted call rejects with what `fetch` throws — a `DOMException` whose `name` is
`AbortError`, or the `reason` you passed to `abort()` — never a `DropInApiError`. So
`err instanceof DropInApiError` still means "the API answered".

Aborting before the call reaches the network also skips `tokenProvider`, so a cancelled
screen does not hit your token endpoint.

`@dropinnodex/react` wires this up for you: its reads are cancelled on unmount, its writes are
not.

## License

MIT
