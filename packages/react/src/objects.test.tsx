import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, waitFor, act } from '@testing-library/react'
import React from 'react'
import { DropInProvider, useFeed, resolveRefs } from './index.js'
import type { Activity, DropInObject } from '@dropinnodex/client'

// Harness copied from hooks.test.tsx — same fixtures/shape, extended with refs/edited_at
// (Task 5/12) and a feed().updateActivity mock (Task 12) that hooks.test.tsx's own
// makeClient doesn't carry yet.
const activity = (
  id: string,
  refs: string[] = [],
  over: Record<string, unknown> = {},
): Activity => ({
  id, actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
  time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
  reaction_counts: {}, actor_user: null, own_reactions: [],
  refs, edited_at: null, version: 1,
  ...over,
}) as Activity

const dropInObject = (type: string, id: string, custom: Record<string, unknown> = {}): DropInObject => ({
  type, id, custom, updated_at: '2026-08-01T00:00:00Z',
})

function makeClient(over: Record<string, unknown> = {}) {
  return {
    feed: vi.fn(() => ({
      get: vi.fn(async () => ({ results: [activity('a1')], next: null })),
      addActivity: vi.fn(async () => activity('new')),
      updateActivity: vi.fn(async (id: string) => activity(id)),
      follow: vi.fn(async () => undefined),
      unfollow: vi.fn(async () => undefined),
      following: vi.fn(async () => ({ results: [], next: null })),
      removeActivity: vi.fn(async () => undefined),
      suggestions: vi.fn(async () => ({ results: [] })),
      head: vi.fn(async () => ({ latest: null })),
    })),
    reactions: {
      add: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
    },
    ...over,
  }
}

function wrapper(client: unknown) {
  return ({ children }: { children: React.ReactNode }) =>
    <DropInProvider client={client as never}>{children}</DropInProvider>
}

describe('resolveRefs', () => {
  it("maps an activity's refs onto the matching objects entries, in ref order", () => {
    const a = activity('a1', ['loc:1', 'org:2'])
    const objects = {
      'org:2': dropInObject('org', '2', { name: 'Org' }),
      'loc:1': dropInObject('loc', '1', { name: 'Loc' }),
    }
    expect(resolveRefs(a, objects)).toEqual([objects['loc:1'], objects['org:2']])
  })

  it('skips a ref with no stored object rather than yielding a hole', () => {
    const a = activity('a1', ['loc:1', 'loc:missing'])
    const objects = { 'loc:1': dropInObject('loc', '1') }
    expect(resolveRefs(a, objects)).toEqual([objects['loc:1']])
  })

  it('returns [] when the sidecar is absent', () => {
    const a = activity('a1', ['loc:1'])
    expect(resolveRefs(a, undefined)).toEqual([])
  })

  it('returns [] for an activity with no refs', () => {
    const a = activity('a1', [])
    expect(resolveRefs(a, { 'loc:1': dropInObject('loc', '1') })).toEqual([])
  })
})

describe('useFeed objects sidecar', () => {
  it('exposes the sidecar from the first page', async () => {
    const objects = { 'loc:1': dropInObject('loc', '1', { name: 'Court A' }) }
    const get = vi.fn(async () => ({ results: [activity('a1', ['loc:1'])], next: null, objects }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity: vi.fn() })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.objects).toEqual(objects)
  })

  it('is {} (not undefined) when the server omits the objects key', async () => {
    const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity: vi.fn() })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.objects).toEqual({})
  })

  it('loadNext MERGES a later page objects into the existing map rather than replacing it', async () => {
    const page1Objects = { 'loc:1': dropInObject('loc', '1', { name: 'Court A' }) }
    const page2Objects = { 'org:9': dropInObject('org', '9', { name: 'Acme' }) }
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1', ['loc:1'])], next: 'cur1', objects: page1Objects })
      .mockResolvedValueOnce({ results: [activity('a2', ['org:9'])], next: null, objects: page2Objects })
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity: vi.fn() })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    expect(result.current.objects).toEqual(page1Objects)

    await act(async () => { await result.current.loadNext() })
    // Both refs resolvable now — a blanket replace would have dropped loc:1.
    expect(result.current.objects).toEqual({ ...page1Objects, ...page2Objects })
  })

  it('addActivity does not erase the cached objects/promoted sidecars for a later mount', async () => {
    const objects = { 'loc:1': dropInObject('loc', '1', { name: 'Court A' }) }
    const get = vi.fn(async () => ({ results: [activity('a1', ['loc:1'])], next: null, objects }))
    const addActivity = vi.fn(async () => activity('new'))
    const client = makeClient({ feed: vi.fn(() => ({ get, addActivity, updateActivity: vi.fn() })) })
    let a: ReturnType<typeof useFeed> | undefined
    let b: ReturnType<typeof useFeed> | undefined
    function A() { a = useFeed('timeline', 'alice'); return null }
    function B() { b = useFeed('timeline', 'alice'); return null }
    const { rerender } = render(<DropInProvider client={client as never}><A /></DropInProvider>)
    await waitFor(() => expect(a!.isLoading).toBe(false))
    expect(a!.objects).toEqual(objects)

    await act(async () => { await a!.addActivity({ verb: 'post', object: 'w:1' }) })

    // B mounts under the SAME provider, on the SAME feed key, and seeds from the cache
    // entry addActivity just wrote — `setCache` REPLACES the whole entry, so if
    // addActivity forgot to carry `objects` forward, B would seed with `{}`.
    rerender(<DropInProvider client={client as never}><A /><B /></DropInProvider>)
    expect(b!.isLoading).toBe(false)
    expect(b!.objects).toEqual(objects)
  })
})

