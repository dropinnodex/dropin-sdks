import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DropInClient, DropInApiError, DEFAULT_API_URL } from './index.js'

let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Call { method: string; headers: Record<string, string>; body?: string }
function callAt(i: number): [string, Call] {
  return fetchMock.mock.calls[i] as [string, Call]
}
function lastUrl(): string {
  return (fetchMock.mock.calls.at(-1) as [string, Call])[0]
}

beforeEach(() => {
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

function client(tokenProvider: () => Promise<string>) {
  return new DropInClient({ apiKey: 'dk_test', url: 'http://api.test', tokenProvider })
}

describe('tokenProvider', () => {
  it('calls the provider and sends the token', async () => {
    const provider = vi.fn(async () => 'tok-1')
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(provider).feed('timeline', 'alice').get()
    expect(provider).toHaveBeenCalledTimes(1)
    expect(callAt(0)[1].headers.authorization).toBe('Bearer tok-1')
  })

  it('caches the token across requests — provider called once, not per request', async () => {
    const provider = vi.fn(async () => 'tok-cached')
    // A fresh Response per call — a body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(200, { results: [], next: null }))
    const c = client(provider)
    await c.feed('timeline', 'alice').get()
    await c.feed('timeline', 'alice').get()
    await c.users.me()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('does not poison the cache when the provider rejects — a later call retries it', async () => {
    const provider = vi.fn()
      .mockRejectedValueOnce(new Error('token endpoint down'))
      .mockResolvedValueOnce('recovered')
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    const c = client(provider)
    await expect(c.users.me()).rejects.toThrow('token endpoint down')
    await c.users.me() // provider is called again, not stuck on the rejected promise
    expect(provider).toHaveBeenCalledTimes(2)
    expect(callAt(0)[1].headers.authorization).toBe('Bearer recovered')
  })

  it('sends the api key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get()
    expect(callAt(0)[1].headers['x-api-key']).toBe('dk_test')
  })

  it('refetches the token on a 401 and replays the request ONCE', async () => {
    const provider = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthenticated', requestId: 'r1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next: null }))
    const res = await client(provider).feed('timeline', 'alice').get()
    expect(res.results).toEqual([])
    expect(provider).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(callAt(1)[1].headers.authorization).toBe('Bearer fresh')
  })

  it('THROWS on a second 401 — never retries unbounded', async () => {
    const provider = vi.fn(async () => 'always-bad')
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Unauthenticated', requestId: 'r1' } }))
    await expect(client(provider).feed('timeline', 'alice').get()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 403 — only 401 is a token problem', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Forbidden', requestId: 'r1' } }))
    await expect(client(async () => 'tok').feed('user', 'bob').addActivity({ verb: 'post', object: 'x' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 429', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded', requestId: 'r1' } }))
    await expect(client(async () => 'tok').feed('timeline', 'alice').get()).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('surface', () => {
  it('builds the documented routes', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, {}))
    const c = client(async () => 'tok')

    await c.feed('timeline', 'alice').get({ limit: 20 })
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice?limit=20')

    await c.feed('user', 'alice').addActivity({ verb: 'post', object: 'w:1', custom: {} })
    expect(lastUrl()).toBe('http://api.test/v1/feeds/user/alice/activities')

    await c.feed('timeline', 'alice').follow('user', 'bob')
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/follows')

    await c.feed('timeline', 'alice').unfollow('user', 'bob')
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/follows/user/bob')

    await c.feed('timeline', 'alice').following()
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/follows')

    await c.feed('user', 'bob').followers({ limit: 5 })
    expect(lastUrl()).toBe('http://api.test/v1/feeds/user/bob/followers?limit=5')

    // GetStream mirror: reactions live on client.reactions, activity id is an arg.
    await c.reactions.add('like', 'a-1')
    expect(lastUrl()).toBe('http://api.test/v1/activities/a-1/reactions')

    await c.reactions.unreact('a-1', 'like')
    expect(lastUrl()).toBe('http://api.test/v1/activities/a-1/reactions/like')

    // GetStream parity: reactions.delete is by reactionId now.
    await c.reactions.delete('R-ID')
    expect(lastUrl()).toBe('http://api.test/v1/reactions/R-ID')

    // GetStream mirror: feed.removeActivity(id) → DELETE /v1/activities/{id}.
    await c.feed('user', 'alice').removeActivity('a-1')
    expect(lastUrl()).toBe('http://api.test/v1/activities/a-1')

    await c.users.me()
    expect(lastUrl()).toBe('http://api.test/v1/users/me')
  })

  it('reads notifications and marks seen/read against the right routes', async () => {
    fetchMock.mockImplementation(async (_u: string, init: { method: string }) =>
      init.method === 'GET'
        ? jsonResponse(200, { results: [], unseen: 0, unread: 0, next: null })
        : new Response(null, { status: 204 }),
    )
    const c = client(async () => 'tok')

    const page = await c.notifications.get({ limit: 10 })
    expect(page).toEqual({ results: [], unseen: 0, unread: 0, next: null })
    expect(callAt(0)[0]).toBe('http://api.test/v1/notifications?limit=10')
    expect(callAt(0)[1].method).toBe('GET')

    await c.notifications.markSeen(['a', 'b'])
    expect(callAt(1)[0]).toBe('http://api.test/v1/notifications/mark')
    expect(callAt(1)[1].method).toBe('POST')
    expect(JSON.parse(callAt(1)[1].body!)).toEqual({ seen: ['a', 'b'] })

    await c.notifications.markRead()
    expect(callAt(2)[0]).toBe('http://api.test/v1/notifications/mark')
    expect(JSON.parse(callAt(2)[1].body!)).toEqual({ read: true })

    await c.notifications.markSeen()
    expect(JSON.parse(callAt(3)[1].body!)).toEqual({ seen: true })

    await c.notifications.markRead(['x'])
    expect(JSON.parse(callAt(4)[1].body!)).toEqual({ read: ['x'] })
  })

  it('notifications.get({}) sends no query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], unseen: 0, unread: 0, next: null }))
    await client(async () => 'tok').notifications.get()
    expect(lastUrl()).toBe('http://api.test/v1/notifications')
  })

  it('notifications.get({ cursor }) — deprecated alias — is mapped to next= on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], unseen: 0, unread: 0, next: null }))
    await client(async () => 'tok').notifications.get({ cursor: 'TOK' })
    expect(lastUrl()).toContain('next=TOK')
    expect(lastUrl()).not.toContain('cursor=')
  })

  it('followStats GETs the stats path and returns the parsed counts', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { follower_count: 3, following_count: 7 }))
    const res = await client(async () => 'tok').feed('user', 'bob').followStats()
    expect(callAt(0)[1].method).toBe('GET')
    expect(lastUrl()).toBe('http://api.test/v1/feeds/user/bob/stats')
    expect(res).toEqual({ follower_count: 3, following_count: 7 })
  })

  it('omits query params that are explicitly undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get({ limit: 20, cursor: undefined })
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice?limit=20')
  })

  it('url-encodes ids', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await client(async () => 'tok').feed('user', 'a/b c').get()
    expect(callAt(0)[0]).toContain('/v1/feeds/user/a%2Fb%20c')
  })

  it('treats a 204 as an empty success', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(client(async () => 'tok').feed('timeline', 'alice').unfollow('user', 'bob')).resolves.toBeUndefined()
  })

  it('treats an empty 201 (a follow) as success — not a JSON parse error', async () => {
    // Regression: follow returns 201 with no body; the client must not JSON.parse('').
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }))
    await expect(client(async () => 'tok').feed('timeline', 'alice').follow('user', 'bob')).resolves.toBeUndefined()
  })

  it('timeline() and userFeed() delegate to the right feed group', async () => {
    const calls: string[] = []
    const c = new DropInClient({ apiKey: 'k', url: 'https://x.test', tokenProvider: async () => 't' })
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(String(u)); return new Response(JSON.stringify({ results: [], next: null }), { status: 200 }) }))
    await c.timeline('alice').get()
    await c.userFeed('alice').get()
    vi.unstubAllGlobals()
    expect(calls[0]).toContain('/v1/feeds/timeline/alice')
    expect(calls[1]).toContain('/v1/feeds/user/alice')
  })

  it('surfaces the error envelope as DropInApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Feed not found', requestId: 'req_9' } }))
    const err = await client(async () => 'tok').feed('user', 'ghost').removeActivity('nope').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DropInApiError)
    expect(err).toMatchObject({ code: 'NOT_FOUND', requestId: 'req_9' })
  })

  it('falls back to INTERNAL on a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('oops, not json', { status: 500 }))
    const err = await client(async () => 'tok').users.me().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DropInApiError)
    expect(err).toMatchObject({ code: 'INTERNAL', status: 500 })
  })

  it('falls back to INTERNAL on a JSON error body with no error envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { oops: true }))
    const err = await client(async () => 'tok').users.me().catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'INTERNAL', status: 500, requestId: '' })
  })
})

