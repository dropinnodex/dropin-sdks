export type ErrorCode =
  | 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'FORBIDDEN'
  | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL'

export interface Activity<TCustom = Record<string, unknown>> {
  id: string
  actor: string
  verb: string
  object: string
  target: string | null
  foreign_id: string | null
  time: string
  custom: TCustom
  origin_feed: string
  reaction_counts: Record<string, number>
  actor_user: { id: string; custom: Record<string, unknown> } | null
  own_reactions?: string[]
  /** Objects this activity points at, as `type:id`. Look them up in `FeedPage.objects`. */
  refs: string[]
  /** Null until the activity has been patched. */
  edited_at: string | null
  /**
   * Row version. Starts at 1 and increments on ANY change to this activity — a patch, a
   * reaction count moving, a soft delete. This is the field to compare when deciding
   * whether a copy you hold is stale; `edited_at` marks patches only, so it misses the
   * field that changes most.
   */
  version: number
}

/** Tenant-owned mutable data an activity points at, resolved into `FeedPage.objects`. */
export interface DropInObject<TCustom = Record<string, unknown>> {
  type: string
  id: string
  custom: TCustom
  updated_at: string
}

/**
 * A patch-style update. Every `set`/`unset` path starts with `custom.`; `unset`
 * applies after `set`. At least one of `set`/`unset`/`refs` must be present.
 */
export interface PatchBody {
  set?: Record<string, unknown>
  unset?: string[]
  /**
   * `feed(group, id).updateActivity()` only — ignored by `objects.patch()`, since
   * objects have no `refs` of their own. Replaces the activity's `refs` array
   * wholesale (not merged): each entry is `type:id`, max 4, no duplicates. `[]`
   * clears every ref. This is how an activity posted before objects existed adopts
   * them, without the delete-and-repost this feature exists to avoid.
   */
  refs?: string[]
}

export interface Page<T> {
  results: T[]
  next: string | null
}

/**
 * A promoted activity — content the app wants seen regardless of who you follow or
 * how recent it is. Activity-shaped so it renders through the same component, but it
 * is not an activity: no `time`, no reactions, and it was never fanned out to a feed.
 */
export interface PromotedActivity<TCustom = Record<string, unknown>> {
  id: string
  actor: string
  verb: string
  object: string
  custom: TCustom
  /** Always true. Branch on it if you merge promoted rows into a list of activities. */
  promoted: true
}

/**
 * A page of a feed, plus the promoted sidecar.
 *
 * `promoted` is present ONLY on the first page (a request with no `next`) — absent,
 * not empty, on every page after it, so you can tell "we didn't ask" from "nothing
 * eligible". It is never inside `results` and never affects `next`: the cursor is a
 * position in the real feed.
 *
 * Treat it as the eligible SET rather than a slot assignment — cache it and place
 * those rows as often as you like while paging. `@dropinnodex/react` does this for
 * you via `promotedPosition` / `promotedRepeatEvery`.
 */
export interface FeedPage<TCustom = Record<string, unknown>> extends Page<Activity<TCustom>> {
  promoted?: PromotedActivity<TCustom>[]
  /**
   * Refs on this page, resolved, keyed by `type:id`. Absent when no activity on the page
   * carries a ref; a ref with no stored object is simply missing from the map, so always
   * fall back to the activity's own `custom`.
   */
  objects?: Record<string, DropInObject<TCustom>>
}

export interface Follow {
  source_group: string
  source_id: string
  target_group: string
  target_id: string
  created_at: string
}

export interface FollowStats {
  follower_count: number
  following_count: number
}

export interface Suggestion {
  /** Always "user" in v1 — only people are suggested. */
  group: string
  id: string
  /** Feeds the caller follows that also follow this one (friends-of-friends overlap).
   *  0 for a popularity-fill suggestion. */
  mutuals: number
}

export interface Notification {
  id: string
  verb: string
  actor: string
  object: string
  reaction_kind: string | null
  created_at: string
  seen_at: string | null
  read_at: string | null
  actor_user: { id: string; custom: Record<string, unknown> } | null
}

export interface Reaction {
  id: string
  kind: string
  activity_id: string
  user_id: string
  custom: Record<string, unknown>
  created_at: string
}

export interface NotificationPage {
  results: Notification[]
  unseen: number
  unread: number
  next: string | null
}

