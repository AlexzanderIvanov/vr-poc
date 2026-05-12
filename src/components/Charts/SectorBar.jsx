import React, { useCallback, useRef } from 'react'
import { useStore } from '../../state/store'

/**
 * Sector-header strip rendered above every chart by `<ChartShell>`.
 *
 * Mirrors the workflow racing-engineers expect from tools like
 * RaceStudio / MoTeC i2 — a compact horizontal band showing each
 * braking-derived sector as a numbered button. Two gestures:
 *
 *   • Double-click a sector → toggle zoom. If the chart viewport
 *     already matches this sector's `[t1Start, t1End]`, reset to
 *     the full-lap viewport; otherwise zoom in.
 *
 *   • Click-and-drag the bar background → pan the viewport
 *     horizontally. Natural-scroll direction (drag right shows
 *     earlier times), matching the chart's `inside` shift-pan and
 *     the VR timeline's brush.
 *
 * Zoom-aware rendering:
 *   The bar's cells are positioned by `viewport.tStart..tEnd`
 *   (mapped through `xAxisFromTime` so distance-axis charts work
 *   too), NOT by the full-lap range. When the user zooms into a
 *   sector, that sector's cell expands to fill the bar — exactly
 *   the same way the chart x-axis below expands. Sectors entirely
 *   outside the viewport are not rendered; sectors that straddle a
 *   viewport edge are clipped at that edge.
 *
 * Highlighting:
 *   • The cell containing the current playhead → yellow accent.
 *   • The cell the viewport is zoomed-in to → cyan accent + outline.
 *   • Both at once → blended.
 *
 * Hot-path discipline:
 *   No `setPointerCapture` — the drag handlers use window-level
 *   `pointermove` / `pointerup` listeners so the cells under the
 *   cursor keep receiving their own `click` / `dblclick` events
 *   undisturbed. (Pointer capture would re-target pointer events
 *   to the captured element, which Chrome propagates into the
 *   click→click→dblclick chain — silently swallowing the
 *   double-click on the cell.)
 *
 * State touched: `setViewport` / `resetViewport`. No `setPlayhead`
 * or `setSectorStartTime` writes — purely viewport editing. The
 * track-map's sector-click still owns "jump playback to sector
 * start + align ghost"; the two surfaces deliberately don't share
 * semantics.
 */

const DRAG_THRESH_PX  = 3      // pixels before treating a press as a drag
const SECTOR_MATCH_EPS = 0.05  // seconds — viewport-vs-sector equality slop

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function viewportMatchesSector(vp, sector) {
  return Math.abs(vp.tStart - sector.t1Start) < SECTOR_MATCH_EPS
      && Math.abs(vp.tEnd   - sector.t1End)   < SECTOR_MATCH_EPS
}

export function SectorBar({
  xAxisFromTime = (t) => t,
  xMax,
  gridLeft  = 30,
  gridRight = 16,
}) {
  const deltaData     = useStore((s) => s.deltaData)
  const duration      = useStore((s) => s.duration)
  const viewport      = useStore((s) => s.viewport)
  const playhead      = useStore((s) => s.playhead)
  const setViewport   = useStore((s) => s.setViewport)
  const resetViewport = useStore((s) => s.resetViewport)

  const innerRef = useRef(null)

  // Pointerdown starts a drag-to-pan. Listeners attach to `window`
  // (not the bar element + pointer capture) so the cells underneath
  // keep their own `click` / `dblclick` events — pointer capture
  // would redirect the click chain to the capturing element and
  // silently swallow double-clicks on the cells.
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return
    const rect = innerRef.current?.getBoundingClientRect()
    if (!rect) return
    const startX = e.clientX
    const startVp = viewport
    const width = rect.width || 1
    let moved = false
    const move = (ev) => {
      const dxPx = ev.clientX - startX
      if (Math.abs(dxPx) > DRAG_THRESH_PX) moved = true
      if (!moved) return
      // The bar's pixel width represents the VISIBLE viewport range
      // (not the full lap), so 1 px of drag should move the viewport
      // by `vpWidth / barWidth` seconds — the same proportion you'd
      // get dragging the chart's `inside` dataZoom directly.
      const vpWidth = startVp.tEnd - startVp.tStart
      const dt = (dxPx / width) * vpWidth
      // Natural-scroll: drag the data, so dragging RIGHT (dx > 0)
      // shows earlier times → viewport tStart decreases.
      const newStart = clamp(startVp.tStart - dt, 0, Math.max(0, duration - vpWidth))
      setViewport({ tStart: newStart, tEnd: newStart + vpWidth })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [viewport, duration, setViewport])

  const onSectorDoubleClick = useCallback((sector, e) => {
    e.stopPropagation()
    if (viewportMatchesSector(viewport, sector)) {
      resetViewport()
    } else {
      setViewport({ tStart: sector.t1Start, tEnd: sector.t1End })
    }
  }, [viewport, setViewport, resetViewport])

  const sectors = deltaData?.sectors || []
  if (!sectors.length || duration <= 0 || !xMax || xMax <= 0) return null

  // Viewport in chart-x units (identity for time-mode, arc-length for
  // distance-mode). The bar's cells are laid out as fractions of THIS
  // range, not 0..xMax — so zooming the chart visually zooms the bar.
  const xVpStart = xAxisFromTime(viewport.tStart)
  const xVpEnd   = xAxisFromTime(viewport.tEnd)
  const xVpRange = xVpEnd - xVpStart || 1

  return (
    <div className="chart-sector-bar">
      <div
        ref={innerRef}
        className="chart-sector-bar-inner"
        style={{
          marginLeft: gridLeft,
          marginRight: gridRight,
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        title="Drag to pan · double-click a sector to zoom"
      >
        {sectors.map((s) => {
          const sStart = xAxisFromTime(s.t1Start)
          const sEnd   = xAxisFromTime(s.t1End)
          // Skip sectors entirely outside the visible viewport.
          if (sEnd <= xVpStart || sStart >= xVpEnd) return null
          // Clip to viewport so a sector that straddles an edge
          // still has the correct visible portion.
          const clippedStart = Math.max(sStart, xVpStart)
          const clippedEnd   = Math.min(sEnd,   xVpEnd)
          const leftPct  = ((clippedStart - xVpStart) / xVpRange) * 100
          const widthPct = ((clippedEnd - clippedStart) / xVpRange) * 100
          if (widthPct <= 0) return null

          const containsPlayhead = playhead >= s.t1Start && playhead < s.t1End
          const isZoomed = viewportMatchesSector(viewport, s)
          const cls = [
            'chart-sector-bar-cell',
            containsPlayhead ? 'is-current' : '',
            isZoomed ? 'is-zoomed' : '',
          ].join(' ').trim()
          return (
            <div
              key={s.number}
              className={cls}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              onDoubleClick={(ev) => onSectorDoubleClick(s, ev)}
            >
              <span className="chart-sector-bar-num">S{s.number}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
