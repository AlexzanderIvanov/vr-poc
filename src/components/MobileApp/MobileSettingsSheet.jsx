import React from 'react'
import { useStore } from '../../state/store'
import { useLapColor } from '../../hooks/useLapColor'

// One row in the mobile "Visible laps" list. Subscribes to its lap's
// presentation colour so the swatch repaints when the user picks a new
// one. Pulled out of the parent's render loop because hooks can't be
// called inside `.map(…)`.
function MobileLapRow({ lap, checked, onToggle }) {
  const lapColor = useLapColor(lap.id)
  return (
    <label className="mobile-lap-row">
      <input type="checkbox" checked={checked} onChange={() => onToggle(lap.id)} />
      <span className="lap-swatch" style={{ background: lapColor }} />
      <span className="mobile-lap-label">{lap.label}</span>
    </label>
  )
}

/**
 * Bottom sheet that slides up from below the tab bar when the "More" tab
 * is tapped. Contains the same view-mode toggles the desktop sidebar
 * exposes — camera mode, compare mode, lap visibility, corner-analysis
 * toggle, video-overlay toggle — laid out for one-thumb reach.
 *
 * Subscribes directly to the store; receives only `open` / `onClose`
 * from the parent so it stays self-contained.
 */
const CAMERA_OPTIONS = [
  { value: 'chase', label: 'Chase' },
  { value: 'hood',  label: 'Hood'  },
  { value: 'side',  label: 'Side'  },
  { value: 'top',   label: 'Top'   },
  { value: 'free',  label: 'Free'  },
]

export function MobileSettingsSheet({ open, onClose }) {
  const laps                = useStore((s) => s.laps)
  const cameraMode          = useStore((s) => s.cameraMode)
  const compareMode         = useStore((s) => s.compareMode)
  const focusLapId          = useStore((s) => s.focusLapId)
  const visibility          = useStore((s) => s.visibility)
  const cornerAnalysisMode  = useStore((s) => s.cornerAnalysisMode)

  const setCameraMode         = useStore((s) => s.setCameraMode)
  const setCompareMode        = useStore((s) => s.setCompareMode)
  const setFocusLapId         = useStore((s) => s.setFocusLapId)
  const setVisibility         = useStore((s) => s.setVisibility)
  const setCornerAnalysisMode = useStore((s) => s.setCornerAnalysisMode)

  const toggleLap = (lapId) =>
    setVisibility((s) => ({ ...s, [lapId]: !s[lapId] }))

  return (
    <>
      {open && <div className="mobile-sheet-backdrop" onClick={onClose} />}
      <div className={`mobile-sheet ${open ? 'is-open' : ''}`} role="dialog" aria-modal="true" aria-label="Settings">
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-body">
          <section className="mobile-sheet-section">
            <h3>Camera</h3>
            <div className="mobile-segctl">
              {CAMERA_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={`mobile-segctl-btn ${cameraMode === o.value ? 'is-active' : ''}`}
                  onClick={() => setCameraMode(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </section>

          <section className="mobile-sheet-section">
            <h3>Compare by</h3>
            <div className="mobile-segctl">
              <button
                className={`mobile-segctl-btn ${compareMode === 'time' ? 'is-active' : ''}`}
                onClick={() => setCompareMode('time')}
              >Time</button>
              <button
                className={`mobile-segctl-btn ${compareMode === 'position' ? 'is-active' : ''}`}
                onClick={() => setCompareMode('position')}
              >Position</button>
            </div>
          </section>

          <section className="mobile-sheet-section">
            <h3>Follow lap</h3>
            <select
              className="mobile-select"
              value={focusLapId ?? ''}
              onChange={(e) => setFocusLapId(e.target.value)}
            >
              {laps.map((lap) => (
                <option key={lap.id} value={lap.id}>{lap.label}</option>
              ))}
            </select>
          </section>

          <section className="mobile-sheet-section">
            <h3>Visible laps</h3>
            <div className="mobile-laplist">
              {laps.map((lap) => (
                <MobileLapRow
                  key={lap.id}
                  lap={lap}
                  checked={visibility[lap.id] ?? true}
                  onToggle={toggleLap}
                />
              ))}
            </div>
          </section>

          <section className="mobile-sheet-section">
            <button
              className={`mobile-toggle-row ${cornerAnalysisMode ? 'is-active' : ''}`}
              onClick={() => setCornerAnalysisMode((v) => !v)}
            >
              <span>Corner analysis</span>
              <span className="mobile-toggle-pill">{cornerAnalysisMode ? 'ON' : 'OFF'}</span>
            </button>
          </section>

          <button className="mobile-sheet-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  )
}
