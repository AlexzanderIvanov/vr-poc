import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * Filter known-harmless ECharts warnings that fire repeatedly during
 * chart init / layout transitions and pollute the DevTools console.
 *
 * Suppressed patterns:
 *
 *   "[ECharts] No coordinate system that supports convertToPixel
 *    found by the given finder."
 *      Fires between `setOption()` and ECharts' internal `update()` —
 *      the grid component is registered but `_coordSysMgr` isn't
 *      populated yet. Our RAF loops (`ChartValueLabels`,
 *      `useEchartsTimeSync`) already wrap the call in `safe()`, so the
 *      result is "skip positioning the overlay for that frame" — the
 *      warning text is the only visible effect.
 *
 *   "[ECharts] Can't get DOM width or height. ..."
 *      Fires during layout-preset swaps when the chart wrapper is
 *      momentarily reparented (CSS Grid swap) and has 0 px dims for
 *      one frame. The next frame the ResizeObserver re-measures and
 *      re-renders correctly.
 *
 * Filtering EXACT substrings rather than wholesale-muting `console.warn`
 * so any genuinely useful ECharts warning still surfaces.
 *
 * Note re: testing — Chrome DevTools (the real user's console) honours
 * this override. The Claude Preview MCP tool captures warnings via
 * `Runtime.consoleAPICalled` on the DevTools Protocol, which fires
 * upstream of any JS-land `console.warn` reassignment. So
 * `preview_console_logs` will still report these even when the user's
 * browser console doesn't — that's a preview-tool artifact, not a bug.
 */
const ECHARTS_NOISE_PATTERNS = [
  'No coordinate system that supports convertToPixel',
  "Can't get DOM width or height",
]
const originalConsoleWarn = console.warn
console.warn = function filteredWarn(...args) {
  const first = args[0]
  if (typeof first === 'string') {
    for (const pat of ECHARTS_NOISE_PATTERNS) {
      if (first.includes(pat)) return
    }
  }
  return originalConsoleWarn.apply(this, args)
}

/**
 * On-screen crash overlay — since mobile tab-crashes hide the DevTools console,
 * this surfaces any uncaught JS error or unhandled promise rejection right on
 * the page so you can screenshot it from the phone.
 */
function showErrorOverlay(title, detail) {
  try {
    const div = document.createElement('div')
    div.style.cssText = [
      'position:fixed', 'inset:0', 'background:#900', 'color:#fff',
      'padding:16px', 'font:12px/1.4 monospace', 'white-space:pre-wrap',
      'overflow:auto', 'z-index:99999',
    ].join(';')
    const close = document.createElement('button')
    close.textContent = 'DISMISS'
    close.style.cssText = 'position:fixed;top:8px;right:8px;padding:6px 10px;background:#fff;color:#900;border:0;border-radius:6px;font-weight:700;z-index:100000'
    close.onclick = () => div.remove()
    div.textContent = `${title}\n\n${detail}`
    div.appendChild(close)
    document.body.appendChild(div)
  } catch {}
}

window.addEventListener('error', (e) => {
  // Browsers fire this for the benign "ResizeObserver loop completed with
  // undelivered notifications" warning when an observer's callback triggers
  // a synchronous layout change. It's not a real crash; ignore.
  if (e?.message?.includes?.('ResizeObserver loop')) return
  showErrorOverlay(
    `ERROR: ${e.message}`,
    `${e.error?.stack || ''}\n\nfile: ${e.filename}:${e.lineno}:${e.colno}\nua: ${navigator.userAgent}`,
  )
})

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason
  showErrorOverlay(
    `UNHANDLED PROMISE: ${reason?.message || String(reason)}`,
    `${reason?.stack || ''}\n\nua: ${navigator.userAgent}`,
  )
})

// Surface WebGL context loss — common cause of "black screen" on mobile GPUs.
window.addEventListener('webglcontextlost', (e) => {
  showErrorOverlay('WEBGL CONTEXT LOST', 'The GPU dropped the WebGL context. Usually caused by GPU memory pressure on mobile.')
}, true)

// Register the asset-caching service worker (see `public/sw.js`). Failures
// are non-fatal: the app still works through normal HTTP caching, just
// without the deterministic-cache-for-big-GLBs benefit. Skipped during
// the Vite HMR worker probe (would 404).
if ('serviceWorker' in navigator) {
  // Defer until after first paint so the worker registration doesn't
  // compete with the critical path.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Don't pop the crash overlay — degrade gracefully.

      console.warn('[sw] registration failed:', err)
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
