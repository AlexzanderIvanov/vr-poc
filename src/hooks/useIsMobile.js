import { useEffect, useState } from 'react'

/**
 * Reactive viewport-class detector. Returns `true` when the viewport is at
 * or below `MOBILE_BREAKPOINT` px wide. Re-renders on resize / orientation
 * change.
 *
 * The breakpoint mirrors the CSS `@media (max-width: 768px)` rules in
 * `styles.css` so JS-driven layout decisions stay in lock-step with the
 * CSS-driven visibility rules.
 *
 * Initial value is computed eagerly on first render so the platform
 * router (`<App>`) picks the correct sub-tree on the first paint — no
 * desktop-then-mobile flash.
 */
export const MOBILE_BREAKPOINT = 768

const readIsMobile = () =>
  typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(readIsMobile)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
    const update = (e) => setIsMobile(e.matches)
    // `addEventListener('change', …)` is the standard API; older Safari uses
    // `addListener`. Support both.
    if (mql.addEventListener) mql.addEventListener('change', update)
    else mql.addListener?.(update)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', update)
      else mql.removeListener?.(update)
    }
  }, [])

  return isMobile
}
