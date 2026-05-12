import React, { useState } from 'react'
import { useCornerAnalysisData, useRecorder } from '../../hooks/useAppInit'
import { useDesktopShortcuts } from '../../hooks/useDesktopShortcuts'
import { useStore } from '../../state/store'
import { CornerAnalysisPanel } from '../Corners/CornerAnalysisPanel'
import { LoadingOverlay } from '../HUD/LoadingOverlay'
import { LayoutGrid, LayoutPresetBar } from '../Layout/LayoutGrid'
import { PersistentViewer3D } from '../Viewer3D/PersistentViewer3D'
import { Viewer3DErrorBoundary } from '../Viewer3D/Viewer3DErrorBoundary'
import { SessionDrawer } from '../Sessions/SessionDrawer'
import { ShortcutsHelp } from '../Shortcuts/ShortcutsHelp'

const CAMERA_MODES = ['chase', 'hood', 'side', 'top', 'free']
const CAMERA_LABELS = { chase: 'Chase', hood: 'Hood', side: 'Side', top: 'Top', free: 'Free' }
const SPEED_OPTIONS = [0.25, 0.5, 1, 2]

/**
 * Compact action button used in the desktop top bar.
 *
 * Visible button + the keyboard shortcut hint right next to it, so
 * the user can see what's available without opening the help
 * overlay. Clicking is functionally identical to pressing the
 * shortcut. `is-active` puts the button into the accent state for
 * toggle-like actions (recording, compare-position, corner mode).
 */
function ToolbarBtn({ label, hint, active, onClick, title, color }) {
  return (
    <button
      type="button"
      className={`desktop-toolbar-btn ${active ? 'is-active' : ''}`}
      onClick={onClick}
      title={title}
      style={color ? { borderColor: color } : undefined}
    >
      <span className="desktop-toolbar-btn-label">{label}</span>
      <span className="desktop-toolbar-btn-hint">{hint}</span>
    </button>
  )
}

/**
 * Desktop presentation root.
 *
 * No left HUD any more. Everything that used to live there has moved
 * to one of three surfaces:
 *
 *   • Top bar — a compact action toolbar (Play, Rec, Camera, Follow,
 *     Compare, Corner, Speed) where every button is also a visual
 *     shortcut cheat-sheet: each shows its keyboard hint next to the
 *     label so the user can see what's available without opening the
 *     help overlay. Clicking a button does the same thing as pressing
 *     its shortcut. Layout-preset chips and the sessions / help
 *     buttons sit on either side.
 *   • Keyboard — `useDesktopShortcuts` registers every binding listed
 *     on those buttons (plus a few more like `S` for the drawer and
 *     `?` for the help overlay). Both inputs converge on the same
 *     store actions.
 *   • Bottom bar — slim time scrubber strip so playback position
 *     stays visible and draggable.
 *   • Session drawer — sessions / lap browser slides out from the
 *     left, fed by mocked data for now (real backend wiring later).
 *
 * Layout responsibilities only — data loading, playback wiring and
 * cross-platform space-to-toggle live in `useAppInit()` (called by
 * `<App>`).
 */
