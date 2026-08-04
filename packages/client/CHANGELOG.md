# @dropinnodex/client

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
