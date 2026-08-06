import { useCallback, useEffect, useRef } from 'react'
import { useFeed, type UseFeedOptions } from './hooks.js'

export interface UseInfiniteFeedOptions<TCustom = Record<string, unknown>>
  extends UseFeedOptions<TCustom> {
  /** How far ahead of the viewport the next page starts loading. Default `'600px'`.
   *  Passed straight to the IntersectionObserver; ignored where there isn't one. */
  rootMargin?: string
}

/**
 * `useFeed` with the scroll wiring attached: everything that hook returns, plus a
 * `sentinelRef` to put on a trailing element and an `onEndReached` for React Native.
 *
 * ```tsx
 * const { activities, sentinelRef, isLoadingInitial, error, retry } = useInfiniteFeed('timeline', uid)
 * if (isLoadingInitial && activities.length === 0) return <FullPageLoading />
 * return <>
 *   {activities.map((a) => <Row key={a.id} activity={a} />)}
 *   {error && <button onClick={() => void retry()}>Try again</button>}
 *   <div ref={sentinelRef} />
 * </>
 * ```
 *
 * The paging rules all live in `useFeed` — in-flight guard, id dedupe, the error guard
 * that `retry()` clears. This adds only the two things a sentinel needs on top:
 *
 * 1. It re-checks after every page. The sentinel does not move when a page lands, so no
 *    new intersection event fires and one-page-per-gesture would be the ceiling.
 * 2. It reads `canLoadMore`/`loadNext` through refs. The observer outlives the render
 *    that created it, so a captured closure would page against a stale cursor.
 *
 * Where there is no `IntersectionObserver` (React Native, SSR), `sentinelRef` is an inert
 * no-op and `onEndReached` — wired to `FlatList`'s prop of the same name — is the path.
 */
export function useInfiniteFeed<TCustom = Record<string, unknown>>(
  group: string,
  id: string,
  opts?: UseInfiniteFeedOptions<TCustom>,
) {
  const feed = useFeed<TCustom>(group, id, opts)
  const { canLoadMore, loadNext } = feed
  const rootMargin = opts?.rootMargin ?? '600px'

  const canRef = useRef(canLoadMore)
  canRef.current = canLoadMore
  const loadRef = useRef(loadNext)
  loadRef.current = loadNext
  const intersecting = useRef(false)

  // Both entry points funnel through here, so "should we fetch?" is answered in exactly
  // one place, against current values rather than whatever the last render captured.
  const maybeLoad = useCallback(() => {
    if (intersecting.current && canRef.current) void loadRef.current()
  }, [])

  // Re-check after EVERY commit — deliberately no dependency array. The obvious version,
  // `useEffect(fn, [canLoadMore])`, depends on React committing the intermediate
  // `canLoadMore: false` render while the page is in flight; when updates batch, the
  // value reads `true` before and after, the dep never "changes", and paging stops dead
  // after one page. Running unconditionally costs a guarded ref check per render, and
  // `maybeLoad` is a no-op unless the sentinel is genuinely in view with a loadable
  // cursor — so this cannot loop: each fetch flips `canLoadMore` false until it lands,
  // and end-of-feed or an error keeps it false.
  useEffect(() => { if (canLoadMore) maybeLoad() })

  const observer = useRef<IntersectionObserver | null>(null)
  /** Attach to a trailing element. A callback ref, not an object ref, so it also fires
   *  when the sentinel is conditionally unmounted and remounted. */
  const sentinelRef = useCallback((node: Element | null) => {
    observer.current?.disconnect()
    observer.current = null
    intersecting.current = false
    if (node === null) return
    // React Native and SSR have no IntersectionObserver — `typeof` (never a bare
    // reference) so an undeclared global is a no-op, not a ReferenceError.
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      intersecting.current = entries.some((e) => e.isIntersecting)
      maybeLoad()
    }, { rootMargin })
    io.observe(node)
    observer.current = io
  }, [rootMargin, maybeLoad])

  useEffect(() => () => { observer.current?.disconnect() }, [])

  /** `<FlatList onEndReached={onEndReached} onEndReachedThreshold={0.5} />`. Guarded the
   *  same way as the sentinel, because FlatList fires it repeatedly near the end. */
  const onEndReached = useCallback(() => {
    if (canRef.current) void loadRef.current()
  }, [])

  return { ...feed, sentinelRef, onEndReached }
}
