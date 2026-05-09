import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { applySyncOffset } from '../../utils/sampleLap'

/**
 * G-sum visualization layer — drawn as a vertical "chart" along the OUTER
 * contour of the lap.
 *
 * For each lap sample, a thin vertical strip rises from the track surface
 * at a fixed perpendicular offset on the OUTER side of the loop. Outer is
 * chosen per-sample so the strips always sit on the outside of corners
 * and never overlap the racing line: we project two candidate offsets
 * (left and right of the racing-line tangent) and pick whichever lands
 * further from the trajectory's centroid.
 *
 * The strip's top edge varies with `gsum` (combined ground-plane g-load,
 * `√(longG² + latG²)`) so the run reads as a 3D bar chart wrapped along
 * the track edge. Vertex-coloured yellow → orange → red by intensity,
 * with a darker base for vertical legibility.
 *
 * One BufferGeometry per lap → single draw call.
 */

const OUTER_OFFSET = 5.0      // metres from racing line, on the outer side
const HEIGHT_PER_G = 4.0      // 1 g → 4 m of wall height
const NOISE_THRESHOLD_G = 0.05
const PEAK_REF_G = 1.8

const _v = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _side = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x }

/** gsum → RGB on a yellow → orange → red ramp. */
function gsumColor(gsum) {
  const m = clamp01(gsum / PEAK_REF_G)
  if (m < 0.5) {
    const k = m / 0.5
    return [
      1.0,
      0.96 + (0.65 - 0.96) * k,
      0.62 + (0.15 - 0.62) * k,
    ]
  }
  const k = (m - 0.5) / 0.5
  return [
    1.0 + (0.72 - 1.0) * k,
    0.65 + (0.11 - 0.65) * k,
    0.15 + (0.11 - 0.15) * k,
  ]
}

/**
 * Build the outer-contour gsum chart geometry.
 *
 * Vertices: two per qualifying sample (base on track surface + top at
 * `gsum × HEIGHT_PER_G`). Quads connect consecutive sample pairs. Off-load
 * runs (gsum < threshold) split into independent runs; their indices are
 * built per-run so the chart doesn't draw spurious geometry between them.
 */
function buildOuterChart(lap, gForces, syncOffset) {
  if (!lap?.samples?.length || !gForces?.length) return null
  const samples = lap.samples
  if (samples.length !== gForces.length) return null

  // Trajectory centroid (XZ) — used to pick the outward perpendicular per
  // sample. Computed once over the entire lap; for a closed loop that
  // gives a stable interior point so "outer" is consistent everywhere.
  let cx = 0, cz = 0
  for (const s of samples) { cx += s.position[0]; cz += s.position[2] }
  cx /= samples.length; cz /= samples.length

  const positions = []
  const colors = []
  const indices = []
  const runs = []
  let run = null

  for (let i = 0; i < gForces.length; i++) {
    const gsum = gForces[i].gsum
    if (gsum < NOISE_THRESHOLD_G) { run = null; continue }

    const pos = new THREE.Vector3().fromArray(samples[i].position)
    const quat = new THREE.Quaternion().fromArray(samples[i].quaternion)
    const { position, quaternion } = applySyncOffset(pos, quat, syncOffset)

    _forward.set(0, 0, -1).applyQuaternion(quaternion)
    _side.crossVectors(_forward, _up).normalize()

    // Pick the side direction that points AWAY from the trajectory
    // centroid. This is the "outer contour" direction.
    const dPlus = (position.x + _side.x * OUTER_OFFSET - cx) ** 2
                + (position.z + _side.z * OUTER_OFFSET - cz) ** 2
    const dMinus = (position.x - _side.x * OUTER_OFFSET - cx) ** 2
                 + (position.z - _side.z * OUTER_OFFSET - cz) ** 2
    const sign = dPlus > dMinus ? 1 : -1

    if (!run) { run = { startVertex: positions.length / 3 }; runs.push(run) }

    _v.copy(position).addScaledVector(_side, OUTER_OFFSET * sign)
    const height = gsum * HEIGHT_PER_G
    positions.push(_v.x, _v.y, _v.z)              // base on track
    positions.push(_v.x, _v.y + height, _v.z)     // top at gsum-derived height

    const rgb = gsumColor(gsum)
    const dim = 0.55
    colors.push(rgb[0] * dim, rgb[1] * dim, rgb[2] * dim)
    colors.push(rgb[0], rgb[1], rgb[2])
  }

  for (let r = 0; r < runs.length; r++) {
    const start = runs[r].startVertex
    const end = (r + 1 < runs.length) ? runs[r + 1].startVertex : positions.length / 3
    const numSamples = (end - start) / 2
    for (let i = 0; i < numSamples - 1; i++) {
      const v0 = start + i * 2, v1 = v0 + 1
      const v2 = v0 + 2, v3 = v0 + 3
      indices.push(v0, v1, v2, v1, v3, v2)
    }
  }

  if (!positions.length) return null
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeBoundingSphere()
  return geo
}

function GForceForLap({ lap, syncOffset }) {
  // `lap.gForces` is pre-computed by the data layer (services/MockBackendAdapter.js
  // → transforms.computeGForces). Reading it directly keeps this component
  // free of derivation work and matches the contract the eventual real
  // backend will fulfil.
  const chart = useMemo(
    () => buildOuterChart(lap, lap?.gForces, syncOffset),
    [lap, syncOffset],
  )
  useEffect(() => () => chart?.dispose?.(), [chart])

  if (!chart) return null
  return (
    <mesh geometry={chart} frustumCulled={false}>
      <meshBasicMaterial
        vertexColors
        transparent
        opacity={0.85}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * Top-level layer. Pass `entries` of `{lap, syncOffset}` for each visible lap.
 */
export const GForceLayer = React.memo(function GForceLayer({ entries }) {
  if (!entries?.length) return null
  return (
    <>
      {entries.map((entry) => (
        <GForceForLap
          key={entry.lap?.id ?? 'lap'}
          lap={entry.lap}
          syncOffset={entry.syncOffset}
        />
      ))}
    </>
  )
})
