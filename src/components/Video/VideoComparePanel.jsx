import React, { useCallback, useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { buildPositionLookup } from '../../utils/positionLookup'
import { sampleLap } from '../../utils/sampleLap'
import { SingleLapVideo } from './SingleLapVideo'

/**
 * Side-by-side lap-cockpit video compare.
 *
 * Two `<SingleLapVideo>` tiles, one per lap (laps[0] = ref, laps[1] =
 * ghost). Each tile is told what *lap-time-on-its-own-clock* to show at
 * the current playhead, taking the global `compareMode` into account:
 *
 *   - `time` mode: ghost video = `playhead + lapTimeOffset` (the same
 *     offset the 3D ghost car uses; non-zero only during a sector jump).
 *   - `position` mode: ghost video = "what time on the ghost's clock
 *     was the ghost car at the same physical position the ref car is
 *     at right now". Mirror of the 3D viewer's `<CarEntity>` position-
 *     compare logic, but run on the throttled `playhead` state rather
 *     than per-RAF because video sync only needs ~15 Hz accuracy.
 *
 * The position lookup table for the ghost lap is memoised on the lap
 * samples + sync offset so it's only rebuilt when the data changes,
 * not on every render.
 *
 * Layout: a single horizontal flex pair, each tile filling half the
 * panel width. The tiles handle their own loading / mute UI. Lap
 * colour from `useLapColorMap` accents the title strip so users can
 * tell which side is which without reading the label.
 *
 * Reusability: this is the canonical "tile-pair compare" pattern any
 * future panel can crib from. Replace `<SingleLapVideo>` with
 * `<SingleLapXyz>` and the same `liveTimeFor(lap, lapIndex)` helper
 * works for any per-lap visualisation.
 */
export function VideoComparePanel() {
  const laps             = useStore((s) => s.laps)
  const syncOffsets      = useStore((s) => s.syncOffsets)
  const compareMode      = useStore((s) => s.compareMode)
  const lapTimeOffset    = useStore((s) => s.lapTimeOffset)
  const lapColorMap      = useLapColorMap()

  const refLap   = laps[0]
  const ghostLap = laps[1]
  const refSyncOffset   = refLap   ? syncOffsets[refLap.id]   : null
  const ghostSyncOffset = ghostLap ? syncOffsets[ghostLap.id] : null

  // Position lookup for the GHOST lap — used only in position-compare
  // mode to find "what time on ghost's lap was the ghost at this XZ".
  // Same builder the 3D viewer uses for its position-compare ghost car.
  const ghostPosLookup = useMemo(
    () => (ghostLap?.samples?.length && compareMode === 'position'
      ? buildPositionLookup(ghostLap.samples, ghostSyncOffset)
      : null),
    [ghostLap, ghostSyncOffset, compareMode],
  )
  // Cache the last sample index for a small O(1)-amortised hint into
  // the position scan (same idiom as the 3D viewer).
  const ghostPosHintRef = useRef(null)

  // Ref tile: live time on the ref lap. Time mode → playhead. Position
  // mode → also playhead (the playhead IS the ref-lap clock). Sector
  // jumps move the playhead, so this stays in sync automatically.
  const liveTimeRef = useCallback(() => useStore.getState().playhead, [])

  // Ghost tile: per-mode strategy. Re-read the playhead from the store
  // on each call rather than capturing it as a prop — that way the
  // returned function survives across renders and the inner video drift
  // watcher always sees the latest value.
  const liveTimeGhost = useCallback(() => {
    const ph = useStore.getState().playhead
    if (!ghostLap?.samples?.length) return 0
    if (compareMode === 'position' && refLap?.samples?.length && ghostPosLookup) {
      // Find ref's *rendered scene* position at the playhead time, then
      // look up which point on the ghost lap that physical location maps
      // to. `sampleLap` returns the unsynced pose; the position-lookup
      // table already bakes the ghost's sync offset into its xz arrays.
      // For the ref side we need to apply its sync offset too so both
      // sides live in the same "scene" frame.
      const refSample = sampleLap(refLap.samples, ph)
      if (!refSample) return ph + (lapTimeOffset ?? 0)
      // Apply the ref's sync offset in-line. `sampleLap` doesn't take an
      // offset arg, but for a position-compare we only need the
      // ground-plane (x, z) — the offset's forward/left translation is
      // small (<3 m) and barely shifts the position-lookup result, so
      // we use the raw scene xz directly. If precision becomes an issue
      // we can switch to `applySyncOffset` here, same as CarEntity does.
      const { x, z } = refSample.position
      const match = ghostPosLookup.findTime(x, z, ghostPosHintRef.current)
      ghostPosHintRef.current = match.idx
      return match.t
    }
    // Time mode (and position-mode fallback when data isn't ready):
    // mirror the 3D viewer's CarEntity time-offset shift.
    return ph + (lapTimeOffset ?? 0)
  }, [refLap, ghostLap, ghostPosLookup, compareMode, lapTimeOffset])

  // Nothing to show — fall back to a friendly message instead of
  // mounting an empty `<video>` that would just spin forever.
  if (!refLap || !ghostLap) {
    return <div className="panel-empty">Side-by-side video needs two laps</div>
  }
  if (!refLap.video_path && !ghostLap.video_path) {
    return <div className="panel-empty">No videos for these laps</div>
  }

  const refColor   = lapColorMap[refLap.id]
  const ghostColor = lapColorMap[ghostLap.id]

  return (
    <div className="video-compare-panel">
      <div className="video-compare-tile" style={{ borderTopColor: refColor }}>
        <SingleLapVideo
          lap={refLap}
          getLiveTimeSec={liveTimeRef}
          label={refLap.video_label || refLap.label}
        />
      </div>
      <div className="video-compare-tile" style={{ borderTopColor: ghostColor }}>
        <SingleLapVideo
          lap={ghostLap}
          getLiveTimeSec={liveTimeGhost}
          label={ghostLap.video_label || ghostLap.label}
        />
      </div>
    </div>
  )
}
