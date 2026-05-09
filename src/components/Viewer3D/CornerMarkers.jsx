import React from 'react'
import { Html } from '@react-three/drei'

/**
 * 3D overlay for the corner-analysis mode. Renders coloured dots per brake
 * zone per lap (brake-start / brake-end / throttle-on / full-throttle) and
 * distance badges between paired ref/ghost key-points so the user can see
 * how far apart drivers triggered them.
 *
 * Apex markers (min-speed / min-radius) live in `<CornerApexLayer />` —
 * those are always on and show the actual values, so this component no
 * longer renders its own HTML apex rings (would double up otherwise).
 */
export const CornerMarkers = React.memo(function CornerMarkers({ cornerData, lap1Color, lap2Color }) {
  if (!cornerData) return null
  const { refCorners = [], ghostCorners = [], pairs = [] } = cornerData

  const dot = (pos, color, key, size = '10px') => (
    <Html key={key} position={[pos.x, pos.y + 0.5, pos.z]} center distanceFactor={24} style={{ pointerEvents: 'none' }}>
      <div className="corner-dot" style={{ background: color, width: size, height: size }} />
    </Html>
  )

  const cornerMarkersFor = (corners, prefix, brakeStartColor) => corners.flatMap((c) => {
    const out = []
    if (c.brakeStart?.pos) out.push(dot(c.brakeStart.pos, brakeStartColor, `${prefix}-${c.cornerNumber}-bs`))
    if (c.brakeEnd?.pos) out.push(dot(c.brakeEnd.pos, '#f44336', `${prefix}-${c.cornerNumber}-be`))
    if (c.throttleOn?.pos) out.push(dot(c.throttleOn.pos, '#4caf50', `${prefix}-${c.cornerNumber}-ton`))
    if (c.fullThrottle?.pos) out.push(dot(c.fullThrottle.pos, '#ffeb3b', `${prefix}-${c.cornerNumber}-ft`))
    // Apex markers (min speed + min radius) handled by <CornerApexLayer>.
    return out
  })

  const deltaBadges = pairs.flatMap((p) => {
    const badges = []
    if (p.brakeStartDistanceM != null && p.ref?.brakeStart?.pos && p.ghost?.brakeStart?.pos) {
      const mid = {
        x: (p.ref.brakeStart.pos.x + p.ghost.brakeStart.pos.x) / 2,
        y: Math.max(p.ref.brakeStart.pos.y, p.ghost.brakeStart.pos.y) + 1.2,
        z: (p.ref.brakeStart.pos.z + p.ghost.brakeStart.pos.z) / 2,
      }
      badges.push(
        <Html key={`bs-delta-${p.cornerNumber}`} position={[mid.x, mid.y, mid.z]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
          <div className="corner-delta-badge corner-delta-brake">
            <span className="corner-delta-label">BRK</span>
            <span className="corner-delta-value">{p.brakeStartDistanceM.toFixed(1)}m</span>
          </div>
        </Html>,
      )
    }
    if (p.fullThrottleDistanceM != null && p.ref?.fullThrottle?.pos && p.ghost?.fullThrottle?.pos) {
      const mid = {
        x: (p.ref.fullThrottle.pos.x + p.ghost.fullThrottle.pos.x) / 2,
        y: Math.max(p.ref.fullThrottle.pos.y, p.ghost.fullThrottle.pos.y) + 1.2,
        z: (p.ref.fullThrottle.pos.z + p.ghost.fullThrottle.pos.z) / 2,
      }
      badges.push(
        <Html key={`ft-delta-${p.cornerNumber}`} position={[mid.x, mid.y, mid.z]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
          <div className="corner-delta-badge corner-delta-throttle">
            <span className="corner-delta-label">FT</span>
            <span className="corner-delta-value">{p.fullThrottleDistanceM.toFixed(1)}m</span>
          </div>
        </Html>,
      )
    }
    return badges
  })

  return (
    <>
      {cornerMarkersFor(refCorners, 'ref', lap1Color || '#4dd0e1')}
      {cornerMarkersFor(ghostCorners, 'ghost', lap2Color || '#ff6b6b')}
      {deltaBadges}
    </>
  )
})
