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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
