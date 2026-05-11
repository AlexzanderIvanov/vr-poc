import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../../state/store'

/**
 * Single-clock playback driver — advances `playheadRef.current` inside the
 * Canvas via `useFrame`, with priority `-100` so it runs BEFORE every other
 * `useFrame` callback (CarEntity, CameraRig, …). That guarantees the scene
 * always reads the freshest playhead in the same animation frame the time
 * was advanced — no two-RAF race, no one-frame stutter when the OS happens
 * to dispatch RAF callbacks in a different order.
 *
 * Why not the old external RAF? Two `requestAnimationFrame` callbacks
 * (`usePlayback`'s loop and r3f's loop) both fire on the same browser RAF
 * tick, but their relative order is determined by registration order and
 * isn't guaranteed across React re-mounts (route changes, layout-preset
 * swaps). When r3f's loop happens to run first, `CarEntity.useFrame` reads
 * the previous frame's playhead and the next frame jumps by 2·Δt — a 33 ms
 * visible discontinuity at 60 fps. Living inside `useFrame` makes that
 * race structurally impossible.
 *
 * The 15 Hz throttled `playhead` state mirror (drives the scrubber label,
 * chart playhead, HUD numerics) is fired from the same callback — also
 * inside r3f's frame, so React renders are scheduled in lockstep with the
 * GPU frame rather than racing it.
 */
const UI_INTERVAL_S = 1 / 15

export function PlaybackClock() {
  const uiAccumRef = useRef(0)

  useFrame((_, delta) => {
    const s = useStore.getState()
    if (!s.playing || s.duration <= 0) return

    const playheadRef = s.playheadRef
    const sectorEndRef = s.sectorEndRef

    let next = playheadRef.current + delta * s.speed

    // Sector-end one-shot — stop playback exactly at the boundary.
    const endT = sectorEndRef.current
    if (endT != null && next >= endT) {
      playheadRef.current = endT
      useStore.setState({ playhead: endT })
      sectorEndRef.current = null
      s.setPlaying(false)
      uiAccumRef.current = 0
      return
    }

    if (next > s.duration) next = next % s.duration
    playheadRef.current = next

    // Throttled React-state mirror — anything that subscribes via
    // `useStore(s => s.playhead)` updates at ~15 Hz instead of 60 Hz.
    uiAccumRef.current += delta
    if (uiAccumRef.current >= UI_INTERVAL_S) {
      uiAccumRef.current = 0
      useStore.setState({ playhead: next })
    }
  }, -100)

  return null
}
