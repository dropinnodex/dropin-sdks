import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Activity, FeedPage, Follow, Notification, Page, PromotedActivity, Reaction, Suggestion,
} from '@dropinnodex/client'
import { useDropInContext, useDropInClientOrNull, type CacheEntry } from './provider.js'
import { useLiveTicks } from './use-live.js'

/** Action-specific context passed as the second arg of `OptimisticOnError`. */
export type OptimisticOnErrorCtx =
  | { hook: 'useReactions'; action: 'react' | 'unreact'; activityId: string; kind: string }
  | { hook: 'useReactionList'; action: 'remove'; activityId: string; reactionId: string }
  | { hook: 'useFollow'; action: 'follow' | 'unfollow';
      source: { group: string; id: string }; target: { group: string; id: string } }
  | { hook: 'useNotifications'; action: 'markSeen' | 'markRead'; ids: string[] | null }

/** Opt-in error sink for an optimistic write. When provided (per-call or via
 *  `<DropInProvider onError>`), the action rolls back AND resolves to `undefined` —
 *  the rejection is replaced by this callback. Absence preserves the existing
 *  reject-after-rollback contract. */
export type OptimisticOnError = (err: Error, ctx: OptimisticOnErrorCtx) => void

/** Internal helper: pick the per-call `opts.onError` if set, else fall back to the
 *  provider-level one from context. Returns `undefined` when neither is set —
 *  the action then falls through to its existing throw. */
function resolveOnError(
  call: { onError?: OptimisticOnError } | undefined,
  provider: OptimisticOnError | undefined,
): OptimisticOnError | undefined {
  return call?.onError ?? provider
}

/**
 * Every hook cancels its READS when the component unmounts (or when the feed/activity it
 * is reading switches), by handing `@dropinnodex/client` an AbortSignal. WRITES are never
 * cancelled: a like or a follow the user already committed to must land even if the
 * component that issued it goes away — aborting those would silently drop user intent.
 *
 * An abort is the caller's own doing, so it is swallowed rather than surfaced through
 * `error`: unmounting a component is not a failure the (now-gone) UI should report.
 *
 * DISABLED MODE (`<DropInProvider enabled={false}>`): the provider carries `client: null`
 * and every hook goes inert — the shared guard is the `client === null` check each
 * effect/callback performs before touching the network. Data hooks return their normal
 * shape with empty data, `isLoading: false`, `error: null`; action functions no-op and
 * RESOLVE to `undefined` (never reject — disabled mode exists precisely so the feed can
 * never break the host app's flow). Every hook return carries `enabled: boolean` as the
 * signal for apps that care; `useDropInEnabled()` is the standalone version.
 *
 * OPTIMISTIC WRITES REJECT AFTER ROLLBACK. Every action below — `react`, `unreact`,
 * `remove` (reaction list), `follow`, `unfollow`, `markSeen`, `markRead` — updates local
 * state immediately, calls the network, and on rejection **rolls back the state AND
 * rejects the returned promise** so callers can show a toast, log, or retry. A
 * fire-and-forget caller (e.g. an `onClick` on a notification bell) MUST wrap the call in
 * `try/catch` or `.catch()` — an unhandled rejection here will surface as an unhandled
 * promise rejection in the host app. Found live in customer validation (FC Urban) against
 * a vendor-side notifications outage: their bell was uncaught and crashed the page.
 */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** One rendered row: a real activity, or a promoted one. Branch with `'promoted' in item`. */
export type FeedItem<TCustom = Record<string, unknown>> = Activity<TCustom> | PromotedActivity<TCustom>

export interface PlacePromotedOptions {
  /** How many activities precede the first promoted slot. Default 3. */
  position?: number
  /** Activities between slots. `null`/omitted places exactly once. */
  repeatEvery?: number | null
}

/**
 * Interleave promoted activities into a list of activities. Pure — usable outside
 * React, and the whole of the placement policy.
 *
 * The sidecar is an eligible SET, not a slot assignment: the same rows may be placed
 * as many times as you like, and consecutive slots rotate through the set (wrapping),
 * so two eligible rows alternate rather than one hogging every slot.
 *
 * A feed shorter than `position` — including an empty one — still gets its first slot
 * at the end. That is deliberate: a brand-new user with an empty feed is exactly the
 * cold-start case promoted content exists to fill.
 */
export function placePromoted<TCustom = Record<string, unknown>>(
  activities: Activity<TCustom>[],
  promoted: PromotedActivity<TCustom>[] | undefined,
  opts: PlacePromotedOptions = {},
): FeedItem<TCustom>[] {
  if (promoted === undefined || promoted.length === 0) return activities
  const position = Math.max(0, opts.position ?? 3)
  const repeat = opts.repeatEvery ?? null

  const slots: number[] = [Math.min(position, activities.length)]
  if (repeat !== null && repeat > 0) {
    for (let at = slots[0]! + repeat; at <= activities.length; at += repeat) slots.push(at)
  }

  const out: FeedItem<TCustom>[] = []
  let slot = 0
  for (let i = 0; i <= activities.length; i++) {
    while (slot < slots.length && slots[slot] === i) {
      out.push(promoted[slot % promoted.length]!)
      slot++
    }
    if (i < activities.length) out.push(activities[i]!)
  }
  return out
}

