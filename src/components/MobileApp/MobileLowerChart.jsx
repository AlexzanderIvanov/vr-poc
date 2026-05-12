import React, { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { arcLengthAtTime, timeAtArcLength } from '../../utils/arcLength'
import { CHART_COLORS } from '../../constants'

/**
 * RaceBox-style scrolling speed chart, pinned to the bottom of the
 * mobile 3D view.
 *
 *   • Visible window is 30 s centred on the playhead. The playhead is
 *     rendered as a dashed vertical line at the chart's horizontal
 *     CENTER. Data slides UNDER the line as playback advances — like
 *     the strip-chart of a chart recorder or the RaceBox live view.
 *
 *   • At t=0, the left half of the chart is empty (no past data) and
 *     the right half shows the upcoming lap from t=0 to t=15 s. As
 *     playback proceeds, the data scrolls leftward.
 *
 *       ┌──────────────────────────┐
 *       │ km/h   ╱╲╱╲   ╱╲    ╱╲   │  ref lap = solid,
 *       │  ╱──╱       ╲╱  ╲──╱     │  ghost lap = dashed
 *       │             ┊             │
 *       └──────────────────────────┘
 *                playhead = dashed ┊
 *
 *     (The lap-delta time used to plot here too; it moved to the
 *      red/green delta badge above the ref car in the 3D scene.)
 *
 *   • Compare-mode toggle (top-right pill) flips between TIME and
 *     POSITION. The chart's x-axis stays in time either way; in
 *     position mode the GHOST trace is re-aligned so each ghost
 *     sample is plotted at the ref-time when the ref was at the same
 *     track position — racebox-style without changing the axis scale.
 *
 *   • Drag horizontally = scrub (past `DRAG_THRESHOLD_PX`). Below the
 *     threshold the tap bubbles up to MobileApp's tap-to-play/pause.
 *
 * Canvas 2D + rAF — no React state per frame.
 */

const WINDOW_SEC = 30   // ± 15 s visible
const DRAG_THRESHOLD_PX = 4

// Chart vertical bands inside the canvas (as fractions of height).
// Speed fills the whole strip — the delta chart that used to sit at
// the bottom is now represented by the red/green numeric badge above
// the ref car in the 3D scene, so plotting it again here is redundant.
const SPEED_TOP_FRAC    = 0.10
const SPEED_BOTTOM_FRAC = 0.94

export function MobileLowerChart() {
  const laps          = useStore((s) => s.laps)
  const visibility    = useStore((s) => s.visibility)
  const compareMode   = useStore((s) => s.compareMode)
  const setPlayhead   = useStore((s) => s.setPlayhead)
  const setPlaying    = useStore((s) => s.setPlaying)
  const lapColors     = useLapColorMap()

  const visibleLaps = useMemo(
    () => laps.filter((l) => visibility[l.id] !== false),
    [laps, visibility],
  )
  const refLap = visibleLaps.find((l) => !l.ghost) ?? visibleLaps[0]
  const byDistance = compareMode === 'position'

  // Speed max — anchors the y-axis so the line stays inside the band
  // regardless of car class. One scan up-front; cheap.
  const speedMax = useMemo(() => {
    let m = 60
    for (const l of visibleLaps) {
      if (!l.gpsSpeed) continue
      for (let i = 0; i < l.gpsSpeed.length; i++) {
        if (l.gpsSpeed[i][1] > m) m = l.gpsSpeed[i][1]
      }
    }
    // Round up to nearest 50 for tidy gridlines (50, 100, 150, …).
    return Math.ceil((m + 5) / 50) * 50
  }, [visibleLaps])

  // Position-mode ghost re-alignment happens per-sample inside
  // `drawFrame` via `arcLengthAtTime` / `timeAtArcLength` lookups
  // against the ref-lap's cached cum-arc table. Cheap enough at
  // 60 Hz that no memoisation is needed.

  const canvasRef = useRef(null)
  const dragRef = useRef(null)

  // Resize + rAF render loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    let alive = true
    let raf = 0
    const tick = () => {
      if (!alive) return
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawFrame(ctx, w, h, {
        playhead: useStore.getState().playheadRef.current,
        refLap,
        visibleLaps,
        lapColors,
        byDistance,
        speedMax,
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect() }
  }, [refLap, visibleLaps, lapColors, byDistance, speedMax])

  // ── Pointer scrub ──────────────────────────────────────────────
  // pointerdown captures the start state; only after the pointer
  // moves past the drag threshold do we commit to scrub mode and
  // pause playback. Below threshold the event falls through as a
  // tap → mobile-body's tap-to-play handler fires.
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    dragRef.current = {
      startX: e.clientX,
      startPlayhead: useStore.getState().playheadRef.current,
      width: rect.width,
      isDragging: false,
      wasPlaying: false,
      pointerId: e.pointerId,
    }
  }
  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (!d.isDragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
      d.isDragging = true
      d.wasPlaying = useStore.getState().playing
      setPlaying(false)
      try { e.currentTarget.setPointerCapture?.(d.pointerId) } catch {}
    }
    // Drag LEFT means time advances (data slides left). Scale is
    // TIME-based in both modes — the chart edges always correspond
    // to playhead ± WINDOW_SEC/2 (see drawFrame), so dragging across
    // half the chart = WINDOW_SEC/2 seconds regardless of mode.
    // Keeps the touch-feel identical when toggling.
    const dt = -dx * (WINDOW_SEC / d.width)
    const nextPh = Math.max(0, d.startPlayhead + dt)
    setPlayhead(nextPh)
    useStore.getState().sectorEndRef.current = null
  }
  const onPointerUp = (e) => {
    const d = dragRef.current
    if (!d) return
    if (d.isDragging) {
      // Suppress the click that would otherwise fire on pointerup +
      // bubble to mobile-body's tap-to-play handler.
      e.stopPropagation()
      if (d.wasPlaying) setPlaying(true)
    }
    try { e.currentTarget.releasePointerCapture?.(d.pointerId) } catch {}
    dragRef.current = null
  }
  const onClick = (e) => {
    // Tap (no drag) is meant to bubble up to mobile-body for play/
    // pause. Drag completes via pointerup which has already
    // stopPropagation'd — onClick won't fire then (browsers
    // suppress click after a scroll-like pointer sequence on touch),
    // but we keep this here as a safety belt against synthetic
    // click after a drag on desktop browsers.
    if (dragRef.current?.isDragging) e.stopPropagation()
  }

  return (
    <div className="m-lower-chart">
      <canvas
        ref={canvasRef}
        className="m-lower-chart-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
      />
    </div>
  )
}

