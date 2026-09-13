import { describe, it, expect } from 'vitest'
import { DropInClient, DropInApiError } from '@dropinnodex/client'
import { createTestDropin } from './index.js'

/** The documented way to wire it: a REAL client, transported by the fake. */
function connect(dropin: ReturnType<typeof createTestDropin>, userId: string) {
  return new DropInClient({
    apiKey: 'test', url: 'http://test.local',
    tokenProvider: async () => dropin.mintToken(userId),
    fetch: dropin.fetch,
  })
}

describe('createTestDropin', () => {
  it('fans out on write, along follow edges, before the write resolves', async () => {
    const dropin = createTestDropin()
    const maya = connect(dropin, 'maya')

    await maya.feed('timeline', 'maya').follow('user', 'diego')
    await connect(dropin, 'diego').feed('user', 'diego').addActivity({ verb: 'post', object: 'w:1' })

    const timeline = await maya.feed('timeline', 'maya').get()
    expect(timeline.results.map((a) => a.object)).toEqual(['w:1'])
  })

  it('does not backfill a new follow — the edge only carries what comes after it', async () => {
    const dropin = createTestDropin()
    await connect(dropin, 'diego').feed('user', 'diego').addActivity({ verb: 'post', object: 'old:1' })
    const maya = connect(dropin, 'maya')
    await maya.feed('timeline', 'maya').follow('user', 'diego')

    expect((await maya.feed('timeline', 'maya').get()).results).toEqual([])
  })

  it('overwrites actor on a user-token write and provisions the user', async () => {
    const dropin = createTestDropin()
    const c = connect(dropin, 'maya')
    // A user token cannot claim to be someone else, however hard it tries.
    const a = await c.feed('user', 'maya').addActivity({ verb: 'post', object: 'w:1', actor: 'user:diego' } as never)
    expect(a.actor).toBe('user:maya')
    expect(a.actor_user).toEqual({ id: 'maya', custom: {} }) // auto-provisioned, not null
  })

  it('dedupes (foreign_id, time) and burns the identity on delete', async () => {
    const dropin = createTestDropin()
    const c = connect(dropin, 'maya')
    const body = { verb: 'post', object: 'w:1', foreign_id: 'w-1', time: new Date().toISOString() }

    const first = await c.feed('user', 'maya').addActivity(body)
    const replay = await c.feed('user', 'maya').addActivity(body)
    expect(replay.id).toBe(first.id) // same row, no second fan-out

    await c.feed('user', 'maya').removeActivity(first.id)
    await expect(c.feed('user', 'maya').addActivity(body)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('rejects foreign_id without time, the way the API does', async () => {
    const dropin = createTestDropin()
    await expect(
      connect(dropin, 'maya').feed('user', 'maya').addActivity({ verb: 'post', object: 'w:1', foreign_id: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('paginates by keyset, newest first, with no overlap between pages', async () => {
    const dropin = createTestDropin()
    const c = connect(dropin, 'maya')
    for (let i = 0; i < 5; i++) await c.feed('user', 'maya').addActivity({ verb: 'post', object: `w:${i}` })

    const p1 = await c.feed('user', 'maya').get({ limit: 2 })
    expect(p1.results.map((a) => a.object)).toEqual(['w:4', 'w:3'])
    const p2 = await c.feed('user', 'maya').get({ limit: 2, next: p1.next! })
    expect(p2.results.map((a) => a.object)).toEqual(['w:2', 'w:1'])
    expect(p2.next).not.toBeNull()
  })

  it('resolves refs into the objects sidecar, and skips ones with no object', async () => {
    const dropin = createTestDropin()
    const c = connect(dropin, 'maya')
    dropin.objects.upsert('session', '1', { spots_left: 3 })
    await c.feed('user', 'maya').addActivity({ verb: 'post', object: 's:1', refs: ['session:1', 'ghost:9'] })

    const page = await c.feed('user', 'maya').get()
    expect(page.objects?.['session:1']?.custom).toEqual({ spots_left: 3 })
    expect(page.objects?.['ghost:9']).toBeUndefined()
  })

  it('counts reactions and reports own_reactions per caller', async () => {
    const dropin = createTestDropin()
    const maya = connect(dropin, 'maya')
    const a = await maya.feed('user', 'maya').addActivity({ verb: 'post', object: 'w:1' })
    await maya.reactions.add('like', a.id)
    await connect(dropin, 'diego').reactions.add('like', a.id)

    const mine = (await maya.feed('user', 'maya').get()).results[0]!
    expect(mine.reaction_counts).toEqual({ like: 2 })
    expect(mine.own_reactions).toEqual(['like'])

    const theirs = (await connect(dropin, 'sam').feed('user', 'maya').get()).results[0]!
    expect(theirs.own_reactions).toEqual([]) // sam liked nothing
  })

  describe('failure injection', () => {
    it('expireTokens() forces the 401 path, and the client re-mints once', async () => {
      const dropin = createTestDropin()
      const c = connect(dropin, 'maya')
      await c.feed('user', 'maya').get()

      dropin.expireTokens()
      await expect(c.feed('user', 'maya').get()).resolves.toBeDefined() // recovered silently
      expect(dropin.requests().filter((r) => r.status === 401)).toHaveLength(1)
    })

    it('one mint serves every request that 401s together', async () => {
      // The bug a tenant found by revoking: N in-flight requests used to mean N mints.
      const dropin = createTestDropin()
      let minted = 0
      const c = new DropInClient({
        apiKey: 'test', url: 'http://test.local',
        tokenProvider: async () => { minted++; return dropin.mintToken('maya') },
        fetch: dropin.fetch,
      })
      await c.feed('user', 'maya').get()
      expect(minted).toBe(1)

      dropin.expireTokens()
      await Promise.all([
        c.feed('user', 'maya').get(),
        c.feed('timeline', 'maya').get(),
        c.feed('flat', 'explore').get(),
      ])
      expect(minted).toBe(2) // one initial, one shared refresh — not four
    })

    it('failNext() surfaces a real DropInApiError with Retry-After', async () => {
      const dropin = createTestDropin()
      dropin.failNext({ code: 'RATE_LIMITED', retryAfterSeconds: 3 })
      const err = await connect(dropin, 'maya').feed('user', 'maya').get().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DropInApiError)
      expect(err).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 3 })
    })

    it('records every request in order, so tests can assert COUNTS', async () => {
      const dropin = createTestDropin()
      await connect(dropin, 'maya').feed('user', 'maya').get({ limit: 5 })
      expect(dropin.requests()).toHaveLength(1)
      expect(dropin.requests()[0]).toMatchObject({ method: 'GET', status: 200 })
      expect(dropin.requests()[0]!.path).toContain('/v1/feeds/user/maya')
    })
  })
})

describe('createTestDropin — remove by foreign_id', () => {
  it("removes the post from followers' timelines before the call resolves", async () => {
    const dropin = createTestDropin()
    const maya = connect(dropin, 'maya')
    const diego = connect(dropin, 'diego')
    await maya.feed('timeline', 'maya').follow('user', 'diego')

    const time = new Date(Date.now() - 60_000).toISOString()
    const posted = await diego.feed('user', 'diego').addActivity({
      verb: 'attend', object: 'session:1', foreign_id: 'attend:1', time,
    })
    expect((await maya.feed('timeline', 'maya').get()).results.map((a) => a.id)).toEqual([posted.id])

    await expect(diego.feed('user', 'diego').removeActivity({ foreign_id: 'attend:1', time: posted.time }))
      .resolves.toEqual({ removed: [posted.id] })
    expect((await maya.feed('timeline', 'maya').get()).results).toEqual([])
  })

  // Raw requests: the client cannot send a repeated key or an absent foreign_id, the API can receive them.
  async function del(dropin: ReturnType<typeof createTestDropin>, userId: string, feed: string, query: string) {
    const res = await dropin.fetch(`http://test.local/v1/feeds/${feed}/activities?${query}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${dropin.mintToken(userId)}` },
    })
    return { status: res.status, body: await res.json() as { removed?: string[]; error?: { code: string } } }
  }

  it('accepts a UTC Z time with or without fraction digits', async () => {
    const dropin = createTestDropin()
    for (const time of ['2026-09-13T10:00:00Z', '2026-09-13T10:00:00.000Z', '2026-09-13T10:00Z']) {
      await expect(connect(dropin, 'maya').feed('user', 'maya').removeActivity({ foreign_id: 'x', time }))
        .resolves.toEqual({ removed: [] })
    }
  })

  // Exactly what the service's z.string().datetime() rejects, which is more than Date.parse does.
  it.each([
    ['date-only', 'time=2026-09-13'],
    ['an offset', 'time=2026-09-13T10:00:00%2B02:00'],
    ['a zoneless local time', 'time=2026-09-13T10:00:00'],
    ['an impossible calendar date', 'time=2026-02-30T10:00:00Z'],
    ['hour 24', 'time=2026-09-13T24:00:00Z'],
    ['an empty time', 'time='],
    ['a repeated time', 'time=2026-09-13T10:00:00Z&time=2026-09-13T10:00:00Z'],
  ])('rejects %s with VALIDATION_FAILED', async (_, time) => {
    const r = await del(createTestDropin(), 'maya', 'user/maya', `foreign_id=x&${time}`)
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } })
  })

  it.each([
    ['missing', ''],
    ['empty', 'foreign_id='],
    ['repeated', 'foreign_id=a&foreign_id=b'],
  ])('rejects a %s foreign_id with VALIDATION_FAILED', async (_, query) => {
    const r = await del(createTestDropin(), 'maya', 'user/maya', query)
    expect(r).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_FAILED' } } })
  })

  it('refuses a user token outside its own user feed, matching or not', async () => {
    const dropin = createTestDropin()
    const time = new Date(Date.now() - 60_000).toISOString()
    await connect(dropin, 'diego').feed('user', 'diego').addActivity({ verb: 'post', object: 'w:1', foreign_id: 'f', time })
    for (const feed of ['user/diego', 'timeline/maya']) {
      const r = await del(dropin, 'maya', feed, 'foreign_id=f')
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } })
    }
    expect(dropin.store.activities[0]!.deleted_at).toBeNull()
  })
})
