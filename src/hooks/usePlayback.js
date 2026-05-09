import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'

/**
 * Playback loop driven by requestAnimationFrame.
 *
 * Reads `playing`, `speed`, `duration` from the store via per-slice selectors;
 * mutates `playheadRef.current` (hot-path) every frame and emits a throttled
 * React-state update (~15 Hz) so charts / HUD numerics tick without a
 * per-frame reconciliation cascade.
 *
 * Sector-end one-shot: if `sectorEndRef.current` is set (sector-jump flow),
 * playback stops at that time and clears the ref.
 */
export function usePlayback({ uiUpdateHz = 15 } = {}) {
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const duration = useStore((s) => s.duration)
  const rafRef = useRef(0)

  useEffect(() => {
    if (!playing || duration <= 0) return undefined

    const playheadRef = useStore.getState().playheadRef
    const sectorEndRef = useStore.getState().sectorEndRef
    const setPlaying = useStore.getState().setPlaying
    const setPlayheadState = (v) => useStore.setState({ playhead: v })

    let previous = performance.now()
    let lastUi = previous
    const uiInterval = 1000 / uiUpdateHz
    let stopped = false

    const tick = (now) => {
      if (stopped) return
      const delta = (now - previous) / 1000
      previous = now

      let next = playheadRef.current + delta * speed

      const endT = sectorEndRef.current
      if (endT != null && next >= endT) {
        playheadRef.current = endT
        setPlayheadState(endT)
        stopped = true
        sectorEndRef.current = null
        requestAnimationFrame(() => setPlaying(false))
        return
      }
      if (next > duration) next = next % duration

      playheadRef.current = next

      if (now - lastUi >= uiInterval) {
        lastUi = now
        setPlayheadState(next)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      // Flush the final ref value into state so the UI isn't a frame behind.
      setPlayheadState(playheadRef.current)
    }
  }, [playing, speed, duration, uiUpdateHz])
}
