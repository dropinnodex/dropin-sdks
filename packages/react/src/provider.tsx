import React, { createContext, useContext, useMemo, useRef } from 'react'
import { DropInClient } from '@dropinnodex/client'
import type { Activity } from '@dropinnodex/client'

export interface CacheEntry {
  activities: Activity[]
  next: string | null
}

interface ContextValue {
  client: DropInClient
  cache: Map<string, CacheEntry>
}

const Ctx = createContext<ContextValue | null>(null)

type ProviderProps =
  | { client: DropInClient; children: React.ReactNode }
  | { apiKey: string; url: string; tokenProvider: () => Promise<string>; children: React.ReactNode }

/**
 * Provides a DropInClient (and its per-feed cache) to the hooks below.
 *
 * Accepts either form:
 * - `<DropInProvider client={myClient}>` — bring your own, already-constructed client.
 * - `<DropInProvider apiKey={k} url={u} tokenProvider={fn}>` — the provider builds the
 *   client for you. `tokenProvider` is called lazily, only when a request needs a token.
 *
 * Note: the client is memoized on apiKey/url — a `tokenProvider` that needs to change
 * identity (e.g. to mint for a different user) won't be picked up unless apiKey/url also
 * change or the provider is remounted. A tokenProvider that always mints for the current
 * session (the usual pattern) needs no change.
 */
export function DropInProvider(props: ProviderProps) {
  const { children } = props
  // The memo always runs (hooks must be unconditional); a supplied client wins.
  const client = useMemo(
    () => ('client' in props
      ? props.client
      : new DropInClient({ apiKey: props.apiKey, url: props.url, tokenProvider: props.tokenProvider })),
    // Rebuild only when the identity-defining inputs change (client, or apiKey+url) —
    // not exhaustive over all props (e.g. tokenProvider) by design.
    ['client' in props ? props.client : props.apiKey, 'client' in props ? undefined : props.url],
  )
  // A small cache keyed by feed. Deliberately not TanStack Query — this package stays
  // dependency-free apart from React itself.
  const cache = useRef(new Map<string, CacheEntry>())
  const value = useMemo(() => ({ client, cache: cache.current }), [client])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDropInContext(): ContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDropIn hooks must be used inside a <DropInProvider>')
  return ctx
}

export function useDropInClient(): DropInClient {
  return useDropInContext().client
}
