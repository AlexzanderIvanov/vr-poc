import { useEffect } from 'react'
import { useStore } from '../state/store'
import { safe } from '../utils/safe'
import {
  CHART_CLICK_PX,
  CHART_HANDLE_HIT_PX,
  CHART_MIN_ZOOM_DRAG_S,
} from '../constants'

/**
 * Per-chart pointer-gesture handler. Attaches zrender events to the
 * chart's canvas to implement:
 *
 *   click (no movement)         → seek playhead
 *   drag near playhead column   → scrub
 *   shift + drag                → pan viewport
 *   drag rightward (free)       → zoom into the dragged range
 *   drag leftward  (free)       → reset viewport to full lap
 *
 * All gestures dispatch through ECharts' own zrender event system —
 * `chart.getZr().on('mousedown'|'mousemove'|'mouseup'|'globalout', ...)`.
 * zrender events fire only while the cursor is over the chart canvas, so
 * events on unrelated DOM (panel-resize separators, side panels) never
 * reach this handler at all. `globalout` aborts an in-progress gesture
 * cleanly when the cursor leaves the canvas, so we never need DOM-level
 * pointer capture or any custom event plumbing.
 *
 * Pointer event coordinates come pre-relative-to-canvas (`offsetX` /
 * `offsetY`) and modifier keys live on `e.event` (the underlying browser
 * event).
 *
 * State / store contract:
 *   - reads  `playhead`, `viewport`, `duration`
 *   - writes `playhead`, `viewport`, `sectorEndRef.current` via store actions
 *
 * Pixel↔data conversion uses `chart.convertFromPixel({gridIndex: N})`.
 */
export function useChartGestures(echartsRef) {
  useEffect(() => {
    // ECharts is created asynchronously by echarts-for-react after the
    // wrapper div mounts. RAF-poll until ready, then attach.
    let cancelled = false
    let cleanup = null
    const attach = () => {
      if (cancelled) return
      const chartInst = echartsRef.current?.getEchartsInstance?.()
      if (!chartInst || chartInst.isDisposed?.()) {
        requestAnimationFrame(attach)
        return
      }
      cleanup = attachChartGestures(chartInst)
    }
    requestAnimationFrame(attach)
    return () => { cancelled = true; if (cleanup) cleanup() }
  }, [echartsRef])
}

