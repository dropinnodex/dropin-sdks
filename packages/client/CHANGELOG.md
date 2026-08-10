# @dropinnodex/client

## 0.8.1

### Patch Changes

- ffcb951: A tenant with no writes yet now gets the revalidation skip too.

  `changed` was `null` until the tenant's first write, and the client treats `null` as
  unknown, so a brand-new or idle tenant revalidated on every 30s tick — denying the
  optimisation to exactly the tenants it helps most. A missing counter now reads as `0`,
  which is a definite "nothing has been mutated" and gates like any other value.

  `null` is now reserved for a counter that exists but does not parse. A Redis outage was
  never this case: the read rejects, the head route fails, and the client's head tick
  swallows it and retries — it never arrives as a value. The previous docs said otherwise
  and were wrong.

  Server-side only; no client code changed.

## 0.8.0

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

## 0.7.0

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

## 0.6.0

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

## 0.5.0

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

## 0.4.0

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

## 0.3.0

### Minor Changes

- dc22696: `feed().get()` now returns `FeedPage<TCustom>` — `Page<Activity>` plus an
  optional `promoted` array of promoted activities. Present only on an uncursored
  read; never inside `results`, and never affects `next`. Additive: the existing
  `results` / `next` shape is unchanged.

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

## 0.1.0

### Minor Changes

- Initial preview release. Isomorphic, zero-dependency client for feeds, activities,
  follows, follower/following lists, follow stats, follow suggestions, reactions,
  notifications, and `users.me`. Keyset pagination via `next`; token refetch-and-replay
  once on a 401; API errors surface as `DropInApiError` with a code and request id.
  Every method takes an optional trailing `RequestOptions` with an `AbortSignal`.

  Pre-1.0: the surface may still change between minor versions.
