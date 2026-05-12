import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { safe, isEchartsGridReady } from '../utils/safe'
import { useChartGestures } from './useChartGestures'
import {
  PLAYHEAD_OVERLAY_CLASS,
  DELTA_TARGET_OVERLAY_CLASS,
  DELTA_WINDOW_OVERLAY_CLASS,
} from '../constants'

/**
 * Centralised wiring between an ECharts instance and the analysis-frame state.
 *
 *   1. Mirror `viewport` → chart dataZoom (fires only on actual zoom/pan).
 *   2. Mirror `playhead` → a DOM-overlay div positioned via raf (NOT
 *      ECharts markLine / graphic). This is the perf-critical path: the
 *      previous markLine + graphic `setOption` calls at 15 Hz × 2 charts
 *      blocked the main thread enough to starve the 3D render loop and
 *      produce visibly choppy car animation. The DOM overlay updates
 *      ~0.05 ms/frame and runs at native rAF rate.
 *   3. Convert chart `dataZoom` events → `setViewport` action.
 *   4. Pointer gestures live in `useChartGestures` (click-to-seek, scrub,
 *      shift-pan, drag-zoom). It binds to the chart's zrender events, so
 *      DOM events outside the canvas never reach the handler.
 *   5. ResizeObserver → `chart.resize()`.
 *
 * Pixel↔data conversion:
 *   `chart.convertFromPixel({gridIndex: N}, [x, y]) → [xValue, yValue]`
 *   `chart.convertToPixel({gridIndex: N},   [xValue, yValue]) → [x, y]`
 *
 * HMR / lifecycle safety:
 *   ECharts can briefly enter a half-initialised state during HMR and React
 *   StrictMode double-mount where `convertToPixel` / `getModel` throw. All
 *   such calls are wrapped in `safe()` to no-op rather than crash.
 */

// `safe()` lives in `utils/safe.js` (was duplicated here and in
// `ChartValueLabels.jsx`). It wraps ECharts API calls that can throw
// during HMR / StrictMode transitions and returns a fallback instead.

// `<ChartPlayheadOverlay />` is exported from
// ../components/Charts/ChartPlayheadOverlay.jsx — JSX can't live in this
// .js file. Charts render it as a sibling of `<ReactECharts>` inside
// their containerRef wrapper; this hook drives its `style.left` via raf.

/**
 * `xAxisFromTime(t) → xValue` lets each chart declare what its x-axis
 * actually plots. Time-axis charts pass identity (`t => t`); distance-axis
 * charts pass an arc-length converter `t => arcLengthAtTime(refLap, t)`.
 * The playhead overlay's pixel position uses this converter so a single
 * source of truth (`playheadRef.current` in seconds) drives both axis
 * variants without each chart re-implementing the rAF positioning loop.
 *
 * `xAxisToTime(xValue) → t` is the inverse: gesture handlers and the
 * dataZoom event mirror use it to translate chart-x back to seconds so
 * `playhead` and `viewport` (always in seconds — the canonical clock)
 * stay coherent across mode swaps.
 *
 * `tMax` is the upper bound of whatever the chart's x-axis represents
 * (seconds for time mode, metres for distance mode) — kept named `tMax`
 * for back-compat.
 */
