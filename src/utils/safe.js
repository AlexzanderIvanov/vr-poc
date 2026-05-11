/**
 * Try/catch wrapper used to guard ECharts (and other third-party) calls
 * that can throw mid-HMR or during a React StrictMode double-mount when
 * the underlying instance is half-initialised.
 *
 * Returns `fallback` (default `undefined`) on any exception. We swallow
 * silently because the call sites are hot-path (rAF loops) and the
 * recovery is "skip this frame" — logging would spam the console.
 */
export function safe(fn, fallback) {
  try { return fn() } catch { return fallback }
}

/**
 * Check whether an ECharts instance has a renderable grid coordinate
 * system at the given index. Use this BEFORE calling
 * `chart.convertToPixel({ gridIndex }, …)` during chart-init transitions
 * — during the first frame after mount / option swap the grid is
 * registered but its coordinate-system rect isn't ready, and ECharts
 * logs "No coordinate system that supports convertToPixel found" to the
 * console each time. `safe()` catches the throw but doesn't suppress
 * the console output — this guard does.
 */
export function isEchartsGridReady(chart, gridIdx = 0) {
  try {
    const model = chart?.getModel?.()
    if (!model) return false
    const grid = model.getComponent('grid', gridIdx)
    if (!grid) return false
    const rect = grid.coordinateSystem?.getRect?.()
    return !!(rect && rect.width > 0 && rect.height > 0)
  } catch {
    return false
  }
}
