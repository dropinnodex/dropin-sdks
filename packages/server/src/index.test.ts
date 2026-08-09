import { describe, it, expect, vi, afterEach } from 'vitest'
import * as jose from 'jose'
import { DropInServer, DEFAULT_API_URL } from './index.js'

const dropin = new DropInServer({
  tenantId: 'acme', apiKey: 'dk_test', apiSecret: 'ds_test_secret', url: 'http://localhost:3000',
})

interface FetchCallOpts { method: string; headers: Record<string, string>; body?: string }
function mockFetchOnce(res: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  // text defaults to the SERIALISED json, because that is what a real Response does —
  // body text and .json() are the same bytes. Defaulting it to '' let the SDK's
  // empty-body handling look correct in tests while failing against a real server.
  const fn = vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => res.json,
    text: async () => res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : ''),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
function lastCall(fn: ReturnType<typeof vi.fn>): [string, FetchCallOpts] {
  return fn.mock.calls[0] as [string, FetchCallOpts]
}
afterEach(() => vi.unstubAllGlobals())

describe('createUserToken', () => {
  it('mints a token verifiable with the api secret — local HMAC, no network', async () => {
    const token = await dropin.createUserToken('alice')
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode('ds_test_secret'), {
      algorithms: ['HS256'], issuer: 'dropin', audience: 'acme',
    })
    expect(payload.sub).toBe('alice')
    expect(payload.user_id).toBe('alice')
  })

  it('signs aud as the TENANT ID, not the api key', async () => {
    const { aud } = jose.decodeJwt(await dropin.createUserToken('alice'))
    expect(aud).toBe('acme')
  })

  it('defaults to a 1h expiry', async () => {
    const { iat, exp } = jose.decodeJwt(await dropin.createUserToken('alice'))
    expect(exp! - iat!).toBe(3600)
  })

  it('honours expiresIn', async () => {
    const { iat, exp } = jose.decodeJwt(await dropin.createUserToken('alice', { expiresIn: '15m' }))
    expect(exp! - iat!).toBe(900)
  })

  it('refuses a TTL over the 24h ceiling rather than minting a token the gateway rejects', async () => {
    await expect(dropin.createUserToken('alice', { expiresIn: '48h' })).rejects.toThrow(/24h|86400/)
  })

  it('rejects a malformed expiresIn', async () => {
    await expect(dropin.createUserToken('alice', { expiresIn: 'banana' })).rejects.toThrow(/invalid expiresIn/)
  })

  it('always sets iat — the gateway requires it for revocation', async () => {
    const { iat } = jose.decodeJwt(await dropin.createUserToken('alice'))
    expect(typeof iat).toBe('number')
  })
})

describe('createServerToken', () => {
  it('mints a token with no sub and no user_id', async () => {
    const token = await dropin.createServerToken()
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode('ds_test_secret'), {
      algorithms: ['HS256'], issuer: 'dropin', audience: 'acme',
    })
    expect(payload.sub).toBeUndefined()
    expect(payload.user_id).toBeUndefined()
  })
})

describe('construction', () => {
  it('refuses an empty secret rather than minting unsigned tokens', () => {
    expect(() => new DropInServer({ tenantId: 'acme', apiKey: 'dk', apiSecret: '', url: 'http://x' })).toThrow(/apiSecret/)
  })

  it('requires an apiKey', () => {
    expect(() => new DropInServer({ tenantId: 'acme', apiKey: '', apiSecret: 'ds', url: 'http://x' })).toThrow(/apiKey/)
  })

  it('requires a tenantId — it is the aud the gateway verifies against', () => {
    expect(() => new DropInServer({ tenantId: '', apiKey: 'dk', apiSecret: 'ds', url: 'http://x' })).toThrow(/tenantId/)
  })
})