/**
 * Loads a feed's first page and keeps it fresh, with optimistic `loadNext`/`addActivity`/
 * `refresh` helpers.
 *
 * Returns `{ activities, loadNext, hasNext, isLoading, error, addActivity, refresh,
 * newCount, showNew, checkNew }`.
 *
 * @param opts.initialData - Server-prefetched page for SSR/SSG hydration, e.g.
 * `{ initialData: await server.feed(group, id).get() }` (the shape is `@dropinnodex/client`'s
 * `Page<Activity<TCustom>>`, so a server-side feed read passes through verbatim).
 * When present, the hook renders that data on the very first render with `isLoading: false`
 * — no loading flash — while the mount effect still fires in the background to
 * revalidate against the live feed. A warm provider cache (a prior fetch this session)
 * always wins over `initialData`, since it is fresher.
 *
 * `opts.pollInterval` (deprecated — prefer `live`) is milliseconds between automatic background `checkNew()` calls
 * (the Twitter/IG "N new posts ↑" pattern). Omit or pass `0`/negative to disable — nothing
 * polls unless this is set. New activities are never auto-prepended: they land in a buffer
 * (`newCount`) until the app calls `showNew()`, so an open feed never jumps under the reader.
 * The timer is cleared on unmount and reset whenever `pollInterval` changes.
 *
 * `checkNew()` fetches page 1 and buffers (does not prepend) any activity newer than what's
 * currently shown, deduped by id against both the shown list and anything already buffered —
 * so a round-tripped `addActivity` (write, then seen again on the next poll) is never counted
 * as "new". `newCount` is the buffered count; call `showNew()` to prepend the buffer into
 * `activities` and clear it. Both are headless — this hook does not render the "N new" pill,
 * the app does. The one carve-out from "buffers, never prepends": calling `checkNew()` on a
 * feed that is currently EMPTY loads the result straight into `activities` (there is nothing
 * to jump over), so `newCount` stays `0` in that case. Caveat: page 1 is fetched at a fixed
 * size of 20, so `newCount` saturates at 20 (it cannot tell 20 new activities from 200+ new
 * activities) — apps displaying the count should render it as "20+" (or similar) whenever
 * `newCount` reaches that page size. `checkNew()` is best-effort when driven by
 * `pollInterval`'s timer: a failed poll is swallowed and never touches `isLoading`/`error` —
 * a transient background failure must not blank an otherwise-working feed.
 *
 * Inside a disabled provider (`enabled={false}`) the hook is inert: empty `activities`,
 * `isLoading: false`, `error: null`, `enabled: false`, all functions no-op resolving
 * `undefined`, zero network — `initialData` and polling are ignored too.
 */
export interface UseFeedOptions<TCustom = Record<string, unknown>> {
  initialData?: FeedPage<TCustom> | Page<Activity<TCustom>>
  /** @deprecated Use `live: true` — cheaper (head check, not a full read) and
   * visibility-aware. Kept working; ignored when `live` is set. */
  pollInterval?: number
  /** Keep this feed fresh: cheap head check every 5s while visible, paused while
   * hidden, full fetch only when something actually changed. */
  live?: boolean
  /** Activities before the first promoted slot in `items`. Default 3. */
  promotedPosition?: number
  /** Activities between promoted slots. Omit (or null) to place exactly once. */
  promotedRepeatEvery?: number | null
  /**
   * Fired once per PLACED SLOT — when a promoted row enters `items`, not when it
   * enters the viewport (which we cannot see from here). Wire an
   * IntersectionObserver yourself if you need true viewability; this is the hook
   * for sending an event to your own analytics.
   */
  onPromotedImpression?: (promoted: PromotedActivity<TCustom>, ctx: { slot: number }) => void
  /** Invoked by the returned `trackPromotedClick`. */
  onPromotedClick?: (promoted: PromotedActivity<TCustom>) => void
}

