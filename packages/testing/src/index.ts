/**
 * `@dropinnodex/testing` — an in-memory dropin you hand to a real client as its transport.
 *
 * The design decision worth knowing: this fakes the TRANSPORT, not the client. You get a
 * `fetch`, and `@dropinnodex/client` / `@dropinnodex/react` run above it untouched — token
 * caching, the single-flight 401 refresh, retry-once, error parsing, cursor encoding. A
 * fake implementing the client's interface would bypass exactly the code most worth
 * exercising, and every bug this package exists to catch has lived there.
 *
 * See docs/superpowers/specs/2026-08-22-testing-fake-design.md.
 */
import { Store, feedRef, type FakeActivity } from './store.js'

export type ErrorCode =
  | 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'FORBIDDEN'
  | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL'

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500,
}

export interface RecordedRequest {
  method: string
  path: string
  status: number
}

export interface InjectedFailure {
  code?: ErrorCode
  /** How many requests it applies to. Default 1. */
  times?: number
  retryAfterSeconds?: number
}

/** A caller, resolved from the token. `userId` null means a server token. */
interface Caller { userId: string | null }

export interface TestDropin {
  /** Hand this to `new DropInClient({ fetch })`. */
  readonly fetch: typeof fetch
  /** Mint a user token. Fake by construction — see the spec's settled decisions. */
  mintToken(userId: string): string
  /** A server token: no user identity, so `own_reactions` is omitted and `actor` is free. */
  serverToken(): string
  /** Invalidate every token minted so far. The next request 401s, exactly like expiry. */
  expireTokens(): void
  /** Fail the next request(s). The client sees a real `DropInApiError`. */
  failNext(f?: InjectedFailure): void
  /** Every request, in order. Assert COUNTS here, not just outcomes. */
  requests(): readonly RecordedRequest[]
  /** Seed data directly, without going through the API. */
  readonly objects: {
    upsert(type: string, id: string, custom: Record<string, unknown>): void
    remove(type: string, id: string): void
  }
  readonly store: Store
}

class Fake implements TestDropin {
  private readonly s = new Store()
  private readonly recorded: RecordedRequest[] = []
  private failures: InjectedFailure[] = []
  /** Tokens minted at or before this watermark are dead. */
  private expiredBefore = 0
  private minted = 0