// ─── Drawing ─────────────────────────────────────────────────────────

/** Render one frame of the scrolling chart. Pure function of state;
 *  re-entered every rAF tick by the loop in `MobileLowerChart`. */
function drawFrame(ctx, w, h, state) {
  const { playhead, refLap, visibleLaps, lapColors,
          byDistance, speedMax } = state

  ctx.clearRect(0, 0, w, h)

  // ── Chart x-axis is always TIME (seconds), window = 30 s ───────
  //
  // The user complained that earlier attempts (matching window in
  // metres via avg speed; piecewise-linear axis from arc-length
  // edges) all caused the x-axis to "change by a mile" or warp
  // visually when toggling modes. The actual UX they want is:
  // toggling compare mode shifts WHICH ghost samples are plotted,
  // NOT what the axis scale is.
  //
  // So the chart x-axis stays in time (always 30 s window centred
  // on playhead). The ref trace is plotted by ref time as before.
  // The GHOST trace gets a different per-sample mapper in position
  // mode: each ghost sample is plotted at the REF time when the ref
  // was at the same track position as the ghost was when that
  // sample was recorded. Same trick the friction circle now uses.
  //
  // Result: ref trace + delta line + x-axis are IDENTICAL between
  // modes. Only the ghost trace's horizontal alignment changes,
  // matching racebox-style position alignment.
  const center = playhead
  const x0 = playhead - WINDOW_SEC / 2
  const x1 = playhead + WINDOW_SEC / 2
  const xToPx = (x) => ((x - x0) / WINDOW_SEC) * w

  // ── Speed band (now fills the whole chart) ─────────────────────
  const speedTop    = h * SPEED_TOP_FRAC
  const speedBottom = h * SPEED_BOTTOM_FRAC
  const speedToY = (v) =>
    speedBottom - (Math.max(0, Math.min(speedMax, v)) / speedMax) * (speedBottom - speedTop)

  // ── Background grid — sparse 50 km/h speed lines ───────────────
  ctx.strokeStyle = CHART_COLORS.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let s = 0; s <= speedMax; s += 50) {
    const y = speedToY(s)
    ctx.moveTo(0, y); ctx.lineTo(w, y)
  }
  ctx.stroke()

  // ── Speed lines (one per visible lap) ──────────────────────────
  //
  // Ref lap: plotted at its own time (identity).
  // Ghost lap: plotted at its own time in TIME mode; in POSITION
  //   mode each sample is mapped to "the REF-time when the ref was
  //   at the same track position as the ghost was when this sample
  //   was recorded" — racebox-style position alignment without
  //   changing the chart's x-axis units.
  for (const lap of visibleLaps) {
    if (!lap.gpsSpeed?.length) continue
    const samples = lap.gpsSpeed
    const positionAlign = byDistance
      && lap.ghost
      && lap.samples?.length
      && refLap?.samples?.length
    const xForSample = positionAlign
      ? (i) => {
          const ghostT = samples[i][0]
          const ghostDist = arcLengthAtTime(lap.samples, ghostT)
          return timeAtArcLength(refLap.samples, ghostDist)
        }
      : (i) => samples[i][0]
    drawSpeedLine(ctx, samples, xForSample, x0, x1, xToPx, speedToY,
      lapColors[lap.id] || '#fff', lap.ghost)
  }

  // ── Center playhead line ───────────────────────────────────────
  const cx = w / 2
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 3])
  ctx.beginPath()
  ctx.moveTo(cx, 0); ctx.lineTo(cx, h)
  ctx.stroke()
  ctx.setLineDash([])

  // ── Static labels ──────────────────────────────────────────────
  ctx.fillStyle = '#8a93a3'
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillText(`${speedMax}`, 4, speedTop + 3)
  ctx.fillText('0',           4, speedBottom - 1)
}