export function useFeed<TCustom = Record<string, unknown>>(
  group: string,
  id: string,
  opts?: UseFeedOptions<TCustom>,
) {
  const { client, cache } = useDropInContext()
  const enabled = client !== null
  const feedKey = `${group}:${id}`
  // The cache is intentionally shared/untyped (one CacheEntry — fixed to the default
  // TCustom — serves every TCustom a caller might use across the app), so both the read
  // and the write need a cast at this boundary rather than threading TCustom through the
  // provider/cache types.
  // `promoted` rides in the cache entry so a remount renders the same slots straight
  // away instead of losing them until the next uncursored read (later pages never
  // carry a sidecar, so it cannot be recovered by paging).
  type Entry = { activities: Activity<TCustom>[]; next: string | null; promoted?: PromotedActivity<TCustom>[] }
  // Seed from the provider cache: a remount or a second component on the
  // same feed renders instantly from the last fetch, then refreshes. A cache hit wins
  // over caller-supplied initialData — the cache means we already fetched fresher data
  // this session (e.g. SSR initialData on the first mount, then a client nav away and
  // back should prefer what we actually fetched over the now-stale SSR payload).
  const cached = cache.get(feedKey) as Entry | undefined
  const setCache = (entry: Entry) => cache.set(feedKey, entry as CacheEntry)
  // Disabled mode ignores seeds too: the contract is EMPTY data, not "whatever
  // initialData happened to carry" — inert must be predictable.
  const seed: Entry | undefined = !enabled ? undefined : cached ?? (opts?.initialData
    ? {
        activities: opts.initialData.results,
        next: opts.initialData.next,
        // An SSR-prefetched first page carries the sidecar too — keep it, or the
        // server-rendered markup and the first client render would disagree.
        ...('promoted' in opts.initialData ? { promoted: opts.initialData.promoted } : {}),
      }
    : undefined)
  const [activities, setActivities] = useState<Activity<TCustom>[]>(seed?.activities ?? [])
  const [next, setNext] = useState<string | null>(seed?.next ?? null)
  const [promoted, setPromoted] = useState<PromotedActivity<TCustom>[]>(seed?.promoted ?? [])
  const [isLoading, setLoading] = useState(enabled && seed === undefined)
  const [error, setError] = useState<Error | null>(null)
  // Buffer for checkNew()/showNew() — activities polled in but not yet flushed into
  // `activities`. Refs mirror the latest state so checkNew (a useCallback with a stable
  // identity for the poll-effect's timer) always dedupes against current data, not a
  // stale closure from whenever it was created.
  const [pending, setPending] = useState<Activity<TCustom>[]>([])
  const activitiesRef = useRef(activities)
  activitiesRef.current = activities
  const promotedRef = useRef(promoted)
  promotedRef.current = promoted
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  // Tracks the live feedKey so an in-flight checkNew from a feed that's since been
  // switched away from (group/id changed while its fetch was in the air) can detect
  // it and drop its result instead of writing stale data into the new feed's state.
  const feedKeyRef = useRef(feedKey)
  feedKeyRef.current = feedKey
  // The controller for this feedKey's lifetime: installed by the mount effect, aborted by
  // its cleanup (unmount or feed switch). loadNext/refresh/checkNew read it so a page-2
  // fetch or a poll in flight dies with the component too, not just the mount fetch.
  const readCtrl = useRef<AbortController | null>(null)
  const readSignal = () => readCtrl.current?.signal

  useEffect(() => {
    if (client === null) return // disabled provider — inert, zero network
    let cancelled = false
    const ctrl = new AbortController()
    readCtrl.current = ctrl
    lastHeadRef.current = null
    // Only flip back to a loading state if we didn't already seed one (cache or
    // initialData) — otherwise a seeded mount would flash a spinner before this
    // background revalidation resolves.
    // `seed` is intentionally NOT in the deps array: it's a fresh object each render, so
    // listing it would refetch every render. The effect only needs the value from the
    // render that created it (mount / feed-key change). Do not "fix" this with exhaustive-deps.
    setLoading(seed === undefined)
    setError(null)
    // A feedKey change (or mount) must invalidate any buffered checkNew() results:
    // they belong to whichever feed was live when they were fetched, and pending is
    // otherwise independent of activities' lifecycle — nothing else resets it here.
    // The feedKeyRef guard in checkNew only drops in-flight responses; it does not
    // clear a buffer that was already committed to state before the switch.
    setPending([])
    // Publish SSR initialData to the shared cache so a sibling/remounted useFeed on the
    // same feed renders from it too (not just this instance), until the fetch lands.
    if (cache.get(feedKey) === undefined && seed !== undefined) cache.set(feedKey, seed as CacheEntry)
    client.feed(group, id).get<TCustom>({ limit: 20 }, { signal: ctrl.signal })
      .then((page) => {
        if (cancelled) return
        // An uncursored read is the only thing that ever carries the sidecar; `?? []`
        // so a server without the feature degrades to "nothing eligible", not undefined.
        const side = page.promoted ?? []
        setCache({ activities: page.results, next: page.next, promoted: side })
        setActivities(page.results)
        setNext(page.next)
        setPromoted(side)
      })
      .catch((err: unknown) => { if (!cancelled && !isAbort(err)) setError(err as Error) })
      .finally(() => { if (!cancelled) setLoading(false) })
    // abort() cancels the request itself; `cancelled` still guards the state writes, since
    // a response that already landed resolves regardless of the signal.
    return () => { cancelled = true; ctrl.abort() }
  }, [client, cache, feedKey, group, id])

  const loadNext = useCallback(async () => {
    if (client === null || next === null) return
    const signal = readSignal()
    setLoading(true)
    try {
      const page = await client.feed(group, id).get<TCustom>({ limit: 20, next }, { signal })
      setActivities((prev) => {
        const merged = [...prev, ...page.results]
        // Page 2+ carries no sidecar by contract — carry the cached one forward so
        // repeat placement keeps filling slots as the list grows.
        setCache({ activities: merged, next: page.next, promoted: promotedRef.current })
        return merged
      })
      setNext(page.next)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, cache, feedKey, group, id, next])

  const addActivity = useCallback(
    async (a: { verb: string; object: string; target?: string | null; foreign_id?: string | null; time?: string; custom?: TCustom }) => {
      if (client === null) return undefined // disabled — no-op resolving undefined
      const created = await client.feed(group, id).addActivity<TCustom>(a)
      setActivities((prev) => {
        const merged = [created, ...prev]
        setCache({ activities: merged, next: cache.get(feedKey)?.next ?? next })
        return merged
      })
      return created
    },
    [client, cache, feedKey, group, id, next],
  )

  const refresh = useCallback(async () => {
    if (client === null) return
    const signal = readSignal()
    setLoading(true)
    setError(null)
    try {
      const page = await client.feed(group, id).get<TCustom>({ limit: 20 }, { signal })
      // refresh() is an uncursored read, so it also re-resolves eligibility — which is
      // how a promotion that expired mid-session stops rendering from the client cache.
      const side = page.promoted ?? []
      setCache({ activities: page.results, next: page.next, promoted: side })
      setActivities(page.results)
      setNext(page.next)
      setPromoted(side)
      // refresh() authoritatively replaces activities from the server, so any
      // checkNew() buffer is now stale (page 1 may already include what it buffered,
      // e.g. an at-least-once replay) — drop it, or showNew() would later duplicate.
      setPending([])
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, cache, feedKey, group, id])

  // Polls page 1 and BUFFERS anything newer than what's shown — never auto-prepends,
  // so an open feed never jumps under the reader (the "N new posts ↑" pattern; the app
  // decides when to call showNew()). Deduped by id against both the shown activities and
  // anything already pending, so a round-tripped addActivity is never double-counted.
  const checkNew = useCallback(async () => {
    if (client === null) return
    // Best-effort: this runs unattended off a timer, so a transient failure (network
    // blip, expired token) must not surface as an unhandled rejection or blank a working
    // feed — swallow it silently, same spirit as stale-while-revalidate. Never setError.
    try {
      const page = await client.feed(group, id).get<TCustom>({ limit: 20 }, { signal: readSignal() })
      // The feed this call was fetching for may have been switched away from (group/id
      // changed) while the request was in flight — drop a result that would otherwise
      // write another feed's activities into this (now different) feed's state.
      if (feedKeyRef.current !== feedKey) return
      const cur = activitiesRef.current
      // A previously-empty feed has nothing to "jump" — load its first activities directly.
      if (cur.length === 0) {
        setCache({ activities: page.results, next: page.next, promoted: promotedRef.current })
        setActivities(page.results)
        setNext(page.next)
        return
      }
      const shown = new Set(cur.map((a) => a.id))
      const buffered = new Set(pendingRef.current.map((a) => a.id))
      const fresh = page.results.filter((r) => !shown.has(r.id) && !buffered.has(r.id))
      if (fresh.length > 0) {
        // Re-dedupe against the LATEST pending inside the updater, not just the
        // pre-await snapshot: overlapping ticks (a slow fetch outlasting pollInterval,
        // or a poll racing a manual checkNew) can both see the same activity as
        // "not yet buffered" off a stale snapshot and each queue a duplicate.
        setPending((p) => {
          const pid = new Set(p.map((a) => a.id))
          const reallyFresh = fresh.filter((f) => !pid.has(f.id))
          return reallyFresh.length > 0 ? [...reallyFresh, ...p] : p
        })
      }
    } catch {
      // Swallowed — see best-effort comment above.
    }
  }, [client, cache, feedKey, group, id])

  // live: signal-consumption head polling (spec 2026-07-31-live-updates). lastHeadRef is
  // the last head value ACTED ON — deliberately not compared against list contents: a
  // deleted activity's id can sit in the head key forever, and comparing against the
  // list would turn every later tick into a full fetch. Reset on feed switch.
  const lastHeadRef = useRef<string | null>(null)
  const headTick = useCallback(async () => {
    if (client === null) return
    try {
      const { latest } = await client.feed(group, id).head({ signal: readSignal() })
      // Mirrors checkNew's guard: the feed this call was checking for may have been
      // switched away from while the request was in flight — drop it rather than
      // consuming a head value (or triggering checkNew) against the new feed's state.
      if (feedKeyRef.current !== feedKey) return
      if (latest === null || latest === lastHeadRef.current) return
      lastHeadRef.current = latest // consume BEFORE the fetch — checkNew dedupes races internally
      await checkNew()
    } catch {
      // Hint only — same swallow policy as polling: never touches isLoading/error.
    }
  }, [client, group, id, feedKey, checkNew])
  useLiveTicks(opts?.live === true, () => { void headTick() })

  // Prepends the buffered activities into `activities` and clears the buffer.
  const showNew = useCallback(() => {
    const p = pendingRef.current
    if (p.length === 0) return
    setActivities((a) => {
      const merged = [...p, ...a]
      setCache({ activities: merged, next: cache.get(feedKey)?.next ?? next })
      return merged
    })
    setPending([])
  }, [cache, feedKey, next])

  // Auto-polling: disabled unless opts.pollInterval is a positive number. Re-armed
  // whenever the interval or checkNew's identity changes; always cleared on unmount.
  useEffect(() => {
    // Matches useLiveTicks' arming condition exactly (opts?.live === true) — a truthy
    // non-boolean `live` must degrade to polling, not silently disable both.
    if (opts?.live === true) return // live mode owns freshness; the deprecated timer never arms
    if (!opts?.pollInterval || opts.pollInterval <= 0) return
    const t = setInterval(() => { void checkNew() }, opts.pollInterval)
    return () => clearInterval(t)
  }, [opts?.live, opts?.pollInterval, checkNew])

  // Placement is presentation, so it happens here rather than server-side: the server
  // answers WHAT is eligible, the client decides WHERE it goes.
  const promotedPosition = opts?.promotedPosition
  const promotedRepeatEvery = opts?.promotedRepeatEvery
  const items = useMemo(
    () => placePromoted<TCustom>(activities, promoted, {
      ...(promotedPosition !== undefined ? { position: promotedPosition } : {}),
      ...(promotedRepeatEvery !== undefined ? { repeatEvery: promotedRepeatEvery } : {}),
    }),
    [activities, promoted, promotedPosition, promotedRepeatEvery],
  )

  // Impressions fire per PLACED SLOT, once each. Keyed by `${id}#${slot}` so the same
  // row placed at two slots counts twice (that is what repeat placement means) while a
  // re-render of the same slots counts zero more. Reset when the feed changes.
  const onImpression = opts?.onPromotedImpression
  const firedRef = useRef(new Set<string>())
  useEffect(() => { firedRef.current = new Set() }, [feedKey])
  useEffect(() => {
    if (!enabled || onImpression === undefined) return
    let slot = 0
    for (const item of items) {
      if (!('promoted' in item)) continue
      const key = `${item.id}#${slot}`
      if (!firedRef.current.has(key)) {
        firedRef.current.add(key)
        onImpression(item, { slot })
      }
      slot++
    }
  }, [items, enabled, onImpression])

  const onClick = opts?.onPromotedClick
  /** Call from your row's click handler; forwards to `onPromotedClick`. */
  const trackPromotedClick = useCallback(
    (p: PromotedActivity<TCustom>) => { if (enabled) onClick?.(p) },
    [enabled, onClick],
  )

  return {
    activities, loadNext, hasNext: next !== null, isLoading, error, addActivity, refresh,
    newCount: pending.length, showNew, checkNew, enabled,
    /** The eligible promoted set for this reader — NOT placed. Empty when none. */
    promoted,
    /** `activities` with promoted rows interleaved per the placement props. */
    items,
    trackPromotedClick,
  }
}

/** `useFeed('timeline', uid, opts)` — the feed aggregating who this user follows. */
export function useTimeline<TCustom = Record<string, unknown>>(
  uid: string,
  opts?: UseFeedOptions<TCustom>,
) { return useFeed<TCustom>('timeline', uid, opts) }

/** `useFeed('user', uid, opts)` — a single user's own activity feed. */
export function useUserFeed<TCustom = Record<string, unknown>>(
  uid: string,
  opts?: UseFeedOptions<TCustom>,
) { return useFeed<TCustom>('user', uid, opts) }

/** GetStream V3 alias for `useFeed` — same signature and return. */
export const useFeedActivities = useFeed

/** Optimistic like/unlike counters. Inside a disabled provider, `react`/`unreact` are
 *  full no-ops resolving `undefined` (no optimistic bump either) and `enabled` is false.
 *
 *  `react(kind)` / `unreact(kind)` reject after rolling back — see the file header.
 *  @throws The network error after the optimistic update has been rolled back. */
export function useReactions(
  activityId: string,
  initialCounts: Record<string, number> = {},
  initialOwn: string[] = [],
) {
  const client = useDropInClientOrNull()
  const ctx = useDropInContext()
  const [counts, setCounts] = useState(initialCounts)
  const [ownReactions, setOwn] = useState(initialOwn)

  const react = useCallback(async (kind: string, opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const prevCounts = counts
    const prevOwn = ownReactions
    // Optimistic.
    setCounts((c) => ({ ...c, [kind]: (c[kind] ?? 0) + 1 }))
    setOwn((o) => (o.includes(kind) ? o : [...o, kind]))
    try {
      await client.reactions.add(kind, activityId)
    } catch (err) {
      setCounts(prevCounts)
      setOwn(prevOwn)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, { hook: 'useReactions', action: 'react', activityId, kind })
        return
      }
      throw err
    }
  }, [client, activityId, counts, ownReactions, ctx])

  const unreact = useCallback(async (kind: string, opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const prevCounts = counts
    const prevOwn = ownReactions
    // Math.max(...,0): the server floors at 0 too — the UI must not disagree.
    setCounts((c) => ({ ...c, [kind]: Math.max((c[kind] ?? 0) - 1, 0) }))
    setOwn((o) => o.filter((k) => k !== kind))
    try {
      await client.reactions.unreact(activityId, kind)
    } catch (err) {
      setCounts(prevCounts)
      setOwn(prevOwn)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, { hook: 'useReactions', action: 'unreact', activityId, kind })
        return
      }
      throw err
    }
  }, [client, activityId, counts, ownReactions, ctx])

  return { react, unreact, counts, ownReactions, enabled: client !== null }
}

