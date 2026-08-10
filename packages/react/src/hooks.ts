import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Activity, DropInObject, FeedPage, Follow, Notification, Page, PatchBody, PromotedActivity,
  Reaction, Suggestion,
} from '@dropinnodex/client'
import { useDropInContext, useDropInClientOrNull, type CacheEntry } from './provider.js'
import { useLiveTicks } from './use-live.js'
import {
  capRefs, runSweep, subscribeToSweeps, DEFAULT_MAX_SWEEP_REFS, type SweepResult,
} from './object-sweep.js'

/** Action-specific context passed as the second arg of `OptimisticOnError`. */
export type OptimisticOnErrorCtx =
  | { hook: 'useReactions'; action: 'react' | 'unreact'; activityId: string; kind: string }
  | { hook: 'useReactionList'; action: 'remove'; activityId: string; reactionId: string }
  | { hook: 'useFollow'; action: 'follow' | 'unfollow';
      source: { group: string; id: string }; target: { group: string; id: string } }
  | { hook: 'useNotifications'; action: 'markSeen' | 'markRead'; ids: string[] | null }
  | { hook: 'useFeed'; action: 'updateActivity'; activityId: string }

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

/**
 * Append `incoming` to `prev`, dropping anything already present by id.
 *
 * A page boundary is not a set boundary: a row inserted ahead of the cursor, or an
 * at-least-once fan-out replay, can put the same activity in two consecutive pages. A
 * bare `[...prev, ...page.results]` then renders duplicate React keys — which a
 * virtualised list treats as a crash, not a cosmetic glitch.
 */
