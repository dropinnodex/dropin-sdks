# @dropinnodex/react

## 0.14.0

### Minor Changes

- 978202d: `DropInProvider` accepts `userId`, and keys the client on it.

  The client is memoized on apiKey/url and caches its token until a 401, so a user switch
  inside a mounted provider kept serving a still-valid token minted for the previous user —
  and the per-feed cache kept serving that user's pages, `own_reactions` included. Neither a
  new `tokenProvider` closure nor a re-render dislodged either, and nothing errored.

  Pass `userId` and an identity change rebuilds the client, drops the feed cache, and
  re-seeds every mounted hook. That last part matters: wiping the cache alone still left the
  previous user's rows in each hook's `useState` until the refetch landed a round trip later,
  and still let a stale SSR `initialData` re-seed the emptied cache with no loading state at
  all. `useFeed`, `useNotifications` and `useCurrentUser` now reset on identity change, and
  `initialData` is honoured only for the identity a hook mounted under.
  It is optional and inert for the common cases — a provider remounted on sign-in, or one
  session for the life of the page — but it is required to be correct where a user can
  change in place. The `client` form is unchanged: supplying a different client is itself
  the identity change, and now resets the cache too.

## 0.13.0

### Minor Changes

- ed6b175: Two hooks that looked like they worked and didn't, both found by a real integration.

  - `retry()` now recovers a failed **first** page. It re-issues the failed cursor when there
    is one and re-reads page 1 when there isn't. Previously it delegated to the cursored
    fetch unconditionally, which no-ops when `next` is null — exactly the state after an
    initial load fails — so the documented escape from the error state silently did nothing
    and a remount was the only way back. End-of-feed stays a no-op: the fallback only fires
    when there was an error to clear.
  - `useReactions` now adopts a **changed** seed. Counts were seeded through a `useState`
    initializer, which reads its argument once, so a button seeded from
    `activity.reaction_counts` froze at mount: `live` mode revalidated the page, someone
    else's like arrived on the prop, and the number on screen never moved. A fresher seed is
    skipped only while one of your own optimistic writes is in flight, since that payload was
    built before the click and adopting it would visibly undo it. If that write then fails,
    the rollback lands on the skipped seed rather than on the pre-click snapshot, so another
    user's reaction is not discarded along with yours.

## 0.12.1

### Patch Changes

- Updated dependencies [2a5745f]
  - @dropinnodex/client@0.9.0

## 0.12.0

### Minor Changes

- 2ed2374: The head check now reports whether anything in the tenant has been mutated, so a `live`
  feed can skip its revalidation entirely when nothing has.

  `live: true` ran two loops: a 5s head check (one Redis read) and a 30s revalidation (a
  page read plus a batch object read, both hitting Postgres). The 30s loop is roughly ten
  times the cost of the 5s one, and on a quiet tenant every single run of it found nothing.

  `head()` now returns `{ latest, changed }`. `changed` is a per-tenant counter incremented
  on every write the head token structurally cannot report — an activity edited, a reaction
  moved, an object written. When it has not moved since the last revalidation, the hook
  issues neither request.

  `null` means unknown: nothing mutated yet, or Redis unavailable. Unknown revalidates. A
  wasted read is cheap; a permanently stale feed is not — so the same applies against a feed
  service that predates the field.

  Tenant-wide rather than per feed, deliberately. An object does not know which feeds
  reference it, so a per-feed counter would need the fan-out on write this whole design
  avoids. The cost is a false positive: one tenant's write makes every open feed in that
  tenant revalidate once. That degrades to the previous behaviour on a busy tenant and
  removes nearly all of it on a quiet one.

  `revalidateObjects()` is never gated — a hand call is user intent, not a timer.

### Patch Changes

- Updated dependencies [2ed2374]
  - @dropinnodex/client@0.8.0

## 0.11.0

### Minor Changes

