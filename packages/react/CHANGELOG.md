# @dropinnodex/react

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