describe('HTTP helpers', () => {
  it('upsertUser POSTs /v1/users with a server-token bearer, api key, and json body', async () => {
    const fn = mockFetchOnce({ status: 200, json: { id: 'zoe', custom: { name: 'Zoe' } } })
    const u = await dropin.upsertUser({ id: 'zoe', custom: { name: 'Zoe' } })
    expect(u).toEqual({ id: 'zoe', custom: { name: 'Zoe' } })
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/users')
    expect(opts.method).toBe('POST')
    expect(opts.headers.authorization).toMatch(/^Bearer /)
    expect(opts.headers['x-api-key']).toBe('dk_test')
    expect(opts.headers['content-type']).toBe('application/json')
    expect(JSON.parse(opts.body!)).toEqual({ id: 'zoe', custom: { name: 'Zoe' } })
  })

  it('upsertUser defaults custom to {} when omitted', async () => {
    const fn = mockFetchOnce({ status: 200, json: { id: 'zoe', custom: {} } })
    await dropin.upsertUser({ id: 'zoe' })
    expect(JSON.parse(lastCall(fn)[1].body!)).toEqual({ id: 'zoe', custom: {} })
  })

  it('feed().addActivity POSTs to the feed activities path', async () => {
    const fn = mockFetchOnce({ status: 201, json: { id: 'a1' } })
    await dropin.feed('user', 'alice').addActivity({ verb: 'post', object: 'w:1' })
    expect(lastCall(fn)[0]).toBe('http://localhost:3000/v1/feeds/user/alice/activities')
    expect(lastCall(fn)[1].method).toBe('POST')
  })

  it('feed().addActivity sends refs as a plain inline-literal field, unmodified', async () => {
    const fn = mockFetchOnce({ status: 201, json: { id: 'a1' } })
    await dropin.feed('user', 'alice').addActivity({
      verb: 'post', object: 'session:1234', custom: { text: 'hi' }, refs: ['session:1234'],
    })
    expect(JSON.parse(lastCall(fn)[1].body!)).toEqual({
      verb: 'post', object: 'session:1234', custom: { text: 'hi' }, refs: ['session:1234'],
    })
  })

  it('feed().get builds a keyset query string with the canonical `next` param', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('user', 'alice').get({ limit: 5, next: 'TOK' })
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/feeds/user/alice?limit=5&next=TOK')
    expect(opts.method).toBe('GET')
    expect(opts.headers['content-type']).toBeUndefined() // no body
  })

  it('feed().get maps the deprecated `cursor` param onto `next`', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('user', 'alice').get({ cursor: 'TOK' })
    const [url] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/feeds/user/alice?next=TOK')
  })

  it('feed().get with no params hits the bare feed path — no next/cursor in the query', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('user', 'alice').get()
    const [url] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/feeds/user/alice')
    expect(url).not.toMatch(/next=|cursor=/)
  })

  it('feed().followStats GETs the stats path and returns the parsed counts', async () => {
    const fn = mockFetchOnce({ status: 200, json: { follower_count: 3, following_count: 7 } })
    const res = await dropin.feed('user', 'bob').followStats()
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/feeds/user/bob/stats')
    expect(opts.method).toBe('GET')
    expect(res).toEqual({ follower_count: 3, following_count: 7 })
  })

  it('throws with the status and body on a non-2xx response', async () => {
    mockFetchOnce({ ok: false, status: 403, text: 'forbidden' })
    await expect(dropin.upsertUser({ id: 'x' })).rejects.toThrow(/403 forbidden/)
  })

  it('treats ANY empty success body as undefined, not just a 204', async () => {
    // POST /v1/feeds/:g/:id/follows answers 201 with NO body (docs/api/v1.yaml:490), and
    // the real undici throws "Unexpected end of JSON input" on res.json() of an empty
    // body — mockFetchOnce's json() resolves undefined instead, which is why every
    // existing test passed while `seed.ts` died on its first follow. Model the real
    // failure here.
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input') },
      text: async () => '',
    })
    vi.stubGlobal('fetch', fn)
    await expect(dropin.feed('flat', 'explore').follow('user', 'maya')).resolves.toBeUndefined()
  })

  it('treats a 204 as an empty success and sends no body', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await expect(dropin.revokeUserTokens('a b')).resolves.toBeUndefined()
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/users/a%20b/revoke-tokens')
    expect(opts.method).toBe('POST')
    expect(opts.headers['content-type']).toBeUndefined()
  })
})