- 02c378e: Activities carry a `version`, and it is what decides whether a rendered row is stale.

  `edited_at` was doing that job and is structurally unable to. It marks PATCHes only, so
  the field that changes most — `reaction_counts` — never moved it. A feed with `live: true`
  therefore fetched fresh reaction counts on every page read and discarded them as
  unchanged: the same bug shape as the objects sidecar being binned, one field over.

  `version` starts at 1 and increments on any real change to the activity row — a patch, a
  reaction count, a soft delete. It is bumped by a database trigger rather than by each
  writer: there are four UPDATE sites today, and a missed one fails silently, with the write
  landing, the version staying put, and every open feed showing stale data with no error
  anywhere. A trigger cannot be forgotten by a writer that does not exist yet.

  `edited_at` stays on the wire. It is still the right field for an "edited" badge — it just
  is not a staleness signal.

  Requires a feed service carrying migration `0009_activity_version.sql`. There is no
  fallback to the old `edited_at` comparison: deploy the backend first, as usual.

### Patch Changes

- Updated dependencies [02c378e]
  - @dropinnodex/client@0.7.0

## 0.10.0

### Minor Changes

- 20cc29d: `live: true` now picks up activity edits, not just new activities and object updates.

  The feed head token is written by the fan-out worker and by nothing else, so it reports
  one event: a new activity arrived. A `PATCH /v1/activities/:id` moves no head, and
  `checkNew()` then dropped the edited body anyway — it dedupes page 1 by activity id, so a
  row already on screen was discarded as "not new". An edit reached an open feed only
  through `refresh()`, which resets pagination.

  Two changes close it:

  - `checkNew()` reconciles edited bodies in place, from the page it had already fetched.
    Comparison is on `edited_at`, which also keeps an in-flight optimistic `updateActivity`
    safe — that patch has not moved the server's `edited_at`, so the pre-edit body coming
    back is not mistaken for newer. Edits never enter the `newCount` buffer and never move
    a row.
  - The revalidation tick reads page 1 as well as sweeping objects, so an edit lands without
    needing a new activity to trigger it. The read is skipped when a head change already
    fetched the same page within the interval.

  Two limits, both deliberate and both tested. Reconciliation covers the **newest page
  only**, because that is the page the revalidation reads; objects have no such limit, since
  a batch read of refs is cheap in a way re-reading N pages is not. And an activity absent
  from that page is **not** removed — absence cannot distinguish a deletion from a row
  pushed off page 1 by newer activities. Both land on the next `refresh()`.

  `liveObjectsInterval` is renamed `liveRevalidateInterval` — the tick covers activity edits
  now, so the old name no longer described it. The old name still works.

  Merging a page's `objects` sidecar also follows the sweep's "newer wins, equal is
  untouched" rule now, so a revalidation that changes nothing no longer hands consumers a
  fresh `objects` identity every tick.

- 8eed750: `useFeed` returns `revalidateObjects()` — re-read the shown activities' objects on demand.

  `live: true` already revalidates objects on a timer, but there was no way to ask for it.
  The only imperative read was `refresh()`, which re-reads page 1 and resets the cursor: a
  reader three pages deep loses two of them and gets a full-page spinner, which is far too
  blunt for "the reader just booked a spot, show them the new count". `revalidateObjects()`
  touches the objects sidecar and nothing else — no pagination, no `isLoadingInitial`.

  Independent of `live`, so an app that polls nothing can still revalidate after its own
  writes. It reuses the shared per-feed sweep, so two components on one feed still perform
  one read.

  It skips the cross-instance cooldown that gates the timer. That cooldown exists to stop
  two offset timers reading the same data seconds apart; a hand call is user intent, not a
  timer, and returning silently-stale data because a sweep happened three seconds ago is the
  bug it would otherwise introduce.

  A caller that joins a sweep already in flight now awaits it rather than returning
  immediately — an awaited `revalidateObjects()` resolves once the data has been applied, so
  a pull-to-refresh spinner cannot stop before the rows update. This also applies to the
  timer's own sweeps, which simply resolve later than they used to.

  No-ops resolving `undefined` inside a disabled provider, and against a
  `@dropinnodex/client` older than 0.6.0, which has no `objects.getMany`.

## 0.9.0

### Minor Changes