function drawSpeedLine(ctx, samples, xForSample, x0, x1, xToPx, yScale, color, isGhost) {
  // Clip to the visible window in the SAME units the window is in —
  // `x0` / `x1` are seconds in time mode and metres in position mode.
  // `xForSample(i)` is the per-lap converter that already respects
  // the mode, so binary-searching on its output works uniformly.
  // (The previous implementation searched on `samples[i][0]` which
  // is always seconds — empty result in position mode → invisible
  // speed line.)
  const n = samples.length
  if (n < 2) return
  // Lower-bound: first index whose mapped x is >= x0.
  let lo = 0, hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xForSample(mid) < x0) lo = mid + 1
    else hi = mid
  }
  const start = Math.max(0, lo - 1)
  // Upper-bound: first index whose mapped x is > x1.
  lo = 0; hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xForSample(mid) <= x1) lo = mid + 1
    else hi = mid
  }
  const end = Math.min(n, lo + 1)
  if (end - start < 2) return

  ctx.strokeStyle = color
  ctx.lineWidth = isGhost ? 1.0 : 1.6
  if (isGhost) ctx.setLineDash([4, 3])
  ctx.beginPath()
  for (let i = start; i < end; i++) {
    const px = xToPx(xForSample(i))
    const py = yScale(samples[i][1])
    if (i === start) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()
  if (isGhost) ctx.setLineDash([])
}