function attachChartGestures(chartInst) {
  const zr = chartInst.getZr()
  if (!zr) return undefined

  const findGrid = (x, y) => {
    const opts = safe(() => chartInst.getOption(), null)
    const grids = opts?.grid
      ? (Array.isArray(opts.grid) ? opts.grid : [opts.grid])
      : []
    for (let i = 0; i < grids.length; i++) {
      if (safe(() => chartInst.containPixel({ gridIndex: i }, [x, y]), false)) return i
    }
    return -1
  }
  const pixelToTime = (gIdx, x) => {
    const dp = safe(() => chartInst.convertFromPixel({ gridIndex: gIdx }, [x, 0]), null)
    if (!dp || !isFinite(dp[0])) return null
    const dur = useStore.getState().duration
    if (dur <= 0) return null
    return Math.max(0, Math.min(dp[0], dur))
  }

  let active = false
  let onHandle = false
  let zooming = false
  let panning = false
  let gridIdx = -1
  let downX = 0
  let panStart = null
  let panGridW = 0
  let zoomRectEl = null

  const showZoomRect = (leftX, rightX, mode) => {
    if (!zoomRectEl) {
      zoomRectEl = document.createElement('div')
      zoomRectEl.style.cssText = [
        'position:absolute', 'top:0', 'bottom:0',
        'pointer-events:none',
        'backdrop-filter:blur(2px)',
        '-webkit-backdrop-filter:blur(2px)',
        'z-index:5',
      ].join(';')
    }
    const wrapper = chartInst.getDom()?.parentElement
    if (zoomRectEl.parentElement !== wrapper) {
      zoomRectEl.remove()
      if (wrapper && !wrapper.style.position) wrapper.style.position = 'relative'
      wrapper?.appendChild(zoomRectEl)
    }
    // Blue = zoom-in, orange = reset.
    if (mode === 'out') {
      zoomRectEl.style.background = 'rgba(255,167,38,0.16)'
      zoomRectEl.style.border = '1px solid rgba(255,167,38,0.55)'
    } else {
      zoomRectEl.style.background = 'rgba(76,175,200,0.16)'
      zoomRectEl.style.border = '1px solid rgba(76,175,200,0.55)'
    }
    const a = Math.min(leftX, rightX)
    const b = Math.max(leftX, rightX)
    zoomRectEl.style.left = `${a}px`
    zoomRectEl.style.width = `${b - a}px`
  }
  const hideZoomRect = () => { if (zoomRectEl?.parentElement) zoomRectEl.remove() }

  const reset = () => {
    active = false
    onHandle = false
    zooming = false
    panning = false
    panStart = null
    panGridW = 0
    hideZoomRect()
    const dom = chartInst.getDom()
    if (dom) dom.style.cursor = ''
  }

  const onMouseDown = (e) => {
    if (active) return
    // Triple-belt guard: if a panel-resize is in flight (by ANY signal —
    // our latch class, the browser-native `:active` state on a separator,
    // or react-resizable-panels' own attribute), the chart does NOT
    // process a gesture. Even if CSS pointer-events somehow failed to
    // mute the canvas, this stops the chart at the JS layer.
    if (
      document.body.classList.contains('panel-resizing') ||
      document.querySelector('[role="separator"]:active') ||
      document.querySelector('[data-separator="active"]')
    ) return
    const x = e.offsetX, y = e.offsetY
    const g = findGrid(x, y)
    if (g === -1) return  // axis label / dataZoom slider / gutter

    const wantsPan = !!e.event?.shiftKey
    const ph = useStore.getState().playhead
    const phX = safe(() => chartInst.convertToPixel({ gridIndex: g }, [ph, 0])?.[0], null)
    const nearHandle = !wantsPan && phX != null && Math.abs(x - phX) <= CHART_HANDLE_HIT_PX

    active = true
    onHandle = nearHandle
    zooming = false
    panning = wantsPan
    gridIdx = g
    downX = x

    if (panning) {
      panStart = { ...useStore.getState().viewport }
      panGridW = safe(
        () => chartInst.getModel().getComponent('grid', g).coordinateSystem.getRect().width,
        0,
      )
      const dom = chartInst.getDom()
      if (dom) dom.style.cursor = 'grabbing'
    }
  }

  const onMouseMove = (e) => {
    if (!active) return
    const curX = e.offsetX

    if (panning) {
      if (!panStart || panGridW <= 0) return
      const tWidth = panStart.tEnd - panStart.tStart
      const tPerPx = tWidth / panGridW
      const dt = -(curX - downX) * tPerPx
      const dur = useStore.getState().duration
      let nextStart = panStart.tStart + dt
      nextStart = Math.max(0, Math.min(dur - tWidth, nextStart))
      useStore.getState().setViewport({ tStart: nextStart, tEnd: nextStart + tWidth })
      return
    }

    if (onHandle) {
      const t = pixelToTime(gridIdx, curX)
      if (t == null) return
      useStore.getState().setPlayhead(t)
      useStore.getState().sectorEndRef.current = null
      return
    }

    const dx = curX - downX
    if (!zooming && Math.abs(dx) <= CHART_CLICK_PX) return
    zooming = true
    showZoomRect(downX, curX, curX < downX ? 'out' : 'in')
  }

  const onMouseUp = (e) => {
    if (!active) return
    const wasZooming = zooming
    const wasOnHandle = onHandle
    const wasPanning = panning
    const upX = e.offsetX
    reset()
    if (wasPanning) return

    if (wasOnHandle) {
      if (Math.abs(upX - downX) <= CHART_CLICK_PX) {
        const t = pixelToTime(gridIdx, downX)
        if (t != null) {
          useStore.getState().setPlayhead(t)
          useStore.getState().sectorEndRef.current = null
        }
      }
      return
    }

    if (!wasZooming) {
      // Pure click → seek.
      if (Math.abs(upX - downX) > CHART_CLICK_PX) return
      const t = pixelToTime(gridIdx, downX)
      if (t == null) return
      useStore.getState().setPlayhead(t)
      useStore.getState().sectorEndRef.current = null
      return
    }

    // Drag completed — direction picks the action.
    if (upX < downX) { useStore.getState().resetViewport(); return }
    const t1 = pixelToTime(gridIdx, downX)
    const t2 = pixelToTime(gridIdx, upX)
    if (t1 == null || t2 == null) return
    const tStart = Math.min(t1, t2)
    const tEnd = Math.max(t1, t2)
    if (tEnd - tStart < CHART_MIN_ZOOM_DRAG_S) return
    useStore.getState().setViewport({ tStart, tEnd })
  }

  // Cursor left the canvas mid-gesture — zrender stops dispatching
  // mousemove/mouseup until it returns. Abort cleanly so we don't dangle
  // a half-active gesture.
  const onGlobalOut = () => { if (active) reset() }

  zr.on('mousedown', onMouseDown)
  zr.on('mousemove', onMouseMove)
  zr.on('mouseup', onMouseUp)
  zr.on('globalout', onGlobalOut)

  return () => {
    zr.off('mousedown', onMouseDown)
    zr.off('mousemove', onMouseMove)
    zr.off('mouseup', onMouseUp)
    zr.off('globalout', onGlobalOut)
    hideZoomRect()
  }
}
