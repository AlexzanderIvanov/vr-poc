import React, { useCallback, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useRecorder } from '../../hooks/useAppInit'
import { LoadingOverlay } from '../HUD/LoadingOverlay'
import { Viewer3DSlot, PersistentViewer3D } from '../Viewer3D/PersistentViewer3D'
import { Viewer3DErrorBoundary } from '../Viewer3D/Viewer3DErrorBoundary'
import { TelemetryChartPanel } from '../Charts/TelemetryChartEcharts'
import { DeltaChartPanel } from '../Charts/DeltaChartEcharts'
import { VRTrackMap } from './VRTrackMap'
import { VRTimelineControl } from './VRTimelineControl'
import { VRFrictionCircle } from './VRFrictionCircle'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Resizable charts stack — telemetry on top, delta below.
 *
 *   • Left edge of the panel is a vertical grab handle: drag toward
 *     the centre of the screen to widen the stack, drag toward the
 *     right edge to shrink it. Both tiles inside resize together
 *     (their `flex` ratio is preserved), so the stack stays a group.
 *   • Horizontal divider between the two tiles is a row-resize
 *     handle: drag up to give delta more room, drag down to give
 *     telemetry more room.
 *
 * Both handles follow the same "invisible hit zone + cursor-only
 * affordance" pattern as the rest of the layout-resize zones in the
 * app — no visible bar, only `col-resize` / `row-resize` cursors.
 */
function VRChartsStack() {
  const overlayRef = useRef(null)
  const [width, setWidth] = useState(460)
  const [topPct, setTopPct] = useState(75)  // % of stack height for telemetry

  const startResize = useCallback((axis) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const startW = width
    const startTop = topPct
    const overlayRect = overlayRef.current?.getBoundingClientRect()
    const overlayH = overlayRect?.height || 1

    const move = (ev) => {
      if (axis === 'width') {
        // Dragging LEFT (smaller clientX) widens the stack — the
        // panel is anchored to the right edge of the screen.
        const dx = startX - ev.clientX
        // Min 280 (smallest the telemetry chart still reads),
        // max screen-width minus map (336) and a comfortable
        // margin for the 3D scene to remain visible.
        const maxW = Math.max(320, window.innerWidth - 360)
        setWidth(clamp(startW + dx, 280, maxW))
      } else if (axis === 'split') {
        const dy = ev.clientY - startY
        const pct = startTop + (dy / overlayH) * 100
        setTopPct(clamp(pct, 20, 90))
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [width, topPct])

  return (
    <div
      ref={overlayRef}
      className="vr-charts-overlay"
      style={{ width: `${width}px` }}
    >
      {/* Left-edge column-resize handle. Invisible — cursor cue
          only, matching the layout-grid splitters. */}
      <div
        className="vr-charts-resize-w"
        onPointerDown={startResize('width')}
        role="separator"
        aria-orientation="vertical"
      />
      <div
        className="vr-chart-tile vr-chart-tile-telemetry"
        style={{ flex: `${topPct} 1 0` }}
      >
        <TelemetryChartPanel hideSlider />
      </div>
      {/* Row-resize handle between the two tiles. */}
      <div
        className="vr-charts-resize-h"
        onPointerDown={startResize('split')}
        role="separator"
        aria-orientation="horizontal"
      />
      <div
        className="vr-chart-tile vr-chart-tile-delta"
        style={{ flex: `${100 - topPct} 1 0` }}
      >
        <DeltaChartPanel />
      </div>
    </div>
  )
}

/**
 * VR / experimental layout — `/vr` route.
 *
 * Compositionally a single full-screen 3D scene with three transparent
 * overlays floating on top:
 *
 *   • Top-left   — zoomable track-map. Wheel/pinch zooms; drag pans;
 *                  double-click resets. The zoom is wired into the
 *                  store's `viewport` so the charts on the right
 *                  narrow to the time range corresponding to whatever
 *                  region of track is currently visible on the map.
 *   • Top-right  — transparent telemetry + delta charts stacked
 *                  vertically. Pointer events are enabled so the
 *                  existing chart gestures (click-to-seek, drag-zoom,
 *                  shift-pan) still work.
 *   • Bottom     — playback chrome: play/pause + speed + scrubber.
 *
 * Reuses everything from the existing app:
 *
 *   • `<PersistentViewer3D>` + `<Viewer3DSlot>` — same single Canvas
 *     that the desktop / mobile shells use, just positioned over a
 *     full-screen slot here. WebGL context is shared so route swaps
 *     between `/`, `/vr`, etc. don't re-upload track / car GLBs.
 *   • `<TelemetryChartPanel>` / `<DeltaChartPanel>` — same components,
 *     wrapped in a `.vr-charts` CSS box that swaps the panel-frame
 *     background to transparent without touching the chart internals.
 *   • `<TrackMap>` — same renderer, wrapped by `<VRTrackMap>` which
 *     adds the wheel-zoom + pan UX and the map↔viewport sync.
 *
 * Nothing in this layout requires React Router — `<App>` already
 * branches on `window.location.pathname`, so adding a route is a
 * single `else if` plus a manifest mapping in `MockBackendAdapter`.
 */
export function VRApp() {
  const playing = useStore((s) => s.playing)
  const speed   = useStore((s) => s.speed)
  const setPlaying = useStore((s) => s.setPlaying)
  const setSpeed   = useStore((s) => s.setSpeed)
  const { recording, toggle: toggleRecording } = useRecorder()

  return (
    <div className="vr-shell">
      {/* Full-screen slot the persistent 3D viewer follows. */}
      <div className="vr-viewer-slot">
        <Viewer3DSlot />
      </div>
      <LoadingOverlay />

      {/* Top-left overlay: zoomable track map. */}
      <div className="vr-map-overlay">
        <VRTrackMap />
      </div>

      {/* Under the map: live friction-circle / g-g diagram with a
          short fading trail of the past 3 seconds. Time-aligned per
          lap (ghost trail uses the same lapTimeOffset as the 3D
          ghost car), so the two head dots show "what each car was
          doing at this moment" on the same axes. */}
      <div className="vr-friction-overlay">
        <VRFrictionCircle />
      </div>

      {/* Right-edge overlay: resizable telemetry stack. Left edge
          drags to set width, divider between the two tiles drags to
          set their vertical split. `hideSlider` drops the in-chart
          dataZoom slider — the bottom `<VRTimelineControl>` now owns
          viewport editing. The chart's `inside` dataZoom (wheel +
          drag-to-zoom) stays so chart-body gestures keep working. */}
      <VRChartsStack />

      {/* Bottom playback chrome — buttons on the left, unified
          timeline control on the right. The timeline handles BOTH
          playhead scrubbing and viewport window editing. */}
      <div className="vr-playback-bar">
        <div className="vr-pb-controls">
          <button className="vr-pb-btn" onClick={() => setPlaying((v) => !v)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <label className="vr-pb-speed">
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={2}>2x</option>
            </select>
          </label>
          <button className={`vr-pb-btn ${recording ? 'is-rec' : ''}`} onClick={toggleRecording}>
            {recording ? '■ Stop' : '● Rec'}
          </button>
        </div>
        <VRTimelineControl />
      </div>

      {/* Persistent 3D Canvas — same single-Canvas pattern the rest
          of the app uses. Error-bounded so a drei asset failure can't
          unmount the rest of the VR shell. */}
      <Viewer3DErrorBoundary>
        <PersistentViewer3D />
      </Viewer3DErrorBoundary>
    </div>
  )
}
