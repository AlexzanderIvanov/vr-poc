import { useEffect, useRef } from 'react'

/**
 * Playback loop driven by requestAnimationFrame.
 *
 * Two-tier time storage:
 *
 * * ``currentTimeRef`` (authoritative, updated **every** RAF frame) — read by
 *   the 3D hot path (``CarEntity`` / ``CameraRig`` useFrame) so the render
 *   follows the true playback clock at display FPS with no React overhead.
 * * ``setCurrentTime`` React state — updated at ``uiUpdateHz`` (default 15 Hz)
 *   so charts, scrubbers and HUD numeric readouts reflect the clock without
 *   triggering a reconciliation on every animation frame. 15 Hz is
 *   imperceptible for digit readouts but reduces React re-render pressure by
 *   ~4×, which is the biggest single contributor to subjective jitter on the
 *   mobile path.
 *
 * Callers still write via ``setCurrentTime`` (sector jumps, scrubber drags)
 * — App wraps it so it mirrors into ``currentTimeRef`` synchronously, so the
 * hot path stays in step with any external edit.
 *
 * Optionally auto-stops when ``sectorEndRef.current`` is reached (sector jump
 * mode). The sectorEnd is read from a ref to avoid re-creating the effect on
 * every change and to avoid stale-closure bugs on rapid sector clicks.
 */
export function usePlayback({
  playing, speed, duration,
  currentTimeRef,
  setCurrentTime,
  setPlaying,
  sectorEndRef,
  uiUpdateHz = 15,
}) {
  const rafRef = useRef(0)

  useEffect(() => {
    if (!playing || duration <= 0) return undefined

    let previous = performance.now()
    let lastUi = previous
    const uiInterval = 1000 / uiUpdateHz
    let stopped = false

    const tick = (now) => {
      if (stopped) return
      const delta = (now - previous) / 1000
      previous = now

      let next = currentTimeRef.current + delta * speed
      const endT = sectorEndRef?.current
      if (endT != null && next >= endT) {
        currentTimeRef.current = endT
        setCurrentTime(endT)
        stopped = true
        if (sectorEndRef) sectorEndRef.current = null
        requestAnimationFrame(() => setPlaying(false))
        return
      }
      if (next > duration) next = next % duration

      // Hot path: ref updated every frame so the 3D animation is at display FPS.
      currentTimeRef.current = next

      // UI path: throttled React state update so scrubber / charts / HUD
      // numerics tick at ~15 Hz instead of per-frame.
      if (now - lastUi >= uiInterval) {
        lastUi = now
        setCurrentTime(next)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      // On stop, flush the final ref value into state so the UI isn't left
      // a frame behind the last-known position.
      setCurrentTime(currentTimeRef.current)
    }
  }, [playing, speed, duration, currentTimeRef, setCurrentTime, setPlaying, sectorEndRef, uiUpdateHz])
}
