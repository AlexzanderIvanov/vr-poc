import React from 'react'
import { totalLapArcLength } from '../../utils/cornerAnalysis'

export function CornerAnalysisPanel({ cornerData, laps }) {
  const { pairs = [], sectorsWithArc = [] } = cornerData
  const refColor = laps?.[0]?.color || '#4dd0e1'
  const ghostColor = laps?.[1]?.color || '#ff6b6b'
  const refTotal = laps?.[0] ? totalLapArcLength(laps[0]) : 0
  const ghostTotal = laps?.[1] ? totalLapArcLength(laps[1]) : 0
  const totalDelta = refTotal - ghostTotal
  const legendItems = [
    { color: refColor, label: 'Brake start — ref' },
    { color: ghostColor, label: 'Brake start — ghost' },
    { color: '#f44336', label: 'Brake end (release)' },
    { color: '#4caf50', label: 'Throttle on' },
    { color: '#ffeb3b', label: 'Full throttle' },
    { color: '#ff9800', label: 'Geometric apex (peak |steer|)' },
    { color: '#ba68c8', label: 'Speed apex (min speed)' },
  ]
  return (
    <div className="corner-analysis-panel">
      <div className="corner-analysis-header">CORNER ANALYSIS</div>

      <div className="corner-analysis-legend">
        <div className="corner-analysis-subhead">Legend</div>
        <div className="corner-analysis-legend-grid">
          {legendItems.map((it) => (
            <div key={it.label} className="corner-analysis-legend-item">
              <span className="corner-analysis-legend-dot" style={{ background: it.color }} />
              <span>{it.label}</span>
            </div>
          ))}
        </div>
      </div>

      {refTotal > 0 && ghostTotal > 0 && (
        <div className="corner-analysis-totals">
          <div className="corner-analysis-subhead">Lap distance</div>
          <div className="corner-analysis-totals-row">
            <span className="corner-analysis-lap-swatch" style={{ background: refColor }} />
            <span className="corner-analysis-totals-value">{Math.round(refTotal)} m</span>
          </div>
          <div className="corner-analysis-totals-row">
            <span className="corner-analysis-lap-swatch" style={{ background: ghostColor }} />
            <span className="corner-analysis-totals-value">{Math.round(ghostTotal)} m</span>
          </div>
          <div className="corner-analysis-totals-delta">
            Δ {totalDelta >= 0 ? '+' : ''}{totalDelta.toFixed(1)} m
          </div>
        </div>
      )}

      {sectorsWithArc.length > 0 && (
        <div className="corner-analysis-sectors">
          <div className="corner-analysis-subhead">Sector distances</div>
          <div className="corner-analysis-sector-grid">
            {sectorsWithArc.map((s) => (
              <div key={s.number} className="corner-analysis-sector">
                <span className="corner-analysis-sector-num">S{s.number}</span>
                <span className="corner-analysis-sector-arc">{s.arcLengthM != null ? `${Math.round(s.arcLengthM)} m` : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="corner-analysis-subhead">Per corner</div>
      <div className="corner-analysis-rows">
        {pairs.length === 0 && (
          <div className="corner-analysis-empty">No brake events yet — waiting for telemetry.</div>
        )}
        {pairs.map((p) => (
          <div key={p.cornerNumber} className="corner-analysis-row">
            <div className="corner-analysis-row-header">
              <span className="corner-analysis-row-num">#{p.cornerNumber}</span>
              <span className="corner-analysis-row-delta">
                {p.brakeStartDistanceM != null && <span className="ca-brk-delta" title="Distance between brake-start points">BRK Δ {p.brakeStartDistanceM.toFixed(1)}m</span>}
                {p.fullThrottleDistanceM != null && <span className="ca-ft-delta" title="Distance between full-throttle points">FT Δ {p.fullThrottleDistanceM.toFixed(1)}m</span>}
                {p.geomApexDistanceM != null && <span className="ca-ga-delta" title="Distance between geometric-apex points (peak steer)">GA Δ {p.geomApexDistanceM.toFixed(1)}m</span>}
                {p.speedApexDistanceM != null && <span className="ca-sa-delta" title="Distance between speed-apex points (min speed)">SA Δ {p.speedApexDistanceM.toFixed(1)}m</span>}
                {p.speedApexDeltaKph != null && <span className="ca-sa-delta" title="Min-speed delta (ref − ghost) in km/h">{p.speedApexDeltaKph >= 0 ? '+' : ''}{p.speedApexDeltaKph.toFixed(1)} kph</span>}
              </span>
            </div>
            {p.arcToBrakeStartDeltaM != null && (
              <div className="corner-analysis-row-arc" title="Cumulative lap distance at brake-start — ref minus ghost">
                arc Δ at brake-start: {p.arcToBrakeStartDeltaM >= 0 ? '+' : ''}{p.arcToBrakeStartDeltaM.toFixed(1)} m
              </div>
            )}
            <div className="corner-analysis-row-body">
              <div className="corner-analysis-lap">
                <span className="corner-analysis-lap-swatch" style={{ background: refColor }} />
                <span>osc {p.ref?.oscillations ?? 0}</span>
                <span>max {p.ref?.maxBrake != null ? p.ref.maxBrake.toFixed(0) : '—'}</span>
                {p.ref?.brakingDistanceM != null && <span>brake {p.ref.brakingDistanceM.toFixed(0)}m</span>}
                {p.ref?.speedApex?.speedMps != null && <span>min {(p.ref.speedApex.speedMps * 3.6).toFixed(0)} kph</span>}
              </div>
              <div className="corner-analysis-lap">
                <span className="corner-analysis-lap-swatch" style={{ background: ghostColor }} />
                <span>osc {p.ghost?.oscillations ?? 0}</span>
                <span>max {p.ghost?.maxBrake != null ? p.ghost.maxBrake.toFixed(0) : '—'}</span>
                {p.ghost?.brakingDistanceM != null && <span>brake {p.ghost.brakingDistanceM.toFixed(0)}m</span>}
                {p.ghost?.speedApex?.speedMps != null && <span>min {(p.ghost.speedApex.speedMps * 3.6).toFixed(0)} kph</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
