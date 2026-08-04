import { describe, it, expect, vi, afterEach } from 'vitest'
import * as jose from 'jose'
import { DropInServer, DEFAULT_API_URL } from './index.js'

const dropin = new DropInServer({
  tenantId: 'acme', apiKey: 'dk_test', apiSecret: 'ds_test_secret', url: 'http://localhost:3000',
})

interface FetchCallOpts { method: string; headers: Record<string, string>; body?: string }
function mockFetchOnce(res: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  const fn = vi.fn().mockResolvedValue({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => res.json,
    text: async () => res.text ?? '',
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