/**
 * Loads the reaction list for an activity (the "who reacted" list — distinct from
 * `useReactions`, which is the optimistic like/unlike counter). Paginates via `loadNext`;
 * `remove(reactionId)` deletes a reaction by id with an optimistic drop + rollback.
 * Inert (empty list, no network, `enabled: false`) inside a disabled provider.
 *
 * `remove(reactionId)` rejects after rolling back — see the file header.
 * @throws The network error after the optimistic drop has been rolled back.
 */
export function useReactionList(activityId: string, opts?: { kind?: string }) {
  const client = useDropInClientOrNull()
  const ctx = useDropInContext()
  const kind = opts?.kind
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)
  // Lifetime of this activityId/kind read — aborted on unmount or when either changes.
  const readCtrl = useRef<AbortController | null>(null)
  const readSignal = () => readCtrl.current?.signal

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      const page = await client.reactions.list(
        activityId, { ...(kind !== undefined ? { kind } : {}), limit: 20 }, { signal },
      )
      setReactions(page.results)
      setNext(page.next)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, activityId, kind])

  // Not passed as `refresh` directly: React would hand a click event in as the signal.
  const refresh = useCallback(() => load(readSignal()), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    readCtrl.current = ctrl
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const loadNext = useCallback(async () => {
    if (client === null || next === null) return
    const signal = readSignal()
    setLoading(true)
    try {
      const page = await client.reactions.list(
        activityId, { ...(kind !== undefined ? { kind } : {}), limit: 20, next }, { signal },
      )
      setReactions((prev) => [...prev, ...page.results])
      setNext(page.next)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, activityId, kind, next])

  const remove = useCallback(async (reactionId: string, opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic drop, no network
    const prev = reactions
    setReactions((rs) => rs.filter((r) => r.id !== reactionId))
    try {
      await client.reactions.delete(reactionId)
    } catch (err) {
      setReactions(prev)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, { hook: 'useReactionList', action: 'remove', activityId, reactionId })
        return
      }
      throw err
    }
  }, [client, activityId, reactions, ctx])

  return { reactions, loadNext, hasNext: next !== null, isLoading, error, remove, refresh, enabled: client !== null }
}

