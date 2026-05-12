import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { TrackMap } from '../TrackMap/TrackMap'

/**
 * Zoomable track-map overlay for the `/vr` layout.
 *
 * Wraps the regular `<TrackMap>` and gives it a user-controllable
 * `worldBounds` rectangle — wheel scrolls in/out around the cursor,
 * drag pans, double-click resets.
 *
 * Time-range sync: every time the visible world rectangle changes, we
 * find which lap samples fall inside it and call `setViewport` on the
 * store with their `[min t, max t]`. That feeds straight into the
 * existing chart dataZoom mirror in `useEchartsTimeSync` — so zooming
 * the map narrows the charts to the corresponding time window without
 * any extra wiring.
 *
 * Reset behaviour: double-click clears the zoom (back to full-track
 * view) and calls `resetViewport` so the charts return to showing the
 * full lap. Same shortcut the chart panels use.
 */

const MIN_BOUND_RANGE_M = 30   // never zoom in tighter than 30 m of track
const ZOOM_STEP = 1.18         // per wheel tick (multiplicative)

function fullBounds(samples) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const s of samples) {
    if (s.position[0] < minX) minX = s.position[0]
    if (s.position[0] > maxX) maxX = s.position[0]
    if (s.position[2] < minZ) minZ = s.position[2]
    if (s.position[2] > maxZ) maxZ = s.position[2]
  }
  // Square-pad the smaller axis so the map preserves aspect at full zoom.
  const rangeX = maxX - minX, rangeZ = maxZ - minZ
  const side = Math.max(rangeX, rangeZ) * 1.05
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
  return {
    minX: cx - side / 2, maxX: cx + side / 2,
    minZ: cz - side / 2, maxZ: cz + side / 2,
  }
}

/**
 * Find the longest contiguous run of samples whose XZ falls inside the
 * world rectangle, return its `[tStart, tEnd]`. Returns `null` if no
 * samples are visible.
 *
 * Why longest-contiguous instead of plain `min/max t`: at extreme zoom-
 * out, both start-of-lap and end-of-lap samples can sit inside the
 * rectangle simultaneously (the track is a closed loop and the
 * recording ends near where it starts). Plain min/max would then span
 * the whole lap and the charts would auto-zoom to the full range,
 * defeating the user's intent. Longest-contiguous picks the natural
 * region under the cursor.
 */
function visibleTimeRange(samples, bounds) {
  if (!samples?.length) return null
  let bestStart = -1, bestEnd = -1, bestLen = 0
  let runStart = -1
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i].position[0], z = samples[i].position[2]
    const inside = x >= bounds.minX && x <= bounds.maxX
                && z >= bounds.minZ && z <= bounds.maxZ
    if (inside) {
      if (runStart < 0) runStart = i
    } else if (runStart >= 0) {
      const len = i - runStart
      if (len > bestLen) { bestLen = len; bestStart = runStart; bestEnd = i - 1 }
      runStart = -1
    }
  }
  if (runStart >= 0) {
    const len = samples.length - runStart
    if (len > bestLen) { bestLen = len; bestStart = runStart; bestEnd = samples.length - 1 }
  }
  if (bestLen < 2) return null
  return { tStart: samples[bestStart].t, tEnd: samples[bestEnd].t }
}