export function DesktopApp() {
  const laps               = useStore((s) => s.laps)
  const playing            = useStore((s) => s.playing)
  const speed              = useStore((s) => s.speed)
  const cameraMode         = useStore((s) => s.cameraMode)
  const focusLapId         = useStore((s) => s.focusLapId)
  const visibility         = useStore((s) => s.visibility)
  const compareMode        = useStore((s) => s.compareMode)
  const cornerAnalysisMode = useStore((s) => s.cornerAnalysisMode)

  const setPlaying            = useStore((s) => s.setPlaying)
  const setSpeed              = useStore((s) => s.setSpeed)
  const setCameraMode         = useStore((s) => s.setCameraMode)
  const setFocusLapId         = useStore((s) => s.setFocusLapId)
  const setCompareMode        = useStore((s) => s.setCompareMode)
  const setCornerAnalysisMode = useStore((s) => s.setCornerAnalysisMode)

  const { recording, toggle: toggleRecording } = useRecorder()
  const cornerData = useCornerAnalysisData()

  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  useDesktopShortcuts({
    onToggleSessions: () => setSessionsOpen((v) => !v),
    onToggleHelp:     () => setHelpOpen((v) => !v),
    onCloseHelp:      () => setHelpOpen(false),
    toggleRecording,
  })

  // Cycle helpers — same logic the shortcut listener uses, kept
  // here so the visible buttons stay in lock-step.
  const cycleCamera = () => {
    const i = CAMERA_MODES.indexOf(cameraMode)
    setCameraMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
  }
  const cycleFocus = () => {
    const visibleIds = laps.filter((l) => visibility[l.id] !== false).map((l) => l.id)
    if (!visibleIds.length) return
    const i = visibleIds.indexOf(focusLapId)
    setFocusLapId(visibleIds[(i + 1) % visibleIds.length])
  }
  const focusLap = laps.find((l) => l.id === focusLapId)
  const focusLapLabel = focusLap?.label
    ? focusLap.label.length > 18
      ? focusLap.label.slice(0, 18) + '…'
      : focusLap.label
    : '—'

  return (
    <div className="app-shell desktop-app-shell">
      <div className="desktop-topbar">
        {/* Left: drawer toggle. */}
        <button
          type="button"
          className={`desktop-topbar-btn ${sessionsOpen ? 'is-active' : ''}`}
          onClick={() => setSessionsOpen((v) => !v)}
          title="Sessions browser (S)"
        >
          <span className="desktop-topbar-btn-label">☰ Sessions</span>
          <span className="desktop-topbar-btn-hint">S</span>
        </button>

        {/* Compact action toolbar — buttons + visible shortcut hints. */}
        <div className="desktop-toolbar">
          <ToolbarBtn
            label={playing ? '⏸ Pause' : '▶ Play'}
            hint="Space"
            active={playing}
            onClick={() => setPlaying((v) => !v)}
            title="Play / pause"
          />
          <ToolbarBtn
            label={recording ? '■ Stop Rec' : '● Rec'}
            hint="R"
            active={recording}
            onClick={toggleRecording}
            title="Toggle recording"
          />
          <ToolbarBtn
            label={`📷 ${CAMERA_LABELS[cameraMode] ?? cameraMode}`}
            hint="C"
            onClick={cycleCamera}
            title={`Cycle camera mode (now: ${CAMERA_LABELS[cameraMode] ?? cameraMode})`}
          />
          <ToolbarBtn
            label={`⊙ ${focusLapLabel}`}
            hint="F"
            onClick={cycleFocus}
            title="Cycle focus lap (camera follows)"
          />
          <ToolbarBtn
            label={`⇄ ${compareMode === 'time' ? 'Time' : 'Position'}`}
            hint="T"
            active={compareMode === 'position'}
            onClick={() => setCompareMode((m) => (m === 'time' ? 'position' : 'time'))}
            title="Toggle compare mode (time / position)"
          />
          <ToolbarBtn
            label={`◎ Corner`}
            hint="N"
            active={cornerAnalysisMode}
            onClick={() => setCornerAnalysisMode((v) => !v)}
            title="Toggle corner-analysis overlay"
          />
          <ToolbarBtn
            label={`${speed}×`}
            hint="1-4"
            onClick={() => {
              const i = SPEED_OPTIONS.indexOf(speed)
              setSpeed(SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length])
            }}
            title="Playback speed (1=0.25× · 2=0.5× · 3=1× · 4=2×)"
          />
        </div>

        {/* Centre: layout-preset chips. */}
        <div className="desktop-topbar-spacer">
          <LayoutPresetBar />
        </div>

        {/* Right: help. */}
        <button
          type="button"
          className={`desktop-topbar-btn ${helpOpen ? 'is-active' : ''}`}
          onClick={() => setHelpOpen((v) => !v)}
          title="Keyboard shortcuts (? or H)"
        >
          <span className="desktop-topbar-btn-label">?</span>
        </button>
      </div>

      <SessionDrawer open={sessionsOpen} onClose={() => setSessionsOpen(false)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <div className="viewer-shell">
        <LayoutGrid />
        <LoadingOverlay />
        {cornerAnalysisMode && cornerData && (
          <CornerAnalysisPanel cornerData={cornerData} laps={laps} />
        )}
      </div>

      <Viewer3DErrorBoundary>
        <PersistentViewer3D />
      </Viewer3DErrorBoundary>
    </div>
  )
}