/** Optimistic follow/unfollow with server hydration. Inside a disabled provider,
 *  `follow`/`unfollow` no-op resolve `undefined`, nothing hydrates, `enabled` is false.
 *
 *  `follow(targetGroup, targetId)` / `unfollow(targetGroup, targetId)` reject after
 *  rolling back — see the file header.
 *  @throws The network error after the optimistic edge toggle has been rolled back. */
export function useFollow(group: string, id: string) {
  const client = useDropInClientOrNull()
  const ctx = useDropInContext()
  const [edges, setEdges] = useState<Set<string>>(new Set())
  // Keys the user has optimistically follow()'d or unfollow()'d this session. Hydration
  // (below) must never override these with server state — see the effect's comment for why.
  const touched = useRef<Set<string>>(new Set())

  // Hydrate from the server on mount (and whenever group/id changes): `edges` started as a
  // purely local, always-empty guess — isFollowing() would report `false` for a
  // genuinely-followed target until the app called follow() itself in this session. The
  // `cancelled` guard prevents a slow/late response from writing a stale hydration result
  // after the effect re-ran (group/id changed) or the component unmounted. Best-effort: a
  // failed or malformed response is swallowed and leaves `edges` at its current (possibly
  // still-empty) value rather than surfacing an error from a hook whose contract has none.
  //
  // ADD server edges, but only for UNTOUCHED keys — never for a key the user has already
  // optimistically follow()'d/unfollow()'d. A wholesale replace or a plain union both fail:
  // an optimistic unfollow(bob) can fire while this GET is still in flight and still
  // reflects the pre-delete state; unconditionally adding bob back from that stale response
  // would silently revert the user's own unfollow, permanently (hydration is mount-only, so
  // nothing ever self-corrects it back). Gating server edges on "not touched" lets the
  // user's own optimistic value win for any key they've acted on, while untouched keys
  // (e.g. carol, whom the user never touched) still hydrate in normally.
  useEffect(() => {
    if (client === null) return // disabled provider — inert, zero network
    let cancelled = false
    const ctrl = new AbortController()
    // async/await + try/catch, NOT `.then().catch()`: a mock (or a real client bug) that
    // returns `undefined` instead of a Promise makes `.then()` throw synchronously inside
    // the effect (uncaught — there's nothing to .catch() because the chain never formed),
    // whereas `await`-ing a non-Promise value just resolves to it, so the try/catch below
    // still swallows the resulting `page.results` failure. Same best-effort contract either
    // way, but only this form is safe against a non-Promise return.
    void (async () => {
      try {
        const page = await client.feed(group, id).following({}, { signal: ctrl.signal })
        if (cancelled) return
        // Read `page.results` eagerly, HERE, inside the try — not inside the setEdges
        // updater below. React may invoke a functional updater during a later render pass,
        // outside this function's call stack; a throw from a malformed `page` in there
        // would land outside this try/catch and go uncaught instead of being swallowed.
        const hydratedKeys = (page.results as Follow[]).map((f) => `${f.target_group}:${f.target_id}`)
        setEdges((prev) => {
          const next = new Set(prev) // keep optimistic edges (incl. removals)
          for (const k of hydratedKeys) {
            if (!touched.current.has(k)) next.add(k) // server truth only for untouched keys
          }
          return next
        })
      } catch {
        // best-effort — keep whatever `edges` currently holds (an abort included)
      }
    })()
    return () => { cancelled = true; ctrl.abort() }
  }, [client, group, id])

  const isFollowing = useCallback((tGroup: string, tId: string) => edges.has(`${tGroup}:${tId}`), [edges])

  const follow = useCallback(async (tGroup: string, tId: string, opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const key = `${tGroup}:${tId}`
    const prev = edges
    touched.current.add(key)
    setEdges((e) => new Set(e).add(key))
    try {
      await client.feed(group, id).follow(tGroup, tId)
    } catch (err) {
      setEdges(prev)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, {
          hook: 'useFollow', action: 'follow',
          source: { group, id }, target: { group: tGroup, id: tId },
        })
        return
      }
      throw err
    }
  }, [client, group, id, edges, ctx])

  const unfollow = useCallback(async (tGroup: string, tId: string, opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const key = `${tGroup}:${tId}`
    const prev = edges
    touched.current.add(key)
    setEdges((e) => { const n = new Set(e); n.delete(key); return n })
    try {
      await client.feed(group, id).unfollow(tGroup, tId)
    } catch (err) {
      setEdges(prev)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, {
          hook: 'useFollow', action: 'unfollow',
          source: { group, id }, target: { group: tGroup, id: tId },
        })
        return
      }
      throw err
    }
  }, [client, group, id, edges, ctx])

  return { follow, unfollow, isFollowing, enabled: client !== null }
}

