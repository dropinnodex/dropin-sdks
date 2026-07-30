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
}

export interface Page<T> {
  results: T[]
  next: string | null
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
    const base = `/v1/feeds/${encodeURIComponent(group)}/${encodeURIComponent(id)}`
    return {
      get: <TCustom = Record<string, unknown>>(
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Activity<TCustom>>>('GET', `${base}${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      addActivity: <TCustom = Record<string, unknown>>(a: {
        verb: string; object: string; target?: string | null
        foreign_id?: string | null; time?: string; custom?: TCustom
      }, opts: RequestOptions = {}) => this.call<Activity<TCustom>>('POST', `${base}/activities`, a, opts),
      follow: (tGroup: string, tId: string, opts: RequestOptions = {}) =>
        this.call<void>('POST', `${base}/follows`, { target: `${tGroup}:${tId}` }, opts),
      unfollow: (tGroup: string, tId: string, opts: RequestOptions = {}) =>
        this.call<void>('DELETE', `${base}/follows/${encodeURIComponent(tGroup)}/${encodeURIComponent(tId)}`, undefined, opts),
      followers: (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>('GET', `${base}/followers${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      following: (
        q: { limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
        opts: RequestOptions = {},
      ) =>
        this.call<Page<Follow>>('GET', `${base}/follows${this.qs({ limit: q.limit, next: q.next ?? q.cursor })}`, undefined, opts),
      // GetStream mirror: feed.removeActivity(id). Hits the activity route; the gateway
      // enforces authority = origin_feed, so removing from a feed you don't own is a 403.
      removeActivity: (activityId: string, opts: RequestOptions = {}) =>
        this.call<void>('DELETE', `/v1/activities/${encodeURIComponent(activityId)}`, undefined, opts),
      followStats: (opts: RequestOptions = {}) =>
        this.call<FollowStats>('GET', `${base}/stats`, undefined, opts),
      // Who this feed should follow — friends-of-friends ranked by mutual overlap, topped
      // up by popularity. A capped top-N, so no cursor and no `next`.
      suggestions: (q: { limit?: number } = {}, opts: RequestOptions = {}) =>
        this.call<{ results: Suggestion[] }>('GET', `${base}/suggestions${this.qs({ limit: q.limit })}`, undefined, opts),
    }
  }

  /** Sugar for `feed('timeline', id)` — the feed that aggregates who you follow. */
  timeline(id: string) { return this.feed('timeline', id) }
  /** Sugar for `feed('user', id)` — a single user's own activity feed. */
  userFeed(id: string) { return this.feed('user', id) }

  // GetStream mirror: client.reactions.add(kind, activityId, data) / .list(activityId) / .delete(reactionId).
  readonly reactions = {
    add: (kind: string, activityId: string, custom: Record<string, unknown> = {}, opts: RequestOptions = {}) =>
      this.call<Reaction>('POST', `/v1/activities/${encodeURIComponent(activityId)}/reactions`, { kind, custom }, opts),
    /** A page of reactions on an activity, newest first. Optional `kind` filters server-side. */
    list: (
      activityId: string,
      q: { kind?: string; limit?: number; next?: string; /** @deprecated use `next` */ cursor?: string } = {},
      opts: RequestOptions = {},
    ) =>
      this.call<Page<Reaction>>(
        'GET',
        `/v1/activities/${encodeURIComponent(activityId)}/reactions${this.qs({
          kind: q.kind, limit: q.limit, next: q.next ?? q.cursor,
        })}`,
        undefined,
        opts,
      ),
    /** GetStream parity: delete a reaction by its id (from add()/list()). */
    delete: (reactionId: string, opts: RequestOptions = {}) =>
      this.call<void>('DELETE', `/v1/reactions/${encodeURIComponent(reactionId)}`, undefined, opts),
    /** Remove the caller's own reaction of a kind from an activity (no id needed). */
    unreact: (activityId: string, kind: string, opts: RequestOptions = {}) =>
      this.call<void>(
        'DELETE',
        `/v1/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(kind)}`,
        undefined,
        opts,
      ),
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
  }
}