describe('pagination: next param (cursor mapped, canonical on the wire)', () => {
  it('get({ next }) sends next= and never cursor=', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get({ next: 'TOK' })
    expect(lastUrl()).toContain('next=TOK')
    expect(lastUrl()).not.toContain('cursor=')
  })

  it('get({ cursor }) — deprecated alias — is mapped to next= on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get({ cursor: 'TOK' })
    expect(lastUrl()).toContain('next=TOK')
    expect(lastUrl()).not.toContain('cursor=')
  })

  it('get({}) sends neither next= nor cursor=', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get({})
    expect(lastUrl()).not.toContain('next=')
    expect(lastUrl()).not.toContain('cursor=')
  })

  it('followers({ next }) sends next= on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('user', 'bob').followers({ next: 'TOK' })
    expect(lastUrl()).toContain('next=TOK')
    expect(lastUrl()).not.toContain('cursor=')
  })

  it('following({ cursor }) — deprecated alias — is mapped to next= on the wire', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('user', 'bob').following({ cursor: 'TOK' })
    expect(lastUrl()).toContain('next=TOK')
    expect(lastUrl()).not.toContain('cursor=')
  })
})

describe('reactions.list', () => {
  it('GETs a page of reactions, url-encoding the id and forwarding kind/limit/next', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      results: [{ id: 'r1', kind: 'like', activity_id: 'a/1', user_id: 'bob', custom: {}, created_at: '2026-07-25T00:00:00Z' }],
      next: 'c2',
    }))
    const page = await client(async () => 't').reactions.list('a/1', { kind: 'like', limit: 5, next: 'c1' })
    expect(lastUrl()).toBe('http://api.test/v1/activities/a%2F1/reactions?kind=like&limit=5&next=c1')
    expect(page.results[0].id).toBe('r1')
    expect(page.results[0].kind).toBe('like')
    expect(page.next).toBe('c2')
  })

  it('omits the query string when no opts are given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 't').reactions.list('a1')
    expect(lastUrl()).toBe('http://api.test/v1/activities/a1/reactions')
  })

  it('lets `next` override the deprecated `cursor`', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 't').reactions.list('a1', { next: 'N', cursor: 'C' })
    expect(lastUrl()).toBe('http://api.test/v1/activities/a1/reactions?next=N')
  })
})