- e08ed31: Object freshness: `live: true` now keeps objects current, not just activities.

  Activities are immutable and objects are the half of a feed that moves, but the only
  freshness signal was the feed head token — which advances on fan-out, so an object
  upsert never moved it. `live: true` therefore delivered no object freshness at all.

  - **client / server**: new `objects.getMany(refs)` — re-read up to 100 objects in one
    request, keyed `type:id`. Backs `GET /v1/objects?refs=…`. Missing refs are absent from
    the map rather than a 404, matching the feed-read sidecar. An empty list costs zero
    requests.
  - **react**: under `live: true`, `useFeed` re-reads the objects on screen every 30s
    (visibility-gated, like the 5s activity head check). Tune with the new
    `liveObjectsInterval`, or pass `0` to keep activity freshness without the object sweep.
    Newest `updated_at` wins, so a sweep landing after a `refresh()` cannot pin a card back
    to an older read, and an unchanged object keeps its identity rather than re-rendering
    the list every interval.
  - **react**: the sweep is bounded at `liveObjectsMaxRefs` refs per tick (default 200, two
    requests), newest activities first, with one console warning when a deeper feed exceeds
    it — a deeply scrolled feed stays cheap instead of billing a request per 100 refs
    forever. Several `useFeed`s on the same feed share one sweep rather than one each, and
    a chunk that fails no longer discards the chunks that succeeded or drops the objects it
    could not check.
  - **react**: `checkNew()` now merges the `objects` sidecar from the page it already
    fetched instead of discarding it.

  Server-side, `updated_at` now advances by at least a millisecond on every object write.
  It is the freshness token every client diffs on, and it reaches them at millisecond
  precision — so two writes inside one millisecond previously produced identical tokens and
  the second silently never reached a client holding the first.

  This replaces hand-rolled per-card `objects.get()` polling with one batch request on a
  cadence that matches how often objects actually change.

### Patch Changes

- Updated dependencies [e08ed31]
  - @dropinnodex/client@0.6.0

## 0.8.0

### Minor Changes

- 9398eab: `PATCH /v1/activities/:id` now accepts `refs`, a top-level field (not a `custom.`
  path) that replaces an activity's `refs` array wholesale — `refs: []` clears it,
  and a body carrying only `refs` is a valid patch on its own. This is the backfill
  path for an activity posted before objects existed: it can adopt refs after the
  fact without the delete-and-repost that would otherwise burn its `foreign_id`
  identity, re-fan-out to every follower, and jump it to the top of every timeline.

  - `PatchBody.refs?: string[]` (client, re-exported by server and react)
  - `dropin.activities.patch(id, { refs: [...] })` (server)
  - `client.feed(group, id).updateActivity(id, { refs: [...] })` (client)
  - `useFeed().updateActivity(id, { refs: [...] })` (react) — `refs` is deliberately
    NOT applied by the optimistic step (unlike `set`/`unset`): what renders is the
    resolved object's `custom` in `objects`, which this hook has no local copy of
    for a ref that just started pointing at it. `activity.refs` itself still
    updates the moment the patch call's network response lands; the newly
    referenced object resolves into `objects` on the next feed read.

### Patch Changes

- Updated dependencies [9398eab]
  - @dropinnodex/client@0.5.0

## 0.7.0

### Minor Changes

- 9a6e43b: Mutable feed data: objects that many activities can point at, and patch-style
  updates for a single activity.

  - `dropin.objects.upsert/patch/get/remove` and `dropin.batch.objects` (server)
  - `dropin.activities.patch` (server), `feed().updateActivity` (client, react)
  - Feed reads return an `objects` sidecar; `resolveRefs(activity, objects)` maps an
    activity onto its objects (react)
  - Activities accept `refs` and return `refs` + `edited_at`
  - `feed().addActivity` (server, client) and `useFeed`/`useFeedActions`'s `addActivity`
    (react) now accept `refs?: string[]` directly, as a plain field alongside `custom` —
    no cast or workaround needed to point a new activity at an object

  **Breaking for hand-built `Activity` mocks:** `Activity` gained two required fields,
  `refs: string[]` and `edited_at: string | null`. A consumer test suite that builds an
  `Activity` object literal by hand (rather than getting one back from the SDK) will need
  to add both fields for it to type-check — `refs: []` and `edited_at: null` restore the
  pre-upgrade shape.