describe('useFeed updateActivity', () => {
  it('applies optimistically, then keeps the server value (edited_at, coercion)', async () => {
    let resolveUpdate!: (v: Activity) => void
    const updateActivity = vi.fn(() => new Promise<Activity>((r) => { resolveUpdate = r }))
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: { a: 1 } })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p!: Promise<Activity | undefined>
    act(() => { p = result.current.updateActivity('a1', { set: { 'custom.a': 2 } }) })
    expect(result.current.activities[0]!.custom).toEqual({ a: 2 }) // optimistic

    const serverActivity = activity('a1', [], { custom: { a: 2 }, edited_at: '2026-08-07T00:00:00Z' })
    await act(async () => { resolveUpdate(serverActivity); await p })
    expect(result.current.activities[0]!.edited_at).toBe('2026-08-07T00:00:00Z')
    expect(result.current.activities[0]!.custom).toEqual({ a: 2 })
    expect(updateActivity).toHaveBeenCalledWith('a1', { set: { 'custom.a': 2 } })
  })

  it('rolls back AND rejects on failure with no onError', async () => {
    const updateActivity = vi.fn(async () => { throw new Error('boom') })
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: { a: 1 } })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await expect(result.current.updateActivity('a1', { set: { 'custom.a': 2 } })).rejects.toThrow('boom')
    })
    expect(result.current.activities[0]!.custom).toEqual({ a: 1 })
  })

  it('with onError supplied, rolls back and resolves undefined, calling the handler', async () => {
    const err = new Error('boom')
    const updateActivity = vi.fn(async () => { throw err })
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: { a: 1 } })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const onError = vi.fn()
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let resolved: Activity | undefined
    await act(async () => {
      resolved = await result.current.updateActivity('a1', { set: { 'custom.a': 2 } }, { onError })
    })
    expect(resolved).toBeUndefined()
    expect(result.current.activities[0]!.custom).toEqual({ a: 1 }) // rolled back
    expect(onError).toHaveBeenCalledWith(err, { hook: 'useFeed', action: 'updateActivity', activityId: 'a1' })
  })

  it('is a full no-op inside a disabled provider — no optimistic write, resolves undefined', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeed('timeline', 'alice'), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <DropInProvider client={client as never} enabled={false}>{children}</DropInProvider>
      ),
    })
    const resolved = await result.current.updateActivity('a1', { set: { 'custom.a': 2 } })
    expect(resolved).toBeUndefined()
    expect(client.feed).not.toHaveBeenCalled()
  })

  describe('refs', () => {
    it('is NOT applied optimistically — activity.refs stays put until the server responds', async () => {
      let resolveUpdate!: (v: Activity) => void
      const updateActivity = vi.fn(() => new Promise<Activity>((r) => { resolveUpdate = r }))
      const get = vi.fn(async () => ({ results: [activity('a1', ['session:1'])], next: null }))
      const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
      const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      let p!: Promise<Activity | undefined>
      act(() => { p = result.current.updateActivity('a1', { refs: ['session:2'] }) })
      // Unlike `custom`, refs is deliberately not echoed by the optimistic step — see
      // applyPatch's doc comment. The old refs are still what's rendered right now.
      expect(result.current.activities[0]!.refs).toEqual(['session:1'])

      const serverActivity = activity('a1', ['session:2'])
      await act(async () => { resolveUpdate(serverActivity); await p })
      // The server's response replaces the whole activity, refs included — no extra
      // code needed for this to land the moment the network call resolves.
      expect(result.current.activities[0]!.refs).toEqual(['session:2'])
      expect(updateActivity).toHaveBeenCalledWith('a1', { refs: ['session:2'] })
    })

    it('accepts a refs-only body with no set/unset', async () => {
      const updateActivity = vi.fn(async (id: string) => activity(id, ['session:9']))
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
      const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      const resolved = await act(() => result.current.updateActivity('a1', { refs: ['session:9'] }))
      expect(resolved?.refs).toEqual(['session:9'])
      expect(result.current.activities[0]!.refs).toEqual(['session:9'])
    })

    it('a failing refs-only patch rejects with nothing to roll back (refs was never applied optimistically)', async () => {
      const updateActivity = vi.fn(async () => { throw new Error('boom') })
      const get = vi.fn(async () => ({ results: [activity('a1', ['session:1'])], next: null }))
      const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
      const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      await act(async () => {
        await expect(result.current.updateActivity('a1', { refs: ['session:2'] })).rejects.toThrow('boom')
      })
      expect(result.current.activities[0]!.refs).toEqual(['session:1'])
    })
  })

  it('a refresh() landing mid-flight is not discarded by a later-failing patch (scoped rollback)', async () => {
    let rejectUpdate!: (e: Error) => void
    const updateActivity = vi.fn(() => new Promise<Activity>((_res, rej) => { rejectUpdate = rej }))
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1', [], { custom: { a: 1 } })], next: null }) // initial load
      .mockResolvedValueOnce({
        results: [activity('a2'), activity('a1', [], { custom: { a: 1 } })], next: null,
      }) // refresh, lands while the patch below is still in flight
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p!: Promise<Activity | undefined>
    act(() => { p = result.current.updateActivity('a1', { set: { 'custom.a': 2 } }) })
    expect(result.current.activities[0]!.custom).toEqual({ a: 2 }) // optimistic

    await act(async () => { await result.current.refresh() })
    expect(result.current.activities.map((a) => a.id)).toEqual(['a2', 'a1'])

    await act(async () => {
      rejectUpdate(new Error('boom'))
      await expect(p).rejects.toThrow('boom')
    })
    // A whole-array rollback would have restored the PRE-refresh snapshot (['a1'] only),
    // silently discarding a2. The scoped rollback only touches a1's own custom field.
    expect(result.current.activities.map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('two overlapping patches on one activity: an earlier failure does not stomp the later optimistic value', async () => {
    let rejectFirst!: (e: Error) => void
    const updateActivity = vi.fn()
      .mockImplementationOnce(() => new Promise<Activity>((_res, rej) => { rejectFirst = rej }))
      .mockImplementationOnce(() => new Promise<Activity>(() => {})) // second call: never resolves
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: { a: 1 } })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p1!: Promise<Activity | undefined>
    act(() => { p1 = result.current.updateActivity('a1', { set: { 'custom.a': 2 } }) })
    expect(result.current.activities[0]!.custom).toEqual({ a: 2 })

    act(() => { void result.current.updateActivity('a1', { set: { 'custom.a': 3 } }) })
    expect(result.current.activities[0]!.custom).toEqual({ a: 3 }) // second call's optimistic value

    await act(async () => {
      rejectFirst(new Error('boom'))
      await expect(p1).rejects.toThrow('boom')
    })
    // The first call's rollback must not stomp the second, still-standing optimistic write.
    expect(result.current.activities[0]!.custom).toEqual({ a: 3 })
  })

  it('two overlapping calls on DIFFERENT activities whose activityId+path would collide under a flat "id::path" ownership key do not stomp each other\'s rollback', async () => {
    // pathOwnerRef used to be keyed by `${activityId}::${path}` — not injective:
    // activityId "U" + path "custom.foo::bar" and activityId "U::custom.foo" + path
    // "bar" both produce the string "U::custom.foo::bar". A `custom` field name
    // containing "::" reaches this through ordinary application code, no attacker
    // required (activity ids are server UUIDs, but a patch's path is caller-supplied).
    // The map is now nested (activityId -> path -> token) so no delimiter choice can
    // collide two DIFFERENT (activityId, path) pairs onto the same ownership slot.
    let rejectFirst!: (e: Error) => void
    const updateActivity = vi.fn()
      .mockImplementationOnce(() => new Promise<Activity>((_res, rej) => { rejectFirst = rej })) // on "U"
      .mockImplementationOnce(() => new Promise<Activity>(() => {})) // on "U::custom.foo", never resolves
    const get = vi.fn(async () => ({
      results: [activity('U', [], { custom: { 'foo::bar': 'orig' } })], next: null,
    }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p1!: Promise<Activity | undefined>
    act(() => { p1 = result.current.updateActivity('U', { set: { 'custom.foo::bar': 'v1' } }) })
    expect(result.current.activities[0]!.custom).toEqual({ 'foo::bar': 'v1' })

    // A call on a DIFFERENT (non-loaded) activity whose id+path collides with the first
    // call's under the OLD flat-key scheme. It has no visible optimistic effect here
    // (that activity isn't in the loaded list) — only its OWNERSHIP entry matters.
    act(() => { void result.current.updateActivity('U::custom.foo', { set: { bar: 'v2' } }) })

    await act(async () => {
      rejectFirst(new Error('boom'))
      await expect(p1).rejects.toThrow('boom')
    })
    // Under the flat-key bug, the second call's ownership write would have overwritten
    // the first call's entry (same string key), so the first call's failure would see
    // stillOwned === false and skip its rollback — leaving `foo::bar` stuck at 'v1'
    // even though its network call failed.
    expect(result.current.activities[0]!.custom).toEqual({ 'foo::bar': 'orig' })
  })

  it('rolls back to a falsy prior value (0, false, null) rather than treating it as absent', async () => {
    let rejectUpdate!: (e: Error) => void
    const updateActivity = vi.fn(() => new Promise<Activity>((_res, rej) => { rejectUpdate = rej }))
    const get = vi.fn(async () => ({
      results: [activity('a1', [], { custom: { zero: 0, bool: false, nil: null } })], next: null,
    }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p!: Promise<Activity | undefined>
    act(() => {
      p = result.current.updateActivity('a1', { set: { 'custom.zero': 99, 'custom.bool': true, 'custom.nil': 'x' } })
    })
    expect(result.current.activities[0]!.custom).toEqual({ zero: 99, bool: true, nil: 'x' })

    await act(async () => {
      rejectUpdate(new Error('boom'))
      await expect(p).rejects.toThrow('boom')
    })
    // A rollback built on `??` (or `||`) instead of an existence check (`in`) would treat
    // a stored `0`/`false`/`null` as "nothing to restore" and either skip it or set it to
    // undefined — this asserts the ACTUAL prior values come back, not a truthy-ish stand-in.
    expect(result.current.activities[0]!.custom).toEqual({ zero: 0, bool: false, nil: null })
  })

  it('rolls back a path that did not previously exist to UNSET, not set-to-undefined', async () => {
    let rejectUpdate!: (e: Error) => void
    const updateActivity = vi.fn(() => new Promise<Activity>((_res, rej) => { rejectUpdate = rej }))
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: {} })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let p!: Promise<Activity | undefined>
    act(() => { p = result.current.updateActivity('a1', { set: { 'custom.newField': 'v' } }) })
    expect(result.current.activities[0]!.custom).toEqual({ newField: 'v' })

    await act(async () => {
      rejectUpdate(new Error('boom'))
      await expect(p).rejects.toThrow('boom')
    })
    // Must roll back to genuinely ABSENT, not `{ newField: undefined }` — those differ
    // under both `'newField' in custom` and JSON.stringify, and a rollback built on `??`
    // instead of `in` would produce exactly the wrong one.
    expect(result.current.activities[0]!.custom).toEqual({})
    expect('newField' in (result.current.activities[0]!.custom as object)).toBe(false)
  })

  it('applies nested set paths and unset (after set), immutably', async () => {
    const updateActivity = vi.fn(() => new Promise<Activity>(() => {})) // never resolves — optimistic phase only
    const get = vi.fn(async () => ({
      results: [activity('a1', [], { custom: { a: { b: 1 }, drop: 'me' } })], next: null,
    }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const before = result.current.activities[0]!.custom

    act(() => {
      void result.current.updateActivity('a1', { set: { 'custom.a.c': 2 }, unset: ['custom.drop'] })
    })
    expect(result.current.activities[0]!.custom).toEqual({ a: { b: 1, c: 2 } })
    expect(before).toEqual({ a: { b: 1 }, drop: 'me' }) // original object untouched
  })
})

// SECURITY: `custom.__proto__.x`-shaped paths are walked over a real JS object here (the
// server's regex accepts them; jsonb has no prototype chain so the server is safe anyway
// — this package is not, unless it guards independently). Each case below performs the
// optimistic write and then asserts a FRESH `{}` literal, never the activity itself: the
// bug this guards against is global (Object.prototype), not local to one object.
describe('updateActivity — prototype pollution guard', () => {
  async function setupWithActivity() {
    const updateActivity = vi.fn(() => new Promise<Activity>(() => {})) // never resolves
    const get = vi.fn(async () => ({ results: [activity('a1', [], { custom: {} })], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get, updateActivity })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    return result
  }

  it('ignores a __proto__ segment instead of polluting Object.prototype', async () => {
    const result = await setupWithActivity()
    act(() => { void result.current.updateActivity('a1', { set: { 'custom.__proto__.polluted': 'yes' } }) })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(result.current.activities[0]!.custom).toEqual({})
  })

  it('ignores a constructor segment', async () => {
    const result = await setupWithActivity()
    act(() => { void result.current.updateActivity('a1', { set: { 'custom.constructor.x': 1 } }) })
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(result.current.activities[0]!.custom).toEqual({})
  })

  it('ignores a prototype segment', async () => {
    const result = await setupWithActivity()
    act(() => { void result.current.updateActivity('a1', { set: { 'custom.prototype.y': 1 } }) })
    expect(({} as Record<string, unknown>).y).toBeUndefined()
    expect(result.current.activities[0]!.custom).toEqual({})
  })

  it('catches a forbidden segment in an INTERMEDIATE position, not just the terminal one', async () => {
    const result = await setupWithActivity()
    act(() => { void result.current.updateActivity('a1', { set: { 'custom.a.__proto__.b': 'yes' } }) })
    expect(({} as Record<string, unknown>).b).toBeUndefined()
    expect(result.current.activities[0]!.custom).toEqual({}) // whole path skipped, not partially applied
  })

  it('also guards unset paths, not just set', async () => {
    const result = await setupWithActivity()
    act(() => { void result.current.updateActivity('a1', { unset: ['custom.__proto__.polluted'] }) })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// ── Object freshness ────────────────────────────────────────────────────────────
// Activities are immutable, objects are not — so the feed head token (which only moves
// on fan-out) can never be the freshness signal for the mutable half. These cover the
// two paths that keep the sidecar current: checkNew merging the page it already fetched,
// and the `live` object sweep re-reading refs in one batch request.

const obj = (type: string, id: string, custom: Record<string, unknown>, updated_at: string): DropInObject => ({
  type, id, custom, updated_at,
})

/** A live-capable client: mount page, head, and a batch object read. */
function liveClient(over: {
  get?: ReturnType<typeof vi.fn>
  head?: ReturnType<typeof vi.fn>
  getMany?: ReturnType<typeof vi.fn>
} = {}) {
  const get = over.get ?? vi.fn(async () => ({
    results: [activity('a1', ['session:1'])],
    next: null,
    objects: { 'session:1': obj('session', '1', { spots_left: 4 }, '2026-08-09T10:00:00Z') },
  }))
  const head = over.head ?? vi.fn(async () => ({ latest: null }))
  const getMany = over.getMany ?? vi.fn(async () => ({}))
  return { client: makeClient({ feed: vi.fn(() => ({ get, head })), objects: { getMany } }), get, head, getMany }
}

describe('checkNew: objects sidecar', () => {
  it('merges the objects it already fetched instead of discarding them', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({
          results: [activity('a1', ['session:1'])], next: null,
          objects: { 'session:1': obj('session', '1', { spots_left: 4 }, '2026-08-09T10:00:00Z') },
        })
        // checkNew's page: no new activity, but the object moved. Before this fix the
        // whole sidecar was dropped on the floor and the card stayed at 4.
        .mockResolvedValue({
          results: [activity('a1', ['session:1'])], next: null,
          objects: { 'session:1': obj('session', '1', { spots_left: 1 }, '2026-08-09T10:05:00Z') },
        })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 4 })

      latest = 'a2'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 1 })
    } finally { vi.useRealTimers() }
  })

  // MERGE, not replace: checkNew reads page 1 only, so replacing would blank every card
  // resolved off page 2+ for a reader who has scrolled.
  it('merges rather than replacing — a deeper page’s objects survive', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({
          results: [activity('a1', ['session:1'])], next: 'cur1',
          objects: { 'session:1': obj('session', '1', {}, '2026-08-09T10:00:00Z') },
        })
        .mockResolvedValueOnce({
          results: [activity('a2', ['session:2'])], next: null,
          objects: { 'session:2': obj('session', '2', {}, '2026-08-09T10:00:00Z') },
        })
        .mockResolvedValue({
          results: [activity('a1', ['session:1'])], next: 'cur1',
          objects: { 'session:1': obj('session', '1', { moved: true }, '2026-08-09T10:05:00Z') },
        })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await result.current.loadNext() })
      expect(Object.keys(result.current.objects).sort()).toEqual(['session:1', 'session:2'])

      latest = 'a3'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.objects['session:1']!.custom).toEqual({ moved: true })
      expect(result.current.objects['session:2']).toBeDefined()
    } finally { vi.useRealTimers() }
  })
})

