import React, { useMemo, useState } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { MOCK_SESSIONS } from './mockSessions'

/**
 * Session / lap browser. Replaces the old left-side HUD on the desktop
 * layout. Collapsed by default — exposed via a small `Sessions` button
 * in the top bar; expands into an overlay panel pinned to the left
 * edge.
 *
 * Sessions today come from `mockSessions.js` (placeholder data); when
 * the backend lands the data feed swaps to `GET /sessions` and the
 * component stays the same. IDs in the mock are kept compatible with
 * the manifest the app currently loads, so laps already on screen
 * (matching by `lap.id`) show up checked and can be toggled via the
 * existing `visibility` slice. Laps that aren't loaded yet stay
 * browse-only — their checkbox is disabled with a tooltip noting the
 * back-end isn't wired up. That's the surface the backend wiring
 * eventually replaces with `loadLap(id)`.
 *
 * Lap rows show: visibility checkbox, lap-colour swatch (resolved
 * through `useLapColor` so the picker can recolour it later), lap
 * number / OUT-IN label, formatted lap time, and a small "best"
 * badge on the session's fastest lap.
 */

const FLAG_LABELS = { best: 'BEST', red: 'RED' }

function LapRow({ lap, loaded, color, onToggle, disabled }) {
  return (
    <label className={`session-drawer-lap ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={loaded}
        onChange={onToggle}
        disabled={disabled}
        title={disabled ? 'Not yet wired up to the backend' : ''}
      />
      <span
        className="session-drawer-lap-swatch"
        style={{ background: loaded ? color : 'rgba(255,255,255,0.08)' }}
      />
      <span className="session-drawer-lap-num">
        {typeof lap.number === 'number' ? `Lap ${lap.number}` : lap.number}
      </span>
      <span className="session-drawer-lap-time">{lap.time}</span>
      {lap.flag && (
        <span className={`session-drawer-lap-flag flag-${lap.flag}`}>
          {FLAG_LABELS[lap.flag] || lap.flag.toUpperCase()}
        </span>
      )}
    </label>
  )
}

export function SessionDrawer({ open, onClose }) {
  const laps = useStore((s) => s.laps)
  const visibility = useStore((s) => s.visibility)
  const setVisibility = useStore((s) => s.setVisibility)
  const lapColorMap = useLapColorMap()

  // Which session header rows are expanded. Defaults to "expand the
  // session(s) containing currently-loaded laps" so the user
  // immediately sees their working set without clicking around.
  const [expandedSessionIds, setExpandedSessionIds] = useState(() => {
    const loadedIds = new Set(laps.map((l) => l.id))
    const open = new Set()
    for (const sess of MOCK_SESSIONS) {
      if (sess.laps.some((l) => loadedIds.has(l.id))) open.add(sess.id)
    }
    return open
  })

  const loadedLapIds = useMemo(() => new Set(laps.map((l) => l.id)), [laps])

  const toggleSession = (id) => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleLap = (lapId) => {
    if (!loadedLapIds.has(lapId)) return  // browse-only until backend lands
    setVisibility((prev) => ({ ...prev, [lapId]: !(prev[lapId] ?? true) }))
  }

  if (!open) return null

  return (
    <>
      <div className="session-drawer-backdrop" onClick={onClose} />
      <aside className="session-drawer">
        <header className="session-drawer-header">
          <span className="session-drawer-title">Sessions</span>
          <button
            type="button"
            className="session-drawer-close"
            onClick={onClose}
            aria-label="Close sessions drawer"
          >
            ×
          </button>
        </header>
        <div className="session-drawer-body">
          {MOCK_SESSIONS.map((sess) => {
            const isOpen = expandedSessionIds.has(sess.id)
            const loadedInSession = sess.laps.filter((l) => loadedLapIds.has(l.id))
            return (
              <section key={sess.id} className="session-drawer-session">
                <button
                  type="button"
                  className="session-drawer-session-header"
                  onClick={() => toggleSession(sess.id)}
                >
                  <span className="session-drawer-chevron">{isOpen ? '▾' : '▸'}</span>
                  <span className="session-drawer-session-name">{sess.name}</span>
                  <span className="session-drawer-session-meta">
                    {sess.date} · {sess.deviceId}
                  </span>
                  {loadedInSession.length > 0 && (
                    <span className="session-drawer-session-loaded">
                      {loadedInSession.length} loaded
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="session-drawer-laps">
                    {sess.laps.map((l) => {
                      const loaded = loadedLapIds.has(l.id)
                      return (
                        <LapRow
                          key={l.id}
                          lap={l}
                          loaded={loaded && (visibility[l.id] ?? true)}
                          color={loaded ? lapColorMap[l.id] : '#7b8399'}
                          onToggle={() => toggleLap(l.id)}
                          disabled={!loaded}
                        />
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
        <footer className="session-drawer-footer">
          <span className="session-drawer-hint">
            Mocked listing. Real load from backend coming.
          </span>
        </footer>
      </aside>
    </>
  )
}
