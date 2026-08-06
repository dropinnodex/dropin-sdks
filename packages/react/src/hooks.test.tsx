import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, waitFor, act } from '@testing-library/react'
import React from 'react'
import {
  DropInProvider, useFeed, useReactions, useFollow, useFollowing, useFeedActions,
  useTimeline, useUserFeed, useFeedActivities, useFollowStats, useNotifications, useReactionList,
  useFollowers, useCurrentUser, useSuggestions,
} from './index.js'

const activity = (id: string, counts: Record<string, number> = {}, own: string[] = []) => ({
  id, actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
  time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
  reaction_counts: counts, actor_user: null, own_reactions: own,
})

function makeClient(over: Record<string, unknown> = {}) {
  return {
    feed: vi.fn(() => ({
      get: vi.fn(async () => ({ results: [activity('a1')], next: null })),
      follow: vi.fn(async () => undefined),
      unfollow: vi.fn(async () => undefined),
      following: vi.fn(async () => ({ results: [], next: null })),
      addActivity: vi.fn(async () => activity('new')),
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

describe('useFeed', () => {
  it('loads a feed', async () => {
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(makeClient()) })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('surfaces an error without throwing', async () => {
    const client = makeClient({
      feed: vi.fn(() => ({ get: vi.fn(async () => { throw new Error('boom') }) })),
    })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })

  it('loadNext appends and tracks hasNext', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(result.current.hasNext).toBe(false)
    // Regression guard: loadNext must call the client with the GetStream-shaped `next`
    // param (not a `cursor` param) — if hooks.ts reverts to `{ limit: 20, cursor: next }`,
    // this assertion must fail.
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, next: 'cur1' }), expect.anything())
    expect(get.mock.calls[1]![0]).not.toHaveProperty('cursor')
  })

  it('an empty mid-feed page keeps hasNext and loadNext recovers the tail', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [], next: 'cur2' })      // empty, but more exists
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1'])
    expect(result.current.hasNext).toBe(true)
    await act(async () => { await result.current.loadNext() })
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(result.current.hasNext).toBe(false)
  })

  it('loadNext is a no-op on an exhausted feed', async () => {
    const client = makeClient() // next: null
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.activities).toHaveLength(1) // not doubled — no fetch happened
  })

  it('loadNext surfaces its own error', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockRejectedValueOnce(new Error('loadmore boom'))
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.error).not.toBeNull()
  })

  it('the old hasMore/loadMore names are gone (breaking rename)', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect((result.current as Record<string, unknown>).hasMore).toBeUndefined()
    expect((result.current as Record<string, unknown>).loadMore).toBeUndefined()
  })

  it('addActivity prepends the created activity to the feed', async () => {
    const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
    const created = activity('new1')
    const addActivity = vi.fn(async () => created)
    const client = makeClient({ feed: vi.fn(() => ({ get, addActivity })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)

    await act(async () => {
      await result.current.addActivity({ verb: 'attend', object: 'session:1' })
    })
    expect(result.current.activities[0].id).toBe('new1')
    expect(result.current.activities).toHaveLength(2)
    expect(addActivity).toHaveBeenCalledWith({ verb: 'attend', object: 'session:1' })
  })

  it('refresh re-fetches the first page', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })
      .mockResolvedValueOnce({ results: [activity('a1'), activity('a2')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.activities).toHaveLength(2)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('seeds instantly from the provider cache on a later mount', async () => {
    const client = makeClient()
    let a: ReturnType<typeof useFeed> | undefined
    let b: ReturnType<typeof useFeed> | undefined
    function A() { a = useFeed('timeline', 'alice'); return null }
    function B() { b = useFeed('timeline', 'alice'); return null }
    const { rerender } = render(<DropInProvider client={client as never}><A /></DropInProvider>)
    await waitFor(() => expect(a!.isLoading).toBe(false))
    // B mounts under the SAME provider (cache is a persistent ref) with the feed warm.
    rerender(<DropInProvider client={client as never}><A /><B /></DropInProvider>)
    expect(b!.isLoading).toBe(false)
    expect(b!.activities).toHaveLength(1)
  })

  it('drops a resolved fetch that lands after unmount', async () => {
    let resolveGet!: (v: unknown) => void
    const get = vi.fn(() => new Promise((r) => { resolveGet = r }))
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result, unmount } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    expect(result.current.isLoading).toBe(true)
    unmount()
    await act(async () => { resolveGet({ results: [activity('a1')], next: null }); await Promise.resolve() })
    expect(result.current.activities).toEqual([]) // the late page was dropped
  })

  it('drops a rejected fetch that lands after unmount', async () => {
    let rejectGet!: (e: unknown) => void
    const get = vi.fn(() => new Promise((_, rej) => { rejectGet = rej }))
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result, unmount } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    unmount()
    await act(async () => { rejectGet(new Error('x')); await Promise.resolve() })
    expect(result.current.error).toBeNull() // the late rejection was dropped
  })

  it('initialData hydrates with no loading flash', async () => {
    const seeded = activity('seed1')
    const get = vi.fn(async () => ({ results: [activity('fresh')], next: null }))
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(
      () => useFeed('user', 'alice', { initialData: { results: [seeded], next: null } }),
      { wrapper: wrapper(client) },
    )
    expect(result.current.isLoading).toBe(false)
    expect(result.current.activities[0]!.id).toBe('seed1')
    await waitFor(() => expect(result.current.activities[0]!.id).toBe('fresh'))
  })

  it('a warm provider cache wins over a sibling initialData', async () => {
    const client = makeClient() // get() resolves to activity('a1'), next: null
    let a: ReturnType<typeof useFeed> | undefined
    let b: ReturnType<typeof useFeed> | undefined
    function A() { a = useFeed('timeline', 'alice'); return null }
    function B() {
      b = useFeed('timeline', 'alice', { initialData: { results: [activity('should-not-render')], next: null } })
      return null
    }
    const { rerender } = render(<DropInProvider client={client as never}><A /></DropInProvider>)
    await waitFor(() => expect(a!.isLoading).toBe(false))
    // B mounts under the SAME provider once the cache is warm from A's fetch — the cache
    // entry must win over B's own initialData.
    rerender(<DropInProvider client={client as never}><A /><B /></DropInProvider>)
    expect(b!.isLoading).toBe(false)
    expect(b!.activities.map((act) => act.id)).toEqual(['a1'])
  })

  it('checkNew buffers newer activities without prepending, showNew flushes them', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })
      .mockResolvedValueOnce({ results: [activity('a2'), activity('a1')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1'])
    expect(result.current.newCount).toBe(0)

    await act(async () => { await result.current.checkNew() })
    expect(result.current.newCount).toBe(1)
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1'])

    act(() => { result.current.showNew() })
    expect(result.current.newCount).toBe(0)
    expect(result.current.activities.map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('checkNew does not double-count an activity already shown', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => { await result.current.checkNew() })
    expect(result.current.newCount).toBe(0)
  })

  it('checkNew swallows a poll failure — no throw, no unhandled rejection, newCount stays 0', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })
      .mockRejectedValueOnce(new Error('network blip'))
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(act(async () => { await result.current.checkNew() })).resolves.not.toThrow()
    expect(result.current.newCount).toBe(0)
    expect(result.current.error).toBeNull() // best-effort: a poll failure must not surface as feed error
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1']) // feed left untouched
  })

  it('refresh clears the pending buffer', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })            // initial load
      .mockResolvedValueOnce({ results: [activity('a2'), activity('a1')], next: null }) // checkNew buffers a2
      .mockResolvedValueOnce({ results: [activity('a2'), activity('a1')], next: null }) // refresh: page 1 now legitimately has a2
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => { await result.current.checkNew() })
    expect(result.current.newCount).toBe(1)

    await act(async () => { await result.current.refresh() })
    expect(result.current.newCount).toBe(0) // stale buffer must not survive an authoritative refresh
    expect(result.current.activities.map((a) => a.id)).toEqual(['a2', 'a1'])

    act(() => { result.current.showNew() }) // no-op: buffer already empty
    expect(result.current.activities.map((a) => a.id)).toEqual(['a2', 'a1']) // NOT ['a2', 'a2', 'a1']
  })

  it('switching feed clears the pending buffer', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: null })            // alice initial load
      .mockResolvedValueOnce({ results: [activity('a2'), activity('a1')], next: null }) // alice checkNew buffers a2
      .mockResolvedValueOnce({ results: [activity('b1')], next: null })            // bob initial load, post-switch
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result, rerender } = renderHook(
      ({ group, id }: { group: string; id: string }) => useFeed(group, id),
      { initialProps: { group: 'user', id: 'alice' }, wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => { await result.current.checkNew() })
    expect(result.current.newCount).toBe(1) // alice's buffered a2

    rerender({ group: 'user', id: 'bob' })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.newCount).toBe(0) // alice's stale buffer must not leak into bob's feed
    expect(result.current.activities.map((a) => a.id)).toEqual(['b1'])
  })

  it('pollInterval triggers checkNew automatically', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn()
        .mockResolvedValueOnce({ results: [activity('a1')], next: null })
        .mockResolvedValue({ results: [activity('a2'), activity('a1')], next: null })
      const client = makeClient({ feed: vi.fn(() => ({ get })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { pollInterval: 5000 }), { wrapper: wrapper(client) })
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false))
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(result.current.newCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// Infinite scroll drives loadNext from an IntersectionObserver, not a button: the call
// fires on intersect AND again as content reflows, so concurrency and error-retry stop
// being edge cases and become the normal path. Each test below is a failure mode that a
// button never reaches.
describe('useFeed infinite scroll', () => {
  /** A promise the test resolves by hand, to hold a page in flight. */
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('drops a second loadNext while one is in flight (same cursor, one fetch)', async () => {
    const page2 = deferred<unknown>()
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockImplementationOnce(() => page2.promise)
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    await act(async () => {
      const first = result.current.loadNext()
      const second = result.current.loadNext() // observer re-fires before page 2 lands
      page2.resolve({ results: [activity('a2')], next: null })
      await Promise.all([first, second])
    })

    expect(get).toHaveBeenCalledTimes(2) // mount + ONE loadNext, not two
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('dedupes by id when a page overlaps what is already shown', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1'), activity('a2')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2'), activity('a3')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    // a2 arrives twice (at-least-once fan-out replay, or a row inserted mid-page) —
    // duplicate React keys are a crash in a virtualised list, so the merge must dedupe.
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('splits isLoadingInitial from isLoadingMore (isLoading stays their union)', async () => {
    const page2 = deferred<unknown>()
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockImplementationOnce(() => page2.promise)
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })

    expect(result.current.isLoadingInitial).toBe(true)
    expect(result.current.isLoadingMore).toBe(false)
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let pending!: Promise<void>
    await act(async () => { pending = result.current.loadNext() })
    // The whole point: a list gated on isLoadingInitial keeps rendering (and keeps its
    // sentinel mounted) while page 2 is in flight.
    expect(result.current.isLoadingInitial).toBe(false)
    expect(result.current.isLoadingMore).toBe(true)
    expect(result.current.isLoading).toBe(true)

    await act(async () => { page2.resolve({ results: [activity('a2')], next: null }); await pending })
    expect(result.current.isLoadingMore).toBe(false)
  })

  it('canLoadMore folds end-of-feed, in-flight and error', async () => {
    const client = makeClient() // next: null
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.canLoadMore).toBe(false) // exhausted
  })

  it('a failed page stops canLoadMore and loadNext no-ops until retry()', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockRejectedValueOnce(new Error('page 2 boom'))
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))

    await act(async () => { await result.current.loadNext() })
    expect(result.current.error).not.toBeNull()
    expect(result.current.canLoadMore).toBe(false) // sentinel unbinds instead of hammering

    // An intersecting sentinel keeps calling: every one of these must be a no-op.
    await act(async () => { await result.current.loadNext(); await result.current.loadNext() })
    expect(get).toHaveBeenCalledTimes(2) // mount + the one failed page

    await act(async () => { await result.current.retry() })
    expect(result.current.error).toBeNull()
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('pageSize replaces the hardcoded limit of 20 on both the first page and loadNext', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const client = makeClient({ feed: vi.fn(() => ({ get })) })
    const { result } = renderHook(() => useFeed('timeline', 'alice', { pageSize: 50 }), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    expect(get).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 50 }), expect.anything())
    await act(async () => { await result.current.loadNext() })
    expect(get).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 50, next: 'cur1' }), expect.anything())
  })
})

