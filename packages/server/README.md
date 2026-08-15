# @dropinnodex/server

Server-side SDK for [dropin-activity](https://github.com/) — a GetStream-shaped activity
feed as a service. **Node only** (imports `node:crypto`; never ship it to a browser).

Your backend uses this to mint short-lived user tokens **offline** (zero network calls to
the feed service), post activities, upsert users, and manage webhook destinations.

Posting from the backend is a first-class path, not a fallback: activities emitted from a
database trigger or a job queue never touch a browser, and a server token can set `actor`
and post historical `time` values a user token cannot.

```bash
npm i @dropinnodex/server
```

## Usage

```ts
import { DropInServer } from '@dropinnodex/server'

const dropin = new DropInServer({
  tenantId: 'acme',
  apiKey: process.env.DROPIN_API_KEY!,       // public
  apiSecret: process.env.DROPIN_API_SECRET!, // never leaves your server
})

// Mint a token for your frontend (HS256, signed with your apiSecret). Zero calls to us.
const token = await dropin.createUserToken('user-123', { expiresIn: '1h' })

// Users — do this BEFORE posting as an actor, or their cards render with no name.
await dropin.upsertUser({ id: 'user-123', custom: { name: 'Ada', image: 'https://…' } })
await dropin.revokeUserTokens('user-123')   // log this user out everywhere

// Activities, straight from your backend
const activity = await dropin.feed('user', 'user-123').addActivity({
  verb: 'workout',
  object: 'workout:1234',
  foreign_id: 'workout:1234',              // with `time`, makes a retry idempotent
  time: new Date().toISOString(),
  custom: { sport: 'run', durationMin: 45 },
})
activity.warnings // ['actor_user_unresolved'] if that actor was never upserted

// Outbound webhooks (server-token only)
await dropin.webhooks.create({ url: 'https://acme.com/dropin-hooks' })
await dropin.webhooks.list()
await dropin.webhooks.remove(destinationId)
```

`apiSecret` is the HMAC signing key — keep it server-side. Tokens carry `aud = tenantId`
and are capped at a 24h TTL.

`url` defaults to `https://api.getnodex.cloud`. Override it for staging, a proxy, or local
development — `url: 'http://localhost:3000'`. No trailing slash.

`webhooks.create`/`list` return a `WebhookDestination`: `id` (pass it to `remove`),
`config.url`, and `credentials` (the HMAC-SHA256 signing secret to verify deliveries
with). Delivery infrastructure owns the rest of the shape, so extra fields stay readable
rather than being typed away.

## Keeping feed data fresh: objects and activity patches

Two ways to update feed data after it's posted — see the [Keeping feed data
fresh](https://docs.getnodex.cloud/guides/keeping-feed-data-fresh/) guide for the
full rule (`custom` if it's true forever, an object if it changes) and why
delete-and-repost is the wrong tool.

```ts
// Objects: data many activities can point at. One write refreshes every
// timeline holding a ref — no re-fan-out.
await dropin.objects.upsert('session', '1234', { spots_left: 12 }) // replace, creates if absent
await dropin.objects.patch('session', '1234', { set: { 'custom.spots_left': 11 } }) // merge, 404s if absent
await dropin.objects.get('session', '1234')
await dropin.objects.remove('session', '1234')
await dropin.batch.objects([{ type: 'session', id: '5678', custom: { spots_left: 4 } }])

// Point an activity at an object with `refs` (max 4, `type:id`):
await dropin.feed('user', 'alice').addActivity({
  verb: 'post', object: 'session:1234',
  custom: { title: 'Thursday 5-a-side' },
  refs: ['session:1234'],
})

// Patch ONE activity's own `custom` — a typo, a corrected caption.
await dropin.activities.patch(activityId, { set: { 'custom.text': 'Corrected caption' } })

// refs is patchable too — the backfill path for an activity posted before objects
// existed. It's a top-level field (not `custom.`-dotted) and replaces wholesale;
// `refs: []` clears every ref. Activity patch only — objects ignore it.
await dropin.activities.patch(activityId, { refs: ['session:1234'] })
```

`custom` is **required** on `upsert`/`batch.objects` — it replaces the object's
`custom` wholesale, so omitting it would wipe the object; the server rejects the
call instead. Every `set`/`unset` path (objects and activities) must start with
`custom.`; `unset` is applied after `set`.

## Errors

Every failed request rejects with a `DropInApiError` — the same class
`@dropinnodex/client` throws, so one `catch` covers both SDKs:

```ts
import { DropInServer, DropInApiError } from '@dropinnodex/server'

try {
  await dropin.feed('user', 'user-123').addActivity({ verb: 'post', object: 'w:1' })
} catch (err) {
  if (!(err instanceof DropInApiError)) throw err   // network failure or abort

  err.code               // 'RATE_LIMITED' | 'VALIDATION_FAILED' | … — branch on this
  err.status             // 429
  err.requestId          // log it; it identifies the request in support
  err.retryAfterSeconds  // set on a 429, undefined otherwise
  err.fields             // [{ path, message }] on a VALIDATION_FAILED with detail
  err.url                // which request failed — worth logging from a multi-route job
}
```

`RATE_LIMITED` and `INTERNAL` are the retryable codes; everything else will fail
identically on a replay. Full table: [Errors](https://docs.getnodex.cloud/concepts/errors/).

## Cancellation

Every method takes an optional `RequestOptions` as its **last** argument, for cancelling a
request you no longer need (a superseded SSR render, a closed connection):

```ts
const ctrl = new AbortController()
const p = dropin.feed('timeline', 'user-123').get({ limit: 20 }, { signal: ctrl.signal })
ctrl.abort()
```

An aborted call rejects with what `fetch` throws (`name === 'AbortError'`), or the
`reason` you passed to `abort()`. Aborting before the request goes out also skips signing
a token. Token minting itself is local and synchronous — there is nothing there to cancel.

## License

MIT
