import React from 'react'
import { sampleTelemetry } from '../../utils/sampleLap'
import { useStore } from '../../state/store'

export function MobileTelemetryCards({ laps, telemetryData, lapTimeOffset, visibility, show }) {
  // Subscribe to playhead INTERNALLY so the parent doesn't have to — keeps
  // 15 Hz re-renders confined to this small leaf component instead of
  // bubbling up to App and triggering reconciliation of the whole tree.
  const currentTime = useStore((s) => s.playhead)
  if (!show || !laps.length) return null
  return (
    <div className="mobile-telemetry-cards">
      {laps.slice(0, 2).map((lap, idx) => {
        if (!(visibility[lap.id] ?? true)) return null
        const tel = telemetryData[lap.id]
        if (!tel) return null
        const t = currentTime + (idx > 0 ? lapTimeOffset : 0)
        const s = sampleTelemetry(tel.samples, t)
        if (!s) return null
        const isBraking = s.fbp > 10
        const isThrottle = s.tps > 200 && !isBraking
        const phase = isBraking ? 'hud-braking' : isThrottle ? 'hud-throttle' : 'hud-coast'
        return (
          <div key={lap.id} className={`mobile-tel-card ${phase}`} style={{ borderColor: lap.color, '--accent': lap.color }}>
            <div className="mobile-tel-card-header" style={{ background: lap.color }} />
            <div className="hud-bar-row">
              <span className="hud-bar-label">TPS</span>
              <div className="hud-bar"><div className="hud-bar-fill hud-bar-tps" style={{ width: `${(s.tps / 255) * 100}%` }} /></div>
            </div>
            <div className="hud-bar-row">
              <span className="hud-bar-label">BRK</span>
              <div className="hud-bar"><div className="hud-bar-fill hud-bar-brake" style={{ width: `${Math.min(s.fbp / 150 * 100, 100)}%` }} /></div>
            </div>
            <div className="hud-rpm">{Math.round(s.rpm)} RPM</div>
          </div>
        )
      })}
    </div>
  )
}