export class DropInApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string,
  ) {
    super(message)
    this.name = 'DropInApiError'
  }
}

/** The hosted API. Overridden via `url` for staging, a proxy, or local development. */
export const DEFAULT_API_URL = 'https://api.getnodex.cloud'

export interface DropInClientOptions {
  apiKey: string
  /**
   * Base URL of the dropin API. Defaults to `https://api.getnodex.cloud`; set it to point
   * at staging, a proxy, or a local server — e.g. `http://localhost:3000`. No trailing slash.
   */
  url?: string | undefined
  /** Called on init and again on a 401 — the same contract GetStream's SDK uses. */
  tokenProvider: () => Promise<string>
}

/**
 * Per-call options, accepted as the LAST argument of every method.
 *
 * `signal` is deliberately not folded into the query objects (`{ limit, next }`): those
 * describe the request the server sees, this describes the caller's lifetime.
 */
export interface RequestOptions {
  /**
   * Standard cancellation. Aborting rejects the call with whatever `fetch` throws — a
   * `DOMException` with `name === 'AbortError'`, or the signal's own `reason` — NOT a
   * `DropInApiError`. So `err instanceof DropInApiError` keeps meaning "the API answered".
   */
  // `| undefined` is explicit so that callers compiling with exactOptionalPropertyTypes
  // can forward an optional signal straight through (`{ signal }` where the local may be
  // undefined) instead of having to spread it conditionally at every call site.
  signal?: AbortSignal | undefined
}

/** The abort reason if the caller supplied one, else the DOMException fetch would throw. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * `encodeURIComponent` leaves `.` untouched, so a segment of exactly `.` or `..` survives
 * encoding and is then removed by the URL parser inside fetch — before the request is
 * sent. A two-segment path like /v1/objects/{type}/{id} therefore lets `type: '..'`
 * cancel the literal `objects` segment and `id` name an arbitrary sibling route, carrying
 * this client's credentials. Mirrors the inbound guard in the gateway (0042bac) and the
 * identical guard in @dropinnodex/server — duplicated on purpose: this package is
 * zero-dependency and isomorphic, so it cannot import from @dropinnodex/server. Do not
 * "fix" that by adding a dependency.
 */
function pathSegment(value: string): string {
  if (value === '.' || value === '..') {
    throw new Error(`invalid path segment ${JSON.stringify(value)}: a dot-segment would be removed by URL normalization inside fetch, silently retargeting the request`)
  }
  return encodeURIComponent(value)
}

export class DropInClient {
  /** Cached until a 401. The provider is called on init and again on a 401 — NOT per
   *  request. Per-request calls would double every operation's latency and hammer your
   *  own token endpoint. */
  private token: Promise<string> | null = null

  constructor(private readonly opts: DropInClientOptions) {}

  private getToken(forceRefresh = false): Promise<string> {
    if (forceRefresh || this.token === null) {
      this.token = Promise.resolve(this.opts.tokenProvider())
      // A rejected fetch must not poison the cache forever.
      this.token.catch(() => { this.token = null })
    }
    return this.token
  }

