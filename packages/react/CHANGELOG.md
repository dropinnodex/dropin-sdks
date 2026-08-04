# @dropinnodex/react

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
