import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { VRFrictionCircle } from '../VRApp/VRFrictionCircle'
import { TrackMap } from '../TrackMap/TrackMap'
import { sampleLap } from '../../utils/sampleLap'

const CHART_HALF_WINDOW_SEC = 15  // matches MobileLowerChart's WINDOW_SEC/2
const MAP_HALF_EXTENT_M     = 100 // shown half-side (m) of the panning map

// Same cycle order the desktop shortcut + settings sheet use, so tapping
// the camera pill walks through identically.
const CAMERA_MODES = ['chase', 'hood', 'side', 'top', 'free']
const CAMERA_LABEL = {
  chase: 'Chase', hood: 'Hood', side: 'Side', top: 'Top', free: 'Free',
}

const formatLapTime = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

/**
 * Heads-up overlay rendered on the mobile 3D viewer.
 *
 *   ┌──────────────────────────────────┐
 *   │ ┌────────┐          ┌────────┐  │  top-left  : mini track map
 *   │ │  map  │           │  ⊕    │  │  top-right : friction circle
 *   │ │       │           │  ◯    │  │  (same box size, square)
 *   │ └────────┘          └────────┘  │
 *   │                                  │
 *   │           [3D scene]             │  tap = play/pause
 *   │                                  │
 *   │ 1:56.400  [📷 Chase│⏱ Time] 1:57│  bottom toolbar: lap times
 *   │                                  │  in the two corners,
 *   │ ┌────────── chart ─────────────┐│  shortcut pills (camera /
 *   │ │  scrolling speed             │  compare) grouped in middle.
 *   └──────────────────────────────────┘  lap times tinted by lap.
 *
 * `pointer-events: none` on the overlay container; only the two
 * shortcut pills take `auto` (and stop propagation so their taps
 * don't bubble up as a play/pause toggle). Everything else — map,
 * friction circle, lap-time labels — passes pointer events through
 * so tapping the 3D-scene area toggles playback.
 *
 * Same rAF-driven readout pattern as every other live overlay — no
 * React re-renders per frame, just DOM textContent writes.
 */

const fmtSigned1 = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
const fmt2       = (v) => v == null ? '—' : v.toFixed(2)

/** Binary-search + linear-interp lookup of the bracketing g-force
 *  sample at time `t`. Returns all three components in one pass —
 *  cheaper than three `findValueAt` calls. */
