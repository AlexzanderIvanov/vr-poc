import React from 'react'
import { sampleTelemetry } from '../../utils/sampleLap'
import { useStore } from '../../state/store'
import { useLapColor } from '../../hooks/useLapColor'

/**
 * NOTE: this component is currently unrendered — the mobile refactor
 * replaced it with the in-panel telemetry view. Kept around (and kept
 * in lock-step with the lap-colour pipe) in case we want a floating
 * always-visible HUD again on small screens.
 */
function MobileTelemetryCard({ lap, sample }) {
  const lapColor = useLapColor(lap.id)
  if (!sample) return null
  const isBraking = sample.fbp > 10
  const isThrottle = sample.tps > 200 && !isBraking
  const phase = isBraking ? 'hud-braking' : isThrottle ? 'hud-throttle' : 'hud-coast'
  return (
    <div
      className={`mobile-tel-card ${phase}`}
      style={{ borderColor: lapColor, '--accent': lapColor }}
    >
      <div className="mobile-tel-card-header" style={{ background: lapColor }} />
      <div className="hud-bar-row">
        <span className="hud-bar-label">TPS</span>
        <div className="hud-bar"><div className="hud-bar-fill hud-bar-tps" style={{ width: `${(sample.tps / 255) * 100}%` }} /></div>
      </div>
      <div className="hud-bar-row">
        <span className="hud-bar-label">BRK</span>
        <div className="hud-bar"><div className="hud-bar-fill hud-bar-brake" style={{ width: `${Math.min(sample.fbp / 150 * 100, 100)}%` }} /></div>
      </div>
      <div className="hud-rpm">{Math.round(sample.rpm)} RPM</div>
    </div>
  )
}

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
        const sample = sampleTelemetry(tel.samples, t)
        return <MobileTelemetryCard key={lap.id} lap={lap} sample={sample} />
      })}
    </div>
  )
}
