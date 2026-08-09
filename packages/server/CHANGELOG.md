# @dropinnodex/server

## 0.10.0

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

## 0.9.0

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

## 0.8.0

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

## 0.7.1

### Patch Changes

- 2286486: Fix `feed().follow()` (and any other empty-body success) throwing
  `SyntaxError: Unexpected end of JSON input`.

  `POST /v1/feeds/:group/:id/follows` answers **201 with no body**, but the SDK only
  treated `204` as empty and called `res.json()` on everything else — which throws on an
  empty body. Every successful follow through the server SDK rejected. It now reads the
  body text once and parses only when there is something to parse, matching
  `@dropinnodex/client`, which already handled it this way.

  The unit tests missed it because the fetch mock returned `undefined` from `json()`
  instead of throwing, and defaulted `text()` to `''` while `json()` returned an object —
  something no real `Response` does. The mock now derives `text()` from the same payload.

## 0.7.0

### Minor Changes

- dc22696: Add the `promoted` namespace: `promoted.create/list/remove` for promoted
  activities — content served alongside a feed's first page regardless of the
  follow graph or recency, with follow-graph targeting (`audience`), scheduling
  (`starts_at` / `expires_at`), instant retraction, and a `served_count` delivery
  counter. Server-token only. `feed().get()` now returns `FeedPage`, so an
  SSR-prefetched page carries the `promoted` sidecar into `useFeed`'s
  `initialData`.

### Patch Changes

- Updated dependencies [dc22696]
  - @dropinnodex/client@0.3.0

## 0.6.0

### Minor Changes

- 3c728a5: Close the server SDK's route-coverage gaps, found by auditing every route against the
  methods the SDK actually exposes.

  - `feed().removeActivity(id)` — a server token may remove an activity from any feed
    (the origin-feed check applies to user tokens only), which is what moderation and
    "the underlying object was deleted in our database" cleanup need.
  - `feed().followers(q)` / `.following(q)` — paged `Page<Follow>`, mirroring the client.
  - `feed().suggestions(q)` — capped top-N, no cursor.
  - `reactions.list(activityId, q)` — paged, optional `kind` filter.
  - `notifications.list/markSeen/markRead({ owner, … })` — server tokens have no identity,
    so each call names the user it acts for. Enables push notifications and digest emails
    from a backend.

  Deliberately still absent: `reactions.add`. A reaction needs an acting user and a server
  token has none.

## 0.5.0

### Minor Changes

- f3b1a34: Add server-side follow writes: `feed(group, id).follow(targetGroup, targetId)` /
  `.unfollow(…)`, plus `userFollow({ follower, following })` / `userUnfollow(…)` sugar.

  The follow route already accepted a server token and notified the followed user, but the
  SDK exposed no method for it — the only reachable follow write was `batch.follows`, which
  is quiet by design. Backends mirroring live follows were pushed to either the quiet import
  path (no notification) or minting a user token as a workaround. Argument shape matches the
  client SDK's `follow(group, id)`.

  Also documents the quiet contract on each `batch.*` member's own jsdoc, so it shows on
  hover for `batch.userFollows` rather than only on the `batch` object.

## 0.4.0

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

## 0.3.0

### Minor Changes

- 78db1d9: Batch import API: `server.batch.users/follows/activities` — cold-start
  migration of existing users, follow graphs, and historical activities.
  `batch.userFollows([{ follower, following }])` covers the common
  user-follows-user case with plain ids, expanding the `timeline:` → `user:`
  feed convention for you.
  Server-token only, ≤100 items per call, per-item results, idempotent, and
  quiet (no notifications, live pings, or webhooks for imported history).

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

- Initial preview release. Node-only backend SDK: mints HS256 user and server tokens
  offline (no network call to dropin), upserts users, revokes a user's tokens, registers
  and lists webhook destinations, reads feeds with a server token, and deletes any user's
  reaction. Every method takes an optional trailing `RequestOptions` with an `AbortSignal`.

  Importing this package in a browser bundle fails on purpose — it would leak your
  `apiSecret`. Use `@dropinnodex/client` there.

  Pre-1.0: the surface may still change between minor versions.
