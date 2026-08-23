# @dropinnodex/testing

## 0.1.0

### Minor Changes

- 69b141e: First release: an in-memory dropin you hand to a real client as its transport.

  Test an integration with no network, no credentials, and no shared dev tenant to pollute.
  The design decision worth knowing is that it fakes the **transport**, not the client: you
  get a `fetch`, and `@dropinnodex/client` and `@dropinnodex/react` run above it untouched —
  token caching, the single-flight 401 refresh, retry-once, error parsing, cursor encoding.
  A fake implementing the client's interface would bypass exactly the code most worth
  exercising.

  ```ts
  const dropin = createTestDropin();
  const client = new DropInClient({
    apiKey: "test",
    url: "http://test.local",
    tokenProvider: async () => dropin.mintToken("user-1"),
    fetch: dropin.fetch,
  });
  ```

  Models fan-out along follow edges, `(foreign_id, time)` dedupe and its 409 burn, the
  user-token `time` clamp, actor overwrite with user provisioning, keyset paging, the objects
  sidecar with skip-not-hole resolution, per-caller `own_reactions`, and notification dedupe.

  Failure injection is the point rather than an extra — `expireTokens()`, `failNext()`, and
  `requests()`, because the bugs worth catching are the ones where everything _succeeded_,
  just N times instead of once.

  Kept honest by a contract suite: the same assertions run against this fake and against the
  real feed service, so drift fails CI rather than a tenant's assumptions. Not covered, and
  said plainly in the suite: fan-out timing (a queue in production, synchronous here) and
  token semantics (simulation for failure injection, not a claim about the gateway).
