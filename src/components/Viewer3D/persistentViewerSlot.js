/**
 * Persistent-viewer slot registry.
 *
 * Problem:
 *   When the user switches layout preset (default → analysis → charts),
 *   the `viewer3d` panel sits at a DIFFERENT position in the React
 *   component tree under each preset (a `<Panel>` from
 *   react-resizable-panels in `default`, a `<div>` cell in the flat
 *   CSS grid for `analysis`, etc). React reconciliation can't match
 *   two different parent chains, so it unmounts the prior instance and
 *   mounts a fresh one — destroying the WebGL context, forcing the
 *   r3f Canvas to re-create itself, GPU-uploading every texture and
 *   geometry again, and producing the visible "asset reload" flicker.
 *
 *   `useGLTF`'s parsed-GLB cache already prevents an HTTP refetch, but
 *   the per-Canvas WebGL state cannot be cached at the loader layer.
 *
 * Solution:
 *   Keep `<Viewer3DPanel>` mounted at ONE stable position in the React
 *   tree (above `<LayoutGrid>` — see `<PersistentViewer3D>`). In the
 *   layout grid, the `viewer3d` panel becomes a thin `<Viewer3DSlot>`
 *   placeholder that only reserves cell space and publishes its own
 *   DOM element to this registry. `<PersistentViewer3D>` subscribes,
 *   tracks the slot's bounding box via `ResizeObserver`, and absolute-
 *   positions the Canvas wrapper to overlay it. The Canvas itself
 *   never unmounts; only the CSS rect moves.
 *
 * The registry is a tiny pub/sub so we avoid a context provider — the
 * persistent viewer lives outside the layout grid's React subtree, so
 * any context-based wiring would have to be hoisted to App level and
 * forced through every consumer regardless.
 */

let currentSlot = null
const subscribers = new Set()

function notify() {
  subscribers.forEach((fn) => fn(currentSlot))
}

export const viewerSlotRegistry = {
  /**
   * Register a DOM element as the active viewer slot. Returns an
   * unregister function. When the same element unmounts AND is still
   * the current slot, the registry clears to `null`. If another slot
   * has claimed it in the meantime (preset swap where the new mount
   * fires before the old unmount), this unregister becomes a no-op.
   */
  register(el) {
    currentSlot = el
    notify()
    return () => {
      if (currentSlot === el) {
        currentSlot = null
        notify()
      }
    }
  },

  subscribe(fn) {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  },

  get current() { return currentSlot },
}