function mergeById<T extends { id: string }>(prev: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return prev
  const seen = new Set(prev.map((a) => a.id))
  const fresh = incoming.filter((a) => !seen.has(a.id))
  return fresh.length === 0 ? prev : [...prev, ...fresh]
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
 * Resolve an activity's refs against a feed page's `objects` sidecar. Pure — it fetches
 * nothing. Refs with no stored object are SKIPPED, not returned as holes: an object may
 * legitimately not exist yet (the tenant posted before storing it), and a hole in the
 * array would push that decision onto every caller.
 */
export function resolveRefs<TCustom = Record<string, unknown>>(
  activity: Activity<TCustom>,
  objects: Record<string, DropInObject<TCustom>> | undefined,
): DropInObject<TCustom>[] {
  if (objects === undefined) return []
  const out: DropInObject<TCustom>[] = []
  for (const ref of activity.refs) {
    const obj = objects[ref]
    if (obj !== undefined) out.push(obj)
  }
  return out
}

/**
 * Every distinct ref currently on screen, in first-seen order. Activities only —
 * `PromotedActivity` carries no `refs`, so a promoted row has nothing to resolve.
 *
 * `refs` is read defensively: it is non-optional on the wire, but a page served by an
 * older feed service (or a hand-built test fixture) can omit it, and this runs on a timer
 * where a throw is invisible.
 */
function shownRefs(list: readonly { refs?: string[] }[]): string[] {
  const seen = new Set<string>()
  for (const a of list) {
    if (!Array.isArray(a.refs)) continue
    for (const ref of a.refs) seen.add(ref)
  }
  return [...seen]
}

/**
 * PROTOTYPE POLLUTION GUARD — defense in depth, do not remove.
 *
 * `custom.__proto__.x` matches patchBodySchema's `^custom(\.[^.]+)+$` at the HTTP
 * boundary, so it reaches this far. It does NOT reach the server unrejected, though: as
 * of `c5d756a` the server folds a patch's paths into a real nested JS object (not a
 * Postgres `text[]` anymore — that was true before that rewrite, not now) via its own
 * `setNested`, which rejects `__proto__`/`constructor`/`prototype` at any segment
 * position and returns 400 (since `8ae05a8`). So this is no longer "harmless server-side,
 * guarded here defensively" — the server actively rejects it too, independently.
 *
 * This client-side guard is still necessary regardless: `applyPatch` runs the optimistic
 * update LOCALLY, before any network round trip, so a request the server will eventually
 * 400 would otherwise still walk these segments over a real JavaScript object here first.
 * That sounds like the same hazard the server closed — but it isn't exploitable as
 * written: what actually stops pollution is that `setAtPath`/`unsetAtPath` below build
 * every level via `{ ...obj, [head]: value }`, a COMPUTED property write. A computed key
 * equal to `"__proto__"` creates an ordinary own property named `"__proto__"` on the new
 * object — it does NOT invoke `Object.prototype.__proto__`'s setter, which only fires for
 * a literal `obj.__proto__ = x` or `obj["__proto__"] = x` MUTATION of an *existing*
 * object. Spread-into-a-new-object is not that. (Verified: disabling this guard entirely
 * still does not pollute `Object.prototype` — see objects.test.tsx.)
 *
 * So this Set is not what closes the hole; immutability is. This guard exists to stop a
 * confusing, inert `"__proto__"`/`"constructor"`/`"prototype"` OWN PROPERTY from landing
 * in `custom` during the optimistic window and being re-serialized back to the server on
 * a LATER write — which is a correctness/hygiene problem, not a pollution one.
 *
 * THE CATCH: if `setAtPath`/`unsetAtPath` are ever "optimized" to mutate in place
 * (`obj[head] = value` on the existing object, skipping the spread) instead of returning
 * a new one, THAT is the moment this guard stops being optional and becomes the only
 * thing standing between a wire-supplied path and `Object.prototype`. Whoever makes that
 * change needs to see this warning, not a comment that already (wrongly) told them the
 * guard had it covered.
 */
const FORBIDDEN_SEGMENT = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Split a `custom.a.b` path into its walk segments (`['a', 'b']`), or `null` when the
 * path is malformed OR any segment — at ANY position, not just the last — is one of
 * `__proto__`/`constructor`/`prototype`. A guard that only checks the terminal segment is
 * a common and useless half-fix: `custom.a.__proto__.b` pollutes just as effectively via
 * an intermediate assignment.
 *
 * A forbidden path is silently dropped rather than thrown: the server rejects the same
 * path too (now, independently — see the guard comment above), so the optimistic window
 * simply never diverges from what will happen for real. Throwing would turn a security
 * guard into an availability bug for a caller who forwards attacker input unchecked.
 */
function safeSegments(path: string): string[] | null {
  const parts = path.split('.')
  if (parts.length < 2 || parts[0] !== 'custom') return null
  const segments = parts.slice(1)
  return segments.some((s) => FORBIDDEN_SEGMENT.has(s)) ? null : segments
}

/** Immutably set `segments` on `obj` to `value`, building intermediate objects with
 *  spread. Segments have already passed `safeSegments` by the time this runs. */
function setAtPath(obj: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = segments
  if (head === undefined) return obj
  if (rest.length === 0) return { ...obj, [head]: value }
  const current = obj[head]
  const child = typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  return { ...obj, [head]: setAtPath(child, rest, value) }
}

/** Immutable counterpart to `setAtPath` for `unset`. A path through a non-object (or a
 *  missing key) is a no-op rather than an error — unsetting something already absent. */
function unsetAtPath(obj: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  const [head, ...rest] = segments
  if (head === undefined || !(head in obj)) return obj
  if (rest.length === 0) {
    // `delete` on a fresh shallow copy rather than destructure-and-drop: the destructuring
    // form needs a binding it never reads, which the mirror repo's eslint rejects even
    // though this one allows a leading underscore. Same result, no unused name.
    const remainder = { ...obj }
    delete remainder[head]
    return remainder
  }
  const current = obj[head]
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return obj
  return { ...obj, [head]: unsetAtPath(current as Record<string, unknown>, rest) }
}

/**
 * Apply a `PatchBody` to an activity's `custom`, immutably — `set` first, then `unset`,
 * matching the server's own order. Any path containing a forbidden segment (see
 * `FORBIDDEN_SEGMENT` above) anywhere in it is skipped entirely, for both `set` and
 * `unset`, rather than partially applied.
 *
 * Deliberately does NOT touch `body.refs`, even though `updateActivity` accepts it
 * (activity-refs-patch amendment, mutable-feed-data spec). `custom` values are
 * self-contained — the new value IS the thing that renders, so echoing it locally
 * before the network round trip is a real, visible improvement. `refs` is not: what
 * actually renders is the RESOLVED object's `custom`, fetched separately into
 * `useFeed`'s `objects` sidecar, and this hook has no local data for an object a ref
 * just started pointing at — `PATCH /v1/activities/:id` returns the patched Activity,
 * not a sidecar. Optimistically flipping `.refs` here would not make anything new
 * appear; it would only make `resolveRefs` hit its already-documented "dangling ref"
 * fallback (spec §8: absent from the map, not an error — render from `custom`) one
 * round trip early, while adding a second, differently-shaped rollback path (`refs`
 * replaces wholesale; it cannot reuse the per-path `pathOwnerRef`/`priorValuesFor`
 * machinery below) for no visible gain. `updateActivity`'s existing success handler —
 * unconditionally replacing the local activity with the server's returned copy —
 * already picks up the new `refs` the moment this very call resolves, which is as
 * fresh as this hook can honestly get without fetching the newly-referenced object
 * too. The next feed read (mount, `refresh()`, `loadNext()`, or `checkNew()`)
 * resolves it into `objects`, same as any other object update (spec §2: freshness is
 * pull, not push, here).
 */
export function applyPatch<TCustom = Record<string, unknown>>(
  activity: Activity<TCustom>,
  body: PatchBody,
): Activity<TCustom> {
  let custom: Record<string, unknown> = { ...(activity.custom as unknown as Record<string, unknown>) }
  for (const [path, value] of Object.entries(body.set ?? {})) {
    const segments = safeSegments(path)
    if (segments === null) continue
    custom = setAtPath(custom, segments, value)
  }
  for (const path of body.unset ?? []) {
    const segments = safeSegments(path)
    if (segments === null) continue
    custom = unsetAtPath(custom, segments)
  }
  return { ...activity, custom: custom as TCustom }
}

/** Read the value already sitting at a `custom.a.b` path, so a failed patch can be
 *  inverted later. `existed: false` covers both "the key was never set" and "the walk
 *  hit a non-object along the way" — either way there is nothing to restore but absence. */
function getAtPath(
  obj: Record<string, unknown>,
  segments: string[],
): { existed: true; value: unknown } | { existed: false } {
  let cur: unknown = obj
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !(seg in (cur as Record<string, unknown>))) {
      return { existed: false }
    }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return { existed: true, value: cur }
}

/** Snapshot, per path, the value `custom` holds right before a patch overwrites it —
 *  the raw material for a scoped inverse (`inversePatchFor`) if that patch's network
 *  call later fails. Forbidden paths (see `safeSegments`) are recorded as `existed:
 *  false`; `applyPatch` already never touched them, so their "inverse" is a no-op. */
function priorValuesFor(
  custom: unknown,
  paths: string[],
): Map<string, { existed: true; value: unknown } | { existed: false }> {
  const base = (custom ?? {}) as Record<string, unknown>
  const out = new Map<string, { existed: true; value: unknown } | { existed: false }>()
  for (const path of paths) {
    const segments = safeSegments(path)
    out.set(path, segments === null ? { existed: false } : getAtPath(base, segments))
  }
  return out
}

/** Build the `PatchBody` that undoes exactly `paths` against a `priorValuesFor` snapshot:
 *  `set` back to whatever was there, or `unset` if nothing was. Restricting to `paths`
 *  (rather than every path the snapshot knows about) is what lets a caller revert only
 *  the subset of touched paths it still owns — see the ownership comment on
 *  `pathOwnerRef` below. */
