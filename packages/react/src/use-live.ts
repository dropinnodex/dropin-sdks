import { useEffect, useRef } from 'react'

/**
 * The cadence engine behind `live: true` (spec 2026-07-31-live-updates): tick every
 * `intervalMs` while the page is visible, zero ticks while hidden, one immediate
 * catch-up tick on becoming visible again.
 *
 * `document` is feature-detected, never assumed: under React Native (no `document`)
 * this degrades to a plain interval — which the OS already pauses with the JS thread
 * in background, so visibility-gating is effectively preserved. Explicit AppState
 * wiring is deferred (spec: out of scope v1).
 */
export function useLiveTicks(enabled: boolean, onTick: () => void, intervalMs = 5000): void {
  // Ref-forwarded callback: the interval survives re-renders without re-arming, yet
  // always invokes the latest closure (same trick as activitiesRef in useFeed).
  const cbRef = useRef(onTick)
  cbRef.current = onTick

  useEffect(() => {
    if (!enabled) return
    const tick = () => cbRef.current()
    const hasDoc = typeof document !== 'undefined'
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => { if (timer === null) timer = setInterval(tick, intervalMs) }
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { tick(); start() }
    }
    if (hasDoc) {
      document.addEventListener('visibilitychange', onVisibility)
      if (!document.hidden) start()
    } else {
      start()
    }
    return () => {
      stop()
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, intervalMs])
}
