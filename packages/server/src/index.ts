// This import is deliberate: it makes a browser-targeted bundle of this package fail
// loudly rather than silently shipping your api_secret to a browser.
import { timingSafeEqual } from 'node:crypto'
import * as jose from 'jose'
// Type-only: @dropinnodex/client is zero-dep and isomorphic, so importing its types here does
// not pull anything into the runtime bundle (erased at compile time) and does not violate
// the dependency boundary — which forbids @dropinnodex/client and @dropinnodex/react depending on
// @dropinnodex/server, not the reverse. This is what makes `feed().get()` return a typed
// `Page<Activity<TCustom>>` instead of `unknown`, so SSR `initialData` flows typed end to end.
import type {
  Activity, DropInObject, FeedPage, Follow, FollowStats, Notification, NotificationPage, Page, PatchBody,
  PromotedActivity, Reaction, RequestOptions, Suggestion,
} from '@dropinnodex/client'

export type {
  RequestOptions, Follow, Notification, NotificationPage, PromotedActivity, Reaction, Suggestion,
  DropInObject, PatchBody,
}

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

/** What you send to promote something. */
export interface PromotedActivityInput<TCustom = Record<string, unknown>> {
  /** Free-form, and never overwritten: these routes are server-token only. e.g. "sponsor:nike". */
  actor: string
  verb: string
  object: string
  custom?: TCustom
  /**
   * Which feeds to target. Omit (or null) to reach EVERY user, including brand-new
   * ones whose feed is otherwise empty. Otherwise feed refs the reader must follow —
   * targeting is the follow graph, because we hold no user attributes. Max 20; a
   * reader matching ANY of them is eligible.
   */
  audience?: string[] | null
  /** ISO timestamp. Defaults to now; nothing is served before it. */
  starts_at?: string
  /** ISO timestamp, must be in the future. Null (or omitted) means "until you retract it". */
  expires_at?: string | null
}

/** A promoted activity as your backend sees it — the full row, including targeting and counters. */
export interface PromotedActivityRecord<TCustom = Record<string, unknown>> {
  id: string
  actor: string
  verb: string
  object: string
  custom: TCustom
  audience: string[] | null
  starts_at: string
  expires_at: string | null
  /**
   * Feed opens that received this row — DELIVERIES, not views. A reader who scrolls
   * past four copies in one session counts once, and whether it entered the viewport
   * is not observable server-side. For view-level numbers use the react SDK's
   * `onPromotedImpression` callback and send them to your own analytics.
   */
  served_count: number
  /** Set once retracted. Retracted rows stay listed here with their final count. */
  deleted_at: string | null
  created_at: string
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

/** Build a query string, dropping undefined params. Returns "" when nothing is set, so it
 *  is always safe to append to a path. */
function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

/**
 * `encodeURIComponent` leaves `.` untouched, so a segment of exactly `.` or `..` survives
 * encoding and is then removed by the URL parser inside fetch — before the request is
 * sent. A two-segment path like /v1/objects/{type}/{id} therefore lets `type: '..'`
 * cancel the literal `objects` segment and `id` name an arbitrary sibling route, carrying
 * this client's server token. Mirrors the inbound guard in the gateway (0042bac).
 */
function pathSegment(value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`invalid path segment ${JSON.stringify(value)}: a dot-segment would be removed by URL normalization inside fetch, silently retargeting the request`)
  }
  return encodeURIComponent(value)
}

