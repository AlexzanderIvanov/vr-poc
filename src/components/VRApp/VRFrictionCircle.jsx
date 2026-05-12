import React, { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { arcLengthAtTime, timeAtArcLength } from '../../utils/arcLength'

/**
 * Live friction circle (a.k.a. g-g diagram) for the `/vr` route.
 *
 * The friction-circle / traction-circle / g-g diagram is the standard
 * motorsport-engineering view of how much grip a driver is actually
 * using. Each point on the plane is one moment in time:
 *
 *     x = latG  (lateral acceleration, +x = right-hand corner)
 *     y = longG (longitudinal acceleration, +y = throttle, −y = brake)
 *
 * The "circle" is the theoretical tyre-grip limit — a perfectly
 * loaded slick tyre on dry tarmac is roughly a 1.5 g circle. Points
 * outside that circle would be exceeding available friction (slip).
 * Skilled drivers' traces ride the edge of the circle through every
 * corner — that's the visual signal the user is reading.
 *
 * Why a "tail" instead of the whole lap (the user's brief):
 *
 *   Static full-lap g-g diagrams are great for post-session analysis
 *   (offline tools like AIM RaceStudio, MoTeC i2 do this) — you see
 *   the overall envelope. But they're useless for live replay: every
 *   corner overlays every other corner, and there's no way to tell
 *   what the driver is doing RIGHT NOW. The "trail / comet" idiom
 *   (used by live sim-racing dashboards, Assetto Corsa apps, racing
 *   game HUDs) shows just the last few seconds — fresh enough to read
 *   the current cornering style, fading old enough to declutter. Per
 *   the user's brief we show only the past window, not the whole lap.
 *
 * UX details:
 *
 *   • TRAIL_DURATION_S = 3 s   — long enough to read a brake-into-
 *     corner sequence, short enough to stay legible.
 *   • Newest sample is opaque + bigger; oldest fades to alpha 0.
 *   • Reference rings at 0.5 / 1.0 / 1.5 g with small "1g" labels.
 *   • Cross-hair axes through the centre with N/S/E/W word labels
 *     so anyone unfamiliar with the convention can tell what's what.
 *   • One trail per visible lap, in that lap's presentation colour.
 *     For multi-lap replay this is the most informative single
 *     comparison view: at any moment you can see e.g. "ghost is
 *     still braking while ref is back on throttle" — directly on
 *     the same axes the driver feels in the car.
 *
 * Data path:
 *
 *   • `lap.gForces` is pre-computed at load time (`computeGForces`)
 *     as one `{t, longG, latG, gsum}` per sample at 20 Hz. We pluck
 *     the slice `[t − TRAIL_DURATION_S, t]` each animation frame.
 *   • Time-compare mode: ghost trail uses `playhead + lapTimeOffset`
 *     same as `<CarEntity>`. Position-compare mode would need the
 *     same `findTime` lookup, but the friction-circle visual still
 *     reads naturally with time-aligned trails (you see "what was
 *     this car doing at this moment"), so we keep it simple.
 *
 * Rendering: 2-D canvas with a single rAF loop. The trail uses
 * per-segment alpha so we get a smooth gradient — `lineargradient`
 * along a polyline isn't built-in to Canvas2D, so we paint short
 * coloured segments at decreasing alpha. ~60 segments at 3 s × 20 Hz,
 * cheap.
 */

const TRAIL_DURATION_S = 5.07
const G_LIMITS         = 1.6   // axes range; outer ring at this magnitude
const REFERENCE_RINGS  = [0.5, 1.0, 1.5]

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return `rgba(255,255,255,${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/**
 * Lookup index into a sorted-by-t array via binary search.
 * Returns the index of the largest sample with t <= target.
 */
function lowerBoundT(arr, target) {
  let lo = 0, hi = arr.length - 1
  if (target <= arr[0].t) return 0
  if (target >= arr[hi].t) return hi
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].t <= target) lo = mid
    else hi = mid
  }
  return lo
}

export function VRFrictionCircle() {
  const laps          = useStore((s) => s.laps)
  const visibility    = useStore((s) => s.visibility)
  const lapTimeOffset = useStore((s) => s.lapTimeOffset)
  const compareMode   = useStore((s) => s.compareMode)
  const lapColors     = useLapColorMap()

  const canvasRef = useRef(null)

  // Resize handler — keeps canvas backing-store in sync with CSS
  // dimensions (DPR-aware so HiDPI screens stay crisp).
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return undefined
    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      const rect = c.getBoundingClientRect()
      c.width  = Math.max(1, Math.floor(rect.width  * dpr))
      c.height = Math.max(1, Math.floor(rect.height * dpr))
      c.style.width = `${rect.width}px`
      c.style.height = `${rect.height}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  // Animation loop — repaints on every frame so the head dot moves
  // smoothly with the 3D scene. Reads `playheadRef.current` directly
  // (not the 15 Hz React mirror) for the same reason every other
  // hot-path overlay in the app does.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return undefined
    const ctx = c.getContext('2d')
    if (!ctx) return undefined
    const dpr = window.devicePixelRatio || 1
    let alive = true
    let rafId = 0

    const tick = () => {
      if (!alive) return
      const w = c.width / dpr
      const h = c.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const cx = w / 2
      const cy = h / 2
      // 14 px padding so labels at the edges aren't clipped.
      const radius = Math.max(0, Math.min(w, h) / 2 - 14)
      const scale = radius / G_LIMITS

      drawGrid(ctx, cx, cy, radius, scale)

      const t = useStore.getState().playheadRef.current
      // Position-compare alignment: in position mode, the ghost trail
      // should reflect g-forces at the same PHYSICAL TRACK POSITION
      // as the ref car right now — not the same elapsed-time clock.
      // Compute the ref-lap's arc length at the current playhead once;
      // each ghost then looks up "what time was I at THAT same arc
      // length?" via its own `timeAtArcLength`. Falls back to plain
      // time-alignment (with optional `lapTimeOffset` sync) when the
      // mode is `'time'` or when ref samples aren't loaded yet.
      const byDistance = compareMode === 'position'
      const refLap = laps.find((l) => !l.ghost && visibility[l.id] !== false)
        ?? laps.find((l) => visibility[l.id] !== false)
      const refDist = (byDistance && refLap?.samples?.length)
        ? arcLengthAtTime(refLap.samples, t)
        : null
      for (const lap of laps) {
        if (visibility[lap.id] === false) continue
        if (!lap.gForces?.length) continue
        let live
        if (lap.ghost && refDist != null && lap.samples?.length) {
          live = timeAtArcLength(lap.samples, refDist)
        } else {
          const off = lap.ghost ? (lapTimeOffset ?? 0) : 0
          live = t + off
        }
        drawTrail(ctx, cx, cy, scale, lap.gForces, live, lapColors[lap.id] || '#ffffff')
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(rafId) }
  }, [laps, visibility, lapTimeOffset, compareMode, lapColors])

  return (
    <div className="vr-friction-circle">
      <canvas ref={canvasRef} />
    </div>
  )
}

