import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveTicks } from './use-live.js'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => { setHidden(false); vi.useRealTimers() })

describe('useLiveTicks', () => {
  it('ticks every 5s while visible; disabled means never', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const off = renderHook(() => useLiveTicks(false, tick))
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(tick).not.toHaveBeenCalled()
    off.unmount()

    const on = renderHook(() => useLiveTicks(true, tick))
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(tick).toHaveBeenCalledTimes(3)
    on.unmount()
  })

  it('pauses entirely while hidden, ticks immediately on return', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    renderHook(() => useLiveTicks(true, tick))
    act(() => { setHidden(true) })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(tick).not.toHaveBeenCalled()
    act(() => { setHidden(false) })
    expect(tick).toHaveBeenCalledTimes(1) // immediate catch-up tick
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(tick).toHaveBeenCalledTimes(2) // interval resumed
  })

  it('unmount clears the timer and the listener', () => {
    vi.useFakeTimers()
    const tick = vi.fn()
    const { unmount } = renderHook(() => useLiveTicks(true, tick))
    unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    act(() => { setHidden(true); setHidden(false) })
    expect(tick).not.toHaveBeenCalled()
  })

  it('always calls the LATEST callback, not a stale closure', () => {
    vi.useFakeTimers()
    const first = vi.fn(); const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useLiveTicks(true, cb), { initialProps: { cb: first } })
    rerender({ cb: second })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