const objectPath = (type: string, id: string): string =>
  `/v1/objects/${pathSegment(type)}/${pathSegment(id)}`

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
    // ANY empty success body → undefined, not just a 204: `POST …/follows` answers 201
    // with no content (docs/api/v1.yaml), and res.json() of an empty body throws
    // "Unexpected end of JSON input". Read the text once, parse only if there is any.
    // Mirrors @dropinnodex/client, which already handles it this way.
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
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
  async revokeUserTokens(userId: string, opts: RequestOptions = {}): Promise<void> {
    return this.call('POST', `/v1/users/${pathSegment(userId)}/revoke-tokens`, undefined, opts)
  }

  /** Outbound webhooks. Server-token only — this is where you register the endpoints feed
   *  events are delivered to. Storage, HMAC-SHA256 signing, and retries are handled for
   *  you; `create` returns the signing secret to verify deliveries with. */
  readonly webhooks = {
    create: (d: { url: string }, opts: RequestOptions = {}) =>
      this.call<WebhookDestination>('POST', '/v1/webhooks', d, opts),
    list: (opts: RequestOptions = {}) => this.call<WebhookDestination[]>('GET', '/v1/webhooks', undefined, opts),
    remove: async (id: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/webhooks/${pathSegment(id)}`, undefined, opts),
  }

  /**
   * Promoted activities: content that stays visible regardless of the follow graph
   * and recency — an under-filled event, an announcement, a sponsor post, a member
   * spotlight. Server-token only; creating one is a backend operation, usually
   * automated.
   *
   * Nothing is fanned out. One row serves every eligible reader, which is why
   * retracting or expiring is instant and costs nothing.
   *
   * **Targeting is the follow graph.** We store no user attributes, so an audience is
   * expressed as feeds. Create a feed like `city:belgrade`, follow your users into it
   * from your backend, then target it:
   *
   * ```ts
   * await dropin.batch.follows([{ source: 'timeline:alice', target: 'city:belgrade' }])
   * await dropin.promoted.create({
   *   actor: 'system:fcurban',
   *   verb: 'promote',
   *   object: 'game:8842',
   *   custom: { text: 'Thursday 20:00 — 6 spots left' },
   *   audience: ['city:belgrade'],
   *   expires_at: kickoffIso,          // stops serving itself; no cleanup
   * })
   * ```
   *
   * Eligible rows arrive in the `promoted` array of a feed read's FIRST page (never
   * inside `results`, never affecting the cursor). That array is the eligible SET, not
   * a slot assignment — the client caches it and decides placement.
   *
   * This is promoted content, not an ad platform: no bidding, no demographic
   * targeting, no viewability tracking. The label your users see ("Sponsored",
   * "Featured") — and any disclosure obligation that comes with paid placement — is
   * yours to render.
   */
  readonly promoted = {
    /** Promote something. Throws CONFLICT past 100 live rows (an abuse guard, not a plan limit). */
    create: <TCustom = Record<string, unknown>>(
      input: PromotedActivityInput<TCustom>,
      opts: RequestOptions = {},
    ) => this.call<PromotedActivityRecord<TCustom>>('POST', '/v1/promoted', input, opts),
    /** Your inventory, newest first — retracted rows included, each with its `served_count`. */
    list: <TCustom = Record<string, unknown>>(
      q: { limit?: number; next?: string } = {},
      opts: RequestOptions = {},
    ) => this.call<Page<PromotedActivityRecord<TCustom>>>(
      'GET', `/v1/promoted${qs({ limit: q.limit, next: q.next })}`, undefined, opts,
    ),
    /** Stop serving it. Takes effect on the next feed read; retracting twice is NOT_FOUND. */
    remove: async (id: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/promoted/${pathSegment(id)}`, undefined, opts),
  }

  /**
   * Objects: data many activities share. Update one row and every timeline carrying a ref
   * to it is fresh on the next read — no re-fan-out, regardless of how many activities
   * point at it. Server-token only, because one object is shared by many activities.
   *
   * @example
   * await dropin.objects.upsert('session', '1234', { spots_left: 2 })
   * // every activity with refs: ['session:1234'] now renders 2
   */
  readonly objects = {
    /** Replaces `custom` wholesale, creating the object if absent. */
    upsert: async <TCustom = Record<string, unknown>>(
      type: string, id: string, custom: TCustom, opts: RequestOptions = {},
    ) => this.call<DropInObject<TCustom>>('PUT', objectPath(type, id), { custom }, opts),

    /** Merges into `custom`. The object must exist — use `upsert` to create. */
    patch: async <TCustom = Record<string, unknown>>(
      type: string, id: string, body: PatchBody, opts: RequestOptions = {},
    ) => this.call<DropInObject<TCustom>>('PATCH', objectPath(type, id), body, opts),

    get: async <TCustom = Record<string, unknown>>(type: string, id: string, opts: RequestOptions = {}) =>
      this.call<DropInObject<TCustom>>('GET', objectPath(type, id), undefined, opts),

    /**
     * Read up to 100 objects in ONE request, keyed `type:id`. Mirrors
     * `@dropinnodex/client`'s `objects.getMany` — the same route, so a server-side
     * revalidation (a cache warm, a webhook handler checking what moved) costs one
     * request rather than one per object.
     *
     * Refs with no stored object are absent from the map rather than an error, matching
     * the feed-read `objects` sidecar. An empty list costs zero requests.
     *
     * @example
     * const fresh = await dropin.objects.getMany(['session:1234', 'session:5678'])
     * fresh['session:1234']?.custom.spots_left
     */
    getMany: async <TCustom = Record<string, unknown>>(
      refs: string[], opts: RequestOptions = {},
    ): Promise<Record<string, DropInObject<TCustom>>> => {
      if (refs.length === 0) return {}
      // Repeated `refs=` rather than one comma-joined value: a ref is `type:id`, which
      // constrains colons but not commas, so joining would shred an id containing one.
      const search = new URLSearchParams()
      for (const ref of refs) search.append('refs', ref)
      return this.call<Record<string, DropInObject<TCustom>>>(
        'GET', `/v1/objects?${search.toString()}`, undefined, opts,
      )
    },

    remove: async (type: string, id: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', objectPath(type, id), undefined, opts),
  }

  /**
   * Activity-level edits. Use this to fix ONE activity's own body — a typo, a corrected
   * caption. For data shared across many activities, use `objects` instead: patching each
   * activity is N writes where an object update is one.
   *
   * `body.refs` (optional, top-level — not a `custom.` path) replaces the activity's
   * refs array wholesale, including `refs: []` to clear it. This is the backfill path
   * for an activity written before objects existed: it can adopt refs after the fact
   * without the delete-and-repost that would otherwise burn its `foreign_id` and
   * re-fan-out to every follower.
   *
   * @example
   * await dropin.activities.patch('a1', { refs: ['session:1234'] })
   */
  readonly activities = {
    patch: async <TCustom = Record<string, unknown>>(
      activityId: string, body: PatchBody, opts: RequestOptions = {},
    ) => this.call<Activity<TCustom>>(
      'PATCH', `/v1/activities/${pathSegment(activityId)}`, body, opts,
    ),
  }

  /** Cold-start import (server-token only, ≤100 items/call, quiet — no notifications,
   *  live pings, or webhooks fire for imported history; see the "Migrating existing
   *  data" guide). Per-item results: partial failure is still a 200, so check each
   *  `results[i].ok`. Rerunning a batch is safe when activities carry `foreign_id` +
   *  `time`. */
  readonly batch = {
    /** QUIET: imported users are created without any side effect. */
    users: (users: Array<{ id: string; custom?: Record<string, unknown> }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/users', { users }, opts),
    /** QUIET: the edges are created but the followed feeds get NO notification and no
     *  `follow.added` webhook. For a follow that just happened in your app, use
     *  {@link DropInServer.userFollow} / `feed().follow()` instead. */
    follows: (follows: Array<{ source: string; target: string }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/follows', { follows }, opts),
    /** The 95% case, without feed-ref plumbing: "alice follows bob" expands to
     *  `{ source: 'timeline:alice', target: 'user:bob' }` — alice's home feed pulls
     *  from bob's wall. Use `follows` directly for non-user feed graphs.
     *
     *  QUIET: bob is NOT notified that alice followed him, and no `follow.added` webhook
     *  fires. That is right for backfilling an existing social graph and wrong for
     *  mirroring a follow a user just made — use {@link DropInServer.userFollow} for that. */
    userFollows: (pairs: Array<{ follower: string; following: string }>, opts: RequestOptions = {}) =>
      this.call<BatchResponse>('POST', '/v1/batch/follows', {
        follows: pairs.map((p) => ({ source: `timeline:${p.follower}`, target: `user:${p.following}` })),
      }, opts),
    /** QUIET: imported activities land in feeds but fire no notifications, live pings,
     *  or `activity.added` webhooks. */
    activities: (
      activities: Array<{ feed: string; activity: Record<string, unknown> }>,
      opts: RequestOptions = {},
    ) => this.call<BatchResponse>('POST', '/v1/batch/activities', { activities }, opts),
    /** Bulk upsert objects. Idempotent — safe to re-run. Check `results[i].ok`. */
    objects: (
      objects: { type: string; id: string; custom: Record<string, unknown> }[],
      opts: RequestOptions = {},
    ) => this.call<BatchResponse>('POST', '/v1/batch/objects', { objects }, opts),
  }

  /** Admin reaction ops (server token deletes any user's reaction). Adding a reaction is
   *  deliberately absent: a reaction needs an acting user, and a server token has no
   *  identity — mint a user token for that. */
  readonly reactions = {
    delete: async (reactionId: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/reactions/${pathSegment(reactionId)}`, undefined, opts),
    /** A page of reactions on an activity, newest first. `kind` filters server-side. */
    list: async (
      activityId: string,
      q: { kind?: string; limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
      opts: RequestOptions = {},
    ) =>
      this.call<Page<Reaction>>(
        'GET',
        `/v1/activities/${pathSegment(activityId)}/reactions${qs({
          kind: q.kind, limit: q.limit, next: q.next ?? q.cursor,
        })}`,
        undefined, opts,
      ),
  }

  /** Read and mark a user's notifications from your backend — for sending push
   *  notifications or emails, or building an admin view. A server token has no identity,
   *  so every call names the `owner` it acts for; omitting it is `FORBIDDEN`, never a
   *  cross-user leak. */
  readonly notifications = {
    list: (
      q: { owner: string; limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string },
      opts: RequestOptions = {},
    ) =>
      this.call<NotificationPage>(
        'GET',
        `/v1/notifications${qs({ owner: q.owner, limit: q.limit, next: q.next ?? q.cursor })}`,
        undefined, opts,
      ),
    /** Mark specific notifications seen, or ALL of the owner's when `ids` is omitted or empty. */
    markSeen: (q: { owner: string; ids?: string[] }, opts: RequestOptions = {}) =>
      this.call<void>('POST', '/v1/notifications/mark',
        { owner: q.owner, seen: q.ids?.length ? q.ids : true }, opts),
    /** Mark specific notifications read, or ALL of the owner's when `ids` is omitted or empty. */
    markRead: (q: { owner: string; ids?: string[] }, opts: RequestOptions = {}) =>
      this.call<void>('POST', '/v1/notifications/mark',
        { owner: q.owner, read: q.ids?.length ? q.ids : true }, opts),
  }

  feed(group: string, id: string) {
    // Deliberately NOT computed eagerly: this method is a plain object-returning function
    // (not async, for fluent chaining), so a synchronous pathSegment() throw here would
    // crash the caller synchronously instead of producing a rejected Promise — the one
    // guarded call site that broke the "every SDK error is a rejection" contract every
    // other guarded method upholds by being `async`. Computing the path lazily, inside
    // each `async` method below, means the throw happens inside an async function body
    // and is converted into a rejection like every other one.
    const path = () => `/v1/feeds/${pathSegment(group)}/${pathSegment(id)}`
    return {
      addActivity: async <TCustom = Record<string, unknown>>(a: {
        /** Server tokens set the actor explicitly (e.g. "user:alice"); user tokens
         *  have it overwritten by the gateway (spec §5). */
        actor?: string
        verb: string; object: string; target?: string | null
        foreign_id?: string | null; time?: string; custom?: TCustom
        /** Objects this activity points at, as `type:id`. Max 4. Resolved into the
         *  feed read's `objects` sidecar — see `dropin.objects`. */
        refs?: string[]
      }, opts: RequestOptions = {}) => this.call<Activity<TCustom>>('POST', `${path()}/activities`, a, opts),
      get: async <TCustom = Record<string, unknown>>(
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        // FeedPage, not Page: a server-rendered first page carries the `promoted`
        // sidecar too, and passing it into useFeed's initialData must not drop it.
        this.call<FeedPage<TCustom>>(
          'GET', `${path()}${qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts,
        ),
      followStats: async (opts: RequestOptions = {}) =>
        this.call<FollowStats>('GET', `${path()}/stats`, undefined, opts),
      /** Create a follow edge, LOUD: a `user:` target gets a follow notification and a
       *  `follow.added` webhook fires. This is the call for a follow that just happened in
       *  your app — `batch.follows` is the quiet import path and notifies nobody.
       *
       *  Idempotent: re-following an existing edge writes nothing and notifies nobody, so
       *  an at-least-once trigger can safely deliver twice. */
      follow: async (targetGroup: string, targetId: string, opts: RequestOptions = {}) =>
        this.call<void>('POST', `${path()}/follows`, { target: `${targetGroup}:${targetId}` }, opts),
      /** Remove a follow edge. Same argument shape as `follow`. */
      unfollow: async (targetGroup: string, targetId: string, opts: RequestOptions = {}) =>
        this.call<void>(
          'DELETE',
          `${path()}/follows/${pathSegment(targetGroup)}/${pathSegment(targetId)}`,
          undefined, opts,
        ),
      /** Who follows this feed, newest edge first. */
      followers: async (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>(
          'GET', `${path()}/followers${qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts,
        ),
      /** Who this feed follows, newest edge first. */
      following: async (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>(
          'GET', `${path()}/follows${qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts,
        ),
      /** Who this feed should follow — friends-of-friends by mutual overlap, topped up by
       *  popularity. A capped top-N, so there is no cursor. */
      suggestions: async (q: { limit?: number } = {}, opts: RequestOptions = {}) =>
        this.call<{ results: Suggestion[] }>(
          'GET', `${path()}/suggestions${qs({ limit: q.limit })}`, undefined, opts,
        ),
      /** Soft-delete an activity. A server token may remove an activity from ANY feed —
       *  the origin-feed authority check applies to user tokens only — which is what makes
       *  this usable for moderation and for cleaning up content deleted in your own app. */
      removeActivity: async (activityId: string, opts: RequestOptions = {}) =>
        this.call<void>('DELETE', `/v1/activities/${pathSegment(activityId)}`, undefined, opts),
    }
  }

  /** "alice follows bob", LOUD — the notifying counterpart of `batch.userFollows`, for a
   *  follow that just happened rather than one being imported. Expands to
   *  `timeline:alice → user:bob`; bob is notified and `follow.added` fires. */
  userFollow(pair: { follower: string; following: string }, opts: RequestOptions = {}): Promise<void> {
    return this.feed('timeline', pair.follower).follow('user', pair.following, opts)
  }

  /** The inverse of {@link DropInServer.userFollow}. */
  userUnfollow(pair: { follower: string; following: string }, opts: RequestOptions = {}): Promise<void> {
    return this.feed('timeline', pair.follower).unfollow('user', pair.following, opts)
  }
}