describe('useFeed live', () => {
  it('head unchanged → no feed fetch; head changed → exactly one checkNew per distinct value', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      let latest: string | null = null
      const head = vi.fn(async () => ({ latest }))
      const client = makeClient({ feed: vi.fn(() => ({ get, head })) })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(get).toHaveBeenCalledTimes(1) // mount load only

      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(head).toHaveBeenCalledTimes(1)
      expect(get).toHaveBeenCalledTimes(1) // null head = nothing new

      latest = 'a2'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(get).toHaveBeenCalledTimes(2) // change → checkNew

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(2) // same head → signal already consumed
    } finally { vi.useRealTimers() }
  })

  it('a deleted head id costs one fetch, never a loop', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      const head = vi.fn(async () => ({ latest: 'gone' }))
      const client = makeClient({ feed: vi.fn(() => ({ get, head })) })
      renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(get).toHaveBeenCalledTimes(2) // one consumption fetch
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(get).toHaveBeenCalledTimes(2) // and no more
    } finally { vi.useRealTimers() }
  })

  it('live beats pollInterval — the interval timer never arms', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      const head = vi.fn(async () => ({ latest: null }))
      const client = makeClient({ feed: vi.fn(() => ({ get, head })) })
      renderHook(() => useFeed('user', 'alice', { live: true, pollInterval: 1000 }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(1) // pollInterval alone would have fetched ~10 more times
      expect(head).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('head errors are swallowed like poll errors — no error state, ticks continue', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      const head = vi.fn(async () => { throw new Error('boom') })
      const client = makeClient({ feed: vi.fn(() => ({ get, head })) })
      const { result } = renderHook(() => useFeed('user', 'alice', { live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(head).toHaveBeenCalledTimes(2)
      expect(result.current.error).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('feed switch resets lastHeadRef — the same head value is treated as new again for the new feed', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => ({ results: [activity('a1')], next: null }))
      const head = vi.fn(async () => ({ latest: 'x1' }))
      const client = makeClient({ feed: vi.fn(() => ({ get, head })) })
      const { rerender } = renderHook(
        ({ id }: { id: string }) => useFeed('user', id, { live: true }),
        { initialProps: { id: 'alice' }, wrapper: wrapper(client) },
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(get).toHaveBeenCalledTimes(1) // alice mount load

      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(get).toHaveBeenCalledTimes(2) // alice consumes head 'x1'

      rerender({ id: 'bob' })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(get).toHaveBeenCalledTimes(3) // bob mount load, post-switch

      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      // Still 'x1' — but bob's lastHeadRef was reset to null on the switch, so the SAME
      // value must be consumed again rather than being (wrongly) treated as already-seen.
      expect(get).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })
})

describe('useTimeline / useUserFeed', () => {
  it('useTimeline/useUserFeed target the right group', async () => {
    const feed = vi.fn(() => ({ get: vi.fn(async () => ({ results: [], next: null })) }))
    const client = makeClient({ feed })
    renderHook(() => useTimeline('alice'), { wrapper: wrapper(client) })
    renderHook(() => useUserFeed('alice'), { wrapper: wrapper(client) })
    await waitFor(() => {
      expect(feed).toHaveBeenCalledWith('timeline', 'alice')
      expect(feed).toHaveBeenCalledWith('user', 'alice')
    })
  })
})

describe('useFeedActivities', () => {
  it('is a GetStream V3-named alias for useFeed with the same shape', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeedActivities('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)
    expect(typeof result.current.loadNext).toBe('function')
    expect(result.current.hasNext).toBe(false)
  })
})

describe('useReactions', () => {
  it('applies a reaction optimistically', async () => {
    let resolve: () => void = () => {}
    const add = vi.fn(() => new Promise((r) => { resolve = () => r({}) }))
    const client = makeClient({ reactions: { add, delete: vi.fn() } })
    const { result } = renderHook(() => useReactions('a1', { like: 0 }, []), { wrapper: wrapper(client) })
    act(() => { void result.current.react('like') })
    expect(result.current.counts.like).toBe(1)
    expect(result.current.ownReactions).toContain('like')
    await act(async () => { resolve() })
    expect(result.current.counts.like).toBe(1)
  })

  it('starts a brand-new reaction kind from zero', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useReactions('a1', {}, []), { wrapper: wrapper(client) })
    await act(async () => { await result.current.react('fire') })
    expect(result.current.counts.fire).toBe(1) // (undefined ?? 0) + 1
  })

  it('does not double-add to own_reactions when the kind is already present', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useReactions('a1', { like: 2 }, ['like']), { wrapper: wrapper(client) })
    await act(async () => { await result.current.react('like') })
    expect(result.current.ownReactions).toEqual(['like'])
    expect(result.current.counts.like).toBe(3)
  })

  it('ROLLS BACK on error', async () => {
    const add = vi.fn(async () => { throw new Error('429') })
    const client = makeClient({ reactions: { add, delete: vi.fn() } })
    const { result } = renderHook(() => useReactions('a1', { like: 3 }, []), { wrapper: wrapper(client) })
    await act(async () => { await result.current.react('like').catch(() => {}) })
    expect(result.current.counts.like).toBe(3)
    expect(result.current.ownReactions).not.toContain('like')
  })

  it('unreact rolls back on error too', async () => {
    const unreact = vi.fn(async () => { throw new Error('nope') })
    const client = makeClient({ reactions: { add: vi.fn(), delete: vi.fn(), unreact } })
    const { result } = renderHook(() => useReactions('a1', { like: 1 }, ['like']), { wrapper: wrapper(client) })
    await act(async () => { await result.current.unreact('like').catch(() => {}) })
    expect(result.current.counts.like).toBe(1)
    expect(result.current.ownReactions).toContain('like')
    expect(unreact).toHaveBeenCalledWith('a1', 'like')
  })

  it('never lets an optimistic unreact go negative', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useReactions('a1', {}, []), { wrapper: wrapper(client) })
    await act(async () => { await result.current.unreact('like') })
    expect(result.current.counts.like ?? 0).toBeGreaterThanOrEqual(0)
  })

  it('unreact calls the renamed client method with (activityId, kind), not the old delete', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useReactions('a1', { like: 1 }, ['like']), { wrapper: wrapper(client) })
    await act(async () => { await result.current.unreact('like') })
    expect(client.reactions.unreact).toHaveBeenCalledWith('a1', 'like')
    expect(client.reactions.delete).not.toHaveBeenCalled()
    expect(result.current.counts.like).toBe(0)
    expect(result.current.ownReactions).not.toContain('like')
  })
})

