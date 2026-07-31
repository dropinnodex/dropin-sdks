# @dropinnodex/react

React hooks for [dropin-activity](https://github.com/) — a GetStream-shaped activity feed
as a service. Feeds, reactions, follows, and notifications with **optimistic updates and
rollback**.

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
    <button onClick={() => (liked ? unreact('like') : react('like'))}>
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
resolves, reverting if it fails, and self-correcting on the next refresh.

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