  /**
   * One retry, then throw. A 401 refetches the token and replays once; a second 401
   * surfaces to the caller. Unbounded retry would turn a permanently-bad token into an
   * infinite loop against both your backend and this API.
   */
  private async call<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const { signal } = opts
    // Bail before tokenProvider(), not just before fetch: the provider is usually a network
    // call to your own backend, and an already-cancelled caller must not trigger it.
    if (signal?.aborted) throw abortReason(signal)
    let res = await this.attempt(method, path, body, false, signal)
    if (res.status === 401) {
      // An abort between the two attempts is caught by fetch itself — a fetch with an
      // aborted signal rejects rather than replaying.
      res = await this.attempt(method, path, body, true, signal) // fresh token, final attempt
    }
    if (!res.ok) throw await this.toError(res)
    // Any empty success body → undefined, not just 204: a follow/unfollow returns 201/204
    // with no content, and JSON.parse('') would throw. Read text once, parse only if present.
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private async attempt(
    method: string, path: string, body: unknown, forceRefresh: boolean, signal?: AbortSignal,
  ): Promise<Response> {
    const token = await this.getToken(forceRefresh)
    return fetch(`${this.opts.url ?? DEFAULT_API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': this.opts.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Omitted entirely when absent: some fetch polyfills choke on `signal: undefined`.
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  private async toError(res: Response): Promise<DropInApiError> {
    let code: ErrorCode = 'INTERNAL'
    let message = res.statusText
    let requestId = ''
    try {
      const parsed = (await res.json()) as { error?: { code: ErrorCode; message: string; requestId: string } }
      if (parsed.error) ({ code, message, requestId } = parsed.error)
    } catch {
      // Non-JSON error body — keep the defaults.
    }
    return new DropInApiError(code, message, res.status, requestId)
  }

  private qs(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) search.set(k, String(v))
    }
    const s = search.toString()
    return s ? `?${s}` : ''
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
      get: async <TCustom = Record<string, unknown>>(
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<FeedPage<TCustom>>('GET', `${path()}${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      addActivity: async <TCustom = Record<string, unknown>>(a: {
        verb: string; object: string; target?: string | null
        foreign_id?: string | null; time?: string; custom?: TCustom
        /** Objects this activity points at, as `type:id`. Max 4. Resolved into the
         *  feed read's `objects` sidecar. */
        refs?: string[]
      }, opts: RequestOptions = {}) => this.call<Activity<TCustom>>('POST', `${path()}/activities`, a, opts),
      follow: async (tGroup: string, tId: string, opts: RequestOptions = {}) =>
        this.call<void>('POST', `${path()}/follows`, { target: `${tGroup}:${tId}` }, opts),
      unfollow: async (tGroup: string, tId: string, opts: RequestOptions = {}) =>
        this.call<void>('DELETE', `${path()}/follows/${pathSegment(tGroup)}/${pathSegment(tId)}`, undefined, opts),
      followers: async (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>('GET', `${path()}/followers${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      following: async (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>('GET', `${path()}/follows${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      // GetStream mirror: feed.removeActivity(id). Hits the activity route; the gateway
      // enforces authority = origin_feed, so removing from a feed you don't own is a 403.
      removeActivity: async (activityId: string, opts: RequestOptions = {}) =>
        this.call<void>('DELETE', `/v1/activities/${pathSegment(activityId)}`, undefined, opts),
      /**
       * Patch an activity's `custom` and/or `refs`. Permitted on your own activities
       * only. `body.refs`, when present, replaces the refs array wholesale (`[]`
       * clears it) — the backfill path for attaching objects to an activity posted
       * before they existed, without the delete-and-repost that would otherwise burn
       * its `foreign_id` and re-fan-out to every follower.
       */
      updateActivity: async <TCustom = Record<string, unknown>>(
        activityId: string, body: PatchBody, opts: RequestOptions = {},
      ) => this.call<Activity<TCustom>>(
        'PATCH', `/v1/activities/${pathSegment(activityId)}`, body, opts,
      ),
      followStats: async (opts: RequestOptions = {}) =>
        this.call<FollowStats>('GET', `${path()}/stats`, undefined, opts),
      // Who this feed should follow — friends-of-friends ranked by mutual overlap, topped
      // up by popularity. A capped top-N, so no cursor and no `next`.
      suggestions: async (q: { limit?: number } = {}, opts: RequestOptions = {}) =>
        this.call<{ results: Suggestion[] }>('GET', `${path()}/suggestions${this.qs({ limit: q.limit })}`, undefined, opts),
      /**
       * Cheap change signal, Redis-only server-side. Two independent fields:
       *
       * - `latest` — opaque token for NEW activities. Compare with the last value you
       *   acted on; null means nothing new.
       * - `changed` — tenant mutation counter, covering the changes `latest` cannot
       *   report: an activity edited, a reaction moved, an object written. Unchanged
       *   since your last revalidation means you can skip re-reading the page and its
       *   objects entirely. `null` means unknown — revalidate rather than assume.
       *
       * It is tenant-wide, so another feed's write can make yours revalidate once. That
       * is the price of a signal an object write can actually reach: an object does not
       * know which feeds reference it.
       */
      head: async (opts: RequestOptions = {}) =>
        this.call<{ latest: string | null; changed: number | null }>('GET', `${path()}/head`, undefined, opts),
    }
  }

  /** Sugar for `feed('timeline', id)` — the feed that aggregates who you follow. */
  timeline(id: string) { return this.feed('timeline', id) }
  /** Sugar for `feed('user', id)` — a single user's own activity feed. */
  userFeed(id: string) { return this.feed('user', id) }

  // GetStream mirror: client.reactions.add(kind, activityId, data) / .list(activityId) / .delete(reactionId).
  readonly reactions = {
    add: async (kind: string, activityId: string, custom: Record<string, unknown> = {}, opts: RequestOptions = {}) =>
      this.call<Reaction>('POST', `/v1/activities/${pathSegment(activityId)}/reactions`, { kind, custom }, opts),
    /** A page of reactions on an activity, newest first. Optional `kind` filters server-side. */
    list: async (
      activityId: string,
      q: { kind?: string; limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
      opts: RequestOptions = {},
    ) =>
      this.call<Page<Reaction>>(
        'GET',
        `/v1/activities/${pathSegment(activityId)}/reactions${this.qs({
          kind: q.kind, limit: q.limit, next: q.next ?? q.cursor,
        })}`,
        undefined,
        opts,
      ),
    /** GetStream parity: delete a reaction by its id (from add()/list()). */
    delete: async (reactionId: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/reactions/${pathSegment(reactionId)}`, undefined, opts),
    /** Remove the caller's own reaction of a kind from an activity (no id needed). */
    unreact: async (activityId: string, kind: string, opts: RequestOptions = {}) =>
      this.call<void>(
        'DELETE',
        `/v1/activities/${pathSegment(activityId)}/reactions/${pathSegment(kind)}`,
        undefined,
        opts,
      ),
  }

  /** Objects are server-write-only — this client can read them, never write them. */
  readonly objects = {
    get: async <TCustom = Record<string, unknown>>(type: string, id: string, opts: RequestOptions = {}) =>
      this.call<DropInObject<TCustom>>(
        'GET',
        `/v1/objects/${pathSegment(type)}/${pathSegment(id)}`,
        undefined,
        opts,
      ),
    /**
     * Re-read up to 100 objects in ONE request, keyed by `type:id`. This is how a
     * rendered page revalidates its `objects` sidecar: `get()` per card is N requests
     * for N cards, and objects are the mutable half of a feed, so that sweep repeats.
     *
     * Refs with no stored object are absent from the map — the same contract as the
     * feed-read sidecar, so a deleted object never fails the sweep. Compare each
     * returned `updated_at` against what you hold and re-render only what moved.
     *
     * An empty list costs zero requests rather than a 400: a page that renders no refs
     * is a normal state, not a caller error.
     */
    getMany: async <TCustom = Record<string, unknown>>(
      refs: string[], opts: RequestOptions = {},
    ): Promise<Record<string, DropInObject<TCustom>>> => {
      if (refs.length === 0) return {}
      // Repeated `refs=` rather than one comma-joined value: a ref is `type:id`, which
      // forbids a colon in each half but permits a comma anywhere, so joining would
      // shred such an id. URLSearchParams.append (not this.qs's `set`) keeps repeats.
      const search = new URLSearchParams()
      for (const ref of refs) search.append('refs', ref)
      return this.call<Record<string, DropInObject<TCustom>>>(
        'GET', `/v1/objects?${search.toString()}`, undefined, opts,
      )
    },
  }

  readonly users = {
    me: (opts: RequestOptions = {}) =>
      this.call<{ id: string; custom: Record<string, unknown> }>('GET', '/v1/users/me', undefined, opts),
  }

  // GetStream mirror: a flat notification feed with seen/read state + counts.
  readonly notifications = {
    get: (
      q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
      opts: RequestOptions = {},
    ) =>
      this.call<NotificationPage>(
        'GET',
        `/v1/notifications${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`,
        undefined,
        opts,
      ),
    /** Mark specific notifications seen, or all when no ids are given (an empty array = all). */
    markSeen: (ids?: string[], opts: RequestOptions = {}) =>
      this.call<void>('POST', '/v1/notifications/mark', ids?.length ? { seen: ids } : { seen: true }, opts),
    /** Mark specific notifications read, or all when no ids are given (an empty array = all). */
    markRead: (ids?: string[], opts: RequestOptions = {}) =>
      this.call<void>('POST', '/v1/notifications/mark', ids?.length ? { read: ids } : { read: true }, opts),
    /** Cheap change signal for the caller's notifications. See feed().head(). */
    head: (opts: RequestOptions = {}) =>
      this.call<{ latest: string | null; changed: number | null }>('GET', '/v1/notifications/head', undefined, opts),
  }
}
