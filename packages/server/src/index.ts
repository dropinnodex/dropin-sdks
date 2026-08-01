// This import is deliberate: it makes a browser-targeted bundle of this package fail
// loudly rather than silently shipping your api_secret to a browser.
import { timingSafeEqual } from 'node:crypto'
import * as jose from 'jose'
// Type-only: @dropinnodex/client is zero-dep and isomorphic, so importing its types here does
// not pull anything into the runtime bundle (erased at compile time) and does not violate
// the dependency boundary — which forbids @dropinnodex/client and @dropinnodex/react depending on
// @dropinnodex/server, not the reverse. This is what makes `feed().get()` return a typed
// `Page<Activity<TCustom>>` instead of `unknown`, so SSR `initialData` flows typed end to end.
import type { Activity, FollowStats, Page, RequestOptions } from '@dropinnodex/client'

export type { RequestOptions }

/**
 * A webhook destination. The delivery infrastructure owns storage and the full response
 * shape, so the fields this SDK itself sets or reads are typed and the index signature
 * keeps everything else reachable — rather than inventing a closed contract the SDK does
 * not control.
 */
export interface WebhookDestination {
  /** Pass this to `webhooks.remove()`. */
  id: string
  /** Always "webhook" for destinations created through this SDK. */
  type?: string
  /** `["*"]` — every event topic. */
  topics?: string[]
  config?: { url?: string } & Record<string, unknown>
  /** The HMAC-SHA256 signing secret. Returned by `create`; verify deliveries with it. */
  credentials?: Record<string, unknown>
  created_at?: string
  disabled_at?: string | null
  [key: string]: unknown
}

/**
 * The outcome of one item in a batch import. `index` is the item's position in the
 * request array; on failure `code` is the stable error code (e.g. "INVALID_ARGUMENT"),
 * never a message — collect the failed indexes and retry just those.
 */
export type BatchResultItem =
  | { index: number; ok: true; id?: string }
  | { index: number; ok: false; code: string }

/** Per-item results of a batch import call. Partial failure is still a 200 — check each item. */
export interface BatchResponse {
  results: BatchResultItem[]
}

const MAX_TTL_SECONDS = 86_400

/** The hosted API. Overridden via `url` for staging, a proxy, or local development. */
export const DEFAULT_API_URL = 'https://api.getnodex.cloud'

export interface DropInServerOptions {
  /** Your tenant id, e.g. "acme". Signed as the token's `aud` claim and verified on every request. */
  tenantId: string
  /** Public. Sent as X-Api-Key so the gateway can resolve the tenant. */
  apiKey: string
  /** Never leaves your server. */
  apiSecret: string
  /**
   * Base URL of the dropin API. Defaults to `https://api.getnodex.cloud`; set it to point
   * at staging, a proxy, or a local server — e.g. `http://localhost:3000`. No trailing slash.
   */
  url?: string | undefined
  /** Upper bound for every request this SDK makes, in ms. Default 10_000. A hung
   *  feed API must never stall YOUR request path (a Cloud Functions callable
   *  awaiting this SDK would otherwise ride to the platform's own timeout).
   *  Passing `signal` in RequestOptions replaces this bound entirely. */
  timeoutMs?: number
}

export interface TokenOptions {
  /** e.g. "1h", "15m", "30s". Default "1h". */
  expiresIn?: string
}

function parseDuration(spec: string): number {
  const m = /^(\d+)([smhd])$/.exec(spec)
  if (!m) throw new Error(`invalid expiresIn: ${spec}`)
  const n = Number(m[1])
  const unit = m[2] as 's' | 'm' | 'h' | 'd'
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[unit]
}

type FetchFn = typeof fetch

export class DropInServer {
  private readonly key: Uint8Array

  constructor(private readonly opts: DropInServerOptions, private readonly fetchFn?: FetchFn) {
    if (!opts.apiSecret) throw new Error('apiSecret is required')
    if (!opts.apiKey) throw new Error('apiKey is required')
    if (!opts.tenantId) throw new Error('tenantId is required')
    this.key = new TextEncoder().encode(opts.apiSecret)
    void timingSafeEqual // keep the node:crypto import load-bearing
  }

  private async sign(claims: Record<string, unknown>, opts: TokenOptions): Promise<string> {
    const ttl = parseDuration(opts.expiresIn ?? '1h')
    if (ttl > MAX_TTL_SECONDS) {
      // Fail here rather than minting a token that will be rejected on first use.
      throw new Error(`expiresIn exceeds the 24h (86400s) ceiling: ${ttl}s`)
    }
    const iat = Math.floor(Date.now() / 1000)
    return new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('dropin')
      // The TENANT ID, not the api key — this is what the audience is verified against.
      .setAudience(this.opts.tenantId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.key)
  }

  /** Local HMAC. Zero network calls — tokens are minted entirely on your server. */
  createUserToken(userId: string, opts: TokenOptions = {}): Promise<string> {
    return this.sign({ sub: userId, user_id: userId }, opts)
  }

