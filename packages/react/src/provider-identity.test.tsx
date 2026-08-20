import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import React from 'react'
import { DropInProvider, useDropInClient, useFeed } from './index.js'
import { useDropInContext } from './provider.js'

/**
 * A provider built from apiKey/url/tokenProvider memoizes the client, and the client
 * caches its token until a 401. Both are right alone and wrong together the moment the
 * signed-in user changes without a remount: the memo holds the old client, that client
 * holds a still-valid token minted for the PREVIOUS user, and its per-feed cache still
 * holds that user's page — including their `own_reactions`. `userId` is the identity
 * input that has to break the memo.
 *
 * These must run against ONE mounted tree. Two separate renders produce two clients
 * whatever the implementation does, which proves nothing.
 */
describe('DropInProvider identity', () => {
  const seen: unknown[] = []
  const caches: Map<string, unknown>[] = []
  const Probe = () => {
    seen.push(useDropInClient())
    caches.push(useDropInContext().cache as Map<string, unknown>)
    return null
  }
  const tree = (userId: string) => (
    <DropInProvider apiKey="k" url="http://api.example"
                    tokenProvider={async () => `tok-${userId}`} userId={userId}>
      <Probe />
    </DropInProvider>
  )

  it('keeps one client across re-renders of the same identity', () => {
    seen.length = 0
    const { rerender } = render(tree('alice'))
    const first = seen.at(-1)
    rerender(tree('alice'))
    expect(seen.at(-1)).toBe(first) // no churn: a rebuild here would refetch every feed
  })

  it('rebuilds the client when userId changes', () => {
    seen.length = 0
    const { rerender } = render(tree('alice'))
    const alice = seen.at(-1)
    rerender(tree('bob'))
    expect(seen.at(-1)).not.toBe(alice)
  })

  it('drops the feed cache with the client, so bob never reads alice\'s page', () => {
    caches.length = 0
    const { rerender } = render(tree('alice'))
    caches.at(-1)?.set('timeline:x', { activities: [{ id: 'a1' }], next: null })
    rerender(tree('bob'))
    expect(caches.at(-1)?.has('timeline:x')).toBe(false)
  })

  it('a client-form provider still gets a fresh cache when the client changes', () => {
    // No userId on this form — the app owns the client, so swapping it IS the identity
    // change. The cache must follow it either way.
    const mk = () => ({ feed: () => ({}) }) as never
    const a = mk(), b = mk()
    const t = (c: never) => <DropInProvider client={c}><Probe /></DropInProvider>
    caches.length = 0
    const { rerender } = render(t(a))
    caches.at(-1)?.set('timeline:x', { activities: [], next: null })
    rerender(t(a))
    expect(caches.at(-1)?.has('timeline:x')).toBe(true)
    rerender(t(b))
    expect(caches.at(-1)?.has('timeline:x')).toBe(false)
  })

  it('the next user is served by a token minted for THEM, not the cached one', async () => {
    // The whole point. The client caches its token until a 401, so without a rebuild the
    // previous user's still-valid token keeps authorizing every read.
    const seenAuth: string[] = []
    const fetchMock = vi.fn(async (_u: string, init?: { headers?: Record<string, string> }) => {
      seenAuth.push(init?.headers?.authorization ?? '')
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ results: [], next: null }),
        text: async () => '{"results":[],"next":null}',
      } as never
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const Feed = () => { useFeed('timeline', 'x'); return null }
      const t = (userId: string) => (
        <DropInProvider apiKey="k" url="http://api.example"
                        tokenProvider={async () => `tok-${userId}`} userId={userId}>
          <Feed />
        </DropInProvider>
      )
      const { rerender } = render(t('alice'))
      await waitFor(() => expect(seenAuth.length).toBeGreaterThan(0))
      expect(seenAuth.at(-1)).toContain('tok-alice')

      rerender(t('bob'))
      await waitFor(() => expect(seenAuth.at(-1)).toContain('tok-bob'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never re-seeds the new user from the previous user\'s SSR initialData', async () => {
    // Wiping the cache alone hands control to `initialData`, which was minted for whoever
    // was signed in when the page was server-rendered and does NOT change on a switch.
    // Seeded that way, bob renders alice's page with isLoadingInitial false — no spinner,
    // no error, no clue.
    const alicePage = {
      results: [{ id: 'alice-1', actor: 'user:alice', verb: 'post', object: 'w:1', target: null,
                  foreign_id: null, time: '2026-07-17T10:00:00Z', custom: {}, origin_feed: 'user:alice',
                  reaction_counts: {}, actor_user: null, own_reactions: ['like'] }],
      next: null,
    }
    const seen: { ids: string[]; loading: boolean }[] = []
    const Feed = () => {
      const f = useFeed('timeline', 'x', { initialData: alicePage as never })
      seen.push({ ids: f.activities.map((a) => a.id), loading: f.isLoadingInitial })
      return null
    }
    const t = (userId: string) => (
      <DropInProvider apiKey="k" url="http://api.example"
                      tokenProvider={async () => `tok-${userId}`} userId={userId}>
        <Feed />
      </DropInProvider>
    )
    const { rerender } = render(t('alice'))
    expect(seen[0]?.ids).toEqual(['alice-1']) // correct for alice: SSR hydrates with no flash

    rerender(t('bob'))
    expect(seen.at(-1)?.ids).toEqual([])      // bob sees nothing of alice's
    expect(seen.at(-1)?.loading).toBe(true)   // and is told a read is in flight
  })

  it('leaves the cache alone while the identity holds', () => {
    caches.length = 0
    const { rerender } = render(tree('alice'))
    caches.at(-1)?.set('timeline:x', { activities: [{ id: 'a1' }], next: null })
    rerender(tree('alice'))
    expect(caches.at(-1)?.has('timeline:x')).toBe(true)
  })
})
