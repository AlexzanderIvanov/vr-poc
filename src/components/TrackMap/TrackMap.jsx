import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useContainerSize } from '../../hooks/useContainerSize'

export function TrackMap({ deltaData, currentTime, duration, laps, selectedSectorNumber = null, viewport = null, onSectorClick, minimal = false }) {
  const canvasRef = useRef(null)
  const dotCanvasRef = useRef(null)
  const [hoveredSector, setHoveredSector] = useState(null)
  const transformRef = useRef(null)
  const [containerRef, size] = useContainerSize({ w: 280, h: 280 })

  // Match canvas backing-store to CSS size (with device pixel ratio for crispness).
  // The 2D context transform is applied at draw time so all our coordinates can
  // stay in CSS pixels.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1

  useEffect(() => {
    for (const c of [canvasRef.current, dotCanvasRef.current]) {
      if (!c) continue
      c.width = Math.floor(size.w * dpr)
      c.height = Math.floor(size.h * dpr)
      c.style.width = `${size.w}px`
      c.style.height = `${size.h}px`
    }
  }, [size.w, size.h, dpr])

  const transform = useMemo(() => {
    if (!laps.length || !laps[0]?.samples?.length) return null
    const samples = laps[0].samples
    const W = size.w, H = size.h
    const PADDING = 16
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const s of samples) {
      minX = Math.min(minX, s.position[0]); maxX = Math.max(maxX, s.position[0])
      minZ = Math.min(minZ, s.position[2]); maxZ = Math.max(maxZ, s.position[2])
    }
    const rangeX = maxX - minX || 1, rangeZ = maxZ - minZ || 1
    const scale = Math.min((W - 2 * PADDING) / rangeX, (H - 2 * PADDING) / rangeZ)
    const offX = (W - rangeX * scale) / 2, offZ = (H - rangeZ * scale) / 2
    return { minX, minZ, scale, offX, offZ, W, H, toX: (x) => offX + (x - minX) * scale, toY: (z) => offZ + (z - minZ) * scale }
  }, [laps, size.w, size.h])

  useEffect(() => { transformRef.current = transform }, [transform])

  // Static draw: track outline + sectors + legend.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !transform || !laps[0]?.samples?.length) return
    try {
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const { W: w, H: h, toX, toY } = transform
      const samples = laps[0].samples
      const sectors = deltaData?.sectors || []

      ctx.clearRect(0, 0, w, h)
      // Dark panel-style background — skipped in `minimal` mode so the
      // overlay variant of this map (rendered on top of the 3D scene)
      // is fully transparent and only the contour + sectors are visible.
      if (!minimal) {
        ctx.fillStyle = 'rgba(9, 11, 16, 0.9)'
        ctx.fillRect(0, 0, w, h)
      }

      // Track outline scales with available area; the line widths and font
      // sizes scale with the smaller dimension so the map stays readable
      // whether the panel is 200 px or 1200 px wide.
      const baseScale = Math.min(w, h) / 280
      const trackLineWidth = 8 * baseScale
      const sectorLineWidth = 3.5 * baseScale
      const sectorHoverLineWidth = 6 * baseScale

      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = trackLineWidth
      ctx.lineCap = 'round'
      ctx.beginPath()
      for (let i = 0; i < samples.length; i += 3) {
        const x = toX(samples[i].position[0]), y = toY(samples[i].position[2])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()

      if (deltaData?.points?.length && sectors.length) {
        const pts = deltaData.points
        const hasSelection = selectedSectorNumber != null
        // When a sector is selected, all OTHER sectors render in a dim blue
        // — the selected one keeps its delta-coloured stroke at full intensity.
        const DIM_BLUE = 'rgba(80, 130, 180, 0.55)'
        for (const sector of sectors) {
          const isHovered = hoveredSector === sector.number
          const isSelected = selectedSectorNumber === sector.number
          const isDimmed = hasSelection && !isSelected
          let color
          if (isDimmed) color = DIM_BLUE
          else color = sector.avgDelta > 0 ? (isHovered ? '#66ff66' : '#4caf50') : (isHovered ? '#ff6666' : '#f44336')
          ctx.strokeStyle = color
          ctx.lineWidth = isSelected ? sectorHoverLineWidth : (isHovered ? sectorHoverLineWidth : sectorLineWidth)
          ctx.lineCap = 'round'
          ctx.beginPath()
          for (let i = sector.idxStart; i <= sector.idxEnd; i += 2) {
            if (i >= pts.length) break
            const x = toX(pts[i].position[0]), y = toY(pts[i].position[2])
            if (i === sector.idxStart) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          }
          ctx.stroke()

          // Per-sector S-number — drawn in BOTH modes. The overlay variant
          // (minimal) gets a slightly dimmer fill so the label sits over
          // the 3D scene without dominating it; the panel variant keeps
          // its brighter style. Per-sector delta-time text is only drawn
          // in non-minimal mode (too noisy for a transparent overlay).
          const midIdx = Math.min(Math.floor((sector.idxStart + sector.idxEnd) / 2), pts.length - 1)
          const mx = toX(pts[midIdx].position[0]), my = toY(pts[midIdx].position[2])
          const labelFontPx = (isHovered || isSelected ? 11 : 9) * baseScale
          ctx.fillStyle = isDimmed
            ? 'rgba(255,255,255,0.25)'
            : (isSelected || isHovered ? '#ffffff' : (minimal ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.7)'))
          ctx.font = `${(isHovered || isSelected) ? 'bold ' : ''}${labelFontPx.toFixed(0)}px monospace`
          ctx.textAlign = 'center'
          // In minimal mode the sector label sits ON the track contour with
          // a soft shadow for legibility on top of the 3D scene.
          if (minimal) {
            ctx.shadowColor = 'rgba(0,0,0,0.85)'
            ctx.shadowBlur = 3
          }
          ctx.fillText('S' + sector.number, mx, my - 6 * baseScale)
          if (minimal) ctx.shadowBlur = 0

          if (!minimal) {
            const deltaFontPx = (isHovered || isSelected ? 10 : 8) * baseScale
            const deltaStr = (sector.avgDelta > 0 ? '+' : '') + sector.avgDelta.toFixed(2) + 's'
            ctx.fillStyle = isDimmed
              ? 'rgba(120, 150, 180, 0.55)'
              : (sector.avgDelta > 0 ? '#4caf50' : '#f44336')
            ctx.font = `${(isHovered || isSelected) ? 'bold ' : ''}${deltaFontPx.toFixed(0)}px monospace`
            ctx.fillText(deltaStr, mx, my + 6 * baseScale)
          }
          ctx.textAlign = 'left'
        }

        // Sector-boundary separators — short perpendicular ticks straddling
        // the track at each sector's start point. Drawn AFTER the sector
        // strokes so they sit on top. In minimal (overlay) mode they're
        // the primary cue for "sector boundary is here" since the per-sector
        // delta text is suppressed; in panel mode they reinforce the
        // colour change between adjacent sectors.
        const tickHalfPx = (trackLineWidth * 0.5 + 4 * baseScale)
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'
        ctx.lineWidth = 1.5 * baseScale
        ctx.lineCap = 'butt'
        for (const sector of sectors) {
          const idx = sector.idxStart
          if (idx >= pts.length) continue
          // Local tangent (in *screen* pixels) — toY may flip signs vs the
          // world Z axis, so the tangent must be computed after toX/toY.
          const i0 = Math.max(0, idx - 1)
          const i1 = Math.min(pts.length - 1, idx + 1)
          const sx0 = toX(pts[i0].position[0]), sy0 = toY(pts[i0].position[2])
          const sx1 = toX(pts[i1].position[0]), sy1 = toY(pts[i1].position[2])
          const tx = sx1 - sx0, ty = sy1 - sy0
          const tlen = Math.hypot(tx, ty) || 1
          const nx = -ty / tlen, ny = tx / tlen
          const cx = toX(pts[idx].position[0]), cy = toY(pts[idx].position[2])
          ctx.beginPath()
          ctx.moveTo(cx - nx * tickHalfPx, cy - ny * tickHalfPx)
          ctx.lineTo(cx + nx * tickHalfPx, cy + ny * tickHalfPx)
          ctx.stroke()
        }

        // Viewport-window overlay — when the chart is zoomed in (viewport
        // covers less than the full lap), over-draw a translucent fade on
        // the trajectory segments whose time is OUTSIDE the visible window.
        // The fade uses the panel-bg colour so sector strokes underneath get
        // visually dimmed without losing colour identity. Inside-viewport
        // segments stay vivid; click hit-testing is unaffected because the
        // dot-canvas (where clicks are routed) is a separate canvas.
        if (viewport && duration > 0) {
          const isFullView =
            viewport.tStart <= 0.01 && viewport.tEnd >= duration - 0.01
          if (!isFullView) {
            ctx.strokeStyle = 'rgba(9, 11, 16, 0.65)'
            ctx.lineWidth = sectorLineWidth + 1.5 * baseScale
            ctx.lineCap = 'round'
            // Walk the delta-points and stroke runs of consecutive
            // out-of-viewport samples. Each path segment gets stroked once
            // when we leave the out-of-viewport run.
            let runStarted = false
            for (let i = 0; i < pts.length; i++) {
              const t = pts[i].t1
              const outside = t < viewport.tStart || t > viewport.tEnd
              if (outside) {
                const x = toX(pts[i].position[0])
                const y = toY(pts[i].position[2])
                if (!runStarted) {
                  ctx.beginPath()
                  ctx.moveTo(x, y)
                  runStarted = true
                } else {
                  ctx.lineTo(x, y)
                }
              } else if (runStarted) {
                ctx.stroke()
                runStarted = false
              }
            }
            if (runStarted) ctx.stroke()
          }
        }
      }

      // `minimal` mode (used by the in-3D-viewer overlay) skips the legend
      // swatches and the footer hint — only the track contour + sectors
      // are drawn so the map can sit transparently over the scene without
      // a strip of text covering the 3D view.
      if (!minimal) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)'
        ctx.font = `${Math.max(8, 8 * baseScale).toFixed(0)}px monospace`
        ctx.fillText('TRACK MAP — click sector to jump', 4, h - 4)
        if (laps.length >= 2) {
          const swatch = 8 * baseScale
          ctx.fillStyle = '#4caf50'
          ctx.fillRect(4, 3, swatch, swatch)
          ctx.fillStyle = 'rgba(255,255,255,0.5)'
          ctx.font = `${Math.max(9, 9 * baseScale).toFixed(0)}px monospace`
          ctx.fillText(laps[0]?.label || '', swatch + 8, swatch + 1)
          ctx.fillStyle = '#f44336'
          ctx.fillRect(4, swatch + 6, swatch, swatch)
          ctx.fillStyle = 'rgba(255,255,255,0.5)'
          ctx.fillText(laps[1]?.label || '', swatch + 8, 2 * swatch + 8)
        }
      }
    } catch (e) { console.error('[TrackMap]', e) }
  }, [deltaData, laps, transform, hoveredSector, selectedSectorNumber, viewport?.tStart, viewport?.tEnd, duration, dpr, minimal])

  // Car-dot overlay (cheap redraws on currentTime changes).
  useEffect(() => {
    const canvas = dotCanvasRef.current
    if (!canvas || !transform || !laps[0]?.samples?.length || duration <= 0) return
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const { W: w, H: h, toX, toY } = transform
    const samples = laps[0].samples
    ctx.clearRect(0, 0, w, h)
    const idx = Math.max(0, Math.min(Math.floor(currentTime / duration * samples.length), samples.length - 1))
    if (!samples[idx]?.position) return
    const cx = toX(samples[idx].position[0]), cy = toY(samples[idx].position[2])
    const r = Math.max(3, 4 * Math.min(w, h) / 280)
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }, [currentTime, duration, laps, transform, dpr])

  const findSector = useCallback((e) => {
    const t = transformRef.current
    if (!t || !deltaData?.sectors?.length || !deltaData?.points?.length) return null
    const canvas = dotCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    // Coordinates are in CSS pixels (transform uses CSS-pixel W/H now).
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const pts = deltaData.points
    const hitRadius = Math.max(10, 15 * Math.min(rect.width, rect.height) / 280)

    let bestSector = null, bestDist = hitRadius
    for (const sector of deltaData.sectors) {
      for (let i = sector.idxStart; i <= sector.idxEnd && i < pts.length; i += 4) {
        const sx = t.toX(pts[i].position[0]), sy = t.toY(pts[i].position[2])
        const d = Math.hypot(mx - sx, my - sy)
        if (d < bestDist) { bestDist = d; bestSector = sector }
      }
    }
    return bestSector
  }, [deltaData])

  const handleMouseMove = useCallback((e) => {
    const sector = findSector(e)
    setHoveredSector(sector ? sector.number : null)
    e.target.style.cursor = sector ? 'pointer' : 'default'
  }, [findSector])

  const handleClick = useCallback((e) => {
    const sector = findSector(e)
    if (sector && onSectorClick) onSectorClick(sector)
  }, [findSector, onSectorClick])

  if (!laps.length) return null
  return (
    <div ref={containerRef} className="track-map-panel">
      <canvas ref={canvasRef} className="track-map-canvas" />
      <canvas
        ref={dotCanvasRef}
        className="track-map-dot"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredSector(null)}
        onClick={handleClick}
      />
    </div>
  )
}