describe('suggestions', () => {
  it('GETs the suggestions path and returns the parsed results', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      results: [
        { group: 'user', id: 'dave', mutuals: 2 },
        { group: 'user', id: 'erin', mutuals: 1 },
      ],
    }))
    const res = await client(async () => 'tok').feed('timeline', 'alice').suggestions()
    expect(callAt(0)[1].method).toBe('GET')
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/suggestions')
    expect(res).toEqual({
      results: [
        { group: 'user', id: 'dave', mutuals: 2 },
        { group: 'user', id: 'erin', mutuals: 1 },
      ],
    })
  })

  it('sends limit= on the wire when provided', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }))
    await client(async () => 'tok').feed('timeline', 'alice').suggestions({ limit: 10 })
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/suggestions?limit=10')
  })

  it('omits limit= when not provided', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [] }))
    await client(async () => 'tok').feed('user', 'bob').suggestions()
    expect(lastUrl()).toBe('http://api.test/v1/feeds/user/bob/suggestions')
  })
})

describe('AbortSignal', () => {
  /** A fetch that never resolves on its own — it only settles when the signal aborts,
   *  the way the real one does. Lets a test observe a cancellation mid-flight. */
  function hangingFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      // Already aborted by the time we're called (the caller aborted while the token
      // provider's microtask was in flight) — reject at once, as real fetch does.
      if (init.signal?.aborted) { reject(init.signal.reason as Error); return }
      init.signal?.addEventListener('abort', () => { reject(init.signal!.reason as Error) })
    }))
  }

  it('forwards the signal to fetch', async () => {
    const ctrl = new AbortController()
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').feed('timeline', 'alice').get({ limit: 5 }, { signal: ctrl.signal })
    expect((callAt(0)[1] as unknown as { signal: AbortSignal }).signal).toBe(ctrl.signal)
  })

  it('omits signal from the fetch init when none is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    await client(async () => 'tok').users.me()
    expect(callAt(0)[1]).not.toHaveProperty('signal')
  })

  it('rejects an already-aborted call without calling fetch OR the token provider', async () => {
    const provider = vi.fn(async () => 'tok')
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(client(provider).users.me({ signal: ctrl.signal })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })

  it('surfaces the abort as an AbortError, NOT a DropInApiError', async () => {
    const ctrl = new AbortController()
    fetchMock.mockImplementation(hangingFetch())
    const p = client(async () => 'tok').feed('timeline', 'alice').get({}, { signal: ctrl.signal })
    ctrl.abort()
    const err = await p.catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(DropInApiError)
    expect((err as Error).name).toBe('AbortError')
  })

  it('preserves a caller-supplied abort reason', async () => {
    const reason = new Error('component unmounted')
    const ctrl = new AbortController()
    ctrl.abort(reason)
    await expect(client(async () => 'tok').users.me({ signal: ctrl.signal })).rejects.toBe(reason)
  })

  it('is accepted by writes too, so a cancelled screen can drop an in-flight POST', async () => {
    const ctrl = new AbortController()
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'a1' }))
    await client(async () => 'tok')
      .feed('user', 'alice')
      .addActivity({ verb: 'post', object: 'w:1' }, { signal: ctrl.signal })
    expect((callAt(0)[1] as unknown as { signal: AbortSignal }).signal).toBe(ctrl.signal)
    expect(callAt(0)[1].body).toBe(JSON.stringify({ verb: 'post', object: 'w:1' }))
  })

  it('carries the signal into the 401 replay', async () => {
    const ctrl = new AbortController()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r' } }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'alice', custom: {} }))
    await client(async () => 'tok').users.me({ signal: ctrl.signal })
    expect((callAt(1)[1] as unknown as { signal: AbortSignal }).signal).toBe(ctrl.signal)
  })
})

