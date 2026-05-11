import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * Playback lifecycle hook — kept as a thin shim for backward compatibility
 * with `useAppInit` callers.
 *
 * The actual frame-by-frame advance now lives inside the Canvas in
 * `<PlaybackClock />` (priority −100 `useFrame`), which gives the scene
 * and the playhead a single shared clock. See `PlaybackClock.jsx` for the
 * rationale.
 *
 * The only remaining responsibility is flushing `playheadRef.current` into
 * React state when playback pauses, so any subscriber that was reading the
 * throttled 15 Hz mirror finishes on the exact final time the user stopped
 * at (rather than ~67 ms behind).
 */
export function usePlayback() {
  const playing = useStore((s) => s.playing)

  useEffect(() => {
    if (playing) return undefined
    // Just paused — flush the latest hot-path time so UI subscribers settle
    // on the precise stop frame.
    const { playheadRef } = useStore.getState()
    useStore.setState({ playhead: playheadRef.current })
    return undefined
  }, [playing])
}
