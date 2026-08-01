# @dropinnodex/react

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
