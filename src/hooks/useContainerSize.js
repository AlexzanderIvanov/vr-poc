import { useEffect, useRef, useState } from 'react'

/**
 * Track an element's CSS-pixel size via ResizeObserver.
 *
 * Returns `[ref, { w, h }]`. Attach the ref to whatever DOM node you want to
 * observe; the size state updates whenever its bounding rect changes.
 *
 * Updates are floored to integer pixels and skipped if dimensions are
 * unchanged, so consumers (e.g. canvas backing-store sizing) don't churn.
 */
export function useContainerSize(initial = { w: 0, h: 0 }) {
  const ref = useRef(null)
  const [size, setSize] = useState(initial)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const update = () => {
      const r = el.getBoundingClientRect()
      const w = Math.max(1, Math.floor(r.width))
      const h = Math.max(1, Math.floor(r.height))
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    update()
    const ro = new ResizeObserver(() => requestAnimationFrame(update))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}
