import React, { createContext, useContext, useMemo, useRef } from 'react'
import { DropInClient } from '@dropinnodex/client'
import type { Activity } from '@dropinnodex/client'
import type { OptimisticOnError } from './hooks.js'

export interface CacheEntry {
  activities: Activity[]
  next: string | null
}

interface ContextValue {
  /** `null` only inside a disabled provider (`enabled={false}`) — no client is ever built. */
  client: DropInClient | null
  cache: Map<string, CacheEntry>
  /** Provider-level default error sink for optimistic writes. Per-call `opts.onError`
   *  on each action overrides this. `undefined` preserves the default reject-after-
   *  rollback contract. */
  onError: OptimisticOnError | undefined
}

const Ctx = createContext<ContextValue | null>(null)

type ProviderProps =
  | { client: DropInClient; enabled?: boolean; onError?: OptimisticOnError; children: React.ReactNode }
  | {
      apiKey: string
      url: string
      tokenProvider: () => Promise<string>
      /**
       * Who the `tokenProvider` currently mints for. Optional, and only load-bearing when
       * the signed-in user can change while this provider stays mounted — pass it there
       * and treat it as required.
       *
       * The client is memoized and caches its token until a 401, so neither a new
       * `tokenProvider` closure nor a re-render dislodges a still-valid token minted for
       * whoever was signed in before. Changing `userId` rebuilds the client and drops the
       * feed cache with it, which is what stops one user rendering another's feed —
       * `own_reactions` most visibly.
       */
      userId?: string
      enabled?: boolean
      onError?: OptimisticOnError
      children: React.ReactNode
    }

/**
 * Provides a DropInClient (and its per-feed cache) to the hooks below.
 *
 * Accepts either form:
 * - `<DropInProvider client={myClient}>` — bring your own, already-constructed client.
 * - `<DropInProvider apiKey={k} url={u} tokenProvider={fn}>` — the provider builds the
 *   client for you. `tokenProvider` is called lazily, only when a request needs a token.
 *
 * Both forms accept `enabled` (default `true`). `enabled={false}` puts the whole tree
 * into an inert mode: NO client is constructed, zero network requests are ever made, and
 * every hook returns its normal shape with empty data, `isLoading: false`, `error: null`
 * and `enabled: false`. Action functions become no-ops that RESOLVE to `undefined` — not
 * rejections — so an optional feed integration (`<DropInProvider enabled={!!apiKey}>`)
 * can never break the host app's flow. Check `useDropInEnabled()` (or the `enabled`
 * field on any hook return) when the app needs to know. Note: rendering hooks with no
 * provider at all still throws — disabled mode is an explicit choice, missing
 * configuration stays loud.
 *
 * Both forms also accept an optional `onError` (typed `OptimisticOnError`) that every
 * hook's optimistic action uses as the default error sink — see "Optimistic-write error
 * handling" in the README.
 *
 * Note: the client is memoized on apiKey/url/userId, never on `tokenProvider` — that is
 * an inline arrow in most apps, and keying on it would rebuild the client every render.
 * **Pass `userId` whenever the signed-in user can change without remounting this
 * provider.** Without it the memo holds the old client, which holds a still-valid token
 * for the previous user, and the next user reads that user's feed. A provider that is
 * remounted on sign-in, or whose tokenProvider always mints for one session, needs
 * nothing.
 */
export function DropInProvider(props: ProviderProps) {
  const { children } = props
  const enabled = props.enabled !== false
  const onError = props.onError
  // The memo always runs (hooks must be unconditional); a supplied client wins.
  // When disabled it returns null WITHOUT constructing anything — that is the whole point.
  const client = useMemo(
    () => {
      if (!enabled) return null
      return 'client' in props
        ? props.client
        : new DropInClient({ apiKey: props.apiKey, url: props.url, tokenProvider: props.tokenProvider })
    },
    // Rebuild only when an identity-defining input changes: enabled, the supplied client,
    // or apiKey+url+userId. `tokenProvider` is deliberately absent — it is an inline arrow
    // in most apps, so keying on it would rebuild every render and refetch every feed.
    // `userId` is the stable stand-in for the identity that closure mints for.
    [
      enabled,
      'client' in props ? props.client : props.apiKey,
      'client' in props ? undefined : props.url,
      'client' in props ? undefined : props.userId,
    ],
  )
  // A small cache keyed by feed. Deliberately not TanStack Query — this package stays
  // dependency-free apart from React itself.
  //
  // Its lifetime is the client's. A cached page carries caller-scoped data (`own_reactions`,
  // and notification reads are owner-scoped), so surviving an identity change would hand
  // the next user the previous one's view until every feed refetched. Reset in render
  // rather than an effect: an effect would let one paint through with the stale map.
  const cache = useRef(new Map<string, CacheEntry>())
  const clientRef = useRef(client)
  if (clientRef.current !== client) {
    clientRef.current = client
    cache.current = new Map<string, CacheEntry>()
  }
  const value = useMemo(() => ({ client, cache: cache.current, onError }), [client, onError])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDropInContext(): ContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDropIn hooks must be used inside a <DropInProvider>')
  return ctx
}

/**
 * The provider's client, or `null` inside a disabled provider. Internal accessor used by
 * the hooks so they can go inert instead of throwing. Prefer `useDropInEnabled()` in app
 * code; reach for this only when you genuinely need the client-or-null itself.
 */
export function useDropInClientOrNull(): DropInClient | null {
  return useDropInContext().client
}

/**
 * The provider's client. Throws when called inside a DISABLED provider
 * (`enabled={false}`) — there is no client there by design; gate on
 * `useDropInEnabled()` first, or use `useDropInClientOrNull()`.
 */
export function useDropInClient(): DropInClient {
  const { client } = useDropInContext()
  if (client === null) {
    throw new Error(
      'useDropInClient() was called inside a disabled <DropInProvider enabled={false}> — '
      + 'no client exists there. Gate on useDropInEnabled() first, or use useDropInClientOrNull().',
    )
  }
  return client
}

/**
 * `true` inside a normal provider, `false` inside `<DropInProvider enabled={false}>`.
 * Throws when there is no provider at all (same convention as every other hook).
 */
export function useDropInEnabled(): boolean {
  return useDropInContext().client !== null
}
