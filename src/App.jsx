import React from 'react'
import { useStore } from './state/store'
import { useAppInit } from './hooks/useAppInit'
import { useIsMobile } from './hooks/useIsMobile'
import { DesktopApp } from './components/DesktopApp/DesktopApp'
import { MobileApp } from './components/MobileApp/MobileApp'
import { VRApp } from './components/VRApp/VRApp'

const isVRRoute = () => typeof window !== 'undefined' && window.location?.pathname === '/vr'

/**
 * Platform router.
 *
 * `<App>` itself owns nothing visible — it only:
 *
 *   1. Calls `useAppInit()` to mount the shared data pipes (DataService
 *      loader, playback RAF loop, viewport auto-follow, panel-resize
 *      tracker, space-to-play keybinding). Both the desktop and mobile
 *      sub-trees read from the same Zustand store these hooks populate.
 *   2. Picks `<DesktopApp>` or `<MobileApp>` based on viewport via the
 *      reactive `useIsMobile()` hook. Resizing the window across the
 *      breakpoint hot-swaps the layout without a page reload.
 *
 * The two platform components share zero JSX — adding a new mobile-only
 * panel or restructuring the desktop layout touches one file each, never
 * both. Anything that should stay in lock-step (data derivation, lap
 * metric formatting, …) goes through `useAppInit` / `state/store` /
 * `utils/*` so both layouts inherit the change automatically.
 */
export default function App() {
  useAppInit()
  const isMobile = useIsMobile()
  const manifest = useStore((s) => s.manifest)

  if (!manifest) {
    return (
      <div className={isMobile ? 'mobile-shell' : 'app-shell'}>
        <div className="loading">Loading assets…</div>
      </div>
    )
  }

  // Experimental VR layout — full-screen 3D + transparent overlays.
  // Pinned to desktop (mobile gets MobileApp regardless of pathname).
  if (!isMobile && isVRRoute()) return <VRApp />

  return isMobile ? <MobileApp /> : <DesktopApp />
}
