# @dropinnodex/client

## 0.1.0

### Minor Changes

- Initial preview release. Isomorphic, zero-dependency client for feeds, activities,
  follows, follower/following lists, follow stats, follow suggestions, reactions,
  notifications, and `users.me`. Keyset pagination via `next`; token refetch-and-replay
  once on a 401; API errors surface as `DropInApiError` with a code and request id.
  Every method takes an optional trailing `RequestOptions` with an `AbortSignal`.

  Pre-1.0: the surface may still change between minor versions.