### Patch Changes

- Updated dependencies [9a6e43b]
  - @dropinnodex/client@0.4.0

## 0.6.0

### Minor Changes

- 97e8a67: `useFeed` (and `useTimeline` / `useUserFeed`) is now safe to drive from an
  IntersectionObserver, not just a "Load more" button. Everything below is additive — the
  existing return shape is unchanged.

  - **`loadNext` no longer double-fetches.** It was guarded only against end-of-feed
    (`next === null`), and `next` updates when the response lands — so two calls before the
    first resolved both sent the same cursor and both appended. A button barely reaches
    this; a sentinel firing on intersect and again on reflow reaches it every scroll. A
    call while a page is in flight is now a no-op.
  - **Pages merge deduped by id.** The merge was a bare `[...prev, ...page.results]`, so an
    overlapping page (a row inserted ahead of the cursor, or an at-least-once fan-out
    replay) produced duplicate React keys.
  - **`isLoadingInitial` / `isLoadingMore`** split out of `isLoading`, which stays as their
    union. Gate a full-page spinner on `isLoadingInitial`: the shared flag is also true
    during `loadNext`, so a list gated on it unmounts its own scroll sentinel mid-fetch and
    scrolling stalls permanently.
  - **`canLoadMore`** — `hasNext` folded together with "not in flight" and "not errored".
    Bind the sentinel to this. A failed page leaves the cursor unchanged, so an unguarded
    sentinel re-issues the identical failed request for as long as it stays intersecting.
    `loadNext` now no-ops while `error` is set; **`retry()`** clears the error and re-issues
    that page.
  - **`pageSize`** option (default 20) replaces the hardcoded per-request limit on every
    read the hook makes. 20 rows is a single screen on a desktop viewport, so scroll paid a
    round trip per screen. Note `newCount` saturates at this value.
  - **`useInfiniteFeed`** — `useFeed` with the scroll wiring attached: a `sentinelRef`
    callback ref for the web (`rootMargin` option, default `'600px'`) and an
    `onEndReached` for React Native's `FlatList`. It re-checks after every commit, because
    the sentinel does not move when a page lands — without that, one scroll gesture loads
    exactly one page. Inert where there is no `IntersectionObserver`, so the same component
    can be shared with React Native.

## 0.5.0

### Minor Changes

- dc22696: `useFeed` (and `useTimeline` / `useUserFeed`) gains promoted-activity support:
  `promoted` (the eligible set), `items` (activities with promoted rows
  interleaved), and `trackPromotedClick`. Placement is client-side via
  `promotedPosition` / `promotedRepeatEvery` — repeat slots keep filling from the
  cached sidecar as later pages load, with no extra request. `onPromotedImpression`
  fires once per placed slot and `onPromotedClick` on click, so per-view numbers go
  to your own analytics. `placePromoted()` is exported as a pure helper for
  non-hook placement. `activities` is unchanged: promoted rows are never mixed in.

### Patch Changes

- Updated dependencies [dc22696]
  - @dropinnodex/client@0.3.0

## 0.4.0

### Minor Changes

- 3b47005: Add an opt-in `onError` sink to every optimistic write in `@dropinnodex/react`:

  - **Per-call**: every `react` / `unreact` / `remove` / `follow` / `unfollow` / `markSeen` /
    `markRead` accepts an optional `{ onError }` arg. When present, the action rolls back AND
    resolves to `undefined` (no rejection) — `onError(err, ctx)` is called instead.
  - **Per-tree**: `<DropInProvider onError>` sets the default for every optimistic write in the
    subtree. Per-call `onError` overrides the provider default.

  Default behavior is unchanged: without an `onError` (call-level OR provider-level), the
  optimistic write still rejects after rollback — existing integrators see no breaking change.

  The `ctx` argument is action-specific so callers can route failures without parsing strings
  (`{ hook, action, activityId, kind }` for reactions, `{ hook, action, source, target }` for
  follows, `{ hook, action, ids }` for notifications, etc.). No new dependency on
  `@dropinnodex/client`; the hook is the only layer that touches the new option.

  Together with the v0.3.1 doc patch, closes the footgun that crashed the FC Urban
  notification bell in live testing (Aug 2026) when the upstream notifications endpoint
  started 500'ing tenant-wide.

