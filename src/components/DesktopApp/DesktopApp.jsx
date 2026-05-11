import React, { useCallback, useMemo, useState } from 'react'
import { useStore } from '../../state/store'
import { useCornerAnalysisData, useRecorder } from '../../hooks/useAppInit'
import { useLapColor } from '../../hooks/useLapColor'
import { CornerAnalysisPanel } from '../Corners/CornerAnalysisPanel'
import { LapSyncControls } from '../HUD/LapSyncControls'
import { LoadingOverlay } from '../HUD/LoadingOverlay'
import { TimeScrubber } from '../HUD/TimeScrubber'
import { VideoOverlay } from '../Video/VideoOverlay'
import { LayoutGrid, LayoutPresetBar } from '../Layout/LayoutGrid'
import { PersistentViewer3D } from '../Viewer3D/PersistentViewer3D'

const MODE_LABELS = {
  standard: 'Standard',
  compare_projected_um981: 'Projected',
  compare_projected_raw: 'Raw Projected',
}
const DEVICE_COLORS = { um982: '#4dd0e1', um981: '#9b7bff', um981raw: '#ffd166' }

function groupLapsBySession(laps) {
  const groups = new Map()
  for (const lap of laps) {
    const sid = lap.session_id ?? 'unknown'
    if (!groups.has(sid)) groups.set(sid, [])
    groups.get(sid).push(lap)
  }
  return groups
}

/**
 * One row in the lap-list sidebar. Pulled into its own component so we
 * can subscribe to the lap's presentation colour via `useLapColor`
 * (hooks can't run in a loop in the parent). When a future
 * `<LapColorPicker>` writes `setLapColor(id, hex)`, this row's swatch
 * re-renders along with every other surface that reads through the
 * same hook.
 */
function LapListRow({ lap, visibility, syncOffset, onToggle, onSyncChange }) {
  const lapColor = useLapColor(lap.id)
  return (
    <div className="lap-entry">
      <label className="lap-row">
        <input
          type="checkbox"
          checked={visibility[lap.id] ?? true}
          onChange={() => onToggle(lap.id)}
        />
        <span className="lap-swatch" style={{ background: lapColor }} />
        <span className="lap-info">
          <span className="lap-name">{lap.label}</span>
          <span className="lap-tags">
            <span
              className="device-badge"
              style={{ borderColor: DEVICE_COLORS[lap.device_id] || '#888' }}
            >{(lap.device_id || '?').toUpperCase()}</span>
            <span className="mode-badge">{MODE_LABELS[lap.mode] || lap.mode || '?'}</span>
          </span>
        </span>
      </label>
      {syncOffset && (
        <LapSyncControls lap={lap} syncOffset={syncOffset} onSyncChange={onSyncChange} />
      )}
    </div>
  )
}

function getRefWarnings(laps, visibility) {
  const warnings = []
  for (const lap of laps) {
    if (!lap.reference_lap_id) continue
    if ((visibility[lap.id]) && visibility[lap.reference_lap_id] === false) {
      warnings.push({ lapId: lap.id, message: `Reference lap hidden for "${lap.label}"` })
    }
  }
  return warnings
}

/**
 * Desktop presentation root.
 *
 * Layout responsibilities only — all data loading, playback wiring, and
 * cross-platform keybindings live in `useAppInit()` (called by `<App>`).
 * Reads everything else straight from the Zustand store.
 *
 * Mobile UA users see `<MobileApp>` instead — the platform router in
 * `App.jsx` picks based on `useIsMobile()`.
 */
