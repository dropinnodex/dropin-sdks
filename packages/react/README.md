# @dropinnodex/react

React hooks for [dropin-activity](https://github.com/) — a GetStream-shaped activity feed
as a service. Feeds, reactions, follows, and notifications with **optimistic updates,
rollback, and a rejection that fires after rollback so callers can react to network
failures** (see [Optimistic writes reject after rollback](#optimistic-writes-reject-after-rollback)).

```bash
npm i @dropinnodex/react @dropinnodex/client react
```

`react` is a peer dependency (>=18). `@dropinnodex/client` provides the underlying client.

## Usage

```tsx
import { DropInClient } from '@dropinnodex/client'
import {
  DropInProvider, useFeed, useFeedActions, useReactions, useFollow, useSuggestions,
  useNotifications,
} from '@dropinnodex/react'

const client = new DropInClient({ apiKey, url, tokenProvider })

function App() {
  return (
    <DropInProvider client={client}>
      <Timeline />
    </DropInProvider>
  )
}

function Timeline() {
  const { activities, loadNext, hasNext, isLoading } = useFeed('user', 'user-123')
  const { addActivity } = useFeedActions('user', 'user-123')
  return activities.map((a) => <Post key={a.id} activity={a} />)
}

function Post({ activity }) {
  // Optimistic: counts update instantly and roll back if the write fails.
  const { react, unreact, counts, ownReactions } = useReactions(
    activity.id, activity.reaction_counts, activity.own_reactions,
  )
  const liked = ownReactions.includes('like')
  // unreact(kind) removes YOUR OWN reaction of that kind — it calls the client's
  // reactions.unreact(activityId, kind) under the hood, not reactions.delete(reactionId)
  // (that's the GetStream-parity delete-by-id primitive, for when you already hold a
  // reaction's id from add()/list() — see @dropinnodex/client's README).
  return (
    <button onClick={() => { void (liked ? unreact('like') : react('like')) }}>
      👍 {counts.like ?? 0}
    </button>
  )
}
```

Deliberately **not** built on TanStack Query — the provider holds a small feed cache so a
remount renders instantly, then refreshes.

`useReactions` is the optimistic like/unlike **counter**. To render the **list of who
reacted**, use `useReactionList` — it loads and paginates the reactions, and `remove` deletes
one by id (optimistic + rollback):

```tsx
import { useReactionList } from '@dropinnodex/react'

const { reactions, loadNext, hasNext, isLoading, error, remove, refresh } =
  useReactionList(activity.id)              // or useReactionList(activity.id, { kind: 'like' })
// reactions: Reaction[]  ·  remove(reactionId) deletes by id
```

### Current user

`useCurrentUser()` loads the caller identified by the current token (wraps
`client.users.me()`):

```tsx
import { useCurrentUser } from '@dropinnodex/react'

const { user, isLoading, error, refresh } = useCurrentUser()
// user: { id: string; custom: Record<string, unknown> } | null
```

### SSR / prefetch hydration

Pass `initialData` (the `Page<Activity<TCustom>>` shape returned by `@dropinnodex/client`'s
`feed().get()`) so a Next/Remix app can server-prefetch page 1 and hydrate with no
loading flash:

```tsx
// server side, e.g. a Next.js Server Component or `getServerSideProps`
import { DropInServer } from '@dropinnodex/server'

const server = new DropInServer({ tenantId, apiKey, apiSecret, url })
const page = await server.feed('user', 'user-123').get<YourCustom>()
// page: Page<Activity<YourCustom>> — typed end to end, no `unknown` cast needed.

// client side
function Timeline() {
  const { activities, isLoading } = useFeed<YourCustom>('user', 'user-123', { initialData: page })
  // isLoading is false on the very first render — the mount effect still
  // revalidates against the live feed in the background. A warm provider cache
  // (a prior fetch this session) wins over initialData, since it is fresher.
  return activities.map((a) => <Post key={a.id} activity={a} />)
}
```

## Pagination & infinite scroll

`useFeed` tracks the keyset cursor for you. `loadNext()` appends the next page;
`pageSize` (default 20) sets the rows per request for every read the hook makes.

```tsx
const { activities, loadNext, canLoadMore, isLoadingMore } = useFeed('timeline', uid)

{canLoadMore && (
  <button onClick={() => void loadNext()} disabled={isLoadingMore}>Load more</button>
)}
```

`useInfiniteFeed` is the same hook with the scroll wiring attached — put `sentinelRef` on
a trailing element and pages load as it comes into view. `rootMargin` (default `'600px'`)
is how far ahead of the viewport to start.

```tsx
import { useInfiniteFeed } from '@dropinnodex/react'

function Timeline({ uid }) {
  const { activities, sentinelRef, isLoadingInitial, isLoadingMore, error, retry } =
    useInfiniteFeed('timeline', uid, { pageSize: 40 })

  // isLoadingInitial, NOT isLoading — see below.
  if (isLoadingInitial && activities.length === 0) return <FullPageLoading />

  return (
    <>
      {activities.map((a) => <Post key={a.id} activity={a} />)}
      {error && <button onClick={() => void retry()}>Try again</button>}
      <div ref={sentinelRef}>{isLoadingMore && <Spinner />}</div>
    </>
  )
}
```

An IntersectionObserver fires on intersect **and again on every reflow**, so three things
that a "Load more" button barely reaches become the normal path. All three are handled,
including for a hand-rolled sentinel — as long as you use the right flags:

- **Gate the list on `isLoadingInitial`, never `isLoading`.** `isLoading` is the union of
  initial and next-page loading. A list gated on it swaps itself for a spinner while page
  2 is in flight, unmounting your sentinel — scrolling then stalls for good and the reader
  loses their position. `isLoadingInitial` covers only the reads that replace the list
  (first load, feed switch, `refresh()`); `isLoadingMore` covers `loadNext`.
- **Bind the sentinel to `canLoadMore`, not `hasNext`.** `canLoadMore` also folds in "a
  page is already in flight" and "the last page failed". A failed page leaves the cursor
  unchanged, so retrying on `hasNext` alone re-issues the identical failed request for as
  long as the sentinel stays in view. `loadNext()` is a no-op while `error` is set;
  `retry()` is the deliberate way back in.
- **Duplicates are handled.** Pages merge deduped by id, and a second `loadNext()` while
  one is in flight is dropped — so an overlapping page can't produce duplicate React keys.

On React Native, `FlatList` does the observing. `sentinelRef` is inert where there is no
`IntersectionObserver`, so the same component works on both.

```tsx
const { activities, onEndReached, isLoadingMore } = useInfiniteFeed('timeline', uid)

<FlatList
  data={activities}
  keyExtractor={(a) => a.id}
  onEndReached={onEndReached}
  onEndReachedThreshold={0.5}
  ListFooterComponent={isLoadingMore ? <Spinner /> : null}
/>
```

## Timeline & follows

Two feed kinds make a social timeline:

- **`user:<id>`** — a person's own activity feed. You post here.
- **`timeline:<id>`** — the aggregated feed of everyone `<id>` follows. You read here.

When someone you follow posts to their `user` feed, it **fans out** into your `timeline`.

```tsx
import { useTimeline, useUserFeed, useFollow, useFollowing } from '@dropinnodex/react'

// Post to your own feed:
const { addActivity } = useUserFeed('me')
await addActivity({ verb: 'attend', object: 'session:42', custom: { title: 'Played a match' } })

// Follow someone (a user token manages follows on its OWN timeline only):
const { follow, unfollow, isFollowing } = useFollow('timeline', 'me')
await follow('user', 'anna')          // now anna's future posts fan into timeline:me

// Read your aggregated timeline:
const { activities } = useTimeline('me')

// Who am I following? (hydrated from the server)
const { following } = useFollowing('timeline', 'me')   // → [{ group: 'user', id: 'anna' }, …]

// Who follows me? (the other direction — mirror of useFollowing)
const { followers } = useFollowers('user', 'me')        // → [{ group: 'user', id: 'bob' }, …]
```

`useFollow` hydrates `isFollowing` from the server on mount, so it reflects real state —
while your own `follow`/`unfollow` calls stay optimistic and are never clobbered by that
hydration.

### Follow counts

`useFollowStats(group, id)` hydrates `{ followerCount, followingCount }` from the server
and exposes a `refresh()` to re-pull them. The counts are denormalized — bumped
in the same transaction as the follow/unfollow write, so they're exact on the server, never
a realtime `COUNT(*)`. Your hydrated copy is only as fresh as the last read, so call
`refresh()` after the viewer follows/unfollows on the profile shown:

```tsx
import { useFollowStats } from '@dropinnodex/react'

function ProfileHeader({ uid }: { uid: string }) {
  const { followerCount, followingCount, isLoading, error, refresh } = useFollowStats('user', uid)
  if (isLoading) return <Spinner />
  if (error) return null
  return (
    <div>
      <strong>{followerCount}</strong> followers · <strong>{followingCount}</strong> following
      <button onClick={refresh}>↻</button>
    </div>
  )
}
```

Because follow edges go from `timeline:<id>` to `user:<other>`, `followerCount` above
(from `useFollowStats('user', uid)`) is who follows this person, while their *following*
count lives on the `timeline` feed instead — `useFollowStats('timeline', uid).followingCount`
— see `@dropinnodex/client`'s README for the full two-call breakdown.

> **No backfill.** Following someone shows their activities **from their next post
> onward** — their *past* posts do **not** appear in your timeline. This is deliberate
> (v1): the follow edge starts delivering at the moment it's created. It is not a bug or a
> sync delay.

### Follow suggestions

`useSuggestions(group, id, { limit? })` hydrates a "who to follow" list from the server —
`user:` feeds this feed doesn't already follow, ranked by mutual overlap (friends-of-friends)
and topped up by popularity for a thin graph. Read-only: it exposes `{ suggestions,
isLoading, error, refresh }` — no pagination (the endpoint is a capped top-N), so call it on
the viewer's **`timeline`** feed, the side the follow graph lives on:

```tsx
import { useSuggestions } from '@dropinnodex/react'

function WhoToFollow({ uid }: { uid: string }) {
  const { suggestions, isLoading, refresh } = useSuggestions('timeline', uid, { limit: 5 })
  if (isLoading) return <Spinner />
  return (
    <ul>
      {suggestions.map((s) => (
        <li key={`${s.group}:${s.id}`}>
          {s.id}{s.mutuals > 0 && <em> · {s.mutuals} mutual</em>}
          <FollowButton group={s.group} id={s.id} onDone={refresh} />
        </li>
      ))}
    </ul>
  )
}
```

`mutuals` is how many of the viewer's follows also follow that suggestion (`0` for a
popularity fill). After the viewer follows someone, call `refresh()` to drop them from the
list.

### Live updates and polling

There is no websocket/SSE (by design). To keep feeds fresh, use **`live: true`** for a cheap
change signal every 5 seconds while your tab is visible (paused when hidden):

```tsx
function TimelineWithPill({ uid }) {
  const { activities, newCount, showNew, isLoading } = useTimeline(uid, { live: true })
  return (
    <>
      {newCount > 0 && (
        <button onClick={showNew}>{newCount > 20 ? '20+' : newCount} new posts ↑</button>
      )}
      {activities.map((a) => <Post key={a.id} activity={a} />)}
    </>
  )
}
```

On a detected change, `useFeed` buffers new items behind `newCount`/`showNew` (no loading
flicker), so you get the familiar "N new posts" pill. Internally, `live` runs one cheap
Redis check per tick; a real fetch only happens if something changed.

**`pollInterval` (deprecated).** The older approach does a full feed read every tick, even
in hidden tabs, costing 3 SQL statements per check. Still works for backward compatibility,
but `live` is strongly recommended — it costs ~1% as much.

```tsx
// Old style — not recommended
const { activities, newCount, showNew } = useTimeline(uid, { pollInterval: 15000 })
```

- `newCount` is a client-side diff of page 1, **capped at the page size (20)** — display `20+`.
- `showNew()` prepends the buffered posts and clears the count. Your own `addActivity`
  posts are already shown, so they never count as "new".
- With `live: true`, no need to set `pollInterval`; `live` takes precedence if both are passed.

### Notifications

`useNotifications(opts?)` loads the caller's **flat** notification feed — the one that fills
when someone follows them or reacts to their post — and keeps `unseen`/`unread` counts.
`markSeen`/`markRead` are **optimistic with rollback**, the same discipline as
`useReactions`: they update the local counter and stamp the rows before the request
resolves, reverting if it fails, and self-correcting on the next refresh. **The returned
promise rejects after the rollback** — see [Optimistic writes reject after
rollback](#optimistic-writes-reject-after-rollback) below.

Keep notifications fresh with **`live: true`** for cheap change checks every 5 seconds
(paused when hidden):

```tsx
import { useNotifications } from '@dropinnodex/react'

function NotificationBell() {
  const { notifications, unseen, unread, markSeen, markRead, loadNext, hasNext, isLoading } =
    useNotifications({ live: true })

  return (
    <details>
      <summary onClick={() => markSeen()}>🔔 {unseen > 0 ? unseen : null}</summary>
      {notifications.map((n) => (
        <div key={n.id} data-unread={n.read_at === null}>
          {n.verb === 'follow'
            ? `${n.actor_user?.custom.name ?? n.actor} followed you`
            : `${n.actor_user?.custom.name ?? n.actor} reacted to your post`}
        </div>
      ))}
      {hasNext && <button onClick={loadNext}>Load more</button>}
    </details>
  )
}
```

With `live: true`, the list is refreshed (`isLoading` cycles, `error` can surface) only when
something actually changed; nothing runs while the tab is hidden.

**`pollInterval` (deprecated).** The older approach does a full refresh every tick. Still works
for backward compatibility, but `live` is recommended for better UX and lower server cost.

Returns `{ notifications, unseen, unread, loadNext, hasNext, isLoading, error, markSeen,
markRead, refresh }`.

- `markSeen()` / `markRead()` with **no ids (or an empty array) mark ALL**; pass an id array
  to mark specific ones. `seen` and `read` are tracked independently.
- Counts are server-authoritative; the optimistic decrement is a display
  convenience that reconciles to the server on the next `refresh`.
- With `live: true`, no need to set `pollInterval`; `live` takes precedence if both are passed.

## Keeping feed data fresh: objects and activity patches

See the [Keeping feed data fresh](https://docs.getnodex.cloud/guides/keeping-feed-data-fresh/)
guide for the full rule (`custom` if it's true forever, an object if it changes)
and why delete-and-repost is the wrong tool. `useFeed` gives you both pieces:

```tsx
import { useFeed, resolveRefs } from '@dropinnodex/react'

function Timeline({ uid }: { uid: string }) {
  const { activities, objects, updateActivity } = useFeed<{ title: string; spots_left?: number }>(
    'timeline', uid,
  )

  return activities.map((activity) => {
    // Pure, no fetching. A ref with no stored object is skipped, not an error —
    // always fall back to the activity's own custom.
    const [session] = resolveRefs(activity, objects)
    const spotsLeft = session?.custom.spots_left ?? activity.custom.spots_left
    return <SessionCard key={activity.id} title={activity.custom.title} spotsLeft={spotsLeft} />
  })
}
```

**`objects` is `{}`, never `undefined`.** `@dropinnodex/client`'s `feed().get()`
types the sidecar as optional — the server omits the key when nothing on the page
carries a ref — but `useFeed` normalizes that to an empty object, so you can index
straight into it without a null check.

`updateActivity(activityId, { set, unset })` patches ONE activity's own `custom` —
optimistic, with rollback and the same reject-after-rollback / `onError` contract
as `react`/`follow` (see below). Every path starts with `custom.`; identity fields
(`actor`, `verb`, `object`, `target`, `time`, `foreign_id`) are never patchable.

```tsx
await updateActivity(activity.id, { set: { 'custom.text': 'Corrected caption' } })
```

Objects themselves are server-write-only — there's no `useObject`/write hook here
on purpose; create and update them from your backend with `@dropinnodex/server`.

## Optimistic writes reject after rollback

Every action that updates local state optimistically — `react`, `unreact`, `remove` (reaction
list), `follow`, `unfollow`, `markSeen`, `markRead` — applies the local change **first**, calls
the network, and on rejection **rolls back the state AND rejects the returned promise**. The
rollback and the rejection are independent signals: the rollback restores the UI to truth,
the rejection lets you show a toast, log, or retry.

This means **a fire-and-forget caller must handle the rejection** — otherwise the host app
sees an unhandled promise rejection. The simplest patterns:

```tsx
// Fire-and-forget on a button: silence the rejection explicitly.
<button onClick={() => { void react('like').catch(() => {}) }}>👍</button>

// Or await in an async handler and branch on success.
<button onClick={async () => {
  try { await markSeen() } catch { /* UI already rolled back */ }
}}>🔔</button>
```

We surfaced this contract live, not in tests: during customer integration (FC Urban, Aug
2026), the upstream notifications endpoint started 500'ing tenant-wide, their bell's
`onClick={() => markSeen()}` had no catch, and the unhandled rejection bubbled to their
React error boundary — page crash. The local bell UI had already rolled back, so the data
state was fine; only the missing `.catch()` was missing.

Why the rejection is part of the contract (and not auto-swallowed): the same
"rejection-after-rollback" shape applies to `react` / `unreact` and `follow` / `unfollow`,
where callers often DO want to surface a failure (toast: "Couldn't save your like —
retry?"). The notification bell is the unusual case where the failure is rarely worth
the user's attention; for it, the `.catch(() => {})` is one extra line — or you can
opt out of the rejection entirely with an `onError` sink (next section).

### Opt-in error handling

If you don't want the post-rollback rejection at all — typically because the failure isn't
worth the user's attention (a notification bell, a fire-and-forget like button) — pass an
`onError` sink. The hook then **rolls back and resolves to `undefined`** instead of
rejecting:

```tsx
// Per-call: silence just this one write.
const { markSeen } = useNotifications()
<button onClick={() => { void markSeen(['n1'], { onError: (err) => console.warn(err) }) }}>
  Mark seen
</button>

// Per-tree: every optimistic write inside this provider swallows via Sentry.
<DropInProvider client={client} onError={(err, ctx) =>
  Sentry.captureException(err, { extra: ctx })}>
  <App />
</DropInProvider>
```

The per-call `onError` (when present) overrides the provider-level one. With neither set,
behavior is unchanged: the SDK still rejects after rollback — useful for `react` /
`unreact` / `follow` / `unfollow` where you DO want to surface a toast or retry prompt.

The `ctx` argument is action-specific so you can route without parsing strings:

| Action | `ctx` shape |
|---|---|
| `useReactions.react` / `unreact` | `{ hook, action, activityId, kind }` |
| `useReactionList.remove` | `{ hook, action, activityId, reactionId }` |
| `useFollow.follow` / `unfollow` | `{ hook, action, source: {group, id}, target: {group, id} }` |
| `useNotifications.markSeen` / `markRead` | `{ hook, action, ids: string[] \| null }` (`null` = mark-all) |
| `useFeed.updateActivity` | `{ hook, action, activityId }` |

Disabled-mode (`<DropInProvider enabled={false}>`) actions resolve to `undefined` and do
NOT invoke `onError` — there is no error to observe.

## Cancellation on unmount

Every hook cancels its **reads** when the component unmounts, and when the feed or activity
it is reading changes — a page-2 fetch, a mount load, or a `pollInterval` tick still in the
air is dropped instead of resolving into a component that is gone. Nothing to wire up.

**Writes are never cancelled.** A `react()`, `follow()`, `addActivity()`, or `markRead()`
the user already committed to still lands even if the component unmounts mid-request —
cancelling those would silently discard what the user asked for.

An abort never appears in `error`: unmounting is not a failure for the (now absent) UI to
report. Real failures still surface exactly as before.

For manual control, `@dropinnodex/client` takes an `AbortSignal` on every method — see its
README.

## License

MIT
