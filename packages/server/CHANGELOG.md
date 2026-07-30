# @dropinnodex/server

## 0.1.0

### Minor Changes

- Initial preview release. Node-only backend SDK: mints HS256 user and server tokens
  offline (no network call to dropin), upserts users, revokes a user's tokens, registers
  and lists webhook destinations, reads feeds with a server token, and deletes any user's
  reaction. Every method takes an optional trailing `RequestOptions` with an `AbortSignal`.

  Importing this package in a browser bundle fails on purpose — it would leak your
  `apiSecret`. Use `@dropinnodex/client` there.

  Pre-1.0: the surface may still change between minor versions.