### Patch Changes

- fd9b32c: Document the **reject-after-rollback** contract on every optimistic write — `react`,
  `unreact`, `remove` (reaction list), `follow`, `unfollow`, `markSeen`, `markRead`. The
  local state is always rolled back on network failure, and the returned promise also
  rejects so callers can show a toast, log, or retry. Fire-and-forget callers (e.g. an
  `onClick` on a notification bell) must wrap calls in `try/catch` or `.catch(() => {})` to
  silence the rejection.

  Surfaced live in customer integration (FC Urban, Aug 2026) when the upstream
  notifications endpoint started 500'ing tenant-wide — their bell's `onClick` had no
  catch and the unhandled rejection crashed the page (the local UI had already rolled
  back, so only the `.catch()` was missing).

  No behavior change: the SDK has rejected after rollback since v0.1.0. This release
  documents the contract on each hook's JSDoc (`@throws`) and adds a dedicated README
  section so the next integrator finds it before shipping. A follow-up `onError` opt-in
  to silence the rejection by default is tracked in
  `docs/superpowers/specs/2026-08-02-optimistic-write-error-handling-design.md`.

## 0.3.0

### Minor Changes

- 7af804c: Customer-zero DX round: server SDK requests now default to a 10s timeout
  (`timeoutMs` option; a caller-supplied `signal` replaces it), and
  `feed().addActivity<TCustom>()`/`get<TCustom>()` gain the client's custom-data
  generics. React: `<DropInProvider enabled={false}>` puts every hook into an
  inert no-network mode (`enabled: false` on hook returns,
  `useDropInEnabled()`) so apps with optional feed config never crash in
  environments without keys.

  Type-level note: `useFeedActions().addActivity/deleteActivity` (and
  `useFeed().addActivity`) now resolve `T | undefined` — `undefined` only in
  disabled mode. Narrow with `if (result)` or gate on `useDropInEnabled()`.
  Server `addActivity` input is now the typed activity shape (was
  `Record<string, unknown>`) — arbitrary extra top-level keys become compile
  errors; move free-form data under `custom`.

## 0.2.0

### Minor Changes

- f367981: Live mode and follow suggestions.

  - **client:** `feed().head()` and `notifications().head()` change-signal reads;
    `feed().suggestions()` with the `Suggestion` type; API base URL now defaults to
    the hosted endpoint (GetStream-style — pass `baseUrl` to override); `AbortSignal`
    accepted on every method; typed webhook destination helpers.
  - **react:** `live: true` on `useFeed` and `useNotifications` — visibility-aware
    head-check polling that refetches only when the head id changes; new
    `useSuggestions` hook.
  - **server:** republished under the same minor for lockstep versioning; no API
    changes beyond shared metadata.

### Patch Changes

- Updated dependencies [f367981]
  - @dropinnodex/client@0.2.0

## 0.1.0

### Minor Changes

- Initial preview release. Hooks over `@dropinnodex/client`: `useFeed` (plus `useTimeline`,
  `useUserFeed`) with SSR `initialData`, a shared cache, keyset `loadNext`, and buffered
  `checkNew`/`showNew` polling; `useReactions` and `useReactionList`; `useFollow`,
  `useFollowing`, `useFollowers`, `useFollowStats`, `useSuggestions`; `useNotifications`;
  `useCurrentUser`; `useFeedActions`. Reaction, follow, and notification mutations are
  optimistic and roll back on error.

  Reads are cancelled on unmount (and when the feed being read changes) via `AbortSignal`.
  Writes are never cancelled — a like the user already committed to still lands.

  Pre-1.0: the surface may still change between minor versions.
