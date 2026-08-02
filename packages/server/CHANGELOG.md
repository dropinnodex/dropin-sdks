# @dropinnodex/server

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