describe('DropInServer.webhooks', () => {
  it('create POSTs the url, list GETs, remove DELETEs — all with a server token', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const fetchMock = vi.fn(async (url: string, init: FetchCallOpts) => {
      calls.push({ method: init.method, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined })
      const status = init.method === 'DELETE' ? 204 : 200
      return {
        ok: true, status,
        json: async () => ({ id: 'd1' }),
        text: async () => JSON.stringify({ id: 'd1' }),
      }
    })
    const server = new DropInServer(
      { tenantId: 'acme', apiKey: 'k', apiSecret: 's', url: 'http://gw' },
      fetchMock as never,
    )
    await server.webhooks.create({ url: 'https://acme.com/h' })
    await server.webhooks.list()
    await server.webhooks.remove('d1')
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/webhooks', body: { url: 'https://acme.com/h' } },
      { method: 'GET', path: '/v1/webhooks', body: undefined },
      { method: 'DELETE', path: '/v1/webhooks/d1', body: undefined },
    ])
    // every webhook call carries the tenant's server-token bearer + api key
    const firstHeaders = (fetchMock.mock.calls[0]![1] as FetchCallOpts).headers
    expect(firstHeaders.authorization).toMatch(/^Bearer /)
    expect(firstHeaders['x-api-key']).toBe('k')
  })
})

describe('DropInServer.promoted', () => {
  it('create POSTs the input body to /v1/promoted', async () => {
    const fn = mockFetchOnce({ status: 201, json: { id: 'p1', served_count: 0 } })
    const row = await dropin.promoted.create({
      actor: 'system:fcurban', verb: 'promote', object: 'game:8842', audience: ['city:belgrade'],
    })
    const [url, opts] = lastCall(fn)
    expect(new URL(url).pathname).toBe('/v1/promoted')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body!)).toEqual({
      actor: 'system:fcurban', verb: 'promote', object: 'game:8842', audience: ['city:belgrade'],
    })
    expect(row.id).toBe('p1')
  })

  it('list GETs with paging params and returns a page', async () => {
    const fn = mockFetchOnce({ json: { results: [{ id: 'p1' }], next: 'cur' } })
    const page = await dropin.promoted.list({ limit: 5, next: 'abc' })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('GET')
    expect(new URL(url).pathname).toBe('/v1/promoted')
    expect(new URL(url).searchParams.get('limit')).toBe('5')
    expect(new URL(url).searchParams.get('next')).toBe('abc')
    expect(page.next).toBe('cur')
  })

  it('remove DELETEs the encoded id', async () => {
    const fn = mockFetchOnce({ status: 204, text: '' })
    await dropin.promoted.remove('a/b')
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).pathname).toBe('/v1/promoted/a%2Fb')
  })

  it('carries the server-token bearer, like every other server-only route', async () => {
    const fn = mockFetchOnce({ status: 201, json: { id: 'p1' } })
    await dropin.promoted.create({ actor: 'a', verb: 'v', object: 'o' })
    const [, opts] = lastCall(fn)
    expect(opts.headers.authorization).toMatch(/^Bearer /)
    expect(opts.headers['x-api-key']).toBe('dk_test')
  })
})

