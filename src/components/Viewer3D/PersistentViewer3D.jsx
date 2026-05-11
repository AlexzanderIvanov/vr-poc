import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Viewer3DPanel } from './Viewer'
import { viewerSlotRegistry } from './persistentViewerSlot'

/**
 * Persistent 3D viewer — mounted ONCE at app-shell level, never
 * remounts when the layout preset changes. See `persistentViewerSlot.js`
 * for the registry pattern and the rationale.
 *
 * Behaviour:
 *   - Subscribes to the slot registry. When a `<Viewer3DSlot>` mounts
 *     inside `<LayoutGrid>`, this component overlays its wrapper div
 *     on the slot's bounding box.
 *   - The wrapper uses `position: fixed` so its placement is independent
 *     of the layout grid's flow. A `ResizeObserver` keeps the bbox in
 *     sync with the slot as panels are resized / window dims change.
 *   - When no slot is registered (e.g. a future preset that omits the
 *     viewer3d panel), the wrapper hides itself but `<Viewer3DPanel>`
 *     stays mounted — the WebGL context survives the temporary absence.
 *
 * z-index = 1 keeps the viewer above the layout grid's background but
 * BELOW panel separators (z = 5 in `LayoutGrid`'s splitter styles) so
 * resize handles remain clickable through the edges of the viewer.
 */
export function PersistentViewer3D() {
  // useSyncExternalStore subscribes us to slot changes; React picks
  // up the new element via its identity (or null) and re-runs the
  // ResizeObserver effect below.
  const slotEl = useSyncExternalStore(
    viewerSlotRegistry.subscribe,
    () => viewerSlotRegistry.current,
    () => null,
  )

  const [rect, setRect] = useState(null)
  const wrapperRef = useRef(null)

  useEffect(() => {
    if (!slotEl) {
      setRect(null)
      return undefined
    }
    const sync = () => {
      const r = slotEl.getBoundingClientRect()
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(slotEl)
    // Window-level resize also affects the bbox even when the slot's
    // own size hasn't changed (e.g. side panel collapses).
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [slotEl])

  const visible = !!rect

  return (
    <div
      ref={wrapperRef}
      className="persistent-viewer3d"
      style={{
        position: 'fixed',
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        // Visibility (not display) keeps the inner Canvas attached to the
        // DOM even when no slot is registered — display:none on a Canvas
        // ancestor would trigger a layout pass that drops WebGL state in
        // some browsers.
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
        zIndex: 1,
        overflow: 'hidden',
      }}
    >
      <Viewer3DPanel />
    </div>
  )
}

/**
 * Layout-grid placeholder for the `viewer3d` panel id.
 *
 * Renders an empty div that occupies its cell's box. Registers itself
 * with the slot registry so `<PersistentViewer3D>` knows where to
 * overlay. The Canvas itself never lives here — preset swaps remount
 * THIS div freely without touching the WebGL context.
 */
export function Viewer3DSlot() {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return undefined
    return viewerSlotRegistry.register(ref.current)
  }, [])
  return <div ref={ref} className="viewer3d-slot" style={{ width: '100%', height: '100%' }} />
}