describe('useFeed live: object sweep', () => {
  it('batch-re-reads the shown refs on its own cadence and applies what moved', async () => {
    vi.useFakeTimers()
    try {
      const getMany = vi.fn(async () => ({
        'session:1': obj('session', '1', { spots_left: 0 }, '2026-08-09T11:00:00Z'),
      }))
      const { client, getMany: gm } = liveClient({ getMany })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(gm).not.toHaveBeenCalled()

      // Activity head ticks at 5s must NOT drag the object sweep along with them.
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(gm).not.toHaveBeenCalled()

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(gm).toHaveBeenCalledTimes(1)
      expect(gm.mock.calls[0]![0]).toEqual(['session:1'])
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 0 })
    } finally { vi.useRealTimers() }
  })

  // Overlay-always-wins is the bug this avoids: a sweep that started before a refresh
  // must not pin the card back to the older read when it lands after it.
  it('newest updated_at wins — a stale sweep response never overwrites a fresher one', async () => {
    vi.useFakeTimers()
    try {
      const getMany = vi.fn(async () => ({
        'session:1': obj('session', '1', { spots_left: 9 }, '2026-08-09T09:00:00Z'), // OLDER than mount
      }))
      const { client } = liveClient({ getMany })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 4 })
    } finally { vi.useRealTimers() }
  })

  it('keeps the same object identity when nothing moved, so the list does not re-render', async () => {
    vi.useFakeTimers()
    try {
      const getMany = vi.fn(async () => ({
        'session:1': obj('session', '1', { spots_left: 4 }, '2026-08-09T10:00:00Z'), // same updated_at
      }))
      const { client } = liveClient({ getMany })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const before = result.current.objects
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.objects).toBe(before)
    } finally { vi.useRealTimers() }
  })

  // A ref we asked for and did not get back was deleted server-side. Keeping it would
  // render a cancelled session forever; the sidecar contract is fall back to the
  // activity's own custom.
  it('drops an object the sweep asked for and did not get back', async () => {
    vi.useFakeTimers()
    try {
      const { client } = liveClient({ getMany: vi.fn(async () => ({})) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.objects['session:1']).toBeDefined()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.objects['session:1']).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('costs no request when the page renders no refs', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        get: vi.fn(async () => ({ results: [activity('a1')], next: null })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(getMany).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('deduplicates refs shared by several activities into one key', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        get: vi.fn(async () => ({
          results: [activity('a1', ['session:1']), activity('a2', ['session:1', 'venue:9'])],
          next: null,
          objects: { 'session:1': obj('session', '1', {}, '2026-08-09T10:00:00Z') },
        })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany.mock.calls[0]![0]).toEqual(['session:1', 'venue:9'])
    } finally { vi.useRealTimers() }
  })

  // The server caps one request at 100 refs. A deep-scrolled feed exceeds that, and a
  // silent slice would leave every card past the first 100 refs permanently stale.
  it('chunks past the 100-ref request cap instead of dropping the tail', async () => {
    vi.useFakeTimers()
    try {
      const many = Array.from({ length: 150 }, (_, i) => activity(`a${i}`, [`session:${i}`]))
      const { client, getMany } = liveClient({
        get: vi.fn(async () => ({ results: many, next: null, objects: {} })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(2)
      expect((getMany.mock.calls[0]![0] as string[]).length).toBe(100)
      expect((getMany.mock.calls[1]![0] as string[]).length).toBe(50)
    } finally { vi.useRealTimers() }
  })

  it('liveObjectsInterval: 0 disables the sweep and leaves activity freshness alone', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany, head } = liveClient()
      renderHook(() => useFeed('user', 'alice', { live: true, liveObjectsInterval: 0 }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(getMany).not.toHaveBeenCalled()
      expect(head.mock.calls.length).toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })

  it('never sweeps without live — the sweep is part of what live means, not a separate opt-in', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient()
      renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(getMany).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('swallows sweep errors — best-effort, like every other unattended tick', async () => {
    vi.useFakeTimers()
    try {
      const { client } = liveClient({ getMany: vi.fn(async () => { throw new Error('boom') }) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(result.current.error).toBeNull()
      expect(result.current.objects['session:1']).toBeDefined() // untouched, not dropped
    } finally { vi.useRealTimers() }
  })

  // react and client version independently, so a newer react paired with a client that
  // predates getMany must degrade to "activities only", not crash every 30s.
  it('degrades quietly against a client with no objects.getMany', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({
        results: [activity('a1', ['session:1'])], next: null,
        objects: { 'session:1': obj('session', '1', { spots_left: 4 }, '2026-08-09T10:00:00Z') },
      }))
      const client = makeClient({ feed: vi.fn(() => ({ get, head: vi.fn(async () => ({ latest: null })) })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(result.current.error).toBeNull()
      expect(result.current.objects['session:1']).toBeDefined()
    } finally { vi.useRealTimers() }
  })
})

describe('useFeed live: sweep cost and failure handling', () => {
  const manyActivities = (n: number) => Array.from({ length: n }, (_, i) => activity(`a${i}`, [`session:${i}`]))

  it('caps the sweep at liveObjectsMaxRefs and says so once, rather than truncating silently', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client, getMany } = liveClient({
        get: vi.fn(async () => ({ results: manyActivities(250), next: null, objects: {} })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      // 250 refs on screen, default ceiling 200 → two requests, not three.
      expect(getMany).toHaveBeenCalledTimes(2)
      const asked = getMany.mock.calls.flatMap((c) => c[0] as string[])
      expect(asked.length).toBe(200)
      expect(asked).toContain('session:0') // newest kept
      expect(asked).not.toContain('session:249') // tail dropped
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('liveObjectsMaxRefs')

      // Warned once per feed, not once per tick.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally { warn.mockRestore(); vi.useRealTimers() }
  })

  it('raising liveObjectsMaxRefs buys more coverage', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        get: vi.fn(async () => ({ results: manyActivities(250), next: null, objects: {} })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true, liveObjectsMaxRefs: 300 }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(3)
      expect(getMany.mock.calls.flatMap((c) => c[0] as string[]).length).toBe(250)
    } finally { vi.useRealTimers() }
  })

  // A chunk tells us nothing about refs it did not cover. Treating "no answer" as
  // "deleted" would drop live objects whenever one request of a sweep failed.
  it('keeps a failed chunk’s objects and still applies the chunk that succeeded', async () => {
    vi.useFakeTimers()
    try {
      const getMany = vi.fn()
        .mockResolvedValueOnce({ 'session:0': obj('session', '0', { spots_left: 1 }, '2026-08-09T11:00:00Z') })
        .mockRejectedValueOnce(new Error('gateway timeout'))
      const { client } = liveClient({
        get: vi.fn(async () => ({
          results: manyActivities(150), next: null,
          objects: {
            'session:0': obj('session', '0', { spots_left: 4 }, '2026-08-09T10:00:00Z'),
            'session:120': obj('session', '120', { spots_left: 2 }, '2026-08-09T10:00:00Z'),
          },
        })),
        getMany,
      })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.objects['session:0']!.custom).toEqual({ spots_left: 1 }) // chunk 1 applied
      expect(result.current.objects['session:120']).toBeDefined() // chunk 2 unknown, not deleted
      expect(result.current.error).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('two hooks on the same feed share ONE sweep, and both get the result', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        getMany: vi.fn(async () => ({ 'session:1': obj('session', '1', { spots_left: 0 }, '2026-08-09T11:00:00Z') })),
      })
      const { result } = renderHook(
        () => ({
          a: useFeed('user', 'alice', { live: true }),
          b: useFeed('user', 'alice', { live: true }),
        }),
        { wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(1) // not once per mounted hook
      expect(result.current.a.objects['session:1']!.custom).toEqual({ spots_left: 0 })
      expect(result.current.b.objects['session:1']!.custom).toEqual({ spots_left: 0 })
    } finally { vi.useRealTimers() }
  })

  // The synthetic version of this only proved the comparison. This one actually
  // interleaves: the sweep is in flight, a refresh lands with newer data, THEN the sweep
  // answers with what it read before that refresh.
  it('a refresh landing mid-sweep wins — the sweep cannot pin the card back', async () => {
    vi.useFakeTimers()
    try {
      let releaseSweep!: (v: Record<string, DropInObject>) => void
      const getMany = vi.fn(() => new Promise<Record<string, DropInObject>>((res) => { releaseSweep = res }))
      const get = vi.fn()
        .mockResolvedValueOnce({
          results: [activity('a1', ['session:1'])], next: null,
          objects: { 'session:1': obj('session', '1', { spots_left: 4 }, '2026-08-09T10:00:00Z') },
        })
        // refresh(): newer than anything the in-flight sweep can be holding
        .mockResolvedValue({
          results: [activity('a1', ['session:1'])], next: null,
          objects: { 'session:1': obj('session', '1', { spots_left: 1 }, '2026-08-09T10:10:00Z') },
        })
      const { client } = liveClient({ get, getMany })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(1) // in flight, unresolved

      await act(async () => { await result.current.refresh() })
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 1 })

      // The sweep now answers with the state it read BEFORE the refresh.
      await act(async () => {
        releaseSweep({ 'session:1': obj('session', '1', { spots_left: 3 }, '2026-08-09T10:05:00Z') })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 1 })
    } finally { vi.useRealTimers() }
  })
})

// ── Activity edit freshness ─────────────────────────────────────────────────────
// The head token is written by the fan-out worker and nothing else, so it means "a new
// activity arrived" — not "something changed". An activity PATCH moves no head, and
// checkNew's id-dedupe then discards the edited body as "not new". These cover the two
// halves of the fix: reconciling the bodies checkNew already holds, and firing a page
// read on the revalidate cadence so it happens without a new activity to trigger it.

describe('checkNew: activity edits', () => {
  const edited = (id: string, version: number, custom: Record<string, unknown>) =>
    activity(id, [], { version, custom })

  it('replaces a shown activity whose version moved', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [edited('a1', 1, { title: 'Yoga' })], next: null })
        .mockResolvedValue({ results: [edited('a1', 2, { title: 'Yoga (moved)' })], next: null })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.activities[0]!.custom).toEqual({ title: 'Yoga' })

      latest = 'a2'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities[0]!.custom).toEqual({ title: 'Yoga (moved)' })
      expect(result.current.newCount).toBe(0) // an edit is not a new post
    } finally { vi.useRealTimers() }
  })

  // Order is the reader's scroll position. An edit must swap a body in place, never
  // move the row — that is the whole reason edits are not routed through `pending`.
  it('keeps list order and identity of untouched rows', async () => {
    vi.useFakeTimers()
    try {
      const first = [edited('a1', 1, { n: 1 }), edited('a2', 1, { n: 2 })]
      const get = vi.fn()
        .mockResolvedValueOnce({ results: first, next: null })
        .mockResolvedValue({
          results: [edited('a1', 1, { n: 1 }), edited('a2', 2, { n: 22 })],
          next: null,
        })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const a1Before = result.current.activities[0]

      latest = 'x'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
      expect(result.current.activities[0]).toBe(a1Before) // untouched row keeps identity
      expect(result.current.activities[1]!.custom).toEqual({ n: 22 })
    } finally { vi.useRealTimers() }
  })

  it('leaves the list alone when no version moved', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [edited('a1', 1, { n: 1 })], next: null }))
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const before = result.current.activities

      latest = 'x'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities).toBe(before) // no new array, so no re-render
    } finally { vi.useRealTimers() }
  })

  // An in-flight optimistic patch has not moved the server's version yet, so the
  // reconcile must not treat the server's pre-edit body as newer and stomp it.
  it('does not clobber an in-flight optimistic updateActivity', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const get = vi.fn(async () => ({ results: [edited('a1', 1, { title: 'server' })], next: null }))
      const updateActivity = vi.fn(async () => { await gate; return edited('a1', 2, { title: 'mine' }) })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      ;(client.feed as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        get, head: vi.fn(async () => ({ latest })), updateActivity,
      }))
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      act(() => { void result.current.updateActivity('a1', { set: { 'custom.title': 'mine' } }) })
      expect(result.current.activities[0]!.custom).toEqual({ title: 'mine' })

      latest = 'x'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities[0]!.custom).toEqual({ title: 'mine' }) // optimistic value survives

      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.activities[0]!.custom).toEqual({ title: 'mine' })
    } finally { vi.useRealTimers() }
  })
})