export function VRTrackMap() {
  const laps           = useStore((s) => s.laps)
  const deltaData      = useStore((s) => s.deltaData)
  const playhead       = useStore((s) => s.playhead)
  const duration       = useStore((s) => s.duration)
  const selectedSector = useStore((s) => s.selectedSector)
  const viewport       = useStore((s) => s.viewport)
  const setPlayhead         = useStore((s) => s.setPlayhead)
  const setLapTimeOffset    = useStore((s) => s.setLapTimeOffset)
  const setSectorStartTime  = useStore((s) => s.setSectorStartTime)
  const setSelectedSector   = useStore((s) => s.setSelectedSector)
  const setViewport         = useStore((s) => s.setViewport)
  const resetViewport       = useStore((s) => s.resetViewport)

  // Default (fully zoomed-out) world bounds — recomputed only when the
  // lap data itself changes, so panning / zooming doesn't re-fit.
  const defaultBounds = useMemo(() => {
    const samples = laps[0]?.samples
    if (!samples?.length) return null
    return fullBounds(samples)
  }, [laps])

  const [bounds, setBounds] = useState(defaultBounds)
  // Re-sync on lap change so we never hold stale bounds.
  useEffect(() => { setBounds(defaultBounds) }, [defaultBounds])

  const containerRef = useRef(null)
  const draggingRef = useRef(null)

  // Compute and push the time range whenever bounds change.
  useEffect(() => {
    if (!bounds || !laps[0]?.samples?.length) return
    const range = visibleTimeRange(laps[0].samples, bounds)
    if (!range) return
    // If the bounds are essentially the full track, restore the full
    // lap viewport so the charts read 0..duration cleanly.
    const isFull = defaultBounds
      && Math.abs(bounds.minX - defaultBounds.minX) < 1
      && Math.abs(bounds.maxX - defaultBounds.maxX) < 1
      && Math.abs(bounds.minZ - defaultBounds.minZ) < 1
      && Math.abs(bounds.maxZ - defaultBounds.maxZ) < 1
    if (isFull) {
      resetViewport()
    } else {
      setViewport(range)
    }
  }, [bounds, laps, defaultBounds, setViewport, resetViewport])

  // Cursor pixel → world XZ (uses current bounds and container rect).
  const pixelToWorld = useCallback((px, py) => {
    const el = containerRef.current
    if (!el || !bounds) return null
    const rect = el.getBoundingClientRect()
    const W = rect.width, H = rect.height
    const PADDING = 16
    const rangeX = bounds.maxX - bounds.minX || 1
    const rangeZ = bounds.maxZ - bounds.minZ || 1
    const scale = Math.min((W - 2 * PADDING) / rangeX, (H - 2 * PADDING) / rangeZ)
    const offX = (W - rangeX * scale) / 2, offZ = (H - rangeZ * scale) / 2
    const worldX = bounds.minX + (px - rect.left - offX) / scale
    const worldZ = bounds.minZ + (py - rect.top  - offZ) / scale
    return { worldX, worldZ }
  }, [bounds])

  // Zoom around the cursor — keeps the cursor pinned to the same
  // world point throughout the zoom.
  const onWheel = useCallback((e) => {
    if (!bounds) return
    e.preventDefault()
    const pivot = pixelToWorld(e.clientX, e.clientY)
    if (!pivot) return
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const rangeX = (bounds.maxX - bounds.minX) * factor
    const rangeZ = (bounds.maxZ - bounds.minZ) * factor
    // Clamp: don't zoom in past `MIN_BOUND_RANGE_M`, don't zoom out
    // past the default (full-track) bounds.
    if (defaultBounds) {
      const maxRangeX = defaultBounds.maxX - defaultBounds.minX
      const maxRangeZ = defaultBounds.maxZ - defaultBounds.minZ
      if (rangeX > maxRangeX && rangeZ > maxRangeZ) {
        setBounds(defaultBounds)
        return
      }
    }
    if (rangeX < MIN_BOUND_RANGE_M && rangeZ < MIN_BOUND_RANGE_M) return

    // Compute new bounds so `pivot` keeps the same screen position.
    const el = containerRef.current
    const rect = el.getBoundingClientRect()
    const W = rect.width, H = rect.height
    const PADDING = 16
    const scale = Math.min((W - 2 * PADDING) / rangeX, (H - 2 * PADDING) / rangeZ)
    const offX = (W - rangeX * scale) / 2, offZ = (H - rangeZ * scale) / 2
    const cursorPx = e.clientX - rect.left, cursorPy = e.clientY - rect.top
    const newMinX = pivot.worldX - (cursorPx - offX) / scale
    const newMinZ = pivot.worldZ - (cursorPy - offZ) / scale
    setBounds({
      minX: newMinX, maxX: newMinX + rangeX,
      minZ: newMinZ, maxZ: newMinZ + rangeZ,
    })
  }, [bounds, pixelToWorld, defaultBounds])

  // Drag-to-pan in screen pixels; translate cursor delta into world Δ.
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    if (!bounds) return
    const el = containerRef.current
    const rect = el.getBoundingClientRect()
    const W = rect.width, H = rect.height
    const PADDING = 16
    const rangeX = bounds.maxX - bounds.minX
    const rangeZ = bounds.maxZ - bounds.minZ
    const scale = Math.min((W - 2 * PADDING) / rangeX, (H - 2 * PADDING) / rangeZ)
    draggingRef.current = {
      startX: e.clientX, startY: e.clientY,
      startBounds: bounds,
      worldPerPx: 1 / scale,
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {}
  }, [bounds])

  const onPointerMove = useCallback((e) => {
    const d = draggingRef.current
    if (!d) return
    const dx = (e.clientX - d.startX) * d.worldPerPx
    const dy = (e.clientY - d.startY) * d.worldPerPx
    setBounds({
      minX: d.startBounds.minX - dx, maxX: d.startBounds.maxX - dx,
      minZ: d.startBounds.minZ - dy, maxZ: d.startBounds.maxZ - dy,
    })
  }, [])

  const onPointerUp = useCallback((e) => {
    draggingRef.current = null
    try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch {}
  }, [])

  const onDoubleClick = useCallback(() => {
    if (defaultBounds) setBounds(defaultBounds)
  }, [defaultBounds])

  // Re-use the existing sector-click handler from the panel (jumps
  // playhead + zooms the time viewport to the sector).
  const onSectorClick = useCallback((sector) => {
    const isAlreadySelected = sector.number === useStore.getState().selectedSector
    if (isAlreadySelected) {
      setSelectedSector(null)
      setSectorStartTime(null)
      resetViewport()
      setBounds(defaultBounds)
      return
    }
    setPlayhead(sector.t1Start)
    setLapTimeOffset(sector.t2Start - sector.t1Start)
    setSectorStartTime(sector.t1Start)
    setSelectedSector(sector.number)
    setViewport({ tStart: sector.t1Start, tEnd: sector.t1End })
  }, [setPlayhead, setLapTimeOffset, setSectorStartTime, setSelectedSector, setViewport, resetViewport, defaultBounds])

  return (
    <div
      ref={containerRef}
      className="vr-trackmap panel-trackmap"
      style={{ touchAction: 'none' }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <TrackMap
        deltaData={deltaData}
        currentTime={playhead}
        duration={duration}
        laps={laps}
        selectedSectorNumber={selectedSector}
        viewport={viewport}
        onSectorClick={onSectorClick}
        minimal
        worldBounds={bounds}
      />
    </div>
  )
}