  readonly fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const res = await this.handle(method, url, init?.headers ?? {}, init?.body)
    this.recorded.push({ method, path: url.pathname + url.search, status: res.status })
    return res
  }) as unknown as typeof fetch

  mintToken(userId: string): string {
    return `u.${userId}.${++this.minted}`
  }

  serverToken(): string {
    return `s..${++this.minted}`
  }

  expireTokens(): void {
    this.expiredBefore = this.minted
  }

  failNext(f: InjectedFailure = {}): void {
    const times = f.times ?? 1
    for (let i = 0; i < times; i++) this.failures.push(f)
  }

  requests(): readonly RecordedRequest[] {
    return this.recorded
  }

  readonly objects = {
    upsert: (type: string, id: string, custom: Record<string, unknown>): void => {
      this.s.objects.set(`${type}:${id}`, { type, id, custom, updated_at: this.s.now() })
    },
    remove: (type: string, id: string): void => {
      this.s.objects.delete(`${type}:${id}`)
    },
  }

  get store(): Store {
    return this.s
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private error(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
    const status = STATUS[code]
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (typeof extra.retryAfterSeconds === 'number') headers['retry-after'] = String(extra.retryAfterSeconds)
    return new Response(
      JSON.stringify({ error: { code, message, requestId: `req_test_${this.recorded.length + 1}`, ...extra } }),
      { status, headers },
    )
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  /** `u.<userId>.<n>` or `s..<n>`; anything else, or a token below the watermark, is dead. */
  private authenticate(headers: Record<string, string>): Caller | null {
    const raw = headers.authorization ?? headers.Authorization
    if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null
    const [kind, userId, seq] = raw.slice('Bearer '.length).split('.')
    if (kind !== 'u' && kind !== 's') return null
    if (Number(seq) <= this.expiredBefore) return null
    return { userId: kind === 'u' ? (userId ?? null) : null }
  }

  private async handle(method: string, url: URL, headers: Record<string, string>, body?: string): Promise<Response> {
    const injected = this.failures.shift()
    if (injected !== undefined) {
      const code = injected.code ?? 'INTERNAL'
      return this.error(code, code, injected.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: injected.retryAfterSeconds })
    }

    const caller = this.authenticate(headers)
    if (caller === null) return this.error('UNAUTHENTICATED', 'Unauthenticated')

    const parsed: unknown = body === undefined ? undefined : JSON.parse(body)
    const p = url.pathname

    // GET /v1/feeds/:group/:id
    let m = /^\/v1\/feeds\/([^/]+)\/([^/]+)$/.exec(p)
    if (m !== null && method === 'GET') return this.readFeed(caller, m[1]!, m[2]!, url)

    // POST /v1/feeds/:group/:id/activities
    m = /^\/v1\/feeds\/([^/]+)\/([^/]+)\/activities$/.exec(p)
    if (m !== null && method === 'POST') return this.addActivity(caller, m[1]!, m[2]!, parsed)

    // POST /v1/feeds/:group/:id/follows
    m = /^\/v1\/feeds\/([^/]+)\/([^/]+)\/follows$/.exec(p)
    if (m !== null && method === 'POST') return this.follow(caller, m[1]!, m[2]!, parsed)

    // DELETE /v1/feeds/:group/:id/follows/:tGroup/:tId
    m = /^\/v1\/feeds\/([^/]+)\/([^/]+)\/follows\/([^/]+)\/([^/]+)$/.exec(p)
    if (m !== null && method === 'DELETE') {
      this.s.unfollow(feedRef(m[1]!, m[2]!), feedRef(m[3]!, m[4]!))
      return new Response(null, { status: 204 })
    }

    // DELETE /v1/activities/:id
    m = /^\/v1\/activities\/([^/]+)$/.exec(p)
    if (m !== null && method === 'DELETE') {
      return this.s.removeActivity(m[1]!)
        ? new Response(null, { status: 204 })
        : this.error('NOT_FOUND', 'Not found')
    }

    // POST /v1/activities/:id/reactions
    m = /^\/v1\/activities\/([^/]+)\/reactions$/.exec(p)
    if (m !== null && method === 'POST') {
      if (caller.userId === null) return this.error('FORBIDDEN', 'Forbidden')
      const b = parsed as { kind?: string }
      if (typeof b?.kind !== 'string') return this.error('VALIDATION_FAILED', 'Validation failed')
      const target = this.s.activities.find((a) => a.id === m![1] && a.deleted_at === null)
      if (target === undefined) return this.error('NOT_FOUND', 'Not found')
      const id = this.s.react(target.id, b.kind, caller.userId)
      this.s.notify({ owner: target.actor, verb: 'react', actor: `user:${caller.userId}`, object: target.id, reaction_kind: b.kind })
      return this.json({ id, kind: b.kind, activity_id: target.id }, 201)
    }

    // DELETE /v1/activities/:id/reactions/:kind
    m = /^\/v1\/activities\/([^/]+)\/reactions\/([^/]+)$/.exec(p)
    if (m !== null && method === 'DELETE') {
      if (caller.userId !== null) this.s.unreact(m[1]!, m[2]!, caller.userId)
      return new Response(null, { status: 204 })
    }

    return this.error('NOT_FOUND', `no fake route for ${method} ${p}`)
  }

  private readFeed(caller: Caller, group: string, id: string, url: URL): Response {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return this.error('VALIDATION_FAILED', 'Validation failed')
    }
    const after = url.searchParams.get('next') ?? url.searchParams.get('cursor')
    const ids = this.s.feedOf(group, id)
    const start = after === null ? 0 : ids.indexOf(this.decodeCursor(after)) + 1
    const page = ids.slice(start, start + limit)
    const results = page
      .map((aid) => this.s.activities.find((a) => a.id === aid))
      .filter((a): a is FakeActivity => a !== undefined)
      .map((a) => this.serialize(a, caller))

    const refs = new Set(results.flatMap((r) => r.refs))
    const objects: Record<string, unknown> = {}
    for (const ref of refs) {
      const o = this.s.objects.get(ref)
      if (o !== undefined) objects[ref] = o // absent refs are SKIPPED, never holed
    }

    const last = page.at(-1)
    const more = start + limit < ids.length
    return this.json({
      results,
      next: more && last !== undefined ? this.encodeCursor(last) : null,
      ...(refs.size > 0 ? { objects } : {}),
    })
  }

  private addActivity(caller: Caller, group: string, id: string, parsed: unknown): Response {
    const b = parsed as Partial<FakeActivity> & { time?: string }
    if (typeof b?.verb !== 'string' || typeof b.object !== 'string') {
      return this.error('VALIDATION_FAILED', 'Validation failed')
    }
    // Dedupe is on the PAIR — a foreign_id alone could never dedupe, so it is refused
    // rather than allowed to fail quietly later.
    if (typeof b.foreign_id === 'string' && typeof b.time !== 'string') {
      return this.error('VALIDATION_FAILED', 'foreign_id requires time')
    }
    if ((b.refs ?? []).length > 4) return this.error('VALIDATION_FAILED', 'at most 4 refs')

    if (typeof b.foreign_id === 'string' && typeof b.time === 'string') {
      // Against the CLAMPED value: the stored identity is what a replay must match.
      const existing = this.s.findByIdentity(b.foreign_id, this.resolveTime(caller, b.time))
      if (existing !== undefined) {
        // Deleted identities are burned; live ones replay into the original row.
        return existing.deleted_at !== null
          ? this.error('CONFLICT', 'This foreign_id/time identity was deleted')
          : this.json(this.serialize(existing, caller), 201)
      }
    }

    if (caller.userId !== null) this.s.ensureUser(caller.userId)
    const actor = caller.userId !== null
      ? `user:${caller.userId}`            // OVERWRITTEN for user tokens, never validated
      : (typeof b.actor === 'string' && b.actor.length > 0 ? b.actor : 'system')

    const created = this.s.addActivity({
      actor, verb: b.verb, object: b.object,
      target: typeof b.target === 'string' ? b.target : null,
      foreign_id: typeof b.foreign_id === 'string' ? b.foreign_id : null,
      time: this.resolveTime(caller, b.time),
      custom: (b.custom ?? {}) as Record<string, unknown>,
      refs: b.refs ?? [],
      origin_feed: feedRef(group, id),
    })
    const out = this.serialize(created, caller)
    return this.json(
      this.s.actorUser(actor) === null && actor.startsWith('user:')
        ? { ...out, warnings: ['actor_user_unresolved'] }
        : out,
      201,
    )
  }

  private follow(caller: Caller, group: string, id: string, parsed: unknown): Response {
    // The wire shape is a single `target: "group:id"` string, not a pair of fields.
    const b = parsed as { target?: string }
    if (typeof b?.target !== 'string' || !b.target.includes(':')) {
      return this.error('VALIDATION_FAILED', 'Validation failed')
    }
    const source = feedRef(group, id)
    const target = b.target
    // Notified only on a genuine new edge, and only when the target is a user — which is
    // why a re-follow after an unfollow is silent even though the edge is real.
    if (this.s.follow(source, target) && target.startsWith('user:') && group === 'timeline') {
      this.s.notify({ owner: target, verb: 'follow', actor: `user:${id}`, object: target, reaction_kind: null })
    }
    return new Response(null, { status: 201 })
  }

  /**
   * A user token's `time` is CLAMPED into `[now - 10 min, now]`; a server token's is not.
   *
   * This is not a restriction, it is what makes retries dedupe: the clamp preserves a
   * client-supplied time inside the window, so a browser resending the same
   * `(foreign_id, time)` pair hits the same identity instead of getting a fresh server
   * timestamp and silently double-posting. Future-pinning stays impossible either way.
   * A server token is unclamped, which is what makes historical backfill possible.
   *
   * Discovered missing by the contract suite: without it the fake deduped writes the real
   * service would have treated as two separate activities.
   */
  private resolveTime(caller: Caller, supplied: string | undefined): string {
    const now = Date.now()
    if (typeof supplied !== 'string') return new Date(now).toISOString()
    if (caller.userId === null) return supplied // server token: unclamped
    const t = Date.parse(supplied)
    if (Number.isNaN(t)) return new Date(now).toISOString()
    return new Date(Math.min(Math.max(t, now - 10 * 60 * 1000), now)).toISOString()
  }

  private serialize(a: FakeActivity, caller: Caller) {
    const own = this.s.ownReactions(a.id, caller.userId)
    return {
      id: a.id, actor: a.actor, verb: a.verb, object: a.object, target: a.target,
      foreign_id: a.foreign_id, time: a.time, custom: a.custom, refs: a.refs,
      origin_feed: a.origin_feed, reaction_counts: this.s.reactionCounts(a.id),
      actor_user: this.s.actorUser(a.actor), edited_at: a.edited_at, version: a.version,
      ...(own === undefined ? {} : { own_reactions: own }),
    }
  }

  // Opaque on purpose: a test that reads the cursor is testing our encoding, not its own code.
  private encodeCursor(activityId: string): string {
    return Buffer.from(`c:${activityId}`).toString('base64url')
  }

  private decodeCursor(cursor: string): string {
    return Buffer.from(cursor, 'base64url').toString().slice(2)
  }
}

/** Create an in-memory dropin. Each call is a fresh, isolated tenant. */
export function createTestDropin(): TestDropin {
  return new Fake()
}