function inversePatchFor(
  prior: Map<string, { existed: true; value: unknown } | { existed: false }>,
  paths: string[],
): PatchBody {
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const path of paths) {
    const v = prior.get(path)
    if (v === undefined) continue
    if (v.existed) set[path] = v.value
    else unset.push(path)
  }
  const body: PatchBody = {}
  if (Object.keys(set).length > 0) body.set = set
  if (unset.length > 0) body.unset = unset
  return body
}

/**
 * Ownership map for `updateActivity`'s optimistic-rollback tracking, keyed by activityId
 * then path — NESTED, not a single `Map<string, symbol>` joined as `` `${activityId}::${path}` ``.
 * A joined string key is not injective: activityId `"U"` + path `"custom.foo::bar"` and
 * activityId `"U::custom.foo"` + path `"bar"` produce the identical key. Activity ids are
 * server UUIDs so the first half of that can't happen from a real id, but `path` is
 * whatever the caller's `custom` field names are — a `custom` field containing `::`
 * reaches the collision through ordinary application code, no attacker required. A
 * collision makes a failing call see `stillOwned === false` and skip a rollback it should
 * have performed, leaving the UI showing a value the server rejected.
 */
type PathOwnerMap = Map<string, Map<string, symbol>>

function setOwner(map: PathOwnerMap, activityId: string, path: string, token: symbol): void {
  let inner = map.get(activityId)
  if (inner === undefined) {
    inner = new Map()
    map.set(activityId, inner)
  }
  inner.set(path, token)
}

function isOwner(map: PathOwnerMap, activityId: string, path: string, token: symbol): boolean {
  return map.get(activityId)?.get(path) === token
}

/** Remove ownership entries `token` still holds for `activityId`, once the call that
 *  wrote them settles (success or failure) — keeps the map from growing unboundedly
 *  across a long-lived feed instead of relying solely on the wholesale reset on feed
 *  switch. Only removes entries still pointing at `token`; a path a newer overlapping
 *  call has since taken over is left untouched, and an empty inner map is dropped too so
 *  a feed with many distinct activities doesn't accumulate empty entries. */
function releaseOwnedPaths(map: PathOwnerMap, activityId: string, paths: string[], token: symbol): void {
  const inner = map.get(activityId)
  if (inner === undefined) return
  for (const path of paths) {
    if (inner.get(path) === token) inner.delete(path)
  }
  if (inner.size === 0) map.delete(activityId)
}