describe('base URL', () => {
  it('defaults to the hosted API when url is omitted', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'alice', custom: {} }))
    await new DropInClient({ apiKey: 'dk_test', tokenProvider: async () => 'tok' }).users.me()
    expect(lastUrl()).toBe(`${DEFAULT_API_URL}/v1/users/me`)
  })

  it('uses an explicit url instead — staging, a proxy, or local development', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'alice', custom: {} }))
    await new DropInClient({
      apiKey: 'dk_test', url: 'http://localhost:3000', tokenProvider: async () => 'tok',
    }).users.me()
    expect(lastUrl()).toBe('http://localhost:3000/v1/users/me')
  })

  it('points at https, so a default install is never plaintext', () => {
    expect(DEFAULT_API_URL.startsWith('https://')).toBe(true)
    expect(DEFAULT_API_URL.endsWith('/')).toBe(false)
  })
})

describe('objects', () => {
  it('client.objects.get(type, id) GETs the object route and returns the parsed object', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      type: 'session', id: '1', custom: { title: 'Yoga' }, updated_at: '2026-08-07T00:00:00Z',
    }))
    const res = await client(async () => 'tok').objects.get('session', '1')
    expect(callAt(0)[1].method).toBe('GET')
    expect(lastUrl()).toBe('http://api.test/v1/objects/session/1')
    expect(res).toEqual({ type: 'session', id: '1', custom: { title: 'Yoga' }, updated_at: '2026-08-07T00:00:00Z' })
  })

  it('url-encodes both type and id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await client(async () => 'tok').objects.get('a/b', 'c d')
    expect(lastUrl()).toBe('http://api.test/v1/objects/a%2Fb/c%20d')
  })

  it('exposes no write methods — object writes are server-token only', async () => {
    const c = client(async () => 'tok')
    const objects = (c as unknown as Record<string, unknown>).objects as Record<string, unknown>
    expect(objects).not.toHaveProperty('upsert')
    expect(objects).not.toHaveProperty('patch')
    expect(objects).not.toHaveProperty('remove')
    expect(objects).not.toHaveProperty('set')
    expect(objects).not.toHaveProperty('delete')
    expect(Object.keys(objects)).toEqual(['get'])
  })
})

