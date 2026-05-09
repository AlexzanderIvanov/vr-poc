import React from 'react'
import { useStore } from '../../state/store'

/**
 * Time-scrubber control — label + range slider — mounted twice per page
 * (once mobile, once desktop). Self-subscribes to `playhead` and
 * `duration` so the 15 Hz playhead state push only re-renders THIS small
 * component, not the entire App tree.
 *
 * Variant via `mode`:
 *   - "desktop" → side-panel block with `Time X.XX / Y.YY s` label
 *   - "mobile"  → bottom-fixed bar
 */
export function TimeScrubber({ mode = 'desktop' }) {
  const currentTime = useStore((s) => s.playhead)
  const duration = useStore((s) => s.duration)
  const setPlayhead = useStore((s) => s.setPlayhead)
  const setLapTimeOffset = useStore((s) => s.setLapTimeOffset)
  const setSelectedSector = useStore((s) => s.setSelectedSector)
  const setSectorStartTime = useStore((s) => s.setSectorStartTime)
  const sectorEndRef = useStore((s) => s.sectorEndRef)

  const onChange = (e) => {
    setPlayhead(Number(e.target.value))
    setLapTimeOffset(0)
    sectorEndRef.current = null
    setSelectedSector(null)
    setSectorStartTime(null)
  }

  if (mode === 'mobile') {
    return (
      <div className="mobile-scrubber">
        <div className="mobile-scrubber-time">
          {currentTime.toFixed(2)} / {duration.toFixed(2)}s
        </div>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration)}
          onChange={onChange}
        />
      </div>
    )
  }

  return (
    <div className="hud-section scrubber">
      <label>
        Time {currentTime.toFixed(2)} / {duration.toFixed(2)} s
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration)}
          onChange={onChange}
        />
      </label>
    </div>
  )
}