describe('useFollow', () => {
  it('follows optimistically and keeps it on success', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.follow('user', 'bob') })
    expect(result.current.isFollowing('user', 'bob')).toBe(true)
  })

  it('rolls back a failed follow', async () => {
    const follow = vi.fn(async () => { throw new Error('nope') })
    const client = makeClient({
      feed: vi.fn(() => ({ follow, unfollow: vi.fn(), following: vi.fn(async () => ({ results: [], next: null })) })),
    })
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.follow('user', 'bob').catch(() => {}) })
    expect(result.current.isFollowing('user', 'bob')).toBe(false)
  })

  it('unfollows optimistically on success', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.follow('user', 'bob') })
    await act(async () => { await result.current.unfollow('user', 'bob') })
    expect(result.current.isFollowing('user', 'bob')).toBe(false)
  })

  it('rolls back a failed unfollow', async () => {
    const unfollow = vi.fn(async () => { throw new Error('nope') })
    const client = makeClient({
      feed: vi.fn(() => ({ follow: vi.fn(), unfollow, following: vi.fn() })),
    })
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.follow('user', 'bob').catch(() => {}) }) // optimistic add (follow mock undefined -> resolves)
    await act(async () => { await result.current.unfollow('user', 'bob').catch(() => {}) })
    expect(result.current.isFollowing('user', 'bob')).toBe(true) // restored
  })

  it('useFollow hydrates isFollowing from the server on mount', async () => {
    const following = vi.fn(async () => ({
      results: [{ source_group: 'timeline', source_id: 'alice', target_group: 'user', target_id: 'bob', created_at: '2026-01-01T00:00:00Z' }],
      next: null,
    }))
    const client = makeClient({ feed: vi.fn(() => ({ follow: vi.fn(async () => undefined), unfollow: vi.fn(async () => undefined), following })) })
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isFollowing('user', 'bob')).toBe(true))
  })

  it('an optimistic unfollow near mount is not reverted by a slower, stale hydration (case c)', async () => {
    // following() resolves LATER than the unfollow — a stale server snapshot that still
    // lists bob, taken before the unfollow's DELETE was processed.
    let resolveFollowing!: (v: { results: unknown[]; next: null }) => void
    const following = vi.fn(() => new Promise<{ results: unknown[]; next: null }>((r) => { resolveFollowing = r }))
    const client = makeClient({
      feed: vi.fn(() => ({
        follow: vi.fn(async () => undefined),
        unfollow: vi.fn(async () => undefined),
        following,
      })),
    })
    const { result } = renderHook(() => useFollow('timeline', 'alice'), { wrapper: wrapper(client) })

    // Optimistic unfollow fires immediately, while the mount-time hydration GET is still pending.
    await act(async () => { await result.current.unfollow('user', 'bob') })
    expect(result.current.isFollowing('user', 'bob')).toBe(false)

    // Hydration now lands, still reporting bob as followed (stale pre-delete state).
    await act(async () => {
      resolveFollowing({
        results: [{ source_group: 'timeline', source_id: 'alice', target_group: 'user', target_id: 'bob', created_at: '2026-01-01T00:00:00Z' }],
        next: null,
      })
      await Promise.resolve()
    })
    // Touched key: the user's own unfollow wins — hydration must not silently re-add bob.
    expect(result.current.isFollowing('user', 'bob')).toBe(false)
  })

  it('useFollowing returns the followed targets', async () => {
    const following = vi.fn(async () => ({
      results: [{ source_group: 'timeline', source_id: 'alice', target_group: 'user', target_id: 'bob', created_at: '2026-01-01T00:00:00Z' }],
      next: null,
    }))
    const client = makeClient({ feed: vi.fn(() => ({ following })) })
    const { result } = renderHook(() => useFollowing('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.following).toEqual([{ group: 'user', id: 'bob' }]))
  })
})

