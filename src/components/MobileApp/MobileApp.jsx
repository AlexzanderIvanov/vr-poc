import React, { useState } from 'react'
import { useStore } from '../../state/store'
import { useCornerAnalysisData } from '../../hooks/useAppInit'
import { PANELS } from '../Layout/panels'
import { LoadingOverlay } from '../HUD/LoadingOverlay'
import { CornerAnalysisPanel } from '../Corners/CornerAnalysisPanel'
import { MobilePlaybackBar } from './MobilePlaybackBar'
import { MobileTabBar, MOBILE_TABS } from './MobileTabBar'
import { MobileSettingsSheet } from './MobileSettingsSheet'
import { PersistentViewer3D } from '../Viewer3D/PersistentViewer3D'
import { Viewer3DErrorBoundary } from '../Viewer3D/Viewer3DErrorBoundary'

/**
 * Mobile presentation root.
 *
 * Completely separate layout from `<DesktopApp>`. Both share the same data
 * pipes (Zustand store, `useAppInit` hooks, the `PANELS` registry) so any
 * derivation we add (sector deltas, corner analysis, GPS-speed smoothing,
 * …) is identical on both platforms.
 *
 * Layout:
 *
 *   ┌────────────────────────────────┐
 *   │ Header (title)                 │
 *   ├────────────────────────────────┤
 *   │                                │
 *   │      Active panel              │ ← single panel fills the body;
 *   │      (3D / Map / Charts / Δ)   │   user switches via bottom tabs
 *   │                                │
 *   ├────────────────────────────────┤
 *   │ ▶  ━━━━●━━━━━  1.49 / 117.10s │ ← persistent playback bar
 *   ├────────────────────────────────┤
 *   │ 3D │ Map │ Tel │ Δ │ ⚙ More    │ ← bottom tab bar
 *   └────────────────────────────────┘
 *
 * Tapping ⚙ slides up `<MobileSettingsSheet>` with camera mode, compare
 * mode, lap visibility, and corner-analysis toggle.
 */
export function MobileApp() {
  const laps               = useStore((s) => s.laps)
  const manifest           = useStore((s) => s.manifest)
  const cornerAnalysisMode = useStore((s) => s.cornerAnalysisMode)
  const cornerData         = useCornerAnalysisData()

  // Active main-content tab. `'settings'` is special — it opens the bottom
  // sheet instead of swapping the main panel.
  const [activeTab, setActiveTab] = useState('viewer3d')
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!manifest) return <div className="mobile-shell"><div className="loading">Loading…</div></div>

  // Resolve the active panel from the shared registry. New panel types
  // (e.g. corner-summary) only need an entry in `panels.jsx` and a tab
  // here.
  const activePanel = PANELS[activeTab]
  const ActiveComponent = activePanel?.component
  const activePanelTitle = activePanel?.title ?? ''

  const handleTab = (key) => {
    if (key === 'settings') {
      setSettingsOpen(true)
      return
    }
    setActiveTab(key)
  }

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-header-title">{activePanelTitle}</div>
        {laps[0]?.label && (
          <div className="mobile-header-sub">{laps[0].label}</div>
        )}
      </header>

      <main className="mobile-body">
        {ActiveComponent ? <ActiveComponent /> : <div className="panel-empty">Pick a panel</div>}
        <LoadingOverlay />
        {/* Corner-analysis panel slides in as an overlay on whichever tab is
            active — same component as desktop so the metric formatting stays
            in lockstep. */}
        {cornerAnalysisMode && cornerData && (
          <CornerAnalysisPanel cornerData={cornerData} laps={laps} />
        )}
      </main>

      <MobilePlaybackBar />
      <MobileTabBar
        tabs={MOBILE_TABS}
        activeTab={activeTab}
        onTab={handleTab}
      />

      <MobileSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Persistent r3f Canvas — survives tab swaps between 3D / Map /
          Telemetry / Delta. Its CSS rect tracks the `<Viewer3DSlot>`
          rendered when the user is on the 3D tab; hidden (but still
          mounted) on every other tab. Error-bounded so a Canvas crash
          can't kill the tab nav / playback bar. */}
      <Viewer3DErrorBoundary>
        <PersistentViewer3D />
      </Viewer3DErrorBoundary>
    </div>
  )
}
