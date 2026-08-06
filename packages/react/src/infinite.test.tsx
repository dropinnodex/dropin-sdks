import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import React from 'react'
import { DropInProvider, useInfiniteFeed } from './index.js'

const activity = (id: string) => ({
  id, actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
  time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
  reaction_counts: {}, actor_user: null, own_reactions: [],
})

function makeClient(get: unknown) {
  return { feed: vi.fn(() => ({ get, head: vi.fn(async () => ({ latest: null })) })) }
}

/** Stands in for the browser's IntersectionObserver: jsdom has none, and a real one
 *  never fires without layout anyway. `fire()` is the scroll. */
class FakeIO {
  static instances: FakeIO[] = []
  static get last() { return FakeIO.instances[FakeIO.instances.length - 1] }
  observed: Element[] = []
  disconnected = false
  constructor(
    private cb: IntersectionObserverCallback,
    readonly opts?: IntersectionObserverInit,
  ) { FakeIO.instances.push(this) }
  observe(el: Element) { this.observed.push(el) }
  unobserve() { /* unused */ }
  disconnect() { this.disconnected = true }
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

type FeedState = ReturnType<typeof useInfiniteFeed>

function Harness({ onState, opts }: { onState: (s: FeedState) => void; opts?: object }) {
  const feed = useInfiniteFeed('timeline', 'alice', opts)
  onState(feed)
  return <div ref={feed.sentinelRef} />
}

function mount(get: unknown, opts?: object) {
  let state!: FeedState
  const utils = render(
    <DropInProvider client={makeClient(get) as never}>
      <Harness onState={(s) => { state = s }} opts={opts} />
    </DropInProvider>,
  )
  return { ...utils, get state() { return state } }
}

beforeEach(() => {
  FakeIO.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('useInfiniteFeed', () => {
  it('loads the next page when the sentinel intersects', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const h = mount(get)
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))

    await act(async () => { FakeIO.last!.fire(true) })
    await waitFor(() => expect(h.state.activities.map((a) => a.id)).toEqual(['a1', 'a2']))
  })

  it('keeps paging while the sentinel stays intersecting', async () => {
    // The failure this exists for: after page 2 lands the sentinel is STILL in view, so no
    // new intersection event ever fires and a naive implementation stops paging forever.
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: 'cur2' })
      .mockResolvedValueOnce({ results: [activity('a3')], next: null })
    const h = mount(get)
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))

    await act(async () => { FakeIO.last!.fire(true) }) // one scroll, three pages

    await waitFor(() => expect(h.state.activities.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']))
    expect(get).toHaveBeenCalledTimes(3)
    expect(h.state.canLoadMore).toBe(false) // and it stops at end-of-feed
  })

  it('does not fetch while canLoadMore is false', async () => {
    const get = vi.fn().mockResolvedValue({ results: [activity('a1')], next: null })
    const h = mount(get)
    await waitFor(() => expect(h.state.isLoading).toBe(false))

    await act(async () => { FakeIO.last?.fire(true) })
    expect(get).toHaveBeenCalledTimes(1) // mount only — the feed is exhausted
  })

  it('stops at a failed page and resumes only after retry()', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockRejectedValueOnce(new Error('page 2 boom'))
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const h = mount(get)
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))

    await act(async () => { FakeIO.last!.fire(true) })
    await waitFor(() => expect(h.state.error).not.toBeNull())
    // Sentinel is still intersecting. Without the error guard this is an infinite
    // request loop against the same cursor.
    await act(async () => { FakeIO.last!.fire(true) })
    expect(get).toHaveBeenCalledTimes(2)

    await act(async () => { await h.state.retry() })
    expect(h.state.activities.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('passes rootMargin through and disconnects on unmount', async () => {
    const get = vi.fn().mockResolvedValue({ results: [activity('a1')], next: 'cur1' })
    const h = mount(get, { rootMargin: '900px' })
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))
    expect(FakeIO.last!.opts?.rootMargin).toBe('900px')

    h.unmount()
    expect(FakeIO.instances.every((io) => io.disconnected)).toBe(true)
  })

  it('onEndReached is the React Native path and respects canLoadMore', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const h = mount(get)
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))

    await act(async () => { h.state.onEndReached() })
    await waitFor(() => expect(h.state.activities.map((a) => a.id)).toEqual(['a1', 'a2']))

    await act(async () => { h.state.onEndReached() }) // exhausted now
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('degrades to onEndReached where IntersectionObserver does not exist (React Native)', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const get = vi.fn()
      .mockResolvedValueOnce({ results: [activity('a1')], next: 'cur1' })
      .mockResolvedValueOnce({ results: [activity('a2')], next: null })
    const h = mount(get) // attaching sentinelRef must not throw
    await waitFor(() => expect(h.state.canLoadMore).toBe(true))

    await act(async () => { h.state.onEndReached() })
    await waitFor(() => expect(h.state.activities.map((a) => a.id)).toEqual(['a1', 'a2']))
  })
})
