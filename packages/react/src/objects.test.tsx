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
  refs, edited_at: null,
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
