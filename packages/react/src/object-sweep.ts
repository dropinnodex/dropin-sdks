import type { DropInObject } from '@dropinnodex/client'

/** Mirrors the server's per-request cap on `GET /v1/objects?refs=…`. */
export const MAX_REFS_PER_REQUEST = 100

/**
 * Default ceiling on how many refs ONE sweep will read, across all its requests.
 *
 * Chunking alone bounds nothing: an infinitely-scrolled feed holding 2000 refs would
 * issue 20 requests every interval, forever — worse than the per-card polling this
 * replaces. 200 is two requests, and it keeps the newest activities (where the reader
 * is) fresh; anything past it goes stale rather than expensive. Raise it with
 * `liveObjectsMaxRefs` if a deep feed genuinely needs full coverage, and know the bill.
 */
export const DEFAULT_MAX_SWEEP_REFS = 200

/** What one completed sweep learned. */
export interface SweepResult<TCustom> {
  /** Objects that came back, keyed `type:id`. */
  fresh: Record<string, DropInObject<TCustom>>
  /**
   * Refs this sweep actually COVERED — the input refs of the chunks that succeeded.
   * A ref absent from `fresh` means "deleted server-side" ONLY if it is in here; a ref
   * whose chunk failed is simply unknown, and a subscriber that confused the two would
   * delete live objects every time one request in a chunked sweep timed out.
   */
  asked: string[]
}

interface FeedSweep<TCustom> {
  inflight: Promise<SweepResult<TCustom>> | null
  /** Completion time of the last sweep, for the cross-instance cooldown. */
  lastAt: number
  subs: Set<(r: SweepResult<TCustom>) => void>
  /** One truncation warning per feed, not one per tick. */
  warned: boolean
}

/**
 * Sweep state per provider, per feed.
 *
 * Keyed by the provider's cache Map — an object that already exists, is created once per
 * `<DropInProvider>`, and dies with it. That gets per-provider isolation and automatic
 * cleanup without widening the context value, which is public API.
 */
const registries = new WeakMap<object, Map<string, FeedSweep<never>>>()

function sweepFor<TCustom>(scope: object, feedKey: string): FeedSweep<TCustom> {
  let reg = registries.get(scope)
  if (reg === undefined) {
    reg = new Map()
    registries.set(scope, reg)
  }
  let s = reg.get(feedKey)
  if (s === undefined) {
    s = { inflight: null, lastAt: 0, subs: new Set(), warned: false }
    reg.set(feedKey, s)
  }
  return s as unknown as FeedSweep<TCustom>
}

/**
 * Subscribe to every sweep result for a feed. Returns the unsubscribe.
 *
 * Every mounted `useFeed` on the same feed subscribes, but only one of them performs the
 * read — see `runSweep`. Two components rendering the same timeline used to mean two
 * full sweeps on two offset timers; now it means one read fanned out to both.
 */
export function subscribeToSweeps<TCustom>(
  scope: object,
  feedKey: string,
  onResult: (r: SweepResult<TCustom>) => void,
): () => void {
  const s = sweepFor<TCustom>(scope, feedKey)
  s.subs.add(onResult)
  return () => {
    s.subs.delete(onResult)
    // Drop the entry once nothing is watching this feed, so a session that browses many
    // feeds does not accumulate one live record per feed for the provider's lifetime.
    if (s.subs.size === 0 && s.inflight === null) registries.get(scope)?.delete(feedKey)
  }
}

/** Cap the sweep, warning once per feed rather than truncating in silence. */
export function capRefs(scope: object, feedKey: string, refs: string[], max: number): string[] {
  if (refs.length <= max) return refs
  const s = sweepFor(scope, feedKey)
  if (!s.warned) {
    s.warned = true
    console.warn(
      `[dropin] feed "${feedKey}" has ${refs.length} object refs on screen; the live object `
      + `sweep refreshes the newest ${max} and leaves the rest at their last-read values. `
      + `Raise liveObjectsMaxRefs to cover more (each ${MAX_REFS_PER_REQUEST} refs costs one `
      + `request per tick), or lower it to spend less.`,
    )
  }
  return refs.slice(0, max)
}

/**
 * Read `refs` and broadcast the result to every subscriber on this feed.
 *
 * Reads nothing when another instance already has a sweep in flight (it awaits that one
 * instead, so an awaited caller resolves once the shared data has landed rather than
 * before it), or when one finished less than `minGapMs` ago — the caller still gets that
 * sweep's data through its subscription, so skipping the request costs it nothing. Pass
 * `minGapMs: 0` for a hand-triggered sweep: the cooldown exists to stop two offset TIMERS
 * reading the same data seconds apart, and user intent is not a timer.
 *
 * Chunks are `allSettled`, not `all`: at 200 refs a sweep is two requests, and one of them
 * failing must not discard what the other returned.
 */
export async function runSweep<TCustom>(
  scope: object,
  feedKey: string,
  refs: string[],
  minGapMs: number,
  fetchChunk: (chunk: string[]) => Promise<Record<string, DropInObject<TCustom>>>,
  now: () => number = Date.now,
): Promise<void> {
  const s = sweepFor<TCustom>(scope, feedKey)
  // `.catch` because the owner's promise is awaited here too: it cannot reject by
  // construction (every chunk is settled), but a throw would propagate into a caller
  // that merely joined someone else's read.
  if (s.inflight !== null) { await s.inflight.catch(() => {}); return }
  if (s.lastAt !== 0 && now() - s.lastAt < minGapMs) return

  const chunks: string[][] = []
  for (let i = 0; i < refs.length; i += MAX_REFS_PER_REQUEST) {
    chunks.push(refs.slice(i, i + MAX_REFS_PER_REQUEST))
  }

  s.inflight = (async () => {
    const settled = await Promise.allSettled(chunks.map((c) => fetchChunk(c)))
    const fresh: Record<string, DropInObject<TCustom>> = {}
    const asked: string[] = []
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return
      Object.assign(fresh, r.value)
      asked.push(...chunks[i]!)
    })
    return { fresh, asked }
  })()

  try {
    const result = await s.inflight
    s.lastAt = now()
    // Copied before iterating: a subscriber's state update can unmount a sibling, and
    // mutating the live Set mid-iteration would skip one.
    for (const sub of [...s.subs]) sub(result)
  } catch {
    // Unreachable — the inflight promise settles every chunk rather than rejecting — but
    // a throw here would otherwise strand `inflight` and wedge the feed's sweeps forever.
  } finally {
    s.inflight = null
  }
}
