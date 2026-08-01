# @dropinnodex/server

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
