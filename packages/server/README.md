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
