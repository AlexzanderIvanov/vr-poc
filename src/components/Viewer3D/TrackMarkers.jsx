import React, { useMemo } from 'react'
import * as THREE from 'three'
import { Billboard, Text } from '@react-three/drei'
import { eventScenePosition } from './helpers'

/**
 * Brake-start markers rendered as ground-anchored race flags.
 *
 * The previous implementation used `<Html>` overlays floating ~4 m above
 * the ground (a diamond + index badge): they billboarded automatically
 * but read as flat HUD chrome and were unreadable in VR / from a distance.
 *
 * Each brake-start now plants a flag on the track surface:
 *   - small ground disc anchoring the position even when the flag is far
 *   - vertical pole rising 3.5 m
 *   - triangular pennant in the lap colour at the top, billboarded so it
 *     always faces the camera (works in chase / hood / top / VR)
 *   - brake number rendered as 3D `<Text>` inside the pennant
 *
 * When two laps are compared, matched brake-start pairs (nearest within
 * 60 m on the ground plane) get a thin connector line and a distance
 * badge halfway between the two flags.
 */

const FLAG_HEIGHT = 5.0         // pole height in metres
const POLE_RADIUS = 0.07
const FLAG_W      = 2.4         // pennant width (extends from pole side)
const FLAG_H      = 1.1         // pennant height
const BASE_RADIUS = 0.7
const PAIR_THRESHOLD_M = 60     // max distance for matching brake-pairs

// Right-pointing triangular pennant in local space (pole at origin):
//   bottom-attach (0,0)  →  tip (FLAG_W, FLAG_H/2)  →  top-attach (0,FLAG_H)
const flagGeometry = (() => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    FLAG_W, FLAG_H * 0.5, 0,
    0, FLAG_H, 0,
  ]), 3))
  g.setIndex([0, 1, 2])
  g.computeVertexNormals()
  return g
})()

function BrakeFlag({ position, color, label }) {
  return (
    <group position={position}>
      {/* Ground disc — anchors the position even when seen from a distance. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
        <circleGeometry args={[BASE_RADIUS, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} />
      </mesh>
      {/* Inner accent ring for readability over coloured kerbs. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
        <ringGeometry args={[BASE_RADIUS * 0.55, BASE_RADIUS * 0.7, 24]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* Pole. */}
      <mesh position={[0, FLAG_HEIGHT * 0.5, 0]}>
        <cylinderGeometry args={[POLE_RADIUS, POLE_RADIUS, FLAG_HEIGHT, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* Pennant + number, billboarded so they always face the camera. */}
      <Billboard position={[0, FLAG_HEIGHT - FLAG_H, 0]}>
        <mesh geometry={flagGeometry}>
          <meshBasicMaterial color={color} side={THREE.DoubleSide} />
        </mesh>
        <Text
          position={[FLAG_W * 0.32, FLAG_H * 0.5, 0.01]}
          fontSize={0.7}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.06}
          outlineColor="#000000"
        >
          {label}
        </Text>
      </Billboard>
    </group>
  )
}

function ConnectorLine({ a, b }) {
  // Thin segment between two paired flag bases.
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      a[0], a[1] + 0.05, a[2],
      b[0], b[1] + 0.05, b[2],
    ]), 3))
    return g
  }, [a, b])
  return (
    <line geometry={geo}>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.4} />
    </line>
  )
}

function DistanceBadge({ position, distance }) {
  return (
    <Billboard position={position}>
      <mesh>
        <planeGeometry args={[1.6, 0.55]} />
        <meshBasicMaterial color="#0a0d14" transparent opacity={0.78} depthWrite={false} />
      </mesh>
      <Text
        position={[0, 0, 0.01]}
        fontSize={0.32}
        color="#ffffff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {`Δ ${distance} m`}
      </Text>
    </Billboard>
  )
}

export const TrackMarkers = React.memo(function TrackMarkers({
  telemetry, telemetry2, visible,
  lap, lap2, syncOffset, syncOffset2,
  lap1Color, lap2Color,
}) {
  const brakePairs = useMemo(() => {
    if (!telemetry?.events?.length) return []
    const brakeEvents1 = telemetry.events
      .filter((e) => e.type === 'brake_start')
      .map((e) => ({ ...e, position: eventScenePosition(e, lap, syncOffset) }))
      .filter((e) => e.position)
    const brakeEvents2 = (telemetry2?.events || [])
      .filter((e) => e.type === 'brake_start')
      .map((e) => ({ ...e, position: eventScenePosition(e, lap2, syncOffset2) }))
      .filter((e) => e.position)
    const pairs = []
    const used2 = new Set()
    for (let i = 0; i < brakeEvents1.length; i++) {
      const e1 = brakeEvents1[i]
      let bestDist = PAIR_THRESHOLD_M
      let bestIdx = -1
      for (let j = 0; j < brakeEvents2.length; j++) {
        if (used2.has(j)) continue
        const dx = e1.position[0] - brakeEvents2[j].position[0]
        const dz = e1.position[2] - brakeEvents2[j].position[2]
        const d = Math.hypot(dx, dz)
        if (d < bestDist) { bestDist = d; bestIdx = j }
      }
      const e2 = bestIdx >= 0 ? brakeEvents2[bestIdx] : null
      if (bestIdx >= 0) used2.add(bestIdx)
      pairs.push({
        number: i + 1,
        e1, e2,
        distance: e2 ? Math.round(bestDist) : null,
      })
    }
    return pairs
  }, [telemetry, telemetry2, lap, lap2, syncOffset, syncOffset2])

  if (!visible || !telemetry?.events?.length) return null

  const color1 = lap1Color || '#4dd0e1'
  const color2 = lap2Color || '#ff6b6b'

  return (
    <>
      {brakePairs.map((pair) => (
        <group key={`brake-pair-${pair.number}`}>
          <BrakeFlag
            position={pair.e1.position}
            color={color1}
            label={`#${pair.number}`}
          />
          {pair.e2 && (
            <>
              <BrakeFlag
                position={pair.e2.position}
                color={color2}
                label={`#${pair.number}`}
              />
              <ConnectorLine a={pair.e1.position} b={pair.e2.position} />
              {pair.distance != null && (
                <DistanceBadge
                  position={[
                    (pair.e1.position[0] + pair.e2.position[0]) * 0.5,
                    Math.max(pair.e1.position[1], pair.e2.position[1]) + FLAG_HEIGHT + 0.6,
                    (pair.e1.position[2] + pair.e2.position[2]) * 0.5,
                  ]}
                  distance={pair.distance}
                />
              )}
            </>
          )}
        </group>
      ))}
    </>
  )
})