describe('useFeed live: revalidate cadence', () => {
  it('reads page 1 on the revalidate tick even though no head moved', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [activity('a1', [], { version: 1, custom: { n: 1 } })], next: null })
        .mockResolvedValue({
          results: [activity('a1', [], { version: 2, custom: { n: 2 } })], next: null,
        })
      // head never moves — this is the gap: an edit is invisible to the 5s signal.
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest: null })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(get).toHaveBeenCalledTimes(1) // head ticks alone never read the page

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(result.current.activities[0]!.custom).toEqual({ n: 2 })
    } finally { vi.useRealTimers() }
  })

  // A head change at 29s and a cadence tick at 30s must not both read page 1.
  it('skips the cadence read when checkNew already read the page just now', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      latest = 'moved'
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) }) // head consumed → 1 page read
      expect(get).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) }) // cadence tick lands right after
      expect(get).toHaveBeenCalledTimes(2) // cooled down, not re-read
    } finally { vi.useRealTimers() }
  })

  it('liveRevalidateInterval retimes both the page read and the object sweep', async () => {
    vi.useFakeTimers()
    try {
      const { client, get, getMany } = liveClient()
      renderHook(
        () => useFeed('user', 'alice', { live: true, liveRevalidateInterval: 10_000 }),
        { wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(getMany).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('liveObjectsInterval still works as the deprecated alias', async () => {
    vi.useFakeTimers()
    try {
      const { client, get, getMany } = liveClient()
      renderHook(
        () => useFeed('user', 'alice', { live: true, liveObjectsInterval: 10_000 }),
        { wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(getMany).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('0 disables the cadence entirely, leaving the 5s head check alone', async () => {
    vi.useFakeTimers()
    try {
      const { client, get, getMany, head } = liveClient()
      renderHook(
        () => useFeed('user', 'alice', { live: true, liveRevalidateInterval: 0 }),
        { wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(get).toHaveBeenCalledTimes(1)
      expect(getMany).not.toHaveBeenCalled()
      expect(head.mock.calls.length).toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })
})

// The imperative half of the same machinery. The timer answers "keep it fresh in the
// background"; this answers "the reader just did something, show them the truth NOW".
describe('useFeed: revalidateObjects()', () => {
  it('re-reads the shown refs on demand and applies what moved', async () => {
    const getMany = vi.fn(async () => ({
      'session:1': obj('session', '1', { spots_left: 0 }, '2026-08-09T11:00:00Z'),
    }))
    const { client } = liveClient({ getMany })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => { await result.current.revalidateObjects() })
    expect(getMany).toHaveBeenCalledTimes(1)
    expect(getMany.mock.calls[0]![0]).toEqual(['session:1'])
    expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 0 })
  })

  // Works WITHOUT `live` — the whole point for an app that polls nothing and only
  // revalidates after its own writes (book a spot, then show the new count).
  it('does not require live: true', async () => {
    const { client, getMany, head } = liveClient()
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => { await result.current.revalidateObjects() })
    expect(getMany).toHaveBeenCalledTimes(1)
    expect(head).not.toHaveBeenCalled()
  })

  // The cross-instance cooldown exists to stop two offset TIMERS reading the same data
  // seconds apart. A hand call is user intent, not a timer, and silently returning stale
  // data because a sweep happened 3s ago is the bug this guards against.
  it('bypasses the sweep cooldown that gates the timer', async () => {
    vi.useFakeTimers()
    try {
      const getMany = vi.fn(async () => ({
        'session:1': obj('session', '1', { spots_left: 2 }, '2026-08-09T11:00:00Z'),
      }))
      const { client } = liveClient({ getMany })
      const { result } = renderHook(
        () => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(1) // the timer's sweep, just now

      await act(async () => { await result.current.revalidateObjects() })
      expect(getMany).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  // Two components on one feed: the second caller must resolve AFTER the shared read has
  // landed, not immediately. An awaited call that returns before the data arrives is a
  // pull-to-refresh spinner that stops too early.
  it('awaits an in-flight sweep instead of returning early', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const getMany = vi.fn(async () => {
      await gate
      return { 'session:1': obj('session', '1', { spots_left: 7 }, '2026-08-09T11:00:00Z') }
    })
    const { client } = liveClient({ getMany })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let secondDone = false
    await act(async () => {
      const first = result.current.revalidateObjects()
      const second = result.current.revalidateObjects().then(() => { secondDone = true })
      expect(secondDone).toBe(false)
      release()
      await Promise.all([first, second])
    })
    expect(getMany).toHaveBeenCalledTimes(1) // coalesced, not doubled
    expect(secondDone).toBe(true)
    expect(result.current.objects['session:1']!.custom).toEqual({ spots_left: 7 })
  })

  it('is inert inside a disabled provider', async () => {
    const { client, getMany } = liveClient()
    const { result } = renderHook(() => useFeed('user', 'alice'), {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        <DropInProvider client={client as never} enabled={false}>{children}</DropInProvider>,
    })
    await expect(result.current.revalidateObjects()).resolves.toBeUndefined()
    expect(getMany).not.toHaveBeenCalled()
  })

  // react and @dropinnodex/client version independently. A hand call against a client
  // that predates getMany must be a no-op, not a TypeError in the app's click handler.
  it('no-ops against a client without objects.getMany', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await expect(result.current.revalidateObjects()).resolves.toBeUndefined()
  })
})

describe('checkNew: the two documented limits of edit reconciliation', () => {
  // Reconciliation reads page 1, so it can only ever see page 1. Re-reading every loaded
  // page each tick is the cost this deliberately does not pay — put the changing, shared
  // part of a card in an object and the sweep covers it at any depth.
  it('does not reconcile an edit to an activity on a deeper page', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [activity('a1', [], { edited_at: null, custom: { n: 1 } })], next: 'cur1' })
        .mockResolvedValueOnce({ results: [activity('a2', [], { edited_at: null, custom: { n: 2 } })], next: null })
        // page 1 again — a2 is not on it, so its edit is invisible here
        .mockResolvedValue({ results: [activity('a1', [], { edited_at: null, custom: { n: 1 } })], next: 'cur1' })
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest: null })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await result.current.loadNext() })
      expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.activities[1]!.custom).toEqual({ n: 2 }) // untouched, by design
    } finally { vi.useRealTimers() }
  })

  // Absence from page 1 cannot distinguish "deleted" from "pushed off page 1 by newer
  // activities" — the object sweep can make that call because it asks for specific refs.
  it('does not drop an activity merely absent from the page-1 read', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [activity('a1'), activity('a2')], next: null })
        .mockResolvedValue({ results: [activity('a1')], next: null })
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest: null })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
    } finally { vi.useRealTimers() }
  })
})