function findGForceAt(gForces, t) {
  if (!gForces?.length) return null
  const n = gForces.length
  if (t <= gForces[0].t) return gForces[0]
  if (t >= gForces[n - 1].t) return gForces[n - 1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (gForces[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = gForces[lo], b = gForces[hi]
  if (a.t === b.t) return a
  const u = (t - a.t) / (b.t - a.t)
  return {
    longG: a.longG + (b.longG - a.longG) * u,
    latG:  a.latG  + (b.latG  - a.latG)  * u,
    gsum:  a.gsum  + (b.gsum  - a.gsum)  * u,
  }
}

export function MobileViewerHUD() {
  const laps             = useStore((s) => s.laps)
  const visibility       = useStore((s) => s.visibility)
  const cameraMode       = useStore((s) => s.cameraMode)
  const setCameraMode    = useStore((s) => s.setCameraMode)
  const compareMode      = useStore((s) => s.compareMode)
  const setCompareMode   = useStore((s) => s.setCompareMode)
  const lapColors        = useLapColorMap()

  // Live data the mini-map needs. `playhead` is the React-state mirror
  // updated at ~15 Hz — enough cadence for the visible-window overlay
  // to track the scrolling chart smoothly without redrawing the map
  // every animation frame.
  const playhead         = useStore((s) => s.playhead)
  const duration         = useStore((s) => s.duration)
  const deltaData        = useStore((s) => s.deltaData)
  const selectedSector   = useStore((s) => s.selectedSector)

  // Square world-bounds centred on the ref car's current XZ. Passed
  // to `<TrackMap>` as `worldBounds`, which overrides its default
  // "fit whole track" transform — the map zooms in to show only a
  // ±MAP_HALF_EXTENT_M-metre window around the car. As the playhead
  // advances and the car moves, this re-derives and the visible
  // chunk of track pans accordingly. Same lever the `/vr` route's
  // zoomable map uses.
  const mapBounds = useMemo(() => {
    const ref = laps.find((l) => !l.ghost) ?? laps[0]
    if (!ref?.samples?.length || duration <= 0) return null
    // `sampleLap` returns `position` as a THREE.Vector3 (`.x .y .z`),
    // NOT as a plain `[x, y, z]` array — accessing by index gives
    // undefined, which propagates as NaN through the bounds and
    // makes TrackMap unable to compute a transform.
    const { position } = sampleLap(ref.samples, playhead)
    const cx = position.x, cz = position.z
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null
    return {
      minX: cx - MAP_HALF_EXTENT_M, maxX: cx + MAP_HALF_EXTENT_M,
      minZ: cz - MAP_HALF_EXTENT_M, maxZ: cz + MAP_HALF_EXTENT_M,
    }
  }, [laps, playhead, duration])

  // Rolling window that matches the bottom chart's visible range
  // (`MobileLowerChart` always shows 30 s centred on playhead).
  // Passed to TrackMap as the `viewport` prop so the map dims the
  // out-of-window portion of the track — same visual the desktop
  // chart's dataZoom drives. Kept LOCAL (not pushed to the store's
  // `viewport` slice) so it doesn't fight with sector-clicks that
  // also write that slice.
  const mapViewport = useMemo(() => {
    if (duration <= 0) return null
    return {
      tStart: Math.max(0, playhead - CHART_HALF_WINDOW_SEC),
      tEnd:   Math.min(duration, playhead + CHART_HALF_WINDOW_SEC),
    }
  }, [playhead, duration])

  // Sector-click — same dispatch chain as the desktop `TrackMapPanel`
  // so tapping a sector on the mini-map jumps playback to that
  // sector and sets up the time-offset / sector-state the rest of
  // the app reads. Inlined here because we bypass TrackMapPanel
  // (which reads `viewport` from the store; we need the LOCAL
  // rolling viewport instead).
  const onSectorClick = useCallback((sector) => {
    const s = useStore.getState()
    if (sector.number === s.selectedSector) {
      s.setSelectedSector(null)
      s.setSectorStartTime(null)
      s.resetViewport()
      return
    }
    s.setPlayhead(sector.t1Start)
    s.setLapTimeOffset(sector.t2Start - sector.t1Start)
    s.setSectorStartTime(sector.t1Start)
    s.setSelectedSector(sector.number)
    s.setViewport({ tStart: sector.t1Start, tEnd: sector.t1End })
  }, [])

  const visibleLaps = useMemo(
    () => laps.filter((l) => visibility[l.id] !== false),
    [laps, visibility],
  )
  const refLap   = visibleLaps.find((l) => !l.ghost) ?? visibleLaps[0]
  // First visible ghost for the right-side lap-time label. If only one
  // lap is loaded the right column just doesn't render its time.
  const ghostLap = visibleLaps.find((l) => l.ghost && l.id !== refLap?.id) ?? null
  const byDistance = compareMode === 'position'

  const cycleCamera = (e) => {
    // Stop the tap from bubbling up to mobile-shell's play/pause handler.
    e.stopPropagation()
    const i = CAMERA_MODES.indexOf(cameraMode)
    setCameraMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
  }
  const toggleCompare = (e) => {
    e.stopPropagation()
    setCompareMode(byDistance ? 'time' : 'position')
  }

  const lonRef = useRef(null)
  const latRef = useRef(null)
  const sumRef = useRef(null)

  useEffect(() => {
    let alive = true, raf = 0
    const tick = () => {
      if (!alive) return
      const t = useStore.getState().playheadRef.current
      const g = refLap ? findGForceAt(refLap.gForces, t) : null
      const set = (el, s) => { if (el && el.textContent !== s) el.textContent = s }
      set(lonRef.current, fmtSigned1(g?.longG))
      set(latRef.current, fmtSigned1(g?.latG))
      set(sumRef.current, fmt2(g?.gsum))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [refLap])

  if (!refLap) return null

  return (
    <div className="m-hud-overlay">
      {/* `stopPropagation` so the user can click a sector to
          jump there without ALSO firing the mobile-shell's
          tap-to-play handler. Without this, every map tap would
          toggle playback as well.
          We render `<TrackMap/>` directly (instead of via
          `TrackMapPanel`) so we can pass a LOCAL rolling viewport —
          mirrors the chart's visible 30 s window — instead of the
          store's `viewport` (which sector clicks would overwrite,
          and which the mobile chart never zooms anyway). */}
      <div className="m-hud-map" onClick={(e) => e.stopPropagation()}>
        <TrackMap
          deltaData={deltaData}
          currentTime={playhead}
          duration={duration}
          laps={laps}
          selectedSectorNumber={selectedSector}
          viewport={mapViewport}
          worldBounds={mapBounds}
          onSectorClick={onSectorClick}
          minimal
        />
      </div>

      {/* Bottom toolbar: lap-times in the two corners, shortcut pills
          (camera-cycle + compare-mode) grouped in the middle. The
          lap-time chips wear their own lap colour as border + text;
          the centre group reads as one segmented control. */}
      <div className="m-hud-toolbar">
        {refLap ? (
          <div className="m-hud-lap-time" style={{ color: lapColors[refLap.id] }}>
            {formatLapTime(refLap.duration)}
          </div>
        ) : <span />}
        <div className="m-hud-toolbar-center">
          <button
            type="button"
            className="m-hud-shortcut"
            onClick={cycleCamera}
            aria-label={`Camera ${CAMERA_LABEL[cameraMode] ?? cameraMode} — tap to cycle`}
          >
            📷 {CAMERA_LABEL[cameraMode] ?? cameraMode}
          </button>
          <button
            type="button"
            className="m-hud-shortcut"
            onClick={toggleCompare}
            aria-label="Toggle time / position compare"
          >
            {byDistance ? '📍 Pos' : '⏱ Time'}
          </button>
        </div>
        {ghostLap ? (
          <div className="m-hud-lap-time" style={{ color: lapColors[ghostLap.id] }}>
            {formatLapTime(ghostLap.duration)}
          </div>
        ) : <span />}
      </div>

      <div className="m-hud-gforce">
        <div className="m-hud-gforce-circle">
          <VRFrictionCircle />
        </div>
        <div className="m-hud-gforce-readouts">
          <div className="m-hud-g-row">
            <span className="m-hud-g-key">lon</span>
            <span className="m-hud-g-val" ref={lonRef}>—</span>
          </div>
          <div className="m-hud-g-row">
            <span className="m-hud-g-key">lat</span>
            <span className="m-hud-g-val" ref={latRef}>—</span>
          </div>
          <div className="m-hud-g-row">
            <span className="m-hud-g-key">Σ</span>
            <span className="m-hud-g-val" ref={sumRef}>—</span>
          </div>
        </div>
      </div>
    </div>
  )
}