/**
 * Panel adapter for the layout registry. Reads everything from the store and
 * dispatches sector-click actions; takes no props from the LayoutGrid.
 *
 * `minimal` (default `false`) hides the legend swatches, the footer hint
 * and the per-sector S-number / delta labels — used by the in-3D-viewer
 * overlay so only the track contour shows over the scene.
 */
export function TrackMapPanel({ minimal = false } = {}) {
  const laps           = useStore((s) => s.laps)
  const deltaData      = useStore((s) => s.deltaData)
  const playhead       = useStore((s) => s.playhead)
  const duration       = useStore((s) => s.duration)
  const selectedSector = useStore((s) => s.selectedSector)
  const viewport       = useStore((s) => s.viewport)
  const setPlayhead        = useStore((s) => s.setPlayhead)
  const setLapTimeOffset   = useStore((s) => s.setLapTimeOffset)
  const setSectorStartTime = useStore((s) => s.setSectorStartTime)
  const setSelectedSector  = useStore((s) => s.setSelectedSector)
  const setViewport        = useStore((s) => s.setViewport)
  const resetViewport      = useStore((s) => s.resetViewport)

  const onSectorClick = useCallback((sector) => {
    // Toggle behaviour — clicking the already-selected sector clears the
    // selection and restores the full lap viewport.
    const isAlreadySelected = sector.number === useStore.getState().selectedSector
    if (isAlreadySelected) {
      setSelectedSector(null)
      setSectorStartTime(null)
      resetViewport()
      return
    }
    setPlayhead(sector.t1Start)
    setLapTimeOffset(sector.t2Start - sector.t1Start)
    setSectorStartTime(sector.t1Start)
    setSelectedSector(sector.number)
    // Zoom every viewport-aware panel (charts, future overlays) to the sector.
    setViewport({ tStart: sector.t1Start, tEnd: sector.t1End })
  }, [setPlayhead, setLapTimeOffset, setSectorStartTime, setSelectedSector, setViewport, resetViewport])

  return (
    <div className="panel-trackmap">
      <TrackMap
        deltaData={deltaData}
        currentTime={playhead}
        duration={duration}
        laps={laps}
        selectedSectorNumber={selectedSector}
        viewport={viewport}
        onSectorClick={onSectorClick}
        minimal={minimal}
      />
    </div>
  )
}