export function useEchartsTimeSync(
  echartsRef,
  containerRef,
  { tMax, xAxisFromTime = (t) => t, xAxisToTime = (x) => x, optionEpoch },
) {
  const viewport = useStore((s) => s.viewport)
  const setViewport = useStore((s) => s.setViewport)
  const ignoreNextRef = useRef(false)

  // Dispatch the current store viewport onto the chart's dataZoom. The
  // `ignoreNext` flag suppresses the inevitable `dataZoom` event echo
  // so we don't loop back through `onDataZoom → setViewport`.
  const applyViewport = (tStart, tEnd) => {
    const chart = echartsRef.current?.getEchartsInstance?.()
    if (!chart || tMax <= 0) return
    const startPct = (xAxisFromTime(tStart) / tMax) * 100
    const endPct   = (xAxisFromTime(tEnd)   / tMax) * 100
    if (!Number.isFinite(startPct) || !Number.isFinite(endPct)) return
    ignoreNextRef.current = true
    safe(() => chart.dispatchAction({ type: 'dataZoom', start: startPct, end: endPct }))
  }

  // viewport → dataZoom (fires only when viewport actually changes —
  // not in the playback hot path). `viewport` is always seconds;
  // converted through `xAxisFromTime` so distance-axis charts get the
  // right fractional window.
  useEffect(() => {
    applyViewport(viewport.tStart, viewport.tEnd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.tStart, viewport.tEnd, tMax, echartsRef, xAxisFromTime])

  // option-swap → re-assert viewport. Necessary because with
  // `notMerge: true` ECharts can reset the dataZoom widget when the
  // surrounding components shrink (e.g. removing an overlay axis),
  // even though we seed `start/end` in the option. Reads viewport
  // non-reactively — this effect only fires on actual option changes.
  useEffect(() => {
    if (optionEpoch == null) return
    const vp = useStore.getState().viewport
    applyViewport(vp.tStart, vp.tEnd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionEpoch, tMax, xAxisFromTime, echartsRef])

  // Playhead overlay — DOM div, NOT an ECharts markLine.
  //
  // Why DOM and not markLine/graphic:
  //   ECharts `setOption` triggers its merge pipeline + canvas re-flush
  //   (~5–15 ms per call on multi-grid charts). The previous version
  //   called `setOption` twice per playhead tick × 2 charts × 15 Hz ≈
  //   60 calls/s, blocking the main thread for hundreds of ms/s and
  //   starving the THREE.js render loop. A DOM div positioned via
  //   `style.left` costs ~0.05 ms per update and lets us run at 60 Hz
  //   without involving React or ECharts at all.
  //
  // Lifecycle:
  //   - The overlay is appended to the container wrapper that holds the
  //     chart (positioned absolutely; doesn't intercept zrender events).
  //   - A raf loop reads `playheadRef.current` (the hot-path ref) and
  //     `chart.convertToPixel` — the latter automatically reflects the
  //     current x-axis range, so the overlay tracks both playhead and
  //     viewport changes without separate listeners.
  //   - Cursor: `ew-resize` on a 14-px-wide invisible hit area; the
  //     visible playhead is a thin dashed line in the middle.
  // Drive the React-rendered playhead overlay's `style.left` via raf.
  // The overlay div itself is rendered by the chart component (see
  // `<ChartPlayheadOverlay />` below) so React owns its lifecycle and
  // ECharts can't blow it away during layout passes.
  useEffect(() => {
    const container = containerRef.current
    if (!container || tMax <= 0) return undefined

    let alive = true
    let rafId = 0
    let lastPx = -1

    // Delta overlays — second vertical line (the "target") plus the
    // band rectangle spanning [playhead .. target]. Both nodes are
    // optional (older charts that don't render `<ChartDeltaOverlays/>`
    // simply skip the work). Cached `lastPx` values avoid redundant
    // style writes when the value hasn't moved by ≥0.5 px.
    let lastTargetPx = -1
    let lastWindow = { l: -1, w: -1 }
    const tick = () => {
      if (!alive) return
      const chart = echartsRef.current?.getEchartsInstance?.()
      if (!chart || chart.isDisposed?.()) {
        rafId = requestAnimationFrame(tick)
        return
      }
      const dom = chart.getDom?.()
      const overlay = container.querySelector(`.${PLAYHEAD_OVERLAY_CLASS}`)
      if (!dom || !overlay) {
        rafId = requestAnimationFrame(tick)
        return
      }
      const phTime = useStore.getState().playheadRef.current
      const drp    = useStore.getState().deltaRefPoint
      // `xAxisFromTime` maps the playhead (always in seconds) onto the
      // chart's x-axis. Identity for time-axis charts, arc-length lookup
      // for distance-axis charts.
      const phX_data = xAxisFromTime(phTime)
      // Guard against the "no coordinate system" warning that fires
      // during the first frame after mount / option swap (grid exists
      // but its rect isn't ready yet). `safe()` catches the eventual
      // throw, but ECharts logs a warning BEFORE throwing — this guard
      // skips the call entirely until the grid is renderable.
      const ready = isEchartsGridReady(chart, 0)
      const phX = ready
        ? safe(() => chart.convertToPixel({ gridIndex: 0 }, [phX_data, 0])?.[0], null)
        : null
      const targetX = (ready && drp)
        ? safe(() => chart.convertToPixel({ gridIndex: 0 }, [xAxisFromTime(drp.time), 0])?.[0], null)
        : null
      const dRect = dom.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      const offX = dRect.left - cRect.left
      const offY = dRect.top - cRect.top
      const innerH = dRect.height - 24
      if (phX != null && isFinite(phX) && phX >= 0) {
        const finalX = offX + phX
        if (Math.abs(finalX - lastPx) >= 0.5) {
          overlay.style.left = `${finalX}px`
          overlay.style.top = `${offY}px`
          overlay.style.height = `${innerH}px`
          overlay.style.display = 'block'
          lastPx = finalX
        }
      } else if (lastPx !== -1) {
        overlay.style.display = 'none'
        lastPx = -1
      }

      // Delta target line + window. Hide both when no target set.
      const tEl = container.querySelector(`.${DELTA_TARGET_OVERLAY_CLASS}`)
      const wEl = container.querySelector(`.${DELTA_WINDOW_OVERLAY_CLASS}`)
      if (!tEl || !wEl) {
        rafId = requestAnimationFrame(tick)
        return
      }
      if (targetX != null && isFinite(targetX) && targetX >= 0 && phX != null) {
        const tFinalX = offX + targetX
        if (Math.abs(tFinalX - lastTargetPx) >= 0.5) {
          tEl.style.left = `${tFinalX}px`
          tEl.style.top = `${offY}px`
          tEl.style.height = `${innerH}px`
          tEl.style.display = 'block'
          lastTargetPx = tFinalX
        }
        // Window rect between the two vertical lines.
        const phFinalX = offX + phX
        const left = Math.min(phFinalX, tFinalX)
        const width = Math.abs(tFinalX - phFinalX)
        if (Math.abs(left - lastWindow.l) >= 0.5 || Math.abs(width - lastWindow.w) >= 0.5) {
          wEl.style.left = `${left}px`
          wEl.style.width = `${width}px`
          wEl.style.top = `${offY}px`
          wEl.style.height = `${innerH}px`
          wEl.style.display = width > 1 ? 'block' : 'none'
          lastWindow = { l: left, w: width }
        }
      } else {
        if (lastTargetPx !== -1) {
          tEl.style.display = 'none'
          lastTargetPx = -1
        }
        if (lastWindow.l !== -1 || lastWindow.w !== -1) {
          wEl.style.display = 'none'
          lastWindow = { l: -1, w: -1 }
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      alive = false
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [tMax, echartsRef, containerRef, xAxisFromTime])

  // resize observer → chart.resize()
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        const chart = echartsRef.current?.getEchartsInstance?.()
        if (chart) safe(() => chart.resize())
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef, echartsRef])

  // Pointer gestures live in their own hook — see useChartGestures. The
  // inverse converter lets the click / drag-zoom paths translate
  // pixel→chart-x→seconds before writing the canonical clock.
  useChartGestures(echartsRef, { xAxisToTime })

  // dataZoom event → setViewport. The slider's `start`/`end` are
  // percentages of the chart's x-axis range; convert to chart-x first,
  // then back to seconds (the viewport's storage unit).
  return useCallback((params) => {
    if (ignoreNextRef.current) {
      ignoreNextRef.current = false
      return
    }
    if (tMax <= 0) return
    const z = params.batch ? params.batch[0] : params
    const startPct = z.start ?? 0
    const endPct = z.end ?? 100
    const xStart = (startPct / 100) * tMax
    const xEnd   = (endPct   / 100) * tMax
    setViewport({
      tStart: xAxisToTime(xStart),
      tEnd:   xAxisToTime(xEnd),
    })
  }, [tMax, setViewport, xAxisToTime])
}

/**
 * Viewport auto-follow.
 *
 * When the user has zoomed into a sub-range (viewport width < lap duration),
 * keep the playhead inside the visible window during playback. As the
 * playhead enters the trailing 10 % of the viewport, shift `tStart`/`tEnd`
 * forward just enough to hold the playhead at that 10 % margin — so the
 * marker visibly "stops" at 90 % of the viewport and the chart starts
 * sliding under it instead of letting it drift off the right edge.
 *
 * The mirror case (playhead crossing into the leading 10 % — typically
 * after a manual rewind) shifts the viewport leftward.
 *
 * Only fires while `playing` is true. When paused — including during
 * scrub / sector-jump / click-to-seek — the viewport is left alone so the
 * user can zoom in around a feature and inspect it without the window
 * yanking itself away. The viewport-effect in `useEchartsTimeSync` already
 * mirrors `setViewport` to both charts via `dispatchAction(dataZoom)`.
 *
 * Subscribed via `useStore.subscribe` (not RAF) and gated on `playhead`
 * actually changing, so the listener only runs at the throttled 15 Hz of
 * the playhead state, not 60 Hz of RAF.
 *
 * Wall-clock throttle: even at 15 Hz, every fired `setViewport` triggers
 * a `dataZoom` dispatchAction on every chart instance (2+ charts, each a
 * multi-grid ECharts canvas), plus a re-render of the TrackMap SVG.
 * Empirically that's 15-30 ms of main-thread work per call — 75% of the
 * frame budget at 15 Hz, which starves the 3D `useFrame` and produces a
 * choppy ghost car in any narrow viewport (i.e. while a sector is
 * selected). The ref car looks fine because `CameraRig` smooths its
 * pose with a ~2.2 Hz exp filter and absorbs frame-timing variance; the
 * ghost has no such filter (we removed it for direct-response chase
 * sync) and exposes every dropped frame as a visible position jump.
 *
 * We rate-limit `setViewport` to `MIN_SHIFT_MS` ms. At 1×–2× speed the
 * playhead drifts at most ~0.4 s in that window — well inside the
 * margin so it never visually leaves the viewport. At >4× speed the
 * playhead may briefly hit the trailing edge between shifts, which is
 * acceptable.
 */
const FOLLOW_MARGIN_FRAC = 0.10  // playhead "sticks" at 10 % from the trailing edge
const MIN_SHIFT_MS = 200          // viewport auto-shift rate ceiling (5 Hz)

export function useViewportAutoFollow() {
  useEffect(() => {
    let lastShiftAt = 0
    return useStore.subscribe((state, prev) => {
      if (state.playhead === prev.playhead) return    // only react to clock ticks
      if (!state.playing) return                       // paused — leave viewport alone
      const { viewport: vp, duration: dur, playhead: ph } = state
      const width = vp.tEnd - vp.tStart
      if (dur <= 0 || width <= 0) return
      // Skip when already showing the whole lap — there's nothing to follow.
      if (width >= dur - 1e-3) return

      const margin = width * FOLLOW_MARGIN_FRAC
      let nextStart = vp.tStart
      let nextEnd = vp.tEnd
      if (ph > vp.tEnd - margin) {
        // Slide forward: keep playhead at (tEnd - margin).
        const shift = ph + margin - vp.tEnd
        nextStart += shift
        nextEnd += shift
      } else if (ph < vp.tStart + margin) {
        // Slide backward (e.g. after a rewind): keep playhead at (tStart + margin).
        const shift = ph - margin - vp.tStart
        nextStart += shift
        nextEnd += shift
      } else {
        return
      }

      // Rate-limit the actual `setViewport` call. The shift math above
      // always runs (cheap), but firing the state update — which fans
      // out to ECharts dataZoom + TrackMap re-render — is throttled.
      const now = performance.now()
      if (now - lastShiftAt < MIN_SHIFT_MS) return
      lastShiftAt = now

      // Clamp at lap boundaries — never let the viewport spill past
      // [0, duration].
      if (nextEnd > dur) { nextEnd = dur; nextStart = dur - width }
      if (nextStart < 0) { nextStart = 0; nextEnd = width }
      state.setViewport({ tStart: nextStart, tEnd: nextEnd })
    })
  }, [])
}

/**
 * Track whether the user is currently dragging a layout-panel separator
 * and mark `<body>` with the `panel-resizing` class for the duration.
 *
 * Why our own tracker instead of `react-resizable-panels`'
 * `data-separator="active"` attribute: that flag flips back to `inactive`
 * MID-DRAG when the cursor crosses back past its starting position (e.g.
 * a left-then-right drag without releasing the mouse), even though the
 * pointer is still held down. The CSS rule that mutes charts during a
 * resize would then stop applying, ECharts' built-in tooltip / axisPointer
 * / dataZoom handlers would re-engage, and the chart would visibly react
 * mid-resize.
 *
 * This tracker latches on `pointerdown` whose target is anywhere inside a
 * `[role="separator"]` element, and only releases on the matching
 * `pointerup` (or pointercancel) anywhere on the page.
 */
export function usePanelResizeTracker() {
  useEffect(() => {
    let activeId = -1
    const isSeparator = (el) => {
      while (el && el !== document.body) {
        if (el.getAttribute?.('role') === 'separator') return true
        el = el.parentElement
      }
      return false
    }
    const onDown = (e) => {
      if (e.button !== 0) return
      if (!isSeparator(e.target)) return
      activeId = e.pointerId
      document.body.classList.add('panel-resizing')
    }
    const release = (e) => {
      if (activeId === -1) return
      if (e && e.pointerId !== activeId) return
      activeId = -1
      document.body.classList.remove('panel-resizing')
    }
    // Capture-phase so we win the latch race even if some other handler
    // calls stopPropagation on the bubble side.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      document.body.classList.remove('panel-resizing')
    }
  }, [])
}