function drawGrid(ctx, cx, cy, radius, scale) {
  if (radius <= 0) return
  ctx.save()
  // Reference rings.
  ctx.lineWidth = 1
  ctx.setLineDash([2, 3])
  for (const g of REFERENCE_RINGS) {
    const r = g * scale
    if (r > radius + 1) continue
    ctx.strokeStyle = g >= 1 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.setLineDash([])
  // Outer envelope.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
  // Cross-hair axes.
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

  // Axis word labels — small monospace, dim grey. Help anyone
  // unfamiliar with the g-g convention read the chart at a glance.
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.fillStyle = 'rgba(255,255,255,0.50)'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText('ACCEL', cx, cy - radius - 8)
  ctx.fillText('BRAKE', cx, cy + radius + 8)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('RIGHT', cx + radius + 4, cy)
  ctx.textAlign = 'right'
  ctx.fillText('LEFT', cx - radius - 4, cy)

  // (Ring magnitude labels intentionally omitted — the dashed
  // reference rings already convey the magnitude scale visually, and
  // the labels were cluttering the small-canvas mobile HUD.)
  ctx.restore()
}

function drawTrail(ctx, cx, cy, scale, gForces, currentT, colorHex) {
  const n = gForces.length
  if (n < 2) return
  // Walk back from currentT through the last TRAIL_DURATION_S
  // seconds. `lowerBoundT` finds the right edge so we don't scan
  // the whole array each frame.
  const endIdx = lowerBoundT(gForces, currentT)
  const startT = currentT - TRAIL_DURATION_S

  // Collect points (limited to the visible window).
  // For TRAIL_DURATION_S=3 at 20 Hz that's ~60 samples — cheap.
  const points = []
  for (let i = endIdx; i >= 0; i--) {
    const g = gForces[i]
    if (g.t < startT) break
    points.push(g)
  }
  if (points.length < 2) return
  // Reverse so points[0] is oldest, last is newest.
  points.reverse()

  // Paint per-segment with linear alpha across the trail length.
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    // Age of the newer end of this segment, 0..1 (0 = current).
    const age = (currentT - b.t) / TRAIL_DURATION_S
    const alpha = Math.max(0.04, 1 - age)
    ctx.strokeStyle = hexToRgba(colorHex, alpha)
    ctx.beginPath()
    ctx.moveTo(cx + a.latG * scale, cy - a.longG * scale)
    ctx.lineTo(cx + b.latG * scale, cy - b.longG * scale)
    ctx.stroke()
  }

  // Head dot — opaque, dark outline for contrast against the trail.
  const head = points[points.length - 1]
  const hx = cx + head.latG * scale
  const hy = cy - head.longG * scale
  ctx.fillStyle = colorHex
  ctx.beginPath()
  ctx.arc(hx, hy, 4.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.65)'
  ctx.lineWidth = 1
  ctx.stroke()
}
