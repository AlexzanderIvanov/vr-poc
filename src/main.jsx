import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

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