  createServerToken(opts: TokenOptions = {}): Promise<string> {
    return this.sign({}, opts)
  }

  private async call<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const { signal } = opts
    // Bail before signing a token for a call the caller has already given up on.
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    // Caller-supplied signal replaces the default bound entirely — whoever owns
    // cancellation owns it fully (spec §2, dx-round3).
    const effectiveSignal = signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
    const token = await this.createServerToken()
    // Fall back to the global fetch at call time (not construction) so tests that swap
    // globalThis.fetch after building the client still take effect.
    const doFetch = this.fetchFn ?? fetch
    const res = await doFetch(`${this.opts.url ?? DEFAULT_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': this.opts.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: effectiveSignal,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`dropin ${method} ${path} failed: ${res.status} ${text}`)
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
  }

  upsertUser(
    user: { id: string; custom?: Record<string, unknown> },
    opts: RequestOptions = {},
  ): Promise<{ id: string; custom: Record<string, unknown> }> {
    return this.call('POST', '/v1/users', { id: user.id, custom: user.custom ?? {} }, opts)
  }

  /** Invalidates all of a user's existing tokens immediately. The revocation is recorded
   *  server-side and enforced from the next request onward, so tokens already handed to a
   *  browser stop working without waiting for them to expire. */
  revokeUserTokens(userId: string, opts: RequestOptions = {}): Promise<void> {
    return this.call('POST', `/v1/users/${encodeURIComponent(userId)}/revoke-tokens`, undefined, opts)
  }

  /** Outbound webhooks. Server-token only — this is where you register the endpoints feed
   *  events are delivered to. Storage, HMAC-SHA256 signing, and retries are handled for
   *  you; `create` returns the signing secret to verify deliveries with. */
  readonly webhooks = {
    create: (d: { url: string }, opts: RequestOptions = {}) =>
      this.call<WebhookDestination>('POST', '/v1/webhooks', d, opts),
    list: (opts: RequestOptions = {}) => this.call<WebhookDestination[]>('GET', '/v1/webhooks', undefined, opts),
    remove: (id: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/webhooks/${encodeURIComponent(id)}`, undefined, opts),
  }

  /** Cold-start import (server-token only, ≤100 items/call, quiet — no notifications,
   *  live pings, or webhooks fire for imported history; see the "Migrating existing
   *  data" guide). Per-item results: partial failure is still a 200, so check each
   *  `results[i].ok`. Rerunning a batch is safe when activities carry `foreign_id` +
   *  `time`. */
  readonly batch = {
    users: (users: Array<{ id: string; custom?: Record<string, unknown> }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/users', { users }, opts),
    follows: (follows: Array<{ source: string; target: string }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/follows', { follows }, opts),
    /** The 95% case, without feed-ref plumbing: "alice follows bob" expands to
     *  `{ source: 'timeline:alice', target: 'user:bob' }` — alice's home feed pulls
     *  from bob's wall. Use `follows` directly for non-user feed graphs. */
    userFollows: (pairs: Array<{ follower: string; following: string }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/follows', {
        follows: pairs.map((p) => ({ source: `timeline:${p.follower}`, target: `user:${p.following}` })),
      }, opts),
    activities: (
      activities: Array<{ feed: string; activity: Record<string, unknown> }>,
      opts: RequestOptions = {},
    ) => this.call<BatchResponse>('POST', '/v1/batch/activities', { activities }, opts),
  }

  /** Admin reaction ops (server token deletes any user's reaction). */
  readonly reactions = {
    delete: (reactionId: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/reactions/${encodeURIComponent(reactionId)}`, undefined, opts),
  }

  feed(group: string, id: string) {
    const base = `/v1/feeds/${encodeURIComponent(group)}/${encodeURIComponent(id)}`
    return {
      addActivity: <TCustom = Record<string, unknown>>(a: {
        /** Server tokens set the actor explicitly (e.g. "user:alice"); user tokens
         *  have it overwritten by the gateway (spec §5). */
        actor?: string
        verb: string; object: string; target?: string | null
        foreign_id?: string | null; time?: string; custom?: TCustom
      }, opts: RequestOptions = {}) => this.call<Activity<TCustom>>('POST', `${base}/activities`, a, opts),
      get: <TCustom = Record<string, unknown>>(
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) => {
        const params = new URLSearchParams()
        if (q.limit !== undefined) params.set('limit', String(q.limit))
        const token = q.next ?? q.cursor
        if (token !== undefined) params.set('next', token)
        const qs = params.toString()
        return this.call<Page<Activity<TCustom>>>('GET', qs ? `${base}?${qs}` : base, undefined, opts)
      },
      followStats: (opts: RequestOptions = {}) =>
        this.call<FollowStats>('GET', `${base}/stats`, undefined, opts),
    }
  }
}