/** The list of feeds `group:id` currently follows (hydrated from the server).
 *  Inert (empty list, no network, `enabled: false`) inside a disabled provider. */
export function useFollowing(group: string, id: string) {
  const client = useDropInClientOrNull()
  const [following, setFollowing] = useState<Array<{ group: string; id: string }>>([])
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      const page = await client.feed(group, id).following({}, { signal })
      setFollowing(page.results.map((f: Follow) => ({ group: f.target_group, id: f.target_id })))
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, group, id])

  // Not `refresh = load`: React would pass a click event in as the signal.
  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return { following, isLoading, error, refresh, enabled: client !== null }
}

/** The list of feeds that follow `group:id` (hydrated from the server). Mirror of
 *  `useFollowing`, reading the follower side (`source_*`) of each edge.
 *  Inert (empty list, no network, `enabled: false`) inside a disabled provider. */
export function useFollowers(group: string, id: string) {
  const client = useDropInClientOrNull()
  const [followers, setFollowers] = useState<Array<{ group: string; id: string }>>([])
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      const page = await client.feed(group, id).followers({}, { signal })
      setFollowers(page.results.map((f: Follow) => ({ group: f.source_group, id: f.source_id })))
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, group, id])

  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return { followers, isLoading, error, refresh, enabled: client !== null }
}

