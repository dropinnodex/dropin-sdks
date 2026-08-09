import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, waitFor, act } from '@testing-library/react'
import React from 'react'
import {
  DropInProvider, useDropInClient, useDropInEnabled,
  useFeed, useFeedActions, useNotifications, useFollowStats, useSuggestions, useReactions,
} from './index.js'

const activity = (id: string) => ({
  id, actor: 'user:alice', verb: 'post', object: 'w:1', target: null, foreign_id: null,
  time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
  reaction_counts: {}, actor_user: null, own_reactions: [],
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

// The convenience-props form: if a disabled provider ever constructs a real
// DropInClient and lets a hook fire, the request lands on this spy.
const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ results: [], next: null })))
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy) })
afterEach(() => { vi.unstubAllGlobals() })

function disabledWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DropInProvider apiKey="k" url="http://api.example" tokenProvider={async () => 'tok'} enabled={false}>
      {children}
    </DropInProvider>
  )
}

describe('DropInProvider enabled={false}', () => {
  it('renders its children', () => {
    const { getByText } = render(
      <DropInProvider apiKey="k" url="http://x" tokenProvider={async () => 't'} enabled={false}>
        <span>hello</span>
      </DropInProvider>,
    )
    expect(getByText('hello')).toBeTruthy()
  })

  it('useFeed returns its full inert shape and never fetches', async () => {
    const { result } = renderHook(() => useFeed('timeline', 'alice'), { wrapper: disabledWrapper })
    expect(result.current.activities).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.enabled).toBe(false)
    expect(result.current.hasNext).toBe(false)
    expect(result.current.newCount).toBe(0)
    expect(result.current.promoted).toEqual([])
    expect(result.current.items).toEqual([])
    expect(result.current.objects).toEqual({})
    // An inert feed can never load more, so a mounted sentinel stays quiet.
    expect(result.current.canLoadMore).toBe(false)
    expect(result.current.isLoadingInitial).toBe(false)
    expect(result.current.isLoadingMore).toBe(false)
    // Shape keys, not just values — the inert return must mirror the live one (plus `enabled`).
    expect(Object.keys(result.current).sort()).toEqual([
      'activities', 'addActivity', 'canLoadMore', 'checkNew', 'enabled', 'error', 'hasNext',
      'isLoading', 'isLoadingInitial', 'isLoadingMore', 'items', 'loadNext', 'newCount',
      'objects', 'promoted', 'refresh', 'retry', 'revalidateObjects', 'showNew',
      'trackPromotedClick', 'updateActivity',
    ])
    // Its action/read fns are no-ops resolving undefined.
    await act(async () => {
      await expect(result.current.loadNext()).resolves.toBeUndefined()
      await expect(result.current.retry()).resolves.toBeUndefined()
      await expect(result.current.refresh()).resolves.toBeUndefined()
      await expect(result.current.checkNew()).resolves.toBeUndefined()
      await expect(result.current.revalidateObjects()).resolves.toBeUndefined()
      await expect(
        result.current.addActivity({ verb: 'post', object: 'w:1' }),
      ).resolves.toBeUndefined()
      await expect(
        result.current.updateActivity('a1', { set: { 'custom.a': 1 } }),
      ).resolves.toBeUndefined()
    })
    // Give any stray effect a chance to fire, then assert zero network.
    await act(async () => { await Promise.resolve() })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useFeedActions fns no-op resolve undefined, zero network', async () => {
    const { result } = renderHook(() => useFeedActions('user', 'alice'), { wrapper: disabledWrapper })
    expect(result.current.enabled).toBe(false)
    await act(async () => {
      await expect(
        result.current.addActivity({ verb: 'post', object: 'w:1' }),
      ).resolves.toBeUndefined()
      await expect(result.current.deleteActivity('a1')).resolves.toBeUndefined()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useNotifications returns its inert shape; markSeen/markRead no-op', async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: disabledWrapper })
    expect(Object.keys(result.current).sort()).toEqual([
      'enabled', 'error', 'hasNext', 'isLoading', 'loadNext',
      'markRead', 'markSeen', 'notifications', 'refresh', 'unread', 'unseen',
    ])
    expect(result.current.notifications).toEqual([])
    expect(result.current.unseen).toBe(0)
    expect(result.current.unread).toBe(0)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.enabled).toBe(false)
    await act(async () => {
      await expect(result.current.markSeen()).resolves.toBeUndefined()
      await expect(result.current.markRead(['n1'])).resolves.toBeUndefined()
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not invoke onError when the provider is disabled (no error to observe)', async () => {
    const onError = vi.fn()
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <DropInProvider apiKey="k" url="http://api.example" tokenProvider={async () => 't'}
                      enabled={false} onError={onError}>
        {children}
      </DropInProvider>
    )
    const { result } = renderHook(() => useNotifications(), { wrapper: wrap })
    await act(async () => {
      await expect(result.current.markSeen(['n1'], { onError })).resolves.toBeUndefined()
      await expect(result.current.markRead()).resolves.toBeUndefined()
    })
    expect(onError).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useFollowStats returns its inert shape', async () => {
    const { result } = renderHook(() => useFollowStats('user', 'alice'), { wrapper: disabledWrapper })
    expect(Object.keys(result.current).sort()).toEqual([
      'enabled', 'error', 'followerCount', 'followingCount', 'isLoading', 'refresh',
    ])
    expect(result.current.followerCount).toBe(0)
    expect(result.current.followingCount).toBe(0)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.enabled).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useSuggestions returns its inert shape', async () => {
    const { result } = renderHook(() => useSuggestions('user', 'alice'), { wrapper: disabledWrapper })
    expect(Object.keys(result.current).sort()).toEqual([
      'enabled', 'error', 'isLoading', 'refresh', 'suggestions',
    ])
    expect(result.current.suggestions).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.enabled).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useReactions react/unreact no-op without optimistic mutation', async () => {
    const { result } = renderHook(() => useReactions('a1', { like: 2 }, []), { wrapper: disabledWrapper })
    expect(result.current.enabled).toBe(false)
    await act(async () => {
      await expect(result.current.react('like')).resolves.toBeUndefined()
      await expect(result.current.unreact('like')).resolves.toBeUndefined()
    })
    // No optimistic bump either — disabled means fully inert, not "optimistic then stuck".
    expect(result.current.counts).toEqual({ like: 2 })
    expect(result.current.ownReactions).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('useDropInClient throws a clear misuse error under a disabled provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useDropInClient(), { wrapper: disabledWrapper }))
      .toThrow(/enabled/)
    spy.mockRestore()
  })
})