describe('DropInServer.batch', () => {
  it('users POSTs /v1/batch/users with the envelope body and returns parsed results', async () => {
    const results = [{ index: 0, ok: true, id: 'alice' }, { index: 1, ok: false, code: 'INVALID_ARGUMENT' }]
    const fn = mockFetchOnce({ status: 200, json: { results } })
    const res = await dropin.batch.users([{ id: 'alice' }, { id: '' }])
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/batch/users')
    expect(opts.method).toBe('POST')
    expect(opts.headers.authorization).toMatch(/^Bearer /)
    expect(opts.headers['x-api-key']).toBe('dk_test')
    expect(JSON.parse(opts.body!)).toEqual({ users: [{ id: 'alice' }, { id: '' }] })
    expect(res).toEqual({ results })
  })

  it('follows POSTs /v1/batch/follows with the envelope body and returns parsed results', async () => {
    const results = [{ index: 0, ok: true }]
    const fn = mockFetchOnce({ status: 200, json: { results } })
    const res = await dropin.batch.follows([{ source: 'timeline:alice', target: 'user:bob' }])
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/batch/follows')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body!)).toEqual({ follows: [{ source: 'timeline:alice', target: 'user:bob' }] })
    expect(res).toEqual({ results })
  })

  it('userFollows expands plain user ids into the timeline:→user: convention', async () => {
    const results = [{ index: 0, ok: true }, { index: 1, ok: true }]
    const fn = mockFetchOnce({ status: 200, json: { results } })
    const res = await dropin.batch.userFollows([
      { follower: 'alice', following: 'bob' },
      { follower: 'carol', following: 'bob' },
    ])
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/batch/follows')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body!)).toEqual({
      follows: [
        { source: 'timeline:alice', target: 'user:bob' },
        { source: 'timeline:carol', target: 'user:bob' },
      ],
    })
    expect(res).toEqual({ results })
  })

  it('activities POSTs /v1/batch/activities with the envelope body and returns parsed results', async () => {
    const results = [{ index: 0, ok: true, id: 'a1' }]
    const fn = mockFetchOnce({ status: 200, json: { results } })
    const res = await dropin.batch.activities([
      { feed: 'user:alice', activity: { verb: 'post', object: 'game:1', foreign_id: 'g:1', time: '2024-01-01T00:00:00Z' } },
    ])
    const [url, opts] = lastCall(fn)
    expect(url).toBe('http://localhost:3000/v1/batch/activities')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body!)).toEqual({
      activities: [
        { feed: 'user:alice', activity: { verb: 'post', object: 'game:1', foreign_id: 'g:1', time: '2024-01-01T00:00:00Z' } },
      ],
    })
    expect(res).toEqual({ results })
  })
})

describe('DropInServer follow writes — the loud path', () => {
  it('feed().follow POSTs the follow route, which notifies (unlike batch)', async () => {
    const fn = mockFetchOnce({ ok: true, status: 201 })
    await dropin.feed('timeline', 'alice').follow('user', 'bob')
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('POST')
    expect(new URL(url).pathname).toBe('/v1/feeds/timeline/alice/follows')
    expect(JSON.parse(opts.body!)).toEqual({ target: 'user:bob' })
    expect(opts.headers.authorization).toMatch(/^Bearer /)
  })

  it('feed().unfollow DELETEs the target-scoped route', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.feed('timeline', 'alice').unfollow('user', 'bob')
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).pathname).toBe('/v1/feeds/timeline/alice/follows/user/bob')
  })

  it('unfollow encodes every path segment', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.feed('timeline', 'a/b').unfollow('user', 'c d')
    const [url] = lastCall(fn)
    expect(new URL(url).pathname).toBe('/v1/feeds/timeline/a%2Fb/follows/user/c%20d')
  })

  it('follow takes (group, id) like the client SDK, not a "group:id" ref', async () => {
    const fn = mockFetchOnce({ ok: true, status: 201 })
    await dropin.feed('timeline', 'alice').follow('user', 'bob')
    const [, opts] = lastCall(fn)
    expect(JSON.parse(opts.body!).target).toBe('user:bob')
  })

  it('userFollow expands plain ids the same way batch.userFollows does', async () => {
    const fn = mockFetchOnce({ ok: true, status: 201 })
    await dropin.userFollow({ follower: 'alice', following: 'bob' })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('POST')
    expect(new URL(url).pathname).toBe('/v1/feeds/timeline/alice/follows')
    expect(JSON.parse(opts.body!)).toEqual({ target: 'user:bob' })
  })

  it('userUnfollow mirrors userFollow', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.userUnfollow({ follower: 'alice', following: 'bob' })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).pathname).toBe('/v1/feeds/timeline/alice/follows/user/bob')
  })
})