describe('useFollowStats', () => {
  it('loads follower/following counts, and refresh re-reads', async () => {
    const followStats = vi.fn()
      .mockResolvedValueOnce({ follower_count: 5, following_count: 3 })
      .mockResolvedValueOnce({ follower_count: 8, following_count: 4 })
    const client = makeClient({ feed: vi.fn(() => ({ followStats })) })
    const { result } = renderHook(() => useFollowStats('user', 'bob'), { wrapper: wrapper(client) })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.followerCount).toBe(5)
    expect(result.current.followingCount).toBe(3)
    expect(result.current.error).toBeNull()

    await act(async () => { await result.current.refresh() })
    expect(result.current.followerCount).toBe(8)
    expect(result.current.followingCount).toBe(4)
  })

  it('surfaces an error without throwing', async () => {
    const followStats = vi.fn(async () => { throw new Error('boom') })
    const client = makeClient({ feed: vi.fn(() => ({ followStats })) })
    const { result } = renderHook(() => useFollowStats('user', 'bob'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })
})

describe('useNotifications', () => {
  const notification = (id: string, over: Record<string, unknown> = {}) => ({
    id, verb: 'follow', actor: 'user:bob', object: 'user:me', reaction_kind: null,
    created_at: '2026-07-17T10:00:00Z', seen_at: null, read_at: null, actor_user: null, ...over,
  })

  it('loads a page and exposes unseen/unread counts', async () => {
    const notifications = {
      get: vi.fn(async () => ({ results: [notification('n1')], unseen: 1, unread: 1, next: null })),
      markSeen: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.unseen).toBe(1)
    expect(result.current.unread).toBe(1)
    expect(result.current.hasNext).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('markSeen() marks all optimistically — zeroes unseen and stamps seen_at', async () => {
    const notifications = {
      get: vi.fn(async () => ({ results: [notification('n1')], unseen: 3, unread: 3, next: null })),
      markSeen: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))

    await act(async () => { await result.current.markSeen() })
    expect(notifications.markSeen).toHaveBeenCalledWith(undefined)
    expect(result.current.unseen).toBe(0)
    expect(result.current.notifications[0]!.seen_at).not.toBeNull()
  })

  it('markSeen(ids) decrements by count and stamps only the given rows', async () => {
    const notifications = {
      get: vi.fn(async () => ({
        results: [notification('n1'), notification('n2')], unseen: 2, unread: 2, next: null,
      })),
      markSeen: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.notifications).toHaveLength(2))

    await act(async () => { await result.current.markSeen(['n1']) })
    expect(notifications.markSeen).toHaveBeenCalledWith(['n1'])
    expect(result.current.unseen).toBe(1)
    expect(result.current.notifications.find((n) => n.id === 'n1')!.seen_at).not.toBeNull()
    expect(result.current.notifications.find((n) => n.id === 'n2')!.seen_at).toBeNull()
  })

  it('markRead() rolls back the optimistic mark on error', async () => {
    const notifications = {
      get: vi.fn(async () => ({ results: [notification('n1')], unseen: 1, unread: 1, next: null })),
      markSeen: vi.fn(async () => undefined),
      markRead: vi.fn(async () => { throw new Error('boom') }),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.notifications).toHaveLength(1))

    await act(async () => { await result.current.markRead().catch(() => {}) })
    expect(result.current.unread).toBe(1) // restored
    expect(result.current.notifications[0]!.read_at).toBeNull() // restored
  })

  it('loadNext appends the next page and tracks hasNext', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [notification('n1')], unseen: 1, unread: 1, next: 'cur1' })
      .mockResolvedValueOnce({ results: [notification('n2')], unseen: 0, unread: 0, next: null })
    const notifications = { get, markSeen: vi.fn(), markRead: vi.fn() }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.notifications.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(result.current.hasNext).toBe(false)
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, next: 'cur1' }), expect.anything())
  })

  it('surfaces a load error without throwing', async () => {
    const notifications = {
      get: vi.fn(async () => { throw new Error('boom') }),
      markSeen: vi.fn(), markRead: vi.fn(),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })
})