/**
 * Loads a feed's first page and keeps it fresh, with optimistic `loadNext`/`addActivity`/
 * `refresh` helpers.
 *
 * Returns `{ activities, loadNext, hasNext, isLoading, error, addActivity, refresh,
 * newCount, showNew, checkNew }`, plus the infinite-scroll set: `canLoadMore`, `retry`,
 * `isLoadingInitial`, `isLoadingMore`.
 *
 * INFINITE SCROLL. Driving `loadNext` from an IntersectionObserver is not the same
 * problem as driving it from a button — the observer fires on intersect and again on
 * every reflow, so what a button reaches once, a sentinel reaches constantly:
 *
 * - Bind the sentinel to `canLoadMore`, not `hasNext`. It also folds in "a page is
 *   already in flight" and "the last page failed and nobody has acknowledged it".
 * - Gate a full-page spinner on `isLoadingInitial`, never on `isLoading`. The shared
 *   flag is true during `loadNext` too, so a list gated on it unmounts its own sentinel
 *   mid-fetch and scrolling stops for good.
 * - `loadNext` is internally guarded anyway: a call while a page is in flight, or while
 *   `error` is set, is a no-op rather than a duplicate request on the same cursor.
 *   Pages merge deduped by id, so an overlapping page cannot produce duplicate keys.
 * - `retry()` is the only way past the error guard. Wire it to a button.
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
  /** Rows per request, for every read this hook makes (first page, `loadNext`,
   *  `refresh`, `checkNew`). Default 20. Raise it for infinite scroll on a desktop
   *  viewport, where 20 rows can be a single screen and each scroll costs a round trip.
   *  `newCount` saturates at this value — see `checkNew` below. */
  pageSize?: number
  /** @deprecated Use `live: true` — cheaper (head check, not a full read) and
   * visibility-aware. Kept working; ignored when `live` is set. */
  pollInterval?: number
  /**
   * Keep this feed fresh. Two cadences, both paused while the tab is hidden and both
   * firing immediately on return:
   *
   * - every 5s, a head check — one Redis read that answers "did a new activity arrive",
   *   costing a full page read only when it did;
   * - every `liveRevalidateInterval`, the changes a head can never report: edits to the
   *   activities on screen, and re-reads of the objects they point at.
   */
  live?: boolean
  /**
   * Milliseconds between revalidation ticks under `live`. Default 30000; `0` disables
   * revalidation entirely, leaving only the 5s new-activity check.
   *
   * Deliberately slower than the head cadence. A head check is one Redis read that
   * usually answers "nothing new"; a revalidation is a real page read plus a batch object
   * read, and edits and object updates happen a handful of times a day, not a handful of
   * times a minute. Running both at 5s would bill six times the requests for the same
   * information.
   */
  liveRevalidateInterval?: number
  /** @deprecated Renamed `liveRevalidateInterval` — the same tick now also picks up
   * activity edits, not just objects. Still honoured when the new name is absent. */
  liveObjectsInterval?: number
  /**
   * Ceiling on how many refs one object sweep reads, across all its requests. Default
   * 200; every 100 refs is one request per tick.
   *
   * A deeply scrolled feed can hold thousands of refs, and refreshing all of them every
   * interval would cost more than the per-card polling this replaces. Past the ceiling
   * the NEWEST activities are refreshed and the tail keeps its last-read values — stale
   * rather than expensive, warned once in the console rather than silently.
   */
  liveObjectsMaxRefs?: number
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
  const { client, cache, onError } = useDropInContext()
  const enabled = client !== null
  const feedKey = `${group}:${id}`
  const pageSize = opts?.pageSize ?? 20
  // Timestamp of the last page-1 read from ANY driver (head-change checkNew, or the
  // revalidate tick itself), so the two never read the same page seconds apart.
  const lastPageReadAtRef = useRef(0)
  // The cache is intentionally shared/untyped (one CacheEntry — fixed to the default
  // TCustom — serves every TCustom a caller might use across the app), so both the read
  // and the write need a cast at this boundary rather than threading TCustom through the
  // provider/cache types.
  // `promoted` rides in the cache entry so a remount renders the same slots straight
  // away instead of losing them until the next uncursored read (later pages never
  // carry a sidecar, so it cannot be recovered by paging). `objects` rides along for the
  // same reason — a remount should render resolved refs instantly too.
  type Entry = {
    activities: Activity<TCustom>[]
    next: string | null
    promoted?: PromotedActivity<TCustom>[]
    objects?: Record<string, DropInObject<TCustom>>
  }
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
        // An SSR-prefetched first page carries the sidecars too — keep them, or the
        // server-rendered markup and the first client render would disagree.
        ...('promoted' in opts.initialData ? { promoted: opts.initialData.promoted } : {}),
        ...('objects' in opts.initialData ? { objects: opts.initialData.objects } : {}),
      }
    : undefined)
  const [activities, setActivities] = useState<Activity<TCustom>[]>(seed?.activities ?? [])
  const [next, setNext] = useState<string | null>(seed?.next ?? null)
  const [promoted, setPromoted] = useState<PromotedActivity<TCustom>[]>(seed?.promoted ?? [])
  // The refs sidecar for the currently-shown page(s). `{}` — never `undefined` — when the
  // server omits the key, so consumers can index straight in without a null check; the
  // client type is `objects?: …` (server may not send it at all), but the hook picks one
  // shape and commits to it. A full page load (mount/refresh) REPLACES this map (it
  // re-resolves eligibility, same as `promoted`); `loadNext` MERGES a later page's objects
  // in instead — a second page can introduce refs the first page didn't carry, and a
  // blanket replace would blank already-rendered cards that resolved off page 1.
  const [objects, setObjects] = useState<Record<string, DropInObject<TCustom>>>(seed?.objects ?? {})
  // Two loading flags, not one. `isLoadingInitial` covers the reads that REPLACE the list
  // (mount, feed switch, refresh) — the only ones a full-page spinner should gate.
  // `isLoadingMore` covers loadNext, which APPENDS: a list gated on the shared flag
  // unmounts its scroll sentinel mid-fetch, so scrolling stalls permanently and the
  // reader loses their position. `isLoading` stays their union, so every caller written
  // against the single-flag shape keeps working.
  const [isLoadingInitial, setLoadingInitial] = useState(enabled && seed === undefined)
  const [isLoadingMore, setLoadingMore] = useState(false)
  const isLoading = isLoadingInitial || isLoadingMore
  const [error, setError] = useState<Error | null>(null)
  // Mirrors isLoadingMore for the in-flight guard: state is a render behind, and an
  // IntersectionObserver re-fires (on intersect, then again as content reflows) long
  // before React has re-rendered with the new flag.
  const loadingMoreRef = useRef(false)
  // Buffer for checkNew()/showNew() — activities polled in but not yet flushed into
  // `activities`. Refs mirror the latest state so checkNew (a useCallback with a stable
  // identity for the poll-effect's timer) always dedupes against current data, not a
  // stale closure from whenever it was created.
  const [pending, setPending] = useState<Activity<TCustom>[]>([])
  const activitiesRef = useRef(activities)
  activitiesRef.current = activities
  // Mirrored for the same reason: `reconcileEdits` needs the current cursor to rewrite
  // the cache entry, and taking `next` as a dependency instead would change its identity
  // on every page load — which propagates into `checkNew` and re-arms the (deprecated)
  // `pollInterval` timer from zero on each `loadNext`.
  const nextRef = useRef(next)
  nextRef.current = next
  const promotedRef = useRef(promoted)
  promotedRef.current = promoted
  const objectsRef = useRef(objects)
  objectsRef.current = objects
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  // Tracks, per activityId then path (see `PathOwnerMap` above for why it's nested rather
  // than a single map joined on a delimiter), which in-flight updateActivity call most
  // recently wrote that specific custom path optimistically. On failure, a call reverts
  // ONLY paths it still owns (the map still points at its own token) — so two overlapping
  // updateActivity calls that touch the same path never stomp each other: whichever
  // wrote LAST keeps its value even if an EARLIER call is the one that fails. Entries are
  // released (`releaseOwnedPaths`) once the call that wrote them settles.
  const pathOwnerRef = useRef<PathOwnerMap>(new Map())
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
    setLoadingInitial(seed === undefined)
    setLoadingMore(false)
    loadingMoreRef.current = false // a page-2 fetch from the previous feed is now irrelevant
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
    // try/catch around the kickoff itself, not just `.catch()` on the resulting promise:
    // `client.feed(group, id)` and `.get(...)` are both expected to reject rather than
    // throw synchronously (every SDK error is a Promise rejection — see pathSegment() in
    // @dropinnodex/client), but this hook's documented contract is that a feed read never
    // crashes the component, only ever surfaces through `error`. Wrapping the kickoff is
    // the same defense-in-depth every sibling hook's `load()` gets for free from being an
    // `async` function with the whole body inside `try` — mirror that here rather than
    // trust an invariant that lives in a different package.
    try {
      client.feed(group, id).get<TCustom>({ limit: pageSize }, { signal: ctrl.signal })
        .then((page) => {
          if (cancelled) return
          // An uncursored read is the only thing that ever carries the sidecar; `?? []`
          // so a server without the feature degrades to "nothing eligible", not undefined.
          const side = page.promoted ?? []
          const objSide = page.objects ?? {}
          setCache({ activities: page.results, next: page.next, promoted: side, objects: objSide })
          setActivities(page.results)
          setNext(page.next)
          setPromoted(side)
          setObjects(objSide)
        })
        .catch((err: unknown) => { if (!cancelled && !isAbort(err)) setError(err as Error) })
        .finally(() => { if (!cancelled) setLoadingInitial(false) })
    } catch (err) {
      if (!cancelled && !isAbort(err)) setError(err as Error)
      if (!cancelled) setLoadingInitial(false)
    }
    // abort() cancels the request itself; `cancelled` still guards the state writes, since
    // a response that already landed resolves regardless of the signal.
    return () => { cancelled = true; ctrl.abort() }
  }, [client, cache, feedKey, group, id, pageSize])

  // Reset path-ownership tracking on a feed switch (or mount) only — NOT on every
  // dependency of the mount effect above (which also includes `pageSize`). A `pageSize`
  // change while an `updateActivity` call is in flight must not wipe the map: that call's
  // token would no longer be found on failure, so its rollback would be silently skipped.
  // A path-ownership token from a DIFFERENT feed is meaningless here (activity ids don't
  // carry across feeds), so `feedKey` is the only dependency that should ever clear it.
  useEffect(() => {
    pathOwnerRef.current = new Map()
  }, [feedKey])

  /**
   * Fold an incoming `objects` sidecar into the one on screen, and into the shared cache
   * so a remount renders the merged map rather than the last full page's.
   *
   * Merge, never replace: every caller of this is a page-1 read, and a reader who has
   * paged deeper holds refs page 1 does not carry. `objectsRef` is advanced eagerly so a
   * caller that also writes the cache later in the same tick (checkNew's empty-feed
   * branch) picks up the merged map instead of the pre-merge one.
   */
  const mergeObjects = useCallback((incoming: Record<string, DropInObject<TCustom>> | undefined) => {
    if (incoming === undefined) return
    // Same "newer wins, equal is untouched" rule the sweep applies, for the same two
    // reasons: this runs on a timer, so re-storing an identical sidecar would hand every
    // consumer a fresh `objects` identity (a whole-list re-render) on every tick, and a
    // page read that started before a newer write must not undo it on arrival.
    const cur = objectsRef.current
    const merged = { ...cur }
    let changed = false
    for (const [ref, got] of Object.entries(incoming)) {
      const held = cur[ref]
      if (held === undefined || Date.parse(got.updated_at) > Date.parse(held.updated_at)) {
        merged[ref] = got
        changed = true
      }
    }
    if (!changed) return
    objectsRef.current = merged
    setObjects(merged)
    const entry = cache.get(feedKey) as Entry | undefined
    if (entry !== undefined) setCache({ ...entry, objects: merged })
  }, [cache, feedKey])

  /**
   * Land server-side edits to activities ALREADY on screen.
   *
   * The head token is written by the fan-out worker and nothing else, so it reports "a
   * new activity arrived", never "an activity changed". `checkNew` then dedupes page 1 by
   * id, which drops an edited body as "not new" — so before this, an edit reached an open
   * feed only through `refresh()`, which resets pagination.
   *
   * Swaps bodies IN PLACE. An edit is not an arrival: routing it through `pending` would
   * park a correction behind a pill the reader has to click, and prepending it would move
   * a row out from under them.
   */
  const reconcileEdits = useCallback((incoming: Activity<TCustom>[]) => {
    const byId = new Map(incoming.map((a) => [a.id, a]))
    let changed = false
    const merged = activitiesRef.current.map((a) => {
      const got = byId.get(a.id)
      // `version` bumps on ANY write to the row — a patch, a reaction count, a soft
      // delete — which is exactly the question being asked. `edited_at` marks patches
      // only, so it is blind to the field that moves most and is not used here.
      //
      // Comparing a server-set marker rather than the body is also what keeps an
      // in-flight optimistic `updateActivity` safe: that patch does not move `version`,
      // so the pre-edit row coming back is not mistaken for newer.
      if (got === undefined || got.version === a.version) return a
      changed = true
      return got
    })
    if (!changed) return
    activitiesRef.current = merged
    setActivities(merged)
    setCache({
      activities: merged, next: (cache.get(feedKey) as Entry | undefined)?.next ?? nextRef.current,
      promoted: promotedRef.current, objects: objectsRef.current,
    })
  }, [cache, feedKey])

  // The fetch itself, with no policy: `loadNext` and `retry` differ only in which guards
  // they apply before calling this.
  const fetchNext = useCallback(async () => {
    if (client === null || next === null) return
    const signal = readSignal()
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const page = await client.feed(group, id).get<TCustom>({ limit: pageSize, next }, { signal })
      // Objects DO merge across pages (unlike `promoted`, which is only ever resolved on
      // an uncursored read): a later page can introduce refs the first page didn't carry,
      // and replacing the map would blank cards that already resolved off page 1.
      const mergedObjects = { ...objectsRef.current, ...(page.objects ?? {}) }
      setActivities((prev) => {
        const merged = mergeById(prev, page.results)
        // Page 2+ carries no promoted sidecar by contract — carry the cached one forward
        // so repeat placement keeps filling slots as the list grows.
        setCache({ activities: merged, next: page.next, promoted: promotedRef.current, objects: mergedObjects })
        return merged
      })
      setNext(page.next)
      setObjects(mergedObjects)
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      loadingMoreRef.current = false
      if (!signal?.aborted) setLoadingMore(false)
    }
  }, [client, cache, feedKey, group, id, next, pageSize])

  /**
   * Append the next page. Safe to call from an IntersectionObserver: it is a no-op at
   * end-of-feed, while a page is already in flight, and while `error` is set.
   *
   * The error guard is what stops a sentinel from hammering: a failed page leaves `next`
   * unchanged, so an unguarded retry re-issues the identical request for as long as the
   * sentinel stays intersecting — which, with the list short one page, is forever. Call
   * `retry()` to clear the error and try that same cursor again.
   */
  const loadNext = useCallback(async () => {
    if (loadingMoreRef.current || error !== null) return
    await fetchNext()
  }, [fetchNext, error])

  /** Clear the error and re-issue the failed page. The explicit escape from the error
   *  guard above — wire it to a "Try again" button, never to the sentinel. */
  const retry = useCallback(async () => {
    if (loadingMoreRef.current) return
    setError(null)
    await fetchNext()
  }, [fetchNext])

  const addActivity = useCallback(
    async (a: {
      verb: string; object: string; target?: string | null; foreign_id?: string | null; time?: string; custom?: TCustom
      /** Objects this activity points at, as `type:id`. Max 4. Resolved into `objects` above. */
      refs?: string[]
    }) => {
      if (client === null) return undefined // disabled — no-op resolving undefined
      const created = await client.feed(group, id).addActivity<TCustom>(a)
      setActivities((prev) => {
        const merged = [created, ...prev]
        // Carry the existing sidecars forward — `setCache` REPLACES the entry, so
        // omitting them would blank a remount's promoted slots / resolved refs even
        // though nothing about them actually changed.
        setCache({
          activities: merged, next: cache.get(feedKey)?.next ?? next,
          promoted: promotedRef.current, objects: objectsRef.current,
        })
        return merged
      })
      return created
    },
    [client, cache, feedKey, group, id, next],
  )

  /**
   * Patch an activity's `custom` optimistically. Structured like `useReactions`'
   * `react`/`unreact` — `if (client === null) return`, apply locally via `applyPatch`
   * (which carries the prototype-pollution guard — see its comment), call the network,
   * replace with the server's value on success (it carries `edited_at` and any
   * server-side coercion the optimistic copy can't know about), and on failure roll back
   * AND reject — unless `onError` is supplied (per-call or via `<DropInProvider
   * onError>`), in which case it rolls back and resolves `undefined` instead. See the
   * file header for the full contract.
   *
   * UNLIKE `react`/`unreact`, the rollback here is NOT a whole-state snapshot restore.
   * `useReactions` can get away with that because its blast radius is one activity's
   * local counters; this hook's state is the shared `activities` ARRAY, and a
   * `refresh()`/`loadNext()` landing while a patch is in flight is a normal, expected
   * race — restoring a captured array snapshot on failure would silently discard
   * whatever that concurrent read brought in. So the rollback instead re-derives from
   * the CURRENT array at failure time and applies only the INVERSE of the paths THIS
   * call itself touched (via `priorValuesFor`/`inversePatchFor`), leaving everything
   * else — other activities, other fields — untouched. `pathOwnerRef` further scopes
   * that to paths this call still "owns": if a second `updateActivity` on the same path
   * started after this one and is still standing, this call's failure does not stomp it.
   *
   * A no-op (activities unchanged) if `activityId` isn't in the currently-loaded list —
   * the network call still fires, since the activity may simply be off-page.
   *
   * `body.refs`, when present, replaces the activity's refs wholesale (not merged) —
   * the backfill path for attaching objects to an activity posted before they existed.
   * Unlike `set`/`unset`, it is NOT applied by the optimistic step (see `applyPatch`'s
   * doc comment for why); it lands as soon as this call's network response replaces
   * the local activity, and the objects it newly points at resolve on the next feed
   * read, same as any other object update.
   *
   * @throws The network error after the optimistic patch has been rolled back (no
   * `onError` supplied).
   */
  const updateActivity = useCallback(
    async (
      activityId: string,
      body: PatchBody,
      callOpts?: { onError?: OptimisticOnError },
    ): Promise<Activity<TCustom> | undefined> => {
      if (client === null) return undefined // disabled — no optimistic write, no network
      const token = Symbol('updateActivity')
      const touchedPaths = [...Object.keys(body.set ?? {}), ...(body.unset ?? [])]
      const target = activitiesRef.current.find((a) => a.id === activityId)
      // `null`, not an empty Map, when the activity isn't currently loaded — failure
      // then has nothing to revert (the optimistic apply below was already a no-op).
      const prior = target ? priorValuesFor(target.custom, touchedPaths) : null
      for (const path of touchedPaths) setOwner(pathOwnerRef.current, activityId, path, token)
      // Optimistic.
      setActivities((prevActs) => {
        const merged = prevActs.map((a) => (a.id === activityId ? applyPatch<TCustom>(a, body) : a))
        setCache({
          activities: merged, next: cache.get(feedKey)?.next ?? next,
          promoted: promotedRef.current, objects: objectsRef.current,
        })
        return merged
      })
      try {
        const updated = await client.feed(group, id).updateActivity<TCustom>(activityId, body)
        setActivities((prevActs) => {
          const merged = prevActs.map((a) => (a.id === activityId ? updated : a))
          setCache({
            activities: merged, next: cache.get(feedKey)?.next ?? next,
            promoted: promotedRef.current, objects: objectsRef.current,
          })
          return merged
        })
        return updated
      } catch (err) {
        if (prior !== null) {
          // Revert only the paths THIS call still owns — ownership moves to a newer
          // overlapping updateActivity call on the same path the moment it optimistically
          // writes there, so a since-superseded path is left alone rather than stomped.
          const stillOwned = touchedPaths.filter(
            (path) => isOwner(pathOwnerRef.current, activityId, path, token),
          )
          if (stillOwned.length > 0) {
            const inverse = inversePatchFor(prior, stillOwned)
            setActivities((prevActs) => {
              // Re-derive from the CURRENT array, not a captured snapshot — anything a
              // concurrent refresh()/loadNext() brought in since this call started
              // (other activities, or other fields on this one) must survive.
              const merged = prevActs.map((a) => (a.id === activityId ? applyPatch<TCustom>(a, inverse) : a))
              setCache({
                activities: merged, next: cache.get(feedKey)?.next ?? next,
                promoted: promotedRef.current, objects: objectsRef.current,
              })
              return merged
            })
          }
        }
        const handler = resolveOnError(callOpts, onError)
        if (handler) {
          handler(err as Error, { hook: 'useFeed', action: 'updateActivity', activityId })
          return undefined
        }
        throw err
      } finally {
        // This call is done either way — drop the ownership entries it still holds so
        // the map doesn't grow unboundedly across a long-lived feed. A path a newer
        // overlapping call has since taken over is left alone (releaseOwnedPaths only
        // removes entries still pointing at `token`).
        releaseOwnedPaths(pathOwnerRef.current, activityId, touchedPaths, token)
      }
    },
    [client, cache, feedKey, group, id, next, onError],
  )

  const refresh = useCallback(async () => {
    if (client === null) return
    const signal = readSignal()
    // refresh() REPLACES the list, so it is an initial-style load, not a "more" one.
    setLoadingInitial(true)
    setError(null)
    try {
      const page = await client.feed(group, id).get<TCustom>({ limit: pageSize }, { signal })
      // refresh() is an uncursored read, so it also re-resolves eligibility — which is
      // how a promotion that expired mid-session stops rendering from the client cache.
      // Objects REPLACE here too (not merge): refresh is initial-style, and an object
      // deleted server-side mid-session should stop resolving, not linger from the cache.
      const side = page.promoted ?? []
      const objSide = page.objects ?? {}
      setCache({ activities: page.results, next: page.next, promoted: side, objects: objSide })
      setActivities(page.results)
      setNext(page.next)
      setPromoted(side)
      setObjects(objSide)
      // refresh() authoritatively replaces activities from the server, so any
      // checkNew() buffer is now stale (page 1 may already include what it buffered,
      // e.g. an at-least-once replay) — drop it, or showNew() would later duplicate.
      setPending([])
    } catch (err) {
      if (!isAbort(err)) setError(err as Error)
    } finally {
      if (!signal?.aborted) setLoadingInitial(false)
    }
  }, [client, cache, feedKey, group, id, pageSize])

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
      const page = await client.feed(group, id).get<TCustom>({ limit: pageSize }, { signal: readSignal() })
      // The feed this call was fetching for may have been switched away from (group/id
      // changed) while the request was in flight — drop a result that would otherwise
      // write another feed's activities into this (now different) feed's state.
      if (feedKeyRef.current !== feedKey) return
      // Stamped on every page-1 read, whatever drove it. The revalidate tick reads this
      // to skip its own read when a head change already fetched the same page seconds ago.
      lastPageReadAtRef.current = Date.now()
      // The page this call already paid for carries the `objects` sidecar, and objects
      // are the half of a feed that actually changes. Dropping it here was the reason
      // `live: true` delivered no object freshness at all. MERGE, not replace: this is a
      // page-1 read, so replacing would blank cards a reader resolved off page 2+ (same
      // rule as loadNext). Applied before the empty-feed branch below, since that one
      // returns early. Activities still buffer rather than prepend — an object moving
      // under a card is not the feed jumping under the reader.
      mergeObjects(page.objects)
      const cur = activitiesRef.current
      // A previously-empty feed has nothing to "jump" — load its first activities directly.
      if (cur.length === 0) {
        setCache({
          activities: page.results, next: page.next,
          promoted: promotedRef.current, objects: objectsRef.current,
        })
        setActivities(page.results)
        setNext(page.next)
        return
      }
      // Edits to rows already on screen land in place, before the id-dedupe below throws
      // those same rows away as "not new".
      reconcileEdits(page.results)
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
  }, [client, cache, feedKey, group, id, pageSize, mergeObjects, reconcileEdits])

  // ── Revalidation ──────────────────────────────────────────────────────────────
  // The head token is written by the fan-out worker and by nothing else, so it reports
  // exactly one event: a new activity arrived. Neither an object upsert nor an activity
  // PATCH moves it, which leaves BOTH kinds of change invisible to the 5s head check.
  // Bumping the head on either write is not the answer — an object (and an activity) sits
  // in N feeds, so that is fan-out on write, N Redis writes per edit.
  //
  // Instead, one slower tick revalidates what the head cannot report: page 1 (for edits
  // to rows on screen) and the object refs (for the shared data those rows point at).
  //
  // A `head`-style object check (refs in, `updated_at` out) was considered and dropped:
  // the timestamp lives in the same Postgres row as `custom`, so it is the same scan and
  // the same row count — it would buy a smaller payload at the cost of a second round
  // trip on every sweep. One batch read of the whole ref set is cheaper and simpler.
  const liveRevalidateInterval = opts?.liveRevalidateInterval ?? opts?.liveObjectsInterval ?? 30_000
  const liveObjectsMaxRefs = opts?.liveObjectsMaxRefs ?? DEFAULT_MAX_SWEEP_REFS

  // What we held for each swept ref at tick time. Read back when the result lands: a ref
  // absent from a COVERED chunk whose local copy still matches this snapshot was deleted
  // server-side; one that changed meanwhile was written by a concurrent page read (a
  // loadNext or refresh landing mid-sweep) and must be left alone.
  const sweptBeforeRef = useRef<Map<string, string | undefined>>(new Map())

  // Applying a sweep is separate from performing one, because one read now serves every
  // mounted hook on this feed (see object-sweep.ts). Whichever instance ticks first does
  // the request; all of them land here.
  const applySweep = useCallback((result: SweepResult<TCustom>) => {
    const before = sweptBeforeRef.current
    const cur = objectsRef.current
    const out = { ...cur }
    let changed = false
    // Iterate the COVERED refs, not the ones we asked for: a chunk that failed tells us
    // nothing about its refs, and treating "no answer" as "deleted" would drop live
    // objects whenever one request of a chunked sweep timed out.
    for (const ref of result.asked) {
      const got = result.fresh[ref]
      const held = cur[ref]
      if (got !== undefined) {
        // Newest `updated_at` wins, and equal counts as unchanged. Both halves matter:
        // taking the response unconditionally would let a sweep that started before a
        // refresh pin the card back to the older read when it lands after it, and
        // re-storing an identical object would hand every consumer a new identity —
        // a re-render of the whole list every interval for no change at all.
        if (held === undefined || Date.parse(got.updated_at) > Date.parse(held.updated_at)) {
          out[ref] = got
          changed = true
        }
      } else if (held !== undefined && before.has(ref) && before.get(ref) === held.updated_at) {
        // Covered by a successful chunk, absent from it, and nothing wrote it meanwhile:
        // deleted server-side. Keeping it would render a cancelled session forever;
        // dropping it restores the documented fallback to the activity's own `custom`.
        // `before.has` matters for a hook that joined a sweep started for another
        // instance's ref list — refs it never snapshotted are not its business.
        delete out[ref]
        changed = true
      }
    }
    if (!changed) return
    objectsRef.current = out
    setObjects(out)
    const entry = cache.get(feedKey) as Entry | undefined
    if (entry !== undefined) setCache({ ...entry, objects: out })
  }, [cache, feedKey])

  useEffect(
    () => subscribeToSweeps<TCustom>(cache, feedKey, applySweep),
    [cache, feedKey, applySweep],
  )

  const sweepObjects = useCallback(async (minGapMs: number) => {
    if (client === null) return
    // react and @dropinnodex/client version independently: a newer react paired with a
    // client that predates getMany must degrade to activity-only freshness, not throw on
    // a timer forever. Feature-detect rather than assume the installed client's shape.
    const objectsApi = (client as { objects?: { getMany?: unknown } }).objects
    if (typeof objectsApi?.getMany !== 'function') return
    const refs = capRefs(cache, feedKey, shownRefs(activitiesRef.current), liveObjectsMaxRefs)
    if (refs.length === 0) return
    sweptBeforeRef.current = new Map(refs.map((r) => [r, objectsRef.current[r]?.updated_at]))
    // Cooldown just under the interval: two hooks on the same feed mount at different
    // moments, so their timers are offset and both would otherwise read the same data
    // seconds apart. The one that skips still receives the other's result.
    await runSweep<TCustom>(
      cache, feedKey, refs, minGapMs,
      (chunk) => client.objects.getMany<TCustom>(chunk, { signal: readSignal() }),
    )
  }, [client, cache, feedKey, liveObjectsMaxRefs])

  /**
   * Re-read the objects the shown activities point at, now.
   *
   * The imperative half of `live`'s revalidation: use it after a write whose effect lives
   * on an object rather than on an activity (book the last spot, then show the count the
   * reader just changed), or behind pull-to-refresh — unlike `refresh()`, it touches no
   * pagination, so a reader three pages deep keeps all three and sees no spinner.
   *
   * Independent of `live`: an app that polls nothing can still call this. It skips the
   * cross-instance cooldown that gates the timer, but still coalesces with a sweep already
   * in flight, and resolves only once that sweep's data has been applied.
   *
   * No-ops (resolving `undefined`) inside a disabled provider, and against a
   * `@dropinnodex/client` older than 0.6.0, which has no `objects.getMany`.
   */
  const revalidateObjects = useCallback(() => sweepObjects(0), [sweepObjects])

  /**
   * One tick, both halves of what the head cannot report.
   *
   * The page read is skipped when a head change already fetched page 1 within this
   * interval — a head at 29s and a tick at 30s would otherwise be two reads of the same
   * page. The object sweep has the same cooldown, applied across hook instances inside
   * `runSweep`.
   */
  const revalidateTick = useCallback(async () => {
    if (Date.now() - lastPageReadAtRef.current >= liveRevalidateInterval * 0.9) await checkNew()
    await sweepObjects(liveRevalidateInterval * 0.9)
  }, [checkNew, sweepObjects, liveRevalidateInterval])

  useLiveTicks(
    opts?.live === true && liveRevalidateInterval > 0,
    () => { void revalidateTick() },
    // Guarded above, but never hand setInterval a 0 delay even on an unreachable path.
    liveRevalidateInterval > 0 ? liveRevalidateInterval : 30_000,
  )

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
      // Carry the existing sidecars forward — see the comment on the same line in
      // addActivity above.
      setCache({
        activities: merged, next: cache.get(feedKey)?.next ?? next,
        promoted: promotedRef.current, objects: objectsRef.current,
      })
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
    /** Bind an infinite-scroll sentinel to THIS, not to `hasNext`: it folds in the two
     *  states where another fetch would be wrong — one already in flight, and an
     *  unacknowledged error on the same cursor. */
    canLoadMore: next !== null && !isLoadingMore && error === null,
    isLoadingInitial,
    isLoadingMore,
    retry,
    /** The eligible promoted set for this reader — NOT placed. Empty when none. */
    promoted,
    /** `activities` with promoted rows interleaved per the placement props. */
    items,
    trackPromotedClick,
    /** Refs sidecar for the currently-shown page(s), keyed `type:id`. `{}` when the
     *  server sent none — never `undefined`. Resolve an activity's refs against it with
     *  `resolveRefs(activity, objects)`. */
    objects,
    /** Re-read the shown activities' objects on demand, without touching pagination —
     *  see the JSDoc above the callback. */
    revalidateObjects,
    /** Optimistic `custom` patch — see the JSDoc above the callback for the full
     *  reject-after-rollback / onError contract. */
    updateActivity,
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
    async (a: {
      verb: string; object: string; custom?: TCustom
      /** Objects this activity points at, as `type:id`. Max 4. Resolved into the feed
       *  read's `objects` sidecar — see `useFeed`. */
      refs?: string[]
    }) =>
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