describe('DropInServer reads — parity with the client SDK', () => {
  it('feed().followers pages the followers route', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('user', 'bob').followers({ limit: 50 })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('GET')
    const u = new URL(url)
    expect(u.pathname).toBe('/v1/feeds/user/bob/followers')
    expect(u.searchParams.get('limit')).toBe('50')
  })

  it('feed().following pages the follows route and forwards the cursor', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('timeline', 'alice').following({ next: 'CUR' })
    const [url] = lastCall(fn)
    const u = new URL(url)
    expect(u.pathname).toBe('/v1/feeds/timeline/alice/follows')
    expect(u.searchParams.get('next')).toBe('CUR')
  })

  it('feed().suggestions takes a limit and no cursor', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [] } })
    await dropin.feed('timeline', 'alice').suggestions({ limit: 5 })
    const [url] = lastCall(fn)
    const u = new URL(url)
    expect(u.pathname).toBe('/v1/feeds/timeline/alice/suggestions')
    expect(u.searchParams.get('limit')).toBe('5')
  })

  it('feed().removeActivity DELETEs the activity route, not a feed-scoped one', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.feed('user', 'bob').removeActivity('ACT-1')
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).pathname).toBe('/v1/activities/ACT-1')
  })

  it('reactions.list pages one activity and filters by kind', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.reactions.list('ACT-1', { kind: 'like', limit: 10 })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('GET')
    const u = new URL(url)
    expect(u.pathname).toBe('/v1/activities/ACT-1/reactions')
    expect(u.searchParams.get('kind')).toBe('like')
    expect(u.searchParams.get('limit')).toBe('10')
  })
})

describe('DropInServer.notifications — server tokens act for a named owner', () => {
  it('list sends owner as a query param', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [], unseen: 0, unread: 0, next: null } })
    await dropin.notifications.list({ owner: 'bob', limit: 20 })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('GET')
    const u = new URL(url)
    expect(u.pathname).toBe('/v1/notifications')
    expect(u.searchParams.get('owner')).toBe('bob')
    expect(u.searchParams.get('limit')).toBe('20')
  })

  it('markSeen with ids sends them alongside the owner', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.notifications.markSeen({ owner: 'bob', ids: ['N1', 'N2'] })
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('POST')
    expect(new URL(url).pathname).toBe('/v1/notifications/mark')
    expect(JSON.parse(opts.body!)).toEqual({ owner: 'bob', seen: ['N1', 'N2'] })
  })

  it('markSeen without ids means ALL — seen: true, matching the client SDK', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.notifications.markSeen({ owner: 'bob' })
    const [, opts] = lastCall(fn)
    expect(JSON.parse(opts.body!)).toEqual({ owner: 'bob', seen: true })
  })

  it('an empty ids array also means ALL, never an empty mark the API would reject', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.notifications.markSeen({ owner: 'bob', ids: [] })
    const [, opts] = lastCall(fn)
    expect(JSON.parse(opts.body!)).toEqual({ owner: 'bob', seen: true })
  })

  it('markRead mirrors markSeen on the read field', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.notifications.markRead({ owner: 'bob', ids: ['N1'] })
    const [, opts] = lastCall(fn)
    expect(JSON.parse(opts.body!)).toEqual({ owner: 'bob', read: ['N1'] })
  })
})

describe('DropInServer.reactions', () => {
  it('delete DELETEs /v1/reactions/:reactionId with a server token', async () => {
    const fn = mockFetchOnce({ ok: true, status: 204 })
    await dropin.reactions.delete('R-ID')
    const [url, opts] = lastCall(fn)
    expect(opts.method).toBe('DELETE')
    expect(new URL(url).pathname).toBe('/v1/reactions/R-ID')
    expect(opts.headers.authorization).toMatch(/^Bearer /)
  })
})

