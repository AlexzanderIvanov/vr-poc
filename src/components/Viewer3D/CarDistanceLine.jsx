import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { useStore } from '../../state/store'

/**
 * Visual "tape measure" between the ref and ghost cars — a thin line
 * connecting their world positions plus a floating label at the
 * midpoint showing the live distance in metres.
 *
 * Only renders when `compareMode === 'position'` and BOTH cars are
 * visible. Position-compare is the only mode where the distance is
 * a meaningful telemetry: the ghost is being placed at "where it
 * was when closest to the ref's current physical position", so the
 * residual gap encodes how much the two drivers' racing lines
 * diverge at this moment (typically 0.5-3 m). In time-compare mode
 * the cars can be hundreds of metres apart and the line would just
 * be visual noise — gate it off.
 *
 * Reads the car `THREE.Group` objects from the parent's
 * `targetMapRef` (the same registry CameraRig uses to follow the
 * focus lap). The groups already carry the cars' world transforms
 * because `<CarEntity>` writes them in its `useFrame` at priority
 * −10; this component reads them at default priority 0 so it always
 * sees the up-to-date pose for the current frame.
 *
 * Hot-path discipline:
 *   • One BufferGeometry shared between Line endpoints — positions
 *     mutated in place; never recreated.
 *   • Label position written into the `labelGroupRef`'s `.position`
 *     vector directly. Html's own `position` prop is left at zero
 *     so React doesn't re-render every frame.
 *   • Label text updated via `textContent` (direct DOM) for the
 *     same reason.
 *   • `depthTest: false` on the line material so the connector
 *     reads clearly even when something (kerbs, scenery) is between
 *     the two cars from the current camera angle.
 */

const LINE_COLOR = 0xffd166      // warm yellow — neutral attention colour
const LINE_OPACITY = 0.85
const LINE_LIFT = 0.4            // raise the line off the ground so it
                                 // doesn't clip into the car undersides
const LABEL_LIFT = 1.8           // metres above the midpoint
const MIN_DISTANCE_M = 0.05      // hide line + label below this (cars overlap)

export function CarDistanceLine({ targetMapRef }) {
  const compareMode = useStore((s) => s.compareMode)
  const laps        = useStore((s) => s.laps)
  const visibility  = useStore((s) => s.visibility)

  // Pick ref + ghost the same way the rest of the scene does:
  // manifest `ghost: false` is the reference; the first `ghost: true`
  // is its comparator. Array-order fallback for legacy manifests.
  const { refLapId, ghostLapId } = useMemo(() => {
    const ref = laps.find((l) => !l.ghost) ?? laps[0]
    const ghost = laps.find((l) => l.ghost) ?? laps[1]
    return { refLapId: ref?.id, ghostLapId: ghost?.id }
  }, [laps])

  // Reused scratch vectors — no per-frame allocations.
  const refPosRef = useRef(new THREE.Vector3())
  const ghostPosRef = useRef(new THREE.Vector3())
  const midPosRef = useRef(new THREE.Vector3())

  // Single BufferGeometry holding the two line endpoints.
  // Float32Array is mutated in place each frame; flagging
  // `needsUpdate = true` is all that's needed to push to the GPU.
  const positions = useMemo(() => new Float32Array(6), [])
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [positions])
  const material = useMemo(() => new THREE.LineBasicMaterial({
    color: LINE_COLOR,
    transparent: true,
    opacity: LINE_OPACITY,
    depthTest: false,
  }), [])
  const lineObj = useMemo(() => {
    const l = new THREE.Line(geometry, material)
    l.renderOrder = 998  // above scenery, below g-arrow overlays
    return l
  }, [geometry, material])

  const labelGroupRef = useRef(null)
  const labelTextRef = useRef(null)

  // Gate: position-compare + both laps + both visible + both groups
  // registered. Anything else → hide.
  const active =
    compareMode === 'position'
    && refLapId && ghostLapId
    && (visibility[refLapId] ?? true)
    && (visibility[ghostLapId] ?? true)

  useFrame(() => {
    if (!active) {
      // Cheap hide — push line into degenerate (collapsed) state and
      // park the label off-screen. Avoids returning null when the
      // gate flips, which would unmount and re-mount the line every
      // toggle.
      if (lineObj.visible) lineObj.visible = false
      if (labelGroupRef.current) labelGroupRef.current.visible = false
      return
    }
    const refGroup = targetMapRef.current.get(refLapId)
    const ghostGroup = targetMapRef.current.get(ghostLapId)
    if (!refGroup || !ghostGroup) {
      lineObj.visible = false
      if (labelGroupRef.current) labelGroupRef.current.visible = false
      return
    }

    refGroup.getWorldPosition(refPosRef.current)
    ghostGroup.getWorldPosition(ghostPosRef.current)
    const distance = refPosRef.current.distanceTo(ghostPosRef.current)
    if (distance < MIN_DISTANCE_M) {
      // Cars overlap (e.g. sector 1 in position mode where the ghost
      // sits right on top of ref). Hide rather than draw a 0-length
      // line with a "0.00 m" label that clutters the scene.
      lineObj.visible = false
      if (labelGroupRef.current) labelGroupRef.current.visible = false
      return
    }
    lineObj.visible = true
    if (labelGroupRef.current) labelGroupRef.current.visible = true

    // Update line endpoints (lifted off the ground).
    positions[0] = refPosRef.current.x
    positions[1] = refPosRef.current.y + LINE_LIFT
    positions[2] = refPosRef.current.z
    positions[3] = ghostPosRef.current.x
    positions[4] = ghostPosRef.current.y + LINE_LIFT
    positions[5] = ghostPosRef.current.z
    geometry.attributes.position.needsUpdate = true

    // Label at midpoint, raised above the line so the text doesn't
    // overlap either car.
    midPosRef.current.copy(refPosRef.current).add(ghostPosRef.current).multiplyScalar(0.5)
    midPosRef.current.y += LABEL_LIFT
    if (labelGroupRef.current) labelGroupRef.current.position.copy(midPosRef.current)

    // Direct DOM text update.
    if (labelTextRef.current) {
      labelTextRef.current.textContent = `${distance.toFixed(2)} m`
    }
  })

  return (
    <>
      <primitive object={lineObj} />
      <group ref={labelGroupRef}>
        <Html
          center
          distanceFactor={18}
          style={{ pointerEvents: 'none' }}
        >
          <div className="car-distance-label">
            <span ref={labelTextRef}>0.00 m</span>
          </div>
        </Html>
      </group>
    </>
  )
}