/** Follower/following counts for `group:id` (denormalized server-side).
 *  Inert (zero counts, no network, `enabled: false`) inside a disabled provider. */
export function useFollowStats(group: string, id: string) {
  const client = useDropInClientOrNull()
  const [followerCount, setFollowerCount] = useState(0)
  const [followingCount, setFollowingCount] = useState(0)
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    try {
      const s = await client.feed(group, id).followStats({ signal })
      setFollowerCount(s.follower_count)
      setFollowingCount(s.following_count)
      setError(null)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, group, id])

  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return { followerCount, followingCount, isLoading, error, refresh, enabled: client !== null }
}

/**
 * Loads follow suggestions for `group:id` — who this feed should follow (friends-of-friends
 * ranked by mutual overlap, topped up by popularity). Read-only: hydrates on mount
 * and whenever `group`/`id`/`limit` change, with a `refresh` to re-read. Not paginated
 * (the endpoint returns a capped top-N), so there is no `loadNext`/`hasNext`.
 * Inert (empty list, no network, `enabled: false`) inside a disabled provider.
 */
export function useSuggestions(group: string, id: string, opts?: { limit?: number }) {
  const client = useDropInClientOrNull()
  const limit = opts?.limit
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      const page = await client.feed(group, id).suggestions(limit !== undefined ? { limit } : {}, { signal })
      setSuggestions(page.results)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, group, id, limit])

  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return { suggestions, isLoading, error, refresh, enabled: client !== null }
}

/**
 * Loads the caller's notification feed and keeps unseen/unread counts. `markSeen`/`markRead`
 * are optimistic: they zero (mark-all) or decrement (mark-ids) the local counter and stamp
 * the rows before the request resolves, rolling back on error — same discipline as
 * useReactions. Pass `pollInterval` to refresh counts on a timer.
 *
 * Inert inside a disabled provider: empty list, zero counts, `isLoading: false`,
 * `error: null`, `enabled: false`; `markSeen`/`markRead` no-op resolve `undefined`.
 *
 * `markSeen(ids?)` / `markRead(ids?)` reject after rolling back — see the file header.
 * @throws The network error after the optimistic stamp has been rolled back. This is the
 * footgun that crashed the FC Urban notification bell in live testing (Aug 2026) when the
 * upstream notifications endpoint started 500'ing: an uncaught promise rejection in their
 * `onClick` handler bubbled to the React error boundary. Always wrap in
 * `try { await markSeen() } catch {}` (or `.catch(() => {})`) for fire-and-forget callers.
 */