describe('objects and patch', () => {
  function recordingServer() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const fetchMock = vi.fn(async (url: string, init: FetchCallOpts) => {
      calls.push({ method: init.method, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined })
      const status = init.method === 'DELETE' ? 204 : 200
      return {
        ok: true, status,
        json: async () => ({ type: 'session', id: '1', custom: {}, updated_at: '2026-08-07T00:00:00Z' }),
        text: async () => (status === 204 ? '' : JSON.stringify({ type: 'session', id: '1', custom: {}, updated_at: '2026-08-07T00:00:00Z' })),
      }
    })
    const server = new DropInServer(
      { tenantId: 'acme', apiKey: 'k', apiSecret: 's', url: 'http://gw' },
      fetchMock as never,
    )
    return { server, calls, fetchMock }
  }

  it('upserts an object with PUT', async () => {
    const { server, calls } = recordingServer()
    const obj = await server.objects.upsert('session', '1', { spots_left: 2 })
    expect(calls).toEqual([
      { method: 'PUT', path: '/v1/objects/session/1', body: { custom: { spots_left: 2 } } },
    ])
    expect(obj.type).toBe('session')
  })

  it('url-encodes type and id', async () => {
    const { server, calls } = recordingServer()
    await server.objects.get('a/b', 'c d')
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/objects/a%2Fb/c%20d', body: undefined },
    ])
  })

  it('patches an object with PATCH', async () => {
    const { server, calls } = recordingServer()
    await server.objects.patch('session', '1', { set: { 'custom.spots_left': 1 } })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/v1/objects/session/1', body: { set: { 'custom.spots_left': 1 } } },
    ])
  })

  it('removes an object', async () => {
    const { server, calls } = recordingServer()
    await expect(server.objects.remove('session', '1')).resolves.toBeUndefined()
    expect(calls).toEqual([
      { method: 'DELETE', path: '/v1/objects/session/1', body: undefined },
    ])
  })

  it('batch-reads objects with one repeated refs param per ref', async () => {
    const { server, fetchMock } = recordingServer()
    await server.objects.getMany(['session:1', 'venue:9'])
    expect(new URL(fetchMock.mock.calls[0]![0] as string).search)
      .toBe('?refs=session%3A1&refs=venue%3A9')
  })

  // Repeated rather than comma-joined: `type:id` constrains colons, not commas, so
  // joining would shred an id containing one into two refs that match nothing.
  it('keeps a comma inside an id intact', async () => {
    const { server, fetchMock } = recordingServer()
    await server.objects.getMany(['venue:north,south'])
    expect(new URL(fetchMock.mock.calls[0]![0] as string).search)
      .toBe('?refs=venue%3Anorth%2Csouth')
  })

  it('short-circuits an empty ref list without a request', async () => {
    const { server, fetchMock } = recordingServer()
    await expect(server.objects.getMany([])).resolves.toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('patches an activity', async () => {
    const { server, calls } = recordingServer()
    await server.activities.patch('a1', { set: { 'custom.title': 'fixed' } })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/v1/activities/a1', body: { set: { 'custom.title': 'fixed' } } },
    ])
  })

  it('patches an activity with refs — the backfill path, no custom set/unset needed', async () => {
    const { server, calls } = recordingServer()
    await server.activities.patch('a1', { refs: ['session:1234'] })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/v1/activities/a1', body: { refs: ['session:1234'] } },
    ])
  })

  it('patches an activity with refs alongside a custom set — refs reaches the wire in the same body', async () => {
    const { server, calls } = recordingServer()
    await server.activities.patch('a1', { set: { 'custom.title': 'fixed' }, refs: ['session:1234'] })
    expect(calls).toEqual([
      {
        method: 'PATCH', path: '/v1/activities/a1',
        body: { set: { 'custom.title': 'fixed' }, refs: ['session:1234'] },
      },
    ])
  })

  it('patches an activity with refs: [] to clear every ref', async () => {
    const { server, calls } = recordingServer()
    await server.activities.patch('a1', { refs: [] })
    expect(calls).toEqual([
      { method: 'PATCH', path: '/v1/activities/a1', body: { refs: [] } },
    ])
  })

  it('bulk-upserts objects', async () => {
    const { server, calls } = recordingServer()
    const objects = [{ type: 'session', id: '1', custom: { spots_left: 2 } }]
    await server.batch.objects(objects)
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/batch/objects', body: { objects } },
    ])
  })

  it('carries the server-token bearer, like every other server-only route', async () => {
    const { server, fetchMock } = recordingServer()
    await server.objects.get('session', '1')
    const headers = (fetchMock.mock.calls[0]![1] as FetchCallOpts).headers
    expect(headers.authorization).toMatch(/^Bearer /)
    expect(headers['x-api-key']).toBe('k')
  })
})

