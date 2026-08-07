# @dropinnodex/server

Server-side SDK for [dropin-activity](https://github.com/) — a GetStream-shaped activity
feed as a service. **Node only** (imports `node:crypto`; never ship it to a browser).

Your backend uses this to mint short-lived user tokens **offline** (zero network calls to
the feed service), upsert users, and manage webhook destinations.

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

// Users
await dropin.upsertUser({ id: 'user-123', custom: { name: 'Ada' } })
await dropin.revokeUserTokens('user-123')   // log this user out everywhere

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
```

`custom` is **required** on `upsert`/`batch.objects` — it replaces the object's
`custom` wholesale, so omitting it would wipe the object; the server rejects the
call instead. Every patch path (objects and activities) must start with
`custom.`; `unset` is applied after `set`.

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