describe('useDropInEnabled', () => {
  it('is false under a disabled provider', () => {
    const { result } = renderHook(() => useDropInEnabled(), { wrapper: disabledWrapper })
    expect(result.current).toBe(false)
  })

  it('is true under a normal provider (client form, no enabled prop)', () => {
    const client = makeClient()
    const { result } = renderHook(() => useDropInEnabled(), {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        <DropInProvider client={client as never}>{children}</DropInProvider>,
    })
    expect(result.current).toBe(true)
  })

  it('throws without a provider, like every other hook', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useDropInEnabled())).toThrow(/DropInProvider/)
    spy.mockRestore()
  })
})

describe('enabled defaults to true', () => {
  it('hooks behave normally and report enabled: true', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeed('timeline', 'alice'), {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        <DropInProvider client={client as never}>{children}</DropInProvider>,
    })
    expect(result.current.enabled).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)
  })

  it('explicit enabled={true} on the client form also behaves normally', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useFeed('timeline', 'alice'), {
      wrapper: ({ children }: { children: React.ReactNode }) =>
        <DropInProvider client={client as never} enabled>{children}</DropInProvider>,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activities).toHaveLength(1)
    expect(result.current.enabled).toBe(true)
  })
})

describe('no provider at all', () => {
  it('useFeed still throws (misconfiguration stays loud)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useFeed('timeline', 'alice'))).toThrow(/DropInProvider/)
    spy.mockRestore()
  })
})