export function useNotifications(opts?: {
  /** @deprecated Use `live: true` — cheaper and visibility-aware. Ignored when `live` is set. */
  pollInterval?: number
  /** Keep notifications fresh via the cheap head check. See useFeed's `live`. */
  live?: boolean
}) {
  const client = useDropInClientOrNull()
  const ctx = useDropInContext()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unseen, setUnseen] = useState(0)
  const [unread, setUnread] = useState(0)
  const [next, setNext] = useState<string | null>(null)
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  // Lifetime of this hook's reads — aborted on unmount, so a poll or a page-2 fetch in
  // flight dies with the component. markSeen/markRead are writes and are never aborted.
  const readCtrl = useRef<AbortController | null>(null)
  const readSignal = () => readCtrl.current?.signal

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      const page = await client.notifications.get({ limit: 20 }, { signal })
      setNotifications(page.results)
      setUnseen(page.unseen)
      setUnread(page.unread)
      setNext(page.next)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client])

  const refresh = useCallback(() => load(readSignal()), [load])

  // Same signal-consumption discipline as useFeed's live mode (spec 2026-07-31-live-updates).
  const lastHeadRef = useRef<string | null>(null)
  const headTick = useCallback(async () => {
    if (client === null) return
    try {
      const { latest } = await client.notifications.head({ signal: readSignal() })
      if (latest === null || latest === lastHeadRef.current) return
      lastHeadRef.current = latest
      await refresh()
    } catch { /* hint only — swallowed like poll errors */ }
  }, [client, refresh])
  useLiveTicks(opts?.live === true, () => { void headTick() })

  useEffect(() => {
    const ctrl = new AbortController()
    readCtrl.current = ctrl
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  const loadNext = useCallback(async () => {
    if (client === null || next === null) return
    const signal = readSignal()
    setLoading(true)
    try {
      const page = await client.notifications.get({ limit: 20, next }, { signal })
      setNotifications((prev) => [...prev, ...page.results])
      setNext(page.next)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client, next])

  const markSeen = useCallback(async (ids?: string[], opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const prev = { notifications, unseen }
    // An empty (or absent) id list means "mark all" — matching client.notifications.markSeen.
    const all = !ids?.length
    const idSet = all ? null : new Set(ids)
    setNotifications((ns) => ns.map((n) =>
      n.seen_at === null && (idSet === null || idSet.has(n.id)) ? { ...n, seen_at: 'now' } : n))
    setUnseen((u) => (all ? 0 : Math.max(u - ids!.length, 0)))
    try {
      await client.notifications.markSeen(ids)
    } catch (err) {
      setNotifications(prev.notifications)
      setUnseen(prev.unseen)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, {
          hook: 'useNotifications', action: 'markSeen', ids: ids ?? null,
        })
        return
      }
      throw err
    }
  }, [client, notifications, unseen, ctx])

  const markRead = useCallback(async (ids?: string[], opts?: { onError?: OptimisticOnError }) => {
    if (client === null) return // disabled — no optimistic write, no network
    const prev = { notifications, unread }
    // An empty (or absent) id list means "mark all" — matching client.notifications.markRead.
    const all = !ids?.length
    const idSet = all ? null : new Set(ids)
    setNotifications((ns) => ns.map((n) =>
      n.read_at === null && (idSet === null || idSet.has(n.id)) ? { ...n, read_at: 'now' } : n))
    setUnread((u) => (all ? 0 : Math.max(u - ids!.length, 0)))
    try {
      await client.notifications.markRead(ids)
    } catch (err) {
      setNotifications(prev.notifications)
      setUnread(prev.unread)
      const handler = resolveOnError(opts, ctx.onError)
      if (handler) {
        handler(err as Error, {
          hook: 'useNotifications', action: 'markRead', ids: ids ?? null,
        })
        return
      }
      throw err
    }
  }, [client, notifications, unread, ctx])

  useEffect(() => {
    if (opts?.live === true) return // live mode owns freshness; the deprecated timer never arms
    if (!opts?.pollInterval || opts.pollInterval <= 0) return
    const t = setInterval(() => { void refresh() }, opts.pollInterval)
    return () => clearInterval(t)
  }, [opts?.live, opts?.pollInterval, refresh])

  return {
    notifications, unseen, unread, loadNext, hasNext: next !== null,
    isLoading, error, markSeen, markRead, refresh, enabled: client !== null,
  }
}

/** Write-only feed actions. Inside a disabled provider both functions are no-ops
 *  resolving `undefined` (never rejecting) and `enabled` is false. */
export function useFeedActions<TCustom = Record<string, unknown>>(group: string, id: string) {
  const client = useDropInClientOrNull()
  const addActivity = useCallback(
    async (a: { verb: string; object: string; custom?: TCustom }) =>
      client === null ? undefined : client.feed(group, id).addActivity<TCustom>(a),
    [client, group, id],
  )
  const deleteActivity = useCallback(
    async (activityId: string) =>
      client === null ? undefined : client.feed(group, id).removeActivity(activityId),
    [client, group, id],
  )
  return { addActivity, deleteActivity, enabled: client !== null }
}

/** The caller identified by the current token — wraps `client.users.me()`.
 *  Inert (`user: null`, no network, `enabled: false`) inside a disabled provider. */
export function useCurrentUser() {
  const client = useDropInClientOrNull()
  const [user, setUser] = useState<{ id: string; custom: Record<string, unknown> } | null>(null)
  const [isLoading, setLoading] = useState(client !== null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (client === null) return // disabled provider — inert, zero network
    setLoading(true)
    setError(null)
    try {
      setUser(await client.users.me({ signal }))
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [client])

  const refresh = useCallback(() => load(), [load])

  useEffect(() => {
    const ctrl = new AbortController()
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  return { user, isLoading, error, refresh, enabled: client !== null }
}