describe('addActivity refs', () => {
  it('sends refs as a plain inline-literal field, unmodified', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'a1' }))
    await client(async () => 'tok').feed('user', 'alice').addActivity({
      verb: 'post', object: 'session:1234', custom: { text: 'hi' }, refs: ['session:1234'],
    })
    expect(JSON.parse(callAt(0)[1].body!)).toEqual({
      verb: 'post', object: 'session:1234', custom: { text: 'hi' }, refs: ['session:1234'],
    })
  })
})

describe('updateActivity', () => {
  it('PATCHes /v1/activities/:id with the patch body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      id: 'a1', actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
      time: '2026-08-07T00:00:00Z', custom: { text: 'x' }, origin_feed: 'user:alice',
      reaction_counts: {}, actor_user: null, refs: [], edited_at: '2026-08-07T00:00:01Z',
    }))
    const res = await client(async () => 'tok')
      .feed('user', 'alice')
      .updateActivity('a1', { set: { 'custom.text': 'x' } })
    expect(callAt(0)[1].method).toBe('PATCH')
    expect(lastUrl()).toBe('http://api.test/v1/activities/a1')
    expect(JSON.parse(callAt(0)[1].body!)).toEqual({ set: { 'custom.text': 'x' } })
    expect(res.edited_at).toBe('2026-08-07T00:00:01Z')
  })

  it('url-encodes the activity id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await client(async () => 'tok').feed('user', 'alice').updateActivity('a/1', { unset: ['custom.text'] })
    expect(lastUrl()).toBe('http://api.test/v1/activities/a%2F1')
  })
})

describe('feed read: objects sidecar', () => {
  it('surfaces objects when the server includes the sidecar', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      results: [{
        id: 'a1', actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
        time: '2026-08-07T00:00:00Z', custom: {}, origin_feed: 'user:alice',
        reaction_counts: {}, actor_user: null, refs: ['session:1234'], edited_at: null,
      }],
      objects: {
        'session:1234': { type: 'session', id: '1234', custom: { title: 'Yoga' }, updated_at: '2026-08-07T00:00:00Z' },
      },
      next: null,
    }))
    const page = await client(async () => 'tok').feed('user', 'alice').get()
    expect(page.objects).toEqual({
      'session:1234': { type: 'session', id: '1234', custom: { title: 'Yoga' }, updated_at: '2026-08-07T00:00:00Z' },
    })
  })

  it('leaves page.objects undefined (key absent) when the server omits the sidecar', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { results: [], next: null }))
    const page = await client(async () => 'tok').feed('user', 'alice').get()
    expect(page.objects).toBeUndefined()
    expect('objects' in page).toBe(false)
  })
})

describe('head', () => {
  it('feed head hits /head and returns the token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { latest: 'act_9' }))
    const r = await client(async () => 't').feed('timeline', 'alice').head()
    expect(lastUrl()).toBe('http://api.test/v1/feeds/timeline/alice/head')
    expect(r).toEqual({ latest: 'act_9' })
  })

  it('notifications head hits /v1/notifications/head', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { latest: null }))
    const r = await client(async () => 't').notifications.head()
    expect(lastUrl()).toBe('http://api.test/v1/notifications/head')
    expect(r).toEqual({ latest: null })
  })
})

