import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import React from 'react'
import { DropInProvider, useFeed, placePromoted } from './index.js'
import type { Activity, PromotedActivity } from '@dropinnodex/client'

const activity = (id: string) => ({
  id, actor: 'user:alice', verb: 'post', object: `w:${id}`, target: null, foreign_id: null,
  time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
  reaction_counts: {}, actor_user: null, own_reactions: [],
}) as Activity

const promo = (id: string): PromotedActivity => ({
  id, actor: 'system:fcurban', verb: 'promote', object: `game:${id}`, custom: {}, promoted: true,
})

/** Page 1 carries the sidecar; later pages never do (that is the server contract). */
function makeClient(opts: { pages: Activity[][]; promoted?: PromotedActivity[] }) {
  let call = 0
  const get = vi.fn(async (q: { next?: string } = {}) => {
    const page = opts.pages[call] ?? []
    call++
    const next = call < opts.pages.length ? `cur${call}` : null
    return q.next === undefined
      ? { results: page, next, ...(opts.promoted ? { promoted: opts.promoted } : {}) }
      : { results: page, next }
  })
  return {
    feed: vi.fn(() => ({
      get,
      follow: vi.fn(async () => undefined),
      unfollow: vi.fn(async () => undefined),
      following: vi.fn(async () => ({ results: [], next: null })),
      addActivity: vi.fn(async () => activity('new')),
      removeActivity: vi.fn(async () => undefined),
      suggestions: vi.fn(async () => ({ results: [] })),
      head: vi.fn(async () => ({ latest: null })),
    })),
    reactions: { add: vi.fn(), delete: vi.fn(), unreact: vi.fn() },
  }
}

function wrapper(client: unknown) {
  return ({ children }: { children: React.ReactNode }) =>
    <DropInProvider client={client as never}>{children}</DropInProvider>
}

const ids = (items: Array<Activity | PromotedActivity>) => items.map((i) => i.id)

describe('placePromoted', () => {
  const acts = Array.from({ length: 9 }, (_, i) => activity(`a${i + 1}`))

  it('places once by default, after `position` activities', () => {
    const out = placePromoted(acts, [promo('p1')], { position: 3 })
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'p1', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
  })

  it('repeats every N activities when asked', () => {
    const out = placePromoted(acts, [promo('p1')], { position: 3, repeatEvery: 3 })
    expect(ids(out)).toEqual(['a1', 'a2', 'a3', 'p1', 'a4', 'a5', 'a6', 'p1', 'a7', 'a8', 'a9', 'p1'])
  })

  it('rotates through the eligible set across slots, wrapping', () => {
    const out = placePromoted(acts, [promo('p1'), promo('p2')], { position: 3, repeatEvery: 3 })
    expect(ids(out).filter((i) => i.startsWith('p'))).toEqual(['p1', 'p2', 'p1'])
  })

  it('still shows one on a feed shorter than `position` — including an empty one', () => {
    expect(ids(placePromoted([activity('a1')], [promo('p1')], { position: 3 }))).toEqual(['a1', 'p1'])
    expect(ids(placePromoted([], [promo('p1')], { position: 3 }))).toEqual(['p1'])
  })

  it('is the identity when there is nothing to place', () => {
    expect(placePromoted(acts, [], { position: 3 })).toEqual(acts)
    expect(placePromoted(acts, undefined, { position: 3 })).toEqual(acts)
  })

  it('marks promoted items so a renderer can branch on them', () => {
    const out = placePromoted(acts, [promo('p1')], { position: 1 })
    expect(out.filter((i) => 'promoted' in i && i.promoted)).toHaveLength(1)
  })
})

describe('useFeed — promoted', () => {
  it('exposes the sidecar from page 1', async () => {
    const client = makeClient({ pages: [[activity('a1')]], promoted: [promo('p1')] })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.promoted.map((p) => p.id)).toEqual(['p1'])
    // activities stays exactly what it always was — no promoted rows smuggled in.
    expect(result.current.activities.map((a) => a.id)).toEqual(['a1'])
  })

  it('returns an empty array when the server sends no sidecar', async () => {
    const client = makeClient({ pages: [[activity('a1')]] })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.promoted).toEqual([])
  })

  it('places into `items` using the props, default position 3 and no repeat', async () => {
    const client = makeClient({
      pages: [Array.from({ length: 5 }, (_, i) => activity(`a${i + 1}`))],
      promoted: [promo('p1')],
    })
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(ids(result.current.items)).toEqual(['a1', 'a2', 'a3', 'p1', 'a4', 'a5'])
  })

  it('keeps placing from the cached sidecar as later pages load', async () => {
    const client = makeClient({
      pages: [
        [activity('a1'), activity('a2'), activity('a3')],
        [activity('a4'), activity('a5'), activity('a6')],
        [activity('a7'), activity('a8'), activity('a9')],
      ],
      promoted: [promo('p1'), promo('p2')],
    })
    const { result } = renderHook(
      () => useFeed('timeline', 'alice', { promotedPosition: 3, promotedRepeatEvery: 3 }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await act(async () => { await result.current.loadNext() })
    await act(async () => { await result.current.loadNext() })

    expect(result.current.activities).toHaveLength(9)
    // The sidecar set never changed — page 2 and 3 carried none — yet their slots filled.
    expect(result.current.promoted.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(ids(result.current.items).filter((i) => i.startsWith('p'))).toEqual(['p1', 'p2', 'p1'])
  })

  it('fires onPromotedImpression once per placed slot, not once per render', async () => {
    const onPromotedImpression = vi.fn()
    const client = makeClient({
      pages: [Array.from({ length: 6 }, (_, i) => activity(`a${i + 1}`))],
      promoted: [promo('p1')],
    })
    const { result, rerender } = renderHook(
      () => useFeed('timeline', 'alice', { promotedPosition: 3, promotedRepeatEvery: 3, onPromotedImpression }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await waitFor(() => expect(onPromotedImpression).toHaveBeenCalledTimes(2))

    rerender()
    rerender()
    expect(onPromotedImpression).toHaveBeenCalledTimes(2)
    expect(onPromotedImpression.mock.calls[0]![0]).toMatchObject({ id: 'p1', promoted: true })
    expect(onPromotedImpression.mock.calls[0]![1]).toEqual({ slot: 0 })
  })

  it('trackPromotedClick forwards to onPromotedClick', async () => {
    const onPromotedClick = vi.fn()
    const client = makeClient({ pages: [[activity('a1')]], promoted: [promo('p1')] })
    const { result } = renderHook(
      () => useFeed('timeline', 'alice', { onPromotedClick }),
      { wrapper: wrapper(client) },
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => { result.current.trackPromotedClick(result.current.promoted[0]!) })
    expect(onPromotedClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })

  it('is inert inside a disabled provider — no sidecar, no callbacks', async () => {
    const onPromotedImpression = vi.fn()
    const { result } = renderHook(
      () => useFeed('timeline', 'alice', { onPromotedImpression }),
      { wrapper: wrapper(null) },
    )
    expect(result.current.enabled).toBe(false)
    expect(result.current.promoted).toEqual([])
    expect(result.current.items).toEqual([])
    await new Promise((r) => setTimeout(r, 20))
    expect(onPromotedImpression).not.toHaveBeenCalled()
  })
})