describe('AbortSignal', () => {
  it('forwards the signal to fetch', async () => {
    const ctrl = new AbortController()
    const fn = mockFetchOnce({ status: 200, json: { id: 'alice', custom: {} } })
    await dropin.upsertUser({ id: 'alice' }, { signal: ctrl.signal })
    expect((lastCall(fn)[1] as unknown as { signal: AbortSignal }).signal).toBe(ctrl.signal)
  })

  it('attaches the default timeout signal when none is given (dx-round3 spec §2)', async () => {
    const fn = mockFetchOnce({ status: 200, json: { id: 'alice', custom: {} } })
    await dropin.upsertUser({ id: 'alice' })
    const { signal } = lastCall(fn)[1] as unknown as { signal?: AbortSignal }
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('rejects an already-aborted call without signing a token or calling fetch', async () => {
    const fn = mockFetchOnce({ status: 204 })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(dropin.revokeUserTokens('alice', { signal: ctrl.signal })).rejects.toThrow()
    expect(fn).not.toHaveBeenCalled()
  })

  it('preserves a caller-supplied abort reason', async () => {
    mockFetchOnce({ status: 204 })
    const reason = new Error('request superseded')
    const ctrl = new AbortController()
    ctrl.abort(reason)
    await expect(dropin.webhooks.list({ signal: ctrl.signal })).rejects.toBe(reason)
  })

  it('reaches the feed and webhook surfaces too', async () => {
    const ctrl = new AbortController()
    const fn = mockFetchOnce({ status: 200, json: { results: [], next: null } })
    await dropin.feed('user', 'alice').get({ limit: 5 }, { signal: ctrl.signal })
    expect((lastCall(fn)[1] as unknown as { signal: AbortSignal }).signal).toBe(ctrl.signal)
  })
})

describe('webhooks.list typing', () => {
  it('returns destinations whose id is typed, with provider extras still reachable', async () => {
    mockFetchOnce({
      status: 200,
      json: [{ id: 'des_1', type: 'webhook', topics: ['*'], config: { url: 'https://acme.com/h' }, some_future_field: 7 }],
    })
    const [dest] = await dropin.webhooks.list()
    // `id` is a typed string — no cast needed at the call site, which is the whole point.
    expect(dest!.id.toUpperCase()).toBe('DES_1')
    expect(dest!.config?.url).toBe('https://acme.com/h')
    expect(dest!.some_future_field).toBe(7)
  })
})

describe('base URL', () => {
  it('defaults to the hosted API when url is omitted', async () => {
    const fn = mockFetchOnce({ status: 200, json: { id: 'alice', custom: {} } })
    const server = new DropInServer({ tenantId: 'acme', apiKey: 'k', apiSecret: 's' })
    await server.upsertUser({ id: 'alice' })
    expect(lastCall(fn)[0]).toBe(`${DEFAULT_API_URL}/v1/users`)
  })

  it('uses an explicit url instead — staging, a proxy, or local development', async () => {
    const fn = mockFetchOnce({ status: 200, json: { id: 'alice', custom: {} } })
    await dropin.upsertUser({ id: 'alice' })
    expect(lastCall(fn)[0]).toBe('http://localhost:3000/v1/users')
  })

  it('points at https, so a default install is never plaintext', () => {
    expect(DEFAULT_API_URL.startsWith('https://')).toBe(true)
    expect(DEFAULT_API_URL.endsWith('/')).toBe(false)
  })
})

describe('request timeout', () => {
  it('attaches a default timeout signal when the caller passes none', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [] } })
    await dropin.batch.users([{ id: 'a' }])
    const [, opts] = lastCall(fn)
    expect((opts as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal)
  })

  it('a caller-supplied signal replaces the default entirely', async () => {
    const fn = mockFetchOnce({ status: 200, json: { results: [] } })
    const ac = new AbortController()
    await dropin.batch.users([{ id: 'a' }], { signal: ac.signal })
    const [, opts] = lastCall(fn)
    expect((opts as { signal?: AbortSignal }).signal).toBe(ac.signal)
  })

  it('timeoutMs option bounds a hanging request', async () => {
    const short = new DropInServer({
      tenantId: 'acme', apiKey: 'dk_test', apiSecret: 'ds_test_secret',
      url: 'http://localhost:3000', timeoutMs: 20,
    })
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })))
    await expect(short.batch.users([{ id: 'a' }])).rejects.toThrow(/timeout|abort/i)
  })
})