export function DesktopApp() {
  // ---------- store reads ----------
  const laps                = useStore((s) => s.laps)
  const playing             = useStore((s) => s.playing)
  const speed               = useStore((s) => s.speed)
  const focusLapId          = useStore((s) => s.focusLapId)
  const cameraMode          = useStore((s) => s.cameraMode)
  const visibility          = useStore((s) => s.visibility)
  const syncOffsets         = useStore((s) => s.syncOffsets)
  const compareMode         = useStore((s) => s.compareMode)
  const cornerAnalysisMode  = useStore((s) => s.cornerAnalysisMode)
  const videoOverlayOn      = useStore((s) => s.videoOverlayOn)
  const sectorStartTime     = useStore((s) => s.sectorStartTime)

  // ---------- store actions ----------
  const setPlaying          = useStore((s) => s.setPlaying)
  const setSpeed            = useStore((s) => s.setSpeed)
  const setCameraMode       = useStore((s) => s.setCameraMode)
  const setFocusLapId       = useStore((s) => s.setFocusLapId)
  const setVisibility       = useStore((s) => s.setVisibility)
  const setSyncOffsets      = useStore((s) => s.setSyncOffsets)
  const setCompareMode      = useStore((s) => s.setCompareMode)
  const setCornerAnalysisMode = useStore((s) => s.setCornerAnalysisMode)
  const setVideoOverlayOn   = useStore((s) => s.setVideoOverlayOn)

  // ---------- shared data pipes ----------
  const cornerData          = useCornerAnalysisData()
  const { recording, toggle: toggleRecording } = useRecorder()

  // ---------- UI-local ----------
  const [mobileDrawer, setMobileDrawer] = useState(null) // null | 'menu' | 'map' | 'data'
  const [showCarHuds, setShowCarHuds]   = useState(true)

  // Cycle helpers for the mobile-toolbar shortcuts left visible on small
  // tablet widths — desktop layout uses the dropdowns below.
  const CAMERA_MODES = ['chase', 'hood', 'side', 'top', 'free']
  const CAMERA_LABELS = { chase: 'CHS', hood: 'HOOD', side: 'SIDE', top: 'TOP', free: 'FREE' }
  const SPEED_OPTIONS = [0.25, 0.5, 1, 2]
  const cycleCamera = () => {
    const i = CAMERA_MODES.indexOf(cameraMode)
    setCameraMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
  }
  const cycleSpeed = () => {
    const i = SPEED_OPTIONS.indexOf(speed)
    setSpeed(SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length])
  }

  const toggleLap = (lapId) => setVisibility((s) => ({ ...s, [lapId]: !s[lapId] }))
  const handleSyncChange = useCallback(
    (lapId, offset) => setSyncOffsets((prev) => ({ ...prev, [lapId]: offset })),
    [setSyncOffsets],
  )

  const sessionGroups = useMemo(() => groupLapsBySession(laps), [laps])
  const warnings = useMemo(() => getRefWarnings(laps, visibility), [laps, visibility])

  return (
    <div className={`app-shell ${mobileDrawer ? `drawer-${mobileDrawer}-open` : ''}`}>
      {/* Mobile/tablet toolbar — visible on small viewports via CSS rules. */}
      <div className="mobile-toolbar">
        <button className="mtb-btn" aria-label="Menu" onClick={() => setMobileDrawer(d => d === 'menu' ? null : 'menu')}>{'☰'}</button>
        <button className="mtb-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(v => !v)}>{playing ? '⏸' : '▶'}</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Speed ${speed}x — tap to cycle`} onClick={cycleSpeed}>{speed}x</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Camera ${cameraMode} — tap to cycle`} onClick={cycleCamera}>{CAMERA_LABELS[cameraMode] || cameraMode.toUpperCase().slice(0, 4)}</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Compare by ${compareMode} — tap to toggle`} onClick={() => setCompareMode(m => m === 'time' ? 'position' : 'time')}>{compareMode === 'time' ? 'T' : 'P'}</button>
        <button className={`mtb-btn mtb-btn-text ${cornerAnalysisMode ? 'mtb-btn-active' : ''}`} aria-label="Corner analysis" onClick={() => setCornerAnalysisMode(v => !v)}>{'◎'}</button>
        {laps.some(l => l.video_path) && (
          <button className={`mtb-btn ${videoOverlayOn ? 'mtb-btn-active' : ''}`} aria-label="Lap video" onClick={() => setVideoOverlayOn(v => !v)}>{'🎥'}</button>
        )}
        <button className="mtb-btn" aria-label="Map" onClick={() => setMobileDrawer(d => d === 'map' ? null : 'map')}>{'🗺'}</button>
        <button className="mtb-btn" aria-label="Charts" onClick={() => setMobileDrawer(d => d === 'data' ? null : 'data')}>{'📈'}</button>
        <button className={`mtb-btn ${showCarHuds ? 'mtb-btn-active' : ''}`} aria-label="Toggle car data" onClick={() => setShowCarHuds(v => !v)}>{'📊'}</button>
      </div>

      {/* Lap video overlay — only renders when the focused lap's manifest entry
          carries ``video_path`` (i.e. the /video route). PIP-style bottom-right
          on desktop; can be hidden / re-opened via the toolbar toggle. */}
      <VideoOverlay
        visible={videoOverlayOn}
        lap={laps.find(l => l.id === focusLapId) ?? laps[0]}
        playing={playing}
        speed={speed}
        sectorStartTime={sectorStartTime}
        onClose={() => setVideoOverlayOn(false)}
      />

      {/* Drawer backdrop — closes the active drawer on tap. */}
      {mobileDrawer && <div className="mobile-drawer-backdrop" onClick={() => setMobileDrawer(null)} />}

      <div className={`hud ${mobileDrawer === 'menu' ? 'hud-open' : ''}`}>
        <div className="hud-section">
          <h1>Virtualization Web POC</h1>
          <p>Track + M3 + lap playback with ghost comparisons and camera presets.</p>
        </div>

        <LayoutPresetBar />

        <div className="hud-section controls-grid">
          <div className="controls-row">
            <button onClick={() => setPlaying((v) => !v)}>{playing ? 'Pause' : 'Play'}</button>
            <button className={`rec-btn ${recording ? 'rec-btn-active' : ''}`} onClick={toggleRecording}>
              {recording ? '■ Stop Rec' : '● Rec'}
            </button>
          </div>
          <label>Speed<select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0.25}>0.25x</option><option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option>
          </select></label>
          <label>Camera<select value={cameraMode} onChange={(e) => setCameraMode(e.target.value)}>
            <option value="chase">Chase</option><option value="hood">Hood</option><option value="side">Side</option><option value="top">Top</option><option value="free">Free</option>
          </select></label>
          <label>Follow<select value={focusLapId ?? ''} onChange={(e) => setFocusLapId(e.target.value)}>
            {laps.map((lap) => <option key={lap.id} value={lap.id}>{lap.label}</option>)}
          </select></label>
          <label>Compare<select value={compareMode} onChange={(e) => setCompareMode(e.target.value)}>
            <option value="time">Time</option>
            <option value="position">Position</option>
          </select></label>
          <button
            className={cornerAnalysisMode ? 'active-toggle' : ''}
            onClick={() => setCornerAnalysisMode(v => !v)}
            aria-pressed={cornerAnalysisMode}
            title="Mark brake / throttle key-points on track + per-corner meter deltas"
          >
            {cornerAnalysisMode ? '◉' : '◎'} Corner analysis
          </button>
          {laps.some(l => l.video_path) && (
            <button
              className={videoOverlayOn ? 'active-toggle' : ''}
              onClick={() => setVideoOverlayOn(v => !v)}
              aria-pressed={videoOverlayOn}
              title="Show / hide synchronised lap video overlay"
            >
              {videoOverlayOn ? '◉' : '◎'} Lap video
            </button>
          )}
        </div>

        <TimeScrubber mode="desktop" />

        {warnings.length > 0 && (
          <div className="hud-section warnings">
            {warnings.map((w) => <div key={w.lapId} className="warning-row">{w.message}</div>)}
          </div>
        )}

        <div className="hud-section lap-list">
          {Array.from(sessionGroups.entries()).map(([sessionId, sessionLaps]) => (
            <div key={sessionId} className="session-group">
              <div className="session-header">Session {sessionId}</div>
              {sessionLaps.map((lap) => (
                <LapListRow
                  key={lap.id}
                  lap={lap}
                  visibility={visibility}
                  syncOffset={syncOffsets[lap.id]}
                  onToggle={toggleLap}
                  onSyncChange={handleSyncChange}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="viewer-shell">
        <LayoutGrid />
        <LoadingOverlay />
        {cornerAnalysisMode && cornerData && <CornerAnalysisPanel cornerData={cornerData} laps={laps} />}
      </div>

      {/* Mounted ONCE for the lifetime of the desktop app — keeps the
          r3f Canvas + WebGL context alive across layout-preset swaps.
          Its CSS rect tracks whichever `<Viewer3DSlot>` is currently
          rendered inside `<LayoutGrid>`. */}
      <PersistentViewer3D />
    </div>
  )
}
