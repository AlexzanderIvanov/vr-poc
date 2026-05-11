import React, { useMemo } from 'react'
import * as THREE from 'three'
import { Billboard, Text } from '@react-three/drei'
import { useStore } from '../../state/store'
import { computeCornerAnalysis } from '../../utils/cornerAnalysis'
import { useLapColor } from '../../hooks/useLapColor'

// Thin container around `<PerLapApexes>` that subscribes to the lap's
// presentation colour so the apex flag posts repaint live when the
// (future) `<LapColorPicker>` writes a new colour.
function PerLapApexesContainer({ lap, telemetry, syncOffset, lapIndex }) {
  const lapColor = useLapColor(lap.id)
  return (
    <PerLapApexes
      lap={lap}
      telemetry={telemetry}
      syncOffset={syncOffset}
      lapColor={lapColor}
      lapIndex={lapIndex}
    />
  )
}

/**
 * Always-on per-corner apex markers showing the **minimum corner speed**
 * (purple) and **minimum corner radius** (orange) values for every turn
 * on every visible lap.
 *
 * The metrics themselves are computed by `computeCornerAnalysis`:
 *   - `speedApex.speedMps`  — slowest sample inside the apex window
 *   - `geomApex.radius`     — 1 / peak path-curvature in metres
 *
 * Visually: small ground disc + thin post + a billboarded value chip.
 * Same idiom as the brake flags but shorter and less prominent so the
 * markers don't obscure the racing line through the corner. The post is
 * tinted with the lap colour so users can tell ref vs ghost apexes apart
 * at a glance, while the chip stays in the metric colour (purple = speed,
 * orange = radius) so the SAME metric reads the same way across laps.
 *
 * Computed lazily — `useMemo` so we don't re-run the corner analysis on
 * every store-tick, only when laps / telemetry / sync-offsets change.
 */

const POST_HEIGHT = 1.6
const POST_RADIUS = 0.04
const DISC_RADIUS = 0.45

const SPEED_COLOR  = '#ba68c8'   // purple — slowest point
const RADIUS_COLOR = '#ff9800'   // orange — tightest point

function ApexFlag({ position, metricColor, lapColor, label, vOffset = 0 }) {
  // `metricColor` colours the disc + chip text (so speed vs radius reads
  // the same across laps); `lapColor` colours the post (so ref vs ghost
  // are visually distinguishable when corners are close).
  const postColor = lapColor || metricColor
  return (
    <group position={[position.x, position.y, position.z]}>
      {/* Ground disc — metric-coloured. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
        <circleGeometry args={[DISC_RADIUS, 20]} />
        <meshBasicMaterial color={metricColor} transparent opacity={0.6} depthWrite={false} />
      </mesh>
      {/* White accent ring so the disc reads on coloured kerbs. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <ringGeometry args={[DISC_RADIUS * 0.55, DISC_RADIUS * 0.7, 20]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* Post — lap-coloured. */}
      <mesh position={[0, POST_HEIGHT * 0.5, 0]}>
        <cylinderGeometry args={[POST_RADIUS, POST_RADIUS, POST_HEIGHT, 8]} />
        <meshBasicMaterial color={postColor} />
      </mesh>
      {/* Billboarded value chip — `vOffset` lets the speed/radius chips
          stack vertically when both apexes are at (nearly) the same point. */}
      <Billboard position={[0, POST_HEIGHT + 0.45 + vOffset, 0]}>
        <mesh>
          <planeGeometry args={[2.2, 0.55]} />
          <meshBasicMaterial color="#0a0d14" transparent opacity={0.82} depthWrite={false} />
        </mesh>
        <Text
          position={[0, 0, 0.01]}
          fontSize={0.32}
          color={metricColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.025}
          outlineColor="#000000"
        >
          {label}
        </Text>
      </Billboard>
    </group>
  )
}

function PerLapApexes({ lap, telemetry, syncOffset, lapColor, lapIndex }) {
  const corners = useMemo(
    () => computeCornerAnalysis(lap, telemetry, syncOffset),
    [lap, telemetry, syncOffset],
  )
  if (!corners?.length) return null

  // Stagger the chip vertical offset per lap so the SAME corner's apex
  // chips for ref vs ghost don't pile on top of each other when the racing
  // lines almost coincide. Lap 0 sits at the base height; lap 1 sits ~1.4 m
  // higher; lap 2+ keeps stepping. The radius chip then adds another 0.7 m
  // on top of that when speed-apex and radius-apex are at the same point.
  const lapStackOffset = lapIndex * 1.4

  return (
    <>
      {corners.map((c) => {
        const out = []
        // Min corner speed (purple chip, lap-coloured post)
        if (c.speedApex?.pos) {
          const kmh = c.speedApex.speedMps * 3.6
          out.push(
            <ApexFlag
              key={`sa-${c.cornerNumber}`}
              position={c.speedApex.pos}
              metricColor={SPEED_COLOR}
              lapColor={lapColor}
              label={`${kmh.toFixed(0)} km/h`}
              vOffset={lapStackOffset}
            />,
          )
        }
        // Min corner radius (orange chip, lap-coloured post)
        if (c.geomApex?.pos && c.geomApex?.radius != null) {
          // If the speed apex is essentially at the same point, push the
          // radius chip up by 0.7 m so they don't overlap.
          let coincident = false
          if (c.speedApex?.pos) {
            const dx = c.geomApex.pos.x - c.speedApex.pos.x
            const dz = c.geomApex.pos.z - c.speedApex.pos.z
            coincident = (dx * dx + dz * dz) < 4   // < 2 m apart
          }
          out.push(
            <ApexFlag
              key={`ra-${c.cornerNumber}`}
              position={c.geomApex.pos}
              metricColor={RADIUS_COLOR}
              lapColor={lapColor}
              label={`R ${c.geomApex.radius.toFixed(0)} m`}
              vOffset={lapStackOffset + (coincident ? 0.7 : 0)}
            />,
          )
        }
        return out
      })}
    </>
  )
}

export const CornerApexLayer = React.memo(function CornerApexLayer() {
  const laps          = useStore((s) => s.laps)
  const telemetryData = useStore((s) => s.telemetryData)
  const syncOffsets   = useStore((s) => s.syncOffsets)
  const visibility    = useStore((s) => s.visibility)

  // Render apex markers for every visible lap. Posts are tinted with the
  // lap colour and chips stack vertically per lap so the same corner's
  // ref-vs-ghost apex info doesn't pile up at one point.
  const visibleLaps = laps.filter((l) => visibility[l.id] !== false)
  if (!visibleLaps.length) return null

  return (
    <>
      {visibleLaps.map((lap, i) => (
        <PerLapApexesContainer
          key={lap.id}
          lap={lap}
          telemetry={telemetryData[lap.id]}
          syncOffset={syncOffsets[lap.id]}
          lapIndex={i}
        />
      ))}
    </>
  )
})