describe('useNotifications live', () => {
  const page = { results: [], unseen: 0, unread: 0, next: null }

  it('refreshes only when the notification head changes', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => page)
      let latest: string | null = null
      const head = vi.fn(async () => ({ latest }))
      const client = makeClient({ notifications: { get, head } })
      renderHook(() => useNotifications({ live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(get).toHaveBeenCalledTimes(1) // mount load

      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(get).toHaveBeenCalledTimes(1) // null head → nothing

      latest = 'ntf_1'
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(get).toHaveBeenCalledTimes(2) // change → refresh

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(2) // consumed
    } finally { vi.useRealTimers() }
  })

  it('live beats pollInterval', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => page)
      const head = vi.fn(async () => ({ latest: null }))
      const client = makeClient({ notifications: { get, head } })
      renderHook(() => useNotifications({ live: true, pollInterval: 1000 }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(get).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('head errors are swallowed like poll errors — no error state, ticks continue', async () => {
    vi.useFakeTimers()
    try {
      const get = vi.fn(async () => page)
      const head = vi.fn(async () => { throw new Error('boom') })
      const client = makeClient({ notifications: { get, head } })
      const { result } = renderHook(() => useNotifications({ live: true }), { wrapper: wrapper(client) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(head).toHaveBeenCalledTimes(2)
      expect(result.current.error).toBeNull()
      expect(get).toHaveBeenCalledTimes(1) // mount only
    } finally { vi.useRealTimers() }
  })
})

describe('useFeedActions', () => {
  it('delegates addActivity and deleteActivity to the client', async () => {
    const add = vi.fn(async () => activity('new'))
    const remove = vi.fn(async () => undefined)
    const client = makeClient({ feed: vi.fn(() => ({ addActivity: add, removeActivity: remove })) })
    const { result } = renderHook(() => useFeedActions('user', 'alice'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.addActivity({ verb: 'post', object: 'w:1' }) })
    await act(async () => { await result.current.deleteActivity('a1') })
    expect(add).toHaveBeenCalledWith({ verb: 'post', object: 'w:1' })
    expect(remove).toHaveBeenCalledWith('a1')
  })
})

const reaction = (id: string, kind = 'like') => ({
  id, kind, activity_id: 'a1', user_id: 'bob', custom: {}, created_at: '2026-07-25T00:00:00Z',
})

describe('useReactionList', () => {
  const withReactions = (over: Record<string, unknown>) =>
    makeClient({ reactions: { add: vi.fn(), delete: vi.fn(async () => undefined), unreact: vi.fn(), list: vi.fn(), ...over } })

  it('loads reactions on mount and forwards the kind filter', async () => {
    const list = vi.fn(async () => ({ results: [reaction('r1')], next: null }))
    const { result } = renderHook(() => useReactionList('a1', { kind: 'like' }), {
      wrapper: wrapper(withReactions({ list })),
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.reactions.map((r) => r.id)).toEqual(['r1'])
    expect(list).toHaveBeenCalledWith('a1', expect.objectContaining({ kind: 'like', limit: 20 }), expect.anything())
  })

  it('loadNext appends and tracks hasNext', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ results: [reaction('r1')], next: 'c1' })
      .mockResolvedValueOnce({ results: [reaction('r2')], next: null })
    const { result } = renderHook(() => useReactionList('a1'), { wrapper: wrapper(withReactions({ list })) })
    await waitFor(() => expect(result.current.hasNext).toBe(true))
    await act(async () => { await result.current.loadNext() })
    expect(result.current.reactions.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(result.current.hasNext).toBe(false)
  })

  it('remove optimistically drops a row, rolling back on error', async () => {
    const del = vi.fn(async () => { throw new Error('nope') })
    const list = vi.fn(async () => ({ results: [reaction('r1'), reaction('r2')], next: null }))
    const { result } = renderHook(() => useReactionList('a1'), {
      wrapper: wrapper(withReactions({ list, delete: del })),
    })
    await waitFor(() => expect(result.current.reactions).toHaveLength(2))
    await act(async () => { await expect(result.current.remove('r1')).rejects.toThrow('nope') })
    expect(result.current.reactions.map((r) => r.id)).toEqual(['r1', 'r2']) // rolled back
  })
})

const followEdge = (sg: string, si: string) => ({
  source_group: sg, source_id: si, target_group: 'user', target_id: 'alice',
  created_at: '2026-07-25T00:00:00Z',
})

describe('useFollowers', () => {
  it('hydrates the follower side (source_*) of each edge', async () => {
    const client = makeClient({
      feed: vi.fn(() => ({ followers: vi.fn(async () => ({ results: [followEdge('user', 'bob')], next: null })) })),
    })
    const { result } = renderHook(() => useFollowers('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.followers).toEqual([{ group: 'user', id: 'bob' }])
    expect(result.current.error).toBeNull()
  })

  it('surfaces an error without throwing', async () => {
    const client = makeClient({
      feed: vi.fn(() => ({ followers: vi.fn(async () => { throw new Error('boom') }) })),
    })
    const { result } = renderHook(() => useFollowers('user', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })
})

describe('useCurrentUser', () => {
  it('loads the current user (null → populated)', async () => {
    const client = makeClient({ users: { me: vi.fn(async () => ({ id: 'alice', custom: { name: 'Alice' } })) } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapper(client) })
    expect(result.current.user).toBeNull()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.user).toEqual({ id: 'alice', custom: { name: 'Alice' } })
  })

  it('surfaces an error without throwing', async () => {
    const client = makeClient({ users: { me: vi.fn(async () => { throw new Error('boom') }) } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toBeNull()
  })
})

describe('provider', () => {
  it('throws a useful error when a hook is used outside the provider', () => {
    expect(() => renderHook(() => useFeed('timeline', 'alice'))).toThrow(/DropInProvider/)
  })

  it('DropInProvider builds a client from apiKey/url/tokenProvider', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [activity('conv')], next: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const conv = ({ children }: { children: React.ReactNode }) => (
      <DropInProvider apiKey="dk_test" url="https://x.test" tokenProvider={async () => 'tok'}>
        {children}
      </DropInProvider>
    )
    const { result } = renderHook(() => useFeed('user', 'alice'), { wrapper: conv })
    await waitFor(() => expect(result.current.activities[0]!.id).toBe('conv'))
    vi.unstubAllGlobals()
  })
})

describe('useSuggestions', () => {
  it('loads suggestions on mount, and refresh re-reads', async () => {
    const suggestions = vi.fn()
      .mockResolvedValueOnce({ results: [{ group: 'user', id: 'dave', mutuals: 2 }] })
      .mockResolvedValueOnce({ results: [{ group: 'user', id: 'erin', mutuals: 1 }] })
    const client = makeClient({ feed: vi.fn(() => ({ suggestions })) })
    const { result } = renderHook(() => useSuggestions('timeline', 'alice'), { wrapper: wrapper(client) })
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.suggestions).toEqual([{ group: 'user', id: 'dave', mutuals: 2 }])
    expect(result.current.error).toBeNull()

    await act(async () => { await result.current.refresh() })
    expect(result.current.suggestions).toEqual([{ group: 'user', id: 'erin', mutuals: 1 }])
  })

  it('forwards limit to the client', async () => {
    const suggestions = vi.fn(async () => ({ results: [] }))
    const client = makeClient({ feed: vi.fn(() => ({ suggestions })) })
    renderHook(() => useSuggestions('timeline', 'alice', { limit: 5 }), { wrapper: wrapper(client) })
    await waitFor(() => expect(suggestions).toHaveBeenCalled())
    expect(suggestions).toHaveBeenCalledWith({ limit: 5 }, expect.anything())
  })

  it('omits limit when not provided', async () => {
    const suggestions = vi.fn(async () => ({ results: [] }))
    const client = makeClient({ feed: vi.fn(() => ({ suggestions })) })
    renderHook(() => useSuggestions('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(suggestions).toHaveBeenCalled())
    expect(suggestions).toHaveBeenCalledWith({}, expect.anything())
  })

  it('surfaces an error without throwing', async () => {
    const suggestions = vi.fn(async () => { throw new Error('boom') })
    const client = makeClient({ feed: vi.fn(() => ({ suggestions })) })
    const { result } = renderHook(() => useSuggestions('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
  })
})

describe('cancellation on unmount', () => {
  /** Captures the RequestOptions each read was handed, so a test can assert on the signal
   *  the hook created — deterministic, unlike racing a real in-flight request. */
  function signalSpy() {
    const seen: Array<AbortSignal | undefined> = []
    const capture = (opts?: { signal?: AbortSignal }) => { seen.push(opts?.signal) }
    /** RequestOptions is the LAST argument, and its position differs per method
     *  (`users.me(opts)` vs `reactions.list(id, q, opts)`) — find it by shape. */
    const captureFrom = (args: unknown[]) => {
      const opts = args.find((a): a is { signal?: AbortSignal } =>
        typeof a === 'object' && a !== null && 'signal' in a)
      capture(opts)
    }
    return { seen, capture, captureFrom }
  }

  it('useFeed aborts its in-flight read when the component unmounts', async () => {
    const { seen, capture } = signalSpy()
    const client = makeClient({
      feed: vi.fn(() => ({
        get: vi.fn(async (_q: unknown, opts?: { signal?: AbortSignal }) => {
          capture(opts)
          return { results: [activity('a1')], next: null }
        }),
      })),
    })
    const { result, unmount } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]!.aborted).toBe(false)
    unmount()
    expect(seen[0]!.aborted).toBe(true)
  })

  it('useFeed aborts the previous feed read when group/id changes', async () => {
    const { seen, capture } = signalSpy()
    const client = makeClient({
      feed: vi.fn(() => ({
        get: vi.fn(async (_q: unknown, opts?: { signal?: AbortSignal }) => {
          capture(opts)
          return { results: [], next: null }
        }),
      })),
    })
    const { result, rerender } = renderHook(({ id }: { id: string }) => useFeed('timeline', id), {
      wrapper: wrapper(client), initialProps: { id: 'alice' },
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    rerender({ id: 'bob' })
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[0]!.aborted).toBe(true)  // alice's read is cancelled
    expect(seen[1]!.aborted).toBe(false) // bob's is live
  })

  it('does NOT surface an abort as an error', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const client = makeClient({
      users: { me: vi.fn(async () => { throw abortErr }) },
    })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.user).toBeNull()
  })

  it('still surfaces a real failure as an error', async () => {
    const client = makeClient({ users: { me: vi.fn(async () => { throw new Error('boom') }) } })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error!.message).toBe('boom')
  })

  it('WRITES are never aborted — a like already issued must land after unmount', async () => {
    const seen: Array<unknown> = []
    const add = vi.fn(async (...args: unknown[]) => { seen.push(args[3]); return {} })
    const client = makeClient({ reactions: { add, delete: vi.fn(), unreact: vi.fn() } })
    const { result, unmount } = renderHook(() => useReactions('a1'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.react('like') })
    unmount()
    expect(add).toHaveBeenCalledTimes(1)
    // No RequestOptions passed at all: nothing can cancel this call.
    expect(seen[0]).toBeUndefined()
  })

  it('read-only hooks each hand the client a signal that unmount aborts', async () => {
    const { seen, captureFrom } = signalSpy()
    const read = (result: unknown) => vi.fn(async (...args: unknown[]) => {
      captureFrom(args)
      return result
    })
    const client = makeClient({
      feed: vi.fn(() => ({
        following: read({ results: [], next: null }),
        followers: read({ results: [], next: null }),
        followStats: read({ follower_count: 0, following_count: 0 }),
        suggestions: read({ results: [] }),
        get: read({ results: [], next: null }),
      })),
      reactions: { list: read({ results: [], next: null }), add: vi.fn(), delete: vi.fn(), unreact: vi.fn() },
      notifications: { get: read({ results: [], unseen: 0, unread: 0, next: null }) },
      users: { me: read({ id: 'alice', custom: {} }) },
    })
    const { unmount } = renderHook(() => {
      useFollowing('user', 'alice')
      useFollowers('user', 'alice')
      useFollowStats('user', 'alice')
      useSuggestions('user', 'alice')
      useReactionList('a1')
      useNotifications()
      useCurrentUser()
    }, { wrapper: wrapper(client) })
    await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(7))
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true)
    unmount()
    expect(seen.every((s) => s!.aborted)).toBe(true)
  })
})

describe('optimistic-write onError plumbing', () => {
  it('threads provider-level onError into useReactions.react on rejection', async () => {
    const onError = vi.fn()
    const reactions = {
      add: vi.fn(async () => { throw new Error('boom') }),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <DropInProvider client={client as never} onError={onError}>{children}</DropInProvider>
    )
    const { result } = renderHook(() => useReactions('a1'), { wrapper: wrap })
    await act(async () => {
      // Should resolve (not reject) when provider-level onError is set.
      await result.current.react('like')
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]![0].message).toBe('boom')
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useReactions', action: 'react', activityId: 'a1', kind: 'like',
    })
  })

  it('useReactions.react with no onError still rejects after rollback (default contract)', async () => {
    const reactions = {
      add: vi.fn(async () => { throw new Error('boom') }),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const { result } = renderHook(() => useReactions('a1'), { wrapper: wrapper(client) })
    await act(async () => {
      await expect(result.current.react('like')).rejects.toThrow('boom')
    })
    expect(result.current.counts.like ?? 0).toBe(0) // rolled back
  })

  it('useReactions.react with call-level onError resolves and invokes callback with rich ctx', async () => {
    const onError = vi.fn()
    const reactions = {
      add: vi.fn(async () => { throw new Error('boom') }),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const { result } = renderHook(() => useReactions('a1'), { wrapper: wrapper(client) })
    await act(async () => {
      // Resolves (not rejects) and rolls back counts.
      await result.current.react('like', { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useReactions', action: 'react', activityId: 'a1', kind: 'like',
    })
    expect(result.current.counts.like ?? 0).toBe(0) // rolled back
    expect(result.current.ownReactions).not.toContain('like') // rolled back
  })

  it('useReactions.unreact with onError resolves and invokes callback', async () => {
    const onError = vi.fn()
    const reactions = {
      add: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => { throw new Error('boom') }),
    }
    const client = makeClient({ reactions })
    const { result } = renderHook(() => useReactions('a1', { like: 3 }, ['like']),
      { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.unreact('like', { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useReactions', action: 'unreact', activityId: 'a1', kind: 'like',
    })
    expect(result.current.counts.like).toBe(3) // rolled back
    expect(result.current.ownReactions).toContain('like') // rolled back
  })

  it('call-level onError overrides provider-level onError on useReactions', async () => {
    const providerOnError = vi.fn()
    const callOnError = vi.fn()
    const reactions = {
      add: vi.fn(async () => { throw new Error('boom') }),
      delete: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <DropInProvider client={client as never} onError={providerOnError}>{children}</DropInProvider>
    )
    const { result } = renderHook(() => useReactions('a1'), { wrapper: wrap })
    await act(async () => {
      await result.current.react('like', { onError: callOnError })
    })
    expect(providerOnError).not.toHaveBeenCalled()
    expect(callOnError).toHaveBeenCalledTimes(1)
  })

  it('useReactionList.remove with onError resolves and invokes callback', async () => {
    const onError = vi.fn()
    const reactions = {
      add: vi.fn(async () => undefined),
      delete: vi.fn(async () => { throw new Error('boom') }),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const { result } = renderHook(() => useReactionList('a1'), { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.remove('r1', { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useReactionList', action: 'remove', activityId: 'a1', reactionId: 'r1',
    })
  })

  it('useReactionList.remove with no onError still rejects after rollback (default contract)', async () => {
    const reactions = {
      add: vi.fn(async () => undefined),
      delete: vi.fn(async () => { throw new Error('boom') }),
      unreact: vi.fn(async () => undefined),
    }
    const client = makeClient({ reactions })
    const { result } = renderHook(() => useReactionList('a1'), { wrapper: wrapper(client) })
    await act(async () => {
      await expect(result.current.remove('r1')).rejects.toThrow('boom')
    })
  })

  it('useFollow.follow with onError resolves and invokes callback with source/target ctx', async () => {
    const onError = vi.fn()
    const feed = vi.fn(() => ({
      get: vi.fn(async () => ({ results: [], next: null })),
      follow: vi.fn(async () => { throw new Error('boom') }),
      unfollow: vi.fn(async () => undefined),
      following: vi.fn(async () => ({ results: [], next: null })),
      addActivity: vi.fn(async () => undefined),
      removeActivity: vi.fn(async () => undefined),
      suggestions: vi.fn(async () => ({ results: [] })),
      head: vi.fn(async () => ({ latest: null })),
    }))
    const client = makeClient({ feed })
    const { result } = renderHook(() => useFollow('user', 'me'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isFollowing('user', 'them')).toBe(false))
    await act(async () => {
      await result.current.follow('user', 'them', { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useFollow', action: 'follow',
      source: { group: 'user', id: 'me' },
      target: { group: 'user', id: 'them' },
    })
    expect(result.current.isFollowing('user', 'them')).toBe(false) // rolled back
  })

  it('useFollow.unfollow with onError resolves and invokes callback', async () => {
    const onError = vi.fn()
    const feed = vi.fn(() => ({
      get: vi.fn(async () => ({ results: [], next: null })),
      follow: vi.fn(async () => undefined),
      unfollow: vi.fn(async () => { throw new Error('boom') }),
      following: vi.fn(async () => ({ results: [], next: null })),
      addActivity: vi.fn(async () => undefined),
      removeActivity: vi.fn(async () => undefined),
      suggestions: vi.fn(async () => ({ results: [] })),
      head: vi.fn(async () => ({ latest: null })),
    }))
    const client = makeClient({ feed })
    const { result } = renderHook(() => useFollow('user', 'me'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isFollowing('user', 'them')).toBe(false))
    // Pre-seed the edge so unfollow has something to remove.
    await act(async () => { await result.current.follow('user', 'them') })
    await act(async () => { await result.current.unfollow('user', 'them', { onError }) })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useFollow', action: 'unfollow',
      source: { group: 'user', id: 'me' },
      target: { group: 'user', id: 'them' },
    })
  })

  it('useNotifications.markSeen with onError resolves and invokes callback with ids ctx', async () => {
    const onError = vi.fn()
    const notifications = {
      get: vi.fn(async () => ({ results: [], unseen: 0, unread: 0, next: null })),
      markSeen: vi.fn(async () => { throw new Error('boom') }),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.markSeen(['n1'], { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useNotifications', action: 'markSeen', ids: ['n1'],
    })
  })

  it('useNotifications.markSeen with no ids and onError passes ids=null in ctx', async () => {
    const onError = vi.fn()
    const notifications = {
      get: vi.fn(async () => ({ results: [], unseen: 0, unread: 0, next: null })),
      markSeen: vi.fn(async () => { throw new Error('boom') }),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.markSeen(undefined, { onError })
    })
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useNotifications', action: 'markSeen', ids: null,
    })
  })

  it('useNotifications.markRead with onError resolves and invokes callback', async () => {
    const onError = vi.fn()
    const notifications = {
      get: vi.fn(async () => ({ results: [], unseen: 0, unread: 0, next: null })),
      markSeen: vi.fn(async () => undefined),
      markRead: vi.fn(async () => { throw new Error('boom') }),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await act(async () => {
      await result.current.markRead([], { onError })
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toMatchObject({
      hook: 'useNotifications', action: 'markRead', ids: [],
    })
  })

  it('useNotifications.markSeen with no onError still rejects after rollback (default contract)', async () => {
    const notifications = {
      get: vi.fn(async () => ({ results: [], unseen: 0, unread: 0, next: null })),
      markSeen: vi.fn(async () => { throw new Error('boom') }),
      markRead: vi.fn(async () => undefined),
    }
    const client = makeClient({ notifications })
    const { result } = renderHook(() => useNotifications(), { wrapper: wrapper(client) })
    await act(async () => {
      await expect(result.current.markSeen(['n1'])).rejects.toThrow('boom')
    })
  })
})
