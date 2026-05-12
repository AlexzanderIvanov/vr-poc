import React, { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../../state/store'

/**
 * Merged timeline control for the `/vr` route.
 *
 * Replaces (a) the standalone `<TimeScrubber>` at the bottom of the
 * playback bar AND (b) the in-chart `dataZoom slider` that the
 * telemetry chart used to draw beneath itself. Both concerns —
 * playhead position and chart viewport window — share one strip
 * of UI here.
 *
 * UX (industry-standard "range + playhead" pattern — DAWs, NLEs,
 * Excel timeline pivots, Google Maps timeline):
 *
 *   • Full strip = lap duration. Two corner labels show `0:00` and
 *     the final lap time.
 *   • A translucent "window" rectangle shows the current chart
 *     viewport `[tStart, tEnd]`. Grab its edges to resize, grab the
 *     middle to pan.
 *   • A vertical playhead marker sits over the strip at the current
 *     time. Drag it to seek. Marker can be inside OR outside the
 *     viewport — outside, the user can still scrub; the chart simply
 *     keeps showing its windowed range.
 *   • Click anywhere on the strip background = seek to that time.
 *   • Wheel anywhere on the strip = zoom the viewport in / out
 *     around the cursor.
 *   • Double-click outside the window = reset viewport to full lap.
 *
 * Sync model:
 *
 *   • Writes go through `setPlayhead` / `setViewport` — the same
 *     store actions the rest of the app uses. The chart's `inside`
 *     dataZoom (wheel / shift-pan / drag-to-zoom on the chart body)
 *     and the `<VRTrackMap>` wheel-zoom emit `setViewport` calls too,
 *     so this control's window auto-updates when the user manipulates
 *     either the chart or the map.
 *   • The playhead marker reads `playheadRef.current` directly via
 *     RAF — matches the chart playhead overlay's smoothness and
 *     avoids React reconciliation at 60 fps. The window edges only
 *     move on user interaction, so they're plain React state.
 *
 * Why not just expand the existing `<TimeScrubber>` to handle range
 * too: TimeScrubber is a thin wrapper around `<input type="range">`,
 * which has one thumb. Adding a window requires composing three
 * draggable elements (left handle, right handle, body) over a track,
 * which doesn't fit the native range-input model. Custom SVG / div
 * is the right tool.
 */

const MIN_WINDOW_S = 0.5      // smallest viewport width the user can drag to
const ZOOM_STEP = 1.18         // wheel zoom multiplier per tick
const HANDLE_HIT_PX = 12       // handle grab width (CSS visual is narrower)

function fmtT(t) {
  if (!isFinite(t) || t < 0) return '0:00.00'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

export function VRTimelineControl() {
  const duration       = useStore((s) => s.duration)
  const playhead       = useStore((s) => s.playhead)
  const viewport       = useStore((s) => s.viewport)
  const setPlayhead    = useStore((s) => s.setPlayhead)
  const setViewport    = useStore((s) => s.setViewport)
  const resetViewport  = useStore((s) => s.resetViewport)

  const trackRef         = useRef(null)
  const playheadMarkerRef = useRef(null)
  const playheadLabelRef  = useRef(null)
  const dragStateRef     = useRef(null)

  // Smooth playhead marker — reads `playheadRef.current` once per
  // animation frame and writes `style.left` directly. No React
  // reconciliation while the playhead is moving; the marker tracks the
  // 3D scene's hot-path clock instead of the 15 Hz React mirror.
  useEffect(() => {
    if (duration <= 0) return undefined
    let alive = true
    let rafId = 0
    let lastPct = -1
    const tick = () => {
      if (!alive) return
      const t = useStore.getState().playheadRef.current
      const pct = clamp((t / duration) * 100, 0, 100)
      if (Math.abs(pct - lastPct) > 0.02) {
        const m = playheadMarkerRef.current
        if (m) m.style.left = `${pct.toFixed(3)}%`
        const lbl = playheadLabelRef.current
        if (lbl) lbl.textContent = fmtT(t)
        lastPct = pct
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(rafId) }
  }, [duration])

  // Pixel → time conversion using the live track rect.
  const pxToTime = useCallback((clientX) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || duration <= 0) return 0
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration)
  }, [duration])

  // Unified drag handler — `kind` picks which thing the cursor is
  // manipulating. Listeners attach to `window` so the gesture
  // doesn't drop when the cursor leaves the strip.
  const startDrag = useCallback((kind, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const rect = trackRef.current.getBoundingClientRect()
    const w = rect.width || 1
    const startX = e.clientX
    const startVp = useStore.getState().viewport
    const startPh = useStore.getState().playheadRef.current

    dragStateRef.current = { kind, startX, w, startVp, startPh }

    const move = (ev) => {
      const dxPx = ev.clientX - startX
      const dx = (dxPx / w) * duration
      const s = dragStateRef.current
      if (!s) return
      if (s.kind === 'playhead') {
        setPlayhead(clamp(s.startPh + dx, 0, duration))
      } else if (s.kind === 'left') {
        const newStart = clamp(s.startVp.tStart + dx, 0, s.startVp.tEnd - MIN_WINDOW_S)
        setViewport({ tStart: newStart, tEnd: s.startVp.tEnd })
      } else if (s.kind === 'right') {
        const newEnd = clamp(s.startVp.tEnd + dx, s.startVp.tStart + MIN_WINDOW_S, duration)
        setViewport({ tStart: s.startVp.tStart, tEnd: newEnd })
      } else if (s.kind === 'window') {
        const wid = s.startVp.tEnd - s.startVp.tStart
        const newStart = clamp(s.startVp.tStart + dx, 0, duration - wid)
        setViewport({ tStart: newStart, tEnd: newStart + wid })
      }
    }
    const up = () => {
      dragStateRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [duration, setPlayhead, setViewport])

  // Background click = seek + (optional) start dragging the playhead.
  // Skip when the target is the window / a handle / the marker —
  // those have their own pointerdown handlers.
  const onTrackPointerDown = useCallback((e) => {
    if (e.target.closest('.vr-timeline-window, .vr-timeline-playhead')) return
    if (e.button !== 0) return
    setPlayhead(pxToTime(e.clientX))
    // Continue into a playhead drag so the user can scrub by holding.
    startDrag('playhead', e)
  }, [pxToTime, setPlayhead, startDrag])

  // Wheel zoom around the cursor (same math as the chart's `inside`
  // dataZoom on wheel). End-to-end consistency: zoom the chart with
  // the wheel, zoom the timeline with the wheel — both update the
  // same `viewport` slice.
  const onWheel = useCallback((e) => {
    if (duration <= 0) return
    e.preventDefault()
    const pivot = pxToTime(e.clientX)
    const factor = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const curStart = viewport.tStart, curEnd = viewport.tEnd
    const curW = (curEnd - curStart) || duration
    const newW = clamp(curW * factor, MIN_WINDOW_S, duration)
    const frac = curW > 0 ? (pivot - curStart) / curW : 0.5
    const newStart = clamp(pivot - frac * newW, 0, duration - newW)
    setViewport({ tStart: newStart, tEnd: newStart + newW })
  }, [duration, viewport.tStart, viewport.tEnd, pxToTime, setViewport])

  const onDoubleClick = useCallback((e) => {
    // Only reset on background double-click (not on the window itself).
    if (e.target.closest('.vr-timeline-window')) return
    resetViewport()
  }, [resetViewport])

  if (duration <= 0) return null

  const winLeft = clamp((viewport.tStart / duration) * 100, 0, 100)
  const winRight = clamp((viewport.tEnd / duration) * 100, 0, 100)
  const winWidth = Math.max(0, winRight - winLeft)

  return (
    <div className="vr-timeline-shell">
      <div className="vr-timeline-meta">
        <span className="vr-tl-meta-label">In</span>
        <span className="vr-tl-meta-val">{fmtT(viewport.tStart)}</span>
        <span className="vr-tl-meta-sep">·</span>
        <span className="vr-tl-meta-label">Now</span>
        <span className="vr-tl-meta-val" ref={playheadLabelRef}>{fmtT(playhead)}</span>
        <span className="vr-tl-meta-sep">·</span>
        <span className="vr-tl-meta-label">Out</span>
        <span className="vr-tl-meta-val">{fmtT(viewport.tEnd)}</span>
        <span className="vr-tl-meta-fill" />
        <span className="vr-tl-meta-label">Lap</span>
        <span className="vr-tl-meta-val">{fmtT(duration)}</span>
      </div>
      <div
        ref={trackRef}
        className="vr-timeline-track"
        onPointerDown={onTrackPointerDown}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        style={{ touchAction: 'none' }}
      >
        {/* Viewport window — translucent box with drag handles on its
            left and right edges. The body acts as a pan handle. */}
        <div
          className="vr-timeline-window"
          style={{ left: `${winLeft}%`, width: `${winWidth}%` }}
          onPointerDown={(e) => startDrag('window', e)}
          title="Drag to pan · grab edges to resize · wheel to zoom"
        >
          <div
            className="vr-timeline-handle vr-timeline-handle-l"
            onPointerDown={(e) => startDrag('left', e)}
            style={{ width: HANDLE_HIT_PX }}
            title="Drag to change viewport start"
          />
          <div
            className="vr-timeline-handle vr-timeline-handle-r"
            onPointerDown={(e) => startDrag('right', e)}
            style={{ width: HANDLE_HIT_PX }}
            title="Drag to change viewport end"
          />
        </div>
        {/* Playhead marker — rendered LAST so it stacks above the
            window when the playhead is inside the viewport. */}
        <div
          ref={playheadMarkerRef}
          className="vr-timeline-playhead"
          onPointerDown={(e) => { e.stopPropagation(); startDrag('playhead', e) }}
          title="Drag to scrub"
        />
      </div>
    </div>
  )
}
