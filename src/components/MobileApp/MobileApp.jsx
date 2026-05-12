import React, { useState } from 'react'
import { useStore } from '../../state/store'
import { useCornerAnalysisData } from '../../hooks/useAppInit'
import { PANELS } from '../Layout/panels'
import { LoadingOverlay } from '../HUD/LoadingOverlay'
import { CornerAnalysisPanel } from '../Corners/CornerAnalysisPanel'
import { MobileTabBar, MOBILE_TABS } from './MobileTabBar'
import { MobileSettingsSheet } from './MobileSettingsSheet'
import { MobileTelemetryPanel } from './MobileTelemetryPanel'
import { MobileViewerHUD } from './MobileViewerHUD'
import { MobileLowerChart } from './MobileLowerChart'
import { PersistentViewer3D } from '../Viewer3D/PersistentViewer3D'
import { Viewer3DErrorBoundary } from '../Viewer3D/Viewer3DErrorBoundary'

/**
 * Mobile presentation root.
 *
 * Layout (on the 3D tab):
 *
 *   ┌────────────────────────────┐
 *   │ Header                     │
 *   ├────────────────────────────┤
 *   │                  ┌──────┐  │  ← G-force friction-circle HUD,
 *   │                  │ ⊕    │  │     top-right
 *   │                  │  ◯   │  │
 *   │                  └──────┘  │
 *   │   [tap = play/pause]       │
 *   │      3D scene              │
 *   │                            │
 *   │ ┌────────────────────────┐ │
 *   │ │ ━━━━━━ │ ━━━━━━  km/h │ │  ← RaceBox-style scrolling
 *   │ │     Δs │ ╱╲___       │ │     speed + delta chart,
 *   │ └────────────────────────┘ │     playhead pinned at centre.
 *   │ [3D] [Map] [Speed&G] [Δ] ⚙ │  ← tab bar
 *   └────────────────────────────┘
 *
 * No play/pause button or speed-cycle button anymore — tapping the 3D
 * scene anywhere toggles playback. The scrolling chart's mode pill
 * (bottom-right) swaps the chart's x-axis between time and position.
 * Per-tap-toggle interactions are stopPropagation'd inside their own
 * elements so they don't bubble up as plain taps.
 */
export function MobileApp() {
  const laps               = useStore((s) => s.laps)
  const manifest           = useStore((s) => s.manifest)
  const cornerAnalysisMode = useStore((s) => s.cornerAnalysisMode)
  const setPlaying         = useStore((s) => s.setPlaying)
  const cornerData         = useCornerAnalysisData()

  const [activeTab, setActiveTab] = useState('viewer3d')
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!manifest) return <div className="mobile-shell"><div className="loading">Loading…</div></div>

  // The `telemetry` tab is overridden to a mobile-first detail panel
  // (`MobileTelemetryPanel`) because the desktop's 5-row ECharts
  // stack doesn't fit phone aspect ratios.
  const MOBILE_OVERRIDES = {
    telemetry: { title: 'Speed & G', component: MobileTelemetryPanel },
  }
  const activePanel = MOBILE_OVERRIDES[activeTab] ?? PANELS[activeTab]
  const ActiveComponent = activePanel?.component
  const activePanelTitle = activePanel?.title ?? ''

  const handleTab = (key) => {
    if (key === 'settings') {
      setSettingsOpen(true)
      return
    }
    setActiveTab(key)
  }

  // Tap on the 3D area toggles play / pause.
  //
  // The R3F Canvas lives in `<PersistentViewer3D>` and is
  // `position: fixed` over the Viewer3DSlot rect — DOM-wise it's a
  // SIBLING of `.mobile-body`, not a child, so clicks on it don't
  // bubble through the body. We attach the handler at the
  // `.mobile-shell` level instead, and ignore taps whose target is
  // inside one of the interactive chrome zones (tab bar, header,
  // settings sheet, or any panel content that ISN'T the 3D viewer).
  //
  // The lower chart's drag-to-scrub gesture already
  // `stopPropagation()`s its pointerup, so a chart drag doesn't fire
  // a stray play/pause. A plain tap on the chart DOES fire it — same
  // as tapping the 3D scene — which is the intended UX (the chart
  // is part of the viewer surface).
  const IGNORE_TAP_SELECTORS = ['.mobile-header', '.mobile-tabbar', '.mobile-sheet']
  const onShellClick = (e) => {
    if (activeTab !== 'viewer3d') return
    for (const sel of IGNORE_TAP_SELECTORS) {
      if (e.target.closest?.(sel)) return
    }
    setPlaying((v) => !v)
  }

  return (
    <div className="mobile-shell" onClick={onShellClick}>
      {/* Header hidden on the 3D tab — the scene is full-screen and the
          chrome is minimal there (HUD widget + scrolling chart only).
          Other tabs still show the panel title + lap label header. */}
      {activeTab !== 'viewer3d' && (
        <header className="mobile-header">
          <div className="mobile-header-title">{activePanelTitle}</div>
          {laps[0]?.label && (
            <div className="mobile-header-sub">{laps[0].label}</div>
          )}
        </header>
      )}

      <main className="mobile-body">
        {ActiveComponent ? <ActiveComponent /> : <div className="panel-empty">Pick a panel</div>}
        {activeTab === 'viewer3d' && <MobileViewerHUD />}
        {activeTab === 'viewer3d' && <MobileLowerChart />}
        <LoadingOverlay />
        {cornerAnalysisMode && cornerData && (
          <CornerAnalysisPanel cornerData={cornerData} laps={laps} />
        )}
      </main>

      <MobileTabBar
        tabs={MOBILE_TABS}
        activeTab={activeTab}
        onTab={handleTab}
      />

      <MobileSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Persistent r3f Canvas — survives tab swaps between 3D / Map /
          Telemetry / Delta. Error-bounded so a Canvas crash can't
          kill the tab nav. */}
      <Viewer3DErrorBoundary>
        <PersistentViewer3D />
      </Viewer3DErrorBoundary>
    </div>
  )
}