describe('dot-segment path guard', () => {
  // `encodeURIComponent` leaves `.` untouched. A segment that is EXACTLY `.` or `..`
  // survives encoding and is then removed by the URL parser inside fetch, before the
  // request is sent — letting one dynamic segment cancel a literal route segment and
  // the next dynamic segment name an arbitrary sibling route. Every interpolated path
  // segment in the SDK must reject this rather than silently retargeting the request.

  it('rejects a "." segment without calling fetch', async () => {
    const fn = mockFetchOnce({ status: 200 })
    await expect(dropin.objects.get('.', 'x')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects a ".." segment without calling fetch', async () => {
    const fn = mockFetchOnce({ status: 200 })
    await expect(dropin.objects.get('..', 'x')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects ".." in the second segment too', async () => {
    const fn = mockFetchOnce({ status: 200 })
    await expect(dropin.objects.get('x', '..')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('REGRESSION: objects.get(\'..\', \'activities\') can no longer redirect to /v1/activities', async () => {
    // This is the exact confused-deputy shape from the report: a tenant looping
    // objects.get(type, id) over their own catalogue, where a record's `type` happens
    // to be '..', would otherwise cancel the literal `objects` segment and hit an
    // arbitrary sibling route carrying this SDK's server token.
    const fn = mockFetchOnce({ status: 200 })
    await expect(dropin.objects.get('..', 'activities')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
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
    const fn = mockFetchOnce({ status: 204 })
    expect(() => dropin.feed('.', 'alice')).not.toThrow()
    expect(() => dropin.feed('user', '..')).not.toThrow()
    await expect(dropin.feed('.', 'alice').get()).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('user', '..').get()).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').addActivity({ verb: 'post', object: 'w:1' })).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').followStats()).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').follow('user', 'bob')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').followers()).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').following()).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('.', 'alice').suggestions()).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects dot segments on feed().unfollow target', async () => {
    const fn = mockFetchOnce({ status: 204 })
    await expect(dropin.feed('timeline', 'alice').unfollow('..', 'bob')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('timeline', 'alice').unfollow('user', '.')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects dot segments on every single-segment call site', async () => {
    const fn = mockFetchOnce({ status: 204 })
    await expect(dropin.revokeUserTokens('..')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.webhooks.remove('.')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.promoted.remove('..')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.activities.patch('.', { set: {} })).rejects.toThrow(/invalid path segment/)
    await expect(dropin.reactions.delete('..')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.reactions.list('.')).rejects.toThrow(/invalid path segment/)
    await expect(dropin.feed('user', 'bob').removeActivity('..')).rejects.toThrow(/invalid path segment/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('still allows the safe cases the guard must not break', async () => {
    // "/" — a literal slash, inert once encoded.
    const fn1 = mockFetchOnce({ status: 200, json: { type: 'a/b', id: 'x', custom: {}, updated_at: 't' } })
    await dropin.objects.get('a/b', 'x')
    expect(new URL(lastCall(fn1)[0]).pathname).toBe('/v1/objects/a%2Fb/x')

    // A pre-encoded "%2F" stays inert too, double-encoded by encodeURIComponent.
    const fn2 = mockFetchOnce({ status: 200, json: { type: '%2F', id: 'x', custom: {}, updated_at: 't' } })
    await dropin.objects.get('%2F', 'x')
    expect(new URL(lastCall(fn2)[0]).pathname).toBe('/v1/objects/%252F/x')

    // Unicode passes through fine.
    const fn3 = mockFetchOnce({ status: 200, json: { type: 'café', id: 'x', custom: {}, updated_at: 't' } })
    await dropin.objects.get('café', 'x')
    expect(new URL(lastCall(fn3)[0]).pathname).toBe('/v1/objects/caf%C3%A9/x')

    // A legitimate dot INSIDE a longer segment (e.g. a version string) must be allowed —
    // only a segment that is ENTIRELY "." or ".." is rejected.
    const fn4 = mockFetchOnce({ status: 200, json: { type: 'release', id: 'v1.2', custom: {}, updated_at: 't' } })
    await dropin.objects.get('release', 'v1.2')
    expect(new URL(lastCall(fn4)[0]).pathname).toBe('/v1/objects/release/v1.2')
  })
})