describe('dot-segment path guard', () => {
  // `encodeURIComponent` leaves `.` untouched. A segment that is EXACTLY `.` or `..`
  // survives encoding and is then removed by the URL parser inside fetch, before the
  // request is sent — letting one dynamic segment cancel a literal route segment and
  // the next dynamic segment name an arbitrary sibling route. Every interpolated path
  // segment in the SDK must reject this rather than silently retargeting the request.
  // This client is zero-dependency and isomorphic, so it carries its OWN copy of the
  // guard (it cannot import @dropinnodex/server's) — these tests are independent of
  // the server package's equivalent suite on purpose.

  it('rejects a "." segment without calling fetch', async () => {
    await expect(client(async () => 'tok').objects.get('.', 'x')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a ".." segment without calling fetch', async () => {
    await expect(client(async () => 'tok').objects.get('..', 'x')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects ".." in the second segment too', async () => {
    await expect(client(async () => 'tok').objects.get('x', '..')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('REGRESSION: objects.get(\'..\', \'activities\') can no longer redirect to /v1/activities', async () => {
    // The exact confused-deputy shape from the report: a tenant looping
    // objects.get(type, id) over their own catalogue, where a record's `type` happens
    // to be '..', would otherwise cancel the literal `objects` segment and hit an
    // arbitrary sibling route carrying this client's credentials.
    await expect(client(async () => 'tok').objects.get('..', 'activities')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
    // Prove it directly too: had the guard not fired, this is what the URL parser
    // would have done to the naively-constructed path.
    const naive = `/v1/objects/${encodeURIComponent('..')}/${encodeURIComponent('activities')}`
    expect(new URL(naive, 'http://x').pathname).toBe('/v1/activities') // the bug, unguarded
  })

  it('rejects dot segments on feed(group, id) — as a rejection, not a synchronous throw', async () => {
    // feed() itself must never throw: it is a plain object-returning method (not async,
    // for fluent chaining), so validating eagerly there would crash the caller
    // synchronously instead of producing a rejected Promise like every other guarded
    // call site. The path is validated lazily, inside each async method instead.
    const c = client(async () => 'tok')
    expect(() => c.feed('.', 'alice')).not.toThrow()
    expect(() => c.feed('user', '..')).not.toThrow()
    await expect(c.feed('.', 'alice').get()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('user', '..').get()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').addActivity({ verb: 'post', object: 'w:1' })).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').follow('user', 'bob')).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').followers()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').following()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').followStats()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').suggestions()).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('.', 'alice').head()).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects dot segments on feed().unfollow target', async () => {
    const c = client(async () => 'tok')
    await expect(c.feed('timeline', 'alice').unfollow('..', 'bob')).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('timeline', 'alice').unfollow('user', '.')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects dot segments on removeActivity, updateActivity, and reactions', async () => {
    const c = client(async () => 'tok')
    await expect(c.feed('user', 'bob').removeActivity('..')).rejects.toThrow(/invalid path segment/)
    await expect(c.feed('user', 'bob').updateActivity('.', { set: {} })).rejects.toThrow(/invalid path segment/)
    await expect(c.reactions.add('like', '..')).rejects.toThrow(/invalid path segment/)
    await expect(c.reactions.list('.')).rejects.toThrow(/invalid path segment/)
    await expect(c.reactions.delete('..')).rejects.toThrow(/invalid path segment/)
    await expect(c.reactions.unreact('..', 'like')).rejects.toThrow(/invalid path segment/)
    await expect(c.reactions.unreact('a1', '..')).rejects.toThrow(/invalid path segment/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still allows the safe cases the guard must not break', async () => {
    const c = client(async () => 'tok')

    // "/" — a literal slash, inert once encoded.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await c.objects.get('a/b', 'x')
    expect(new URL(lastUrl()).pathname).toBe('/v1/objects/a%2Fb/x')

    // A pre-encoded "%2F" stays inert too, double-encoded by encodeURIComponent.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await c.objects.get('%2F', 'x')
    expect(new URL(lastUrl()).pathname).toBe('/v1/objects/%252F/x')

    // Unicode passes through fine.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await c.objects.get('café', 'x')
    expect(new URL(lastUrl()).pathname).toBe('/v1/objects/caf%C3%A9/x')

    // A legitimate dot INSIDE a longer segment (e.g. a version string) must be allowed —
    // only a segment that is ENTIRELY "." or ".." is rejected.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    await c.objects.get('release', 'v1.2')
    expect(new URL(lastUrl()).pathname).toBe('/v1/objects/release/v1.2')
  })
})