// ── Row version ─────────────────────────────────────────────────────────────────
// `version` is the only staleness signal. `edited_at` is an EDIT marker: reaction counts
// — the field that moves most — never touch it, so a page read returned fresh counts and
// the reconcile threw them away as unchanged. `edited_at` stays on the wire as the
// human-facing "this was edited" flag; it is not what decides a re-render.

describe('reconcile: row version', () => {
  const withVersion = (id: string, version: number, custom: Record<string, unknown>) =>
    activity(id, [], { edited_at: null, version, custom })

  it('reconciles a reaction count — version moved, edited_at did not', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({
          results: [activity('a1', [], { edited_at: null, version: 1, reaction_counts: {} })],
          next: null,
        })
        .mockResolvedValue({
          results: [activity('a1', [], { edited_at: null, version: 2, reaction_counts: { like: 1 } })],
          next: null,
        })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(result.current.activities[0]!.reaction_counts).toEqual({})

      latest = 'x'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities[0]!.reaction_counts).toEqual({ like: 1 })
    } finally { vi.useRealTimers() }
  })

  it('leaves the row alone when the version is unchanged, whatever the body says', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [withVersion('a1', 7, { t: 'mine' })], next: null })
        // Same version, different body — a response that started before a local write.
        .mockResolvedValue({ results: [withVersion('a1', 7, { t: 'stale server copy' })], next: null })
      let latest: string | null = null
      const { client } = liveClient({ get, head: vi.fn(async () => ({ latest })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const before = result.current.activities

      latest = 'x'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.activities).toBe(before)
    } finally { vi.useRealTimers() }
  })
})

// ── Tenant change counter ───────────────────────────────────────────────────────
// The 30s revalidation is the expensive tick: a page read plus a batch object read, both
// hitting Postgres. `changed` lets a client skip it entirely when nothing in the tenant
// has been mutated — which, on a quiet tenant, is almost always.

describe('useFeed live: change counter gating', () => {
  it('skips the revalidation entirely while the counter is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const { client, get, getMany } = liveClient({
        head: vi.fn(async () => ({ latest: null, changed: 7 })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      // First revalidate tick has nothing to compare against, so it runs once.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(getMany).toHaveBeenCalledTimes(1)

      // Counter still 7 across the next three ticks: no page read, no object read.
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(getMany).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('revalidates again once the counter moves', async () => {
    vi.useFakeTimers()
    try {
      let changed = 7
      const { client, get, getMany } = liveClient({
        head: vi.fn(async () => ({ latest: null, changed })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(1)

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(1) // still 7 — skipped

      changed = 8 // somebody wrote something
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(getMany).toHaveBeenCalledTimes(2)
      expect(get).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  // Unknown must mean revalidate. A feed service that predates the counter, or one whose
  // Redis is down, returns null — and treating that as "nothing changed" would freeze
  // every open feed silently, which is strictly worse than a wasted read.
  it('revalidates unconditionally when the server reports no counter', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        head: vi.fn(async () => ({ latest: null, changed: null })),
      })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
      expect(getMany).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })

  // A hand call is user intent, not a timer. Gating it would return stale data right
  // after the write the caller made.
  it('never gates the imperative revalidateObjects()', async () => {
    vi.useFakeTimers()
    try {
      const { client, getMany } = liveClient({
        head: vi.fn(async () => ({ latest: null, changed: 7 })),
      })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      const afterTick = getMany.mock.calls.length

      await act(async () => { await result.current.revalidateObjects() })
      expect(getMany.mock.calls.length).toBe(afterTick + 1)
    } finally { vi.useRealTimers() }
  })
})
