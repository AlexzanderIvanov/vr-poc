import React, { useEffect, useMemo, useRef } from 'react'
import { Html, useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sampleLapInto, sampleTelemetry, applySyncOffsetInPlace } from '../../utils/sampleLap'
import { cloneSceneWithMaterials } from './helpers'
import { getPlayheadRef } from '../../state/store'
import { useLapColor } from '../../hooks/useLapColor'

const WHEEL_PATTERNS = {
  fl: /frontwheelleft|wheel.*fl|fl.*wheel|front.*left|wheel_fl/i,
  fr: /frontwheelright|wheel.*fr|fr.*wheel|front.*right|wheel_fr/i,
  rl: /wheel.*rl|rl.*wheel|rear.*left|wheel_rl/i,
  rr: /wheel.*rr|rr.*wheel|rear.*right|wheel_rr/i,
}

const SPIN_VISUAL_GAIN = 1.0
// Real BMW E46 ratio is ~16:1; exaggerated for visible wheel turn at scale.
const STEERING_RATIO = 8.0

function computeSteerCenter(telemetry) {
  if (!telemetry?.samples?.length) return 0
  const straightSamples = telemetry.samples
    .filter(s => s.t <= 8)
    .map(s => s.steer)
    .filter(v => typeof v === 'number')
  if (!straightSamples.length) return 0
  const sorted = [...straightSamples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export const CarEntity = React.memo(function CarEntity({ carUrl, lap, lapTimeOffset, otherLapTimeOffset, visible, onTargetReady, syncOffset, telemetry, isRefLap, sectorStartTime, otherLap, hideDelta, showCarHuds, compareMode, refLap, refSyncOffset, ownPositionLookup }) {
  // Hot-path clock — read once at mount; the object is stable for the
  // lifetime of the page, only its `.current` is mutated by the playback loop.
  const currentTimeRef = getPlayheadRef()
  // Reactive per-lap colour — sourced from the store so the picker can
  // recolour this car (model tint + dot) without component remount.
  const lapColor = useLapColor(lap.id)
  const { scene } = useGLTF(carUrl)
  const groupRef = useRef(null)
  const steerCenterRef = useRef(0)
  const hudRef = useRef(null)
  const tpsBarRef = useRef(null)
  const brkBarRef = useRef(null)
  const rpmTextRef = useRef(null)
  const deltaBadgeRef = useRef(null)
  const hudLastClassRef = useRef('')

  useEffect(() => {
    steerCenterRef.current = computeSteerCenter(telemetry)
  }, [telemetry])

  const wheelsRef = useRef({
    fl: null, fr: null, rl: null, rr: null,
    baseX: { fl: 0, fr: 0, rl: 0, rr: 0 },
    baseY: { fl: 0, fr: 0 },
  })
  const carScene = useMemo(() => cloneSceneWithMaterials(scene), [scene])

  useEffect(() => {
    const ANISO = 16
    carScene.traverse((node) => {
      if (!node.isMesh || !node.material) return
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      for (const m of mats) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
          if (m[key]) m[key].anisotropy = Math.max(m[key].anisotropy ?? 1, ANISO)
        }
      }
    })
  }, [carScene])

  useEffect(() => {
    const wheels = { fl: null, fr: null, rl: null, rr: null }
    carScene.traverse((node) => {
      if (!node.name) return
      for (const [key, pattern] of Object.entries(WHEEL_PATTERNS)) {
        if (pattern.test(node.name)) {
          wheels[key] = node
        }
      }
    })
    wheelsRef.current = {
      ...wheels,
      baseX: {
        fl: wheels.fl ? wheels.fl.rotation.x : 0,
        fr: wheels.fr ? wheels.fr.rotation.x : 0,
        rl: wheels.rl ? wheels.rl.rotation.x : 0,
        rr: wheels.rr ? wheels.rr.rotation.x : 0,
      },
      baseY: {
        fl: wheels.fl ? wheels.fl.rotation.y : 0,
        fr: wheels.fr ? wheels.fr.rotation.y : 0,
      },
    }
    if (wheels.fl) wheels.fl.rotation.order = 'YXZ'
    if (wheels.fr) wheels.fr.rotation.order = 'YXZ'
    if (wheels.rl) wheels.rl.rotation.order = 'YXZ'
    if (wheels.rr) wheels.rr.rotation.order = 'YXZ'
  }, [carScene, lap.id])

  useEffect(() => {
    carScene.traverse((node) => {
      if (node.name === 'Cube') {
        node.visible = false
      }
      if (!node.isMesh || !node.material) return
      const materials = Array.isArray(node.material) ? node.material : [node.material]
      for (const material of materials) {
        if (lap.ghost) {
          material.transparent = true
          material.opacity = 0.35
          if (material.color) material.color.lerp(new THREE.Color(lapColor), 0.5)
          if ('emissive' in material) {
            material.emissive = new THREE.Color(lapColor)
            material.emissiveIntensity = 0.25
          }
        }
      }
    })
  }, [carScene, lapColor, lap.ghost])

  useEffect(() => {
    onTargetReady(lap.id, groupRef.current)
    return () => onTargetReady(lap.id, null)
  }, [lap.id, onTargetReady])

  const positionHintIdxRef = useRef(null)
  const scratchPos1Ref = useRef(new THREE.Vector3())
  const scratchPos2Ref = useRef(new THREE.Vector3())
  const scratchPos3Ref = useRef(new THREE.Vector3())
  const scratchQuat1Ref = useRef(new THREE.Quaternion())
  const scratchQuat2Ref = useRef(new THREE.Quaternion())
  const scratchForwardRef = useRef(new THREE.Vector3())
  const hudAccumRef = useRef(0)

  const hasTelemetry = !!telemetry?.samples?.length
  const showDeltaBadge = !hideDelta && isRefLap && !!otherLap?.samples?.length

  // Priority −10: runs AFTER PlaybackClock (−100) but BEFORE CameraRig (0).
  // Critical for visual smoothness — CameraRig reads `group.getWorldPosition`
  // to frame the chase camera. If the car updated AFTER the camera in the
  // same frame, the camera would frame yesterday's position (1-frame lag),
  // which the eye perceives as the camera lurching to catch the car. With
  // the negative priority, the car body is updated first, then CameraRig
  // reads the up-to-date world position via `getWorldPosition` (which calls
  // `updateMatrixWorld()` on demand).
  useFrame(({ camera }, delta) => {
    if (!groupRef.current) return
    const playheadTime = currentTimeRef?.current ?? 0

    let liveTime
    const refScratchPos = scratchPos2Ref.current
    const refScratchQuat = scratchQuat2Ref.current
    if (compareMode === 'position' && !isRefLap && refLap?.samples?.length && ownPositionLookup) {
      if (sampleLapInto(refLap.samples, playheadTime, refScratchPos, refScratchQuat)) {
        applySyncOffsetInPlace(refScratchPos, refScratchQuat, refSyncOffset)
        const match = ownPositionLookup.findTime(refScratchPos.x, refScratchPos.z, positionHintIdxRef.current)
        positionHintIdxRef.current = match.idx
        liveTime = match.t
      } else {
        liveTime = playheadTime + (lapTimeOffset ?? 0)
      }
    } else {
      liveTime = playheadTime + (lapTimeOffset ?? 0)
    }

    // Sample the lap directly into the group's transform.
    //
    // No post-filter: `sampleLapInto` runs Catmull-Rom over samples that
    // were already Savitzky-Golay smoothed at load (`utils/smoothing.js`).
    // The previous 8 Hz one-pole IIR added ~20 ms of phase lag for zero
    // visual benefit — Catmull-Rom is C¹-continuous on smooth input, so
    // the rendered position is already a smooth function of playhead time.
    //
    // The visible payoff: scrubbing snaps instantly, the car no longer
    // "drags" behind the chart playhead, and motion is exactly in sync
    // with the single playback clock above (PlaybackClock).
    const targetPos = scratchPos1Ref.current
    const targetQuat = scratchQuat1Ref.current
    if (!sampleLapInto(lap.samples, liveTime, targetPos, targetQuat)) return
    applySyncOffsetInPlace(targetPos, targetQuat, syncOffset)

    groupRef.current.position.copy(targetPos)
    groupRef.current.quaternion.copy(targetQuat)

    const tel = telemetry ? sampleTelemetry(telemetry.samples, liveTime) : null
    const steerCenter = steerCenterRef.current
    const roadWheelDeg = tel && typeof tel.steer === 'number'
      ? (tel.steer - steerCenter) / STEERING_RATIO
      : 0
    const steerRad = THREE.MathUtils.degToRad(roadWheelDeg)
    if (Number.isFinite(steerRad)) {
      const { fl, fr, rl, rr, baseX } = wheelsRef.current
      if (fl) {
        fl.rotation.y = steerRad
        fl.rotation.x = baseX.fl + ((tel?.spin_fl_rad ?? 0) * SPIN_VISUAL_GAIN)
      }
      if (fr) {
        fr.rotation.y = steerRad
        fr.rotation.x = baseX.fr + ((tel?.spin_fr_rad ?? 0) * SPIN_VISUAL_GAIN)
      }
      if (rl) rl.rotation.x = baseX.rl + ((tel?.spin_rl_rad ?? 0) * SPIN_VISUAL_GAIN)
      if (rr) rr.rotation.x = baseX.rr + ((tel?.spin_rr_rad ?? 0) * SPIN_VISUAL_GAIN)
    }

    if (hudRef.current) {
      const dist = camera.position.distanceTo(targetPos)
      const HUD_MIN_DIST = 3
      const HUD_FULL_DIST = 10
      const tDist = THREE.MathUtils.clamp((dist - HUD_MIN_DIST) / (HUD_FULL_DIST - HUD_MIN_DIST), 0, 1)
      const scale = 0.45 + tDist * 0.55
      hudRef.current.style.transform = `scale(${scale.toFixed(3)})`
    }

    hudAccumRef.current += delta
    const HUD_INTERVAL = 1 / 15
    if (hudAccumRef.current >= HUD_INTERVAL) {
      hudAccumRef.current = 0

      if (tel && showCarHuds && hasTelemetry && hudRef.current) {
        if (tpsBarRef.current) tpsBarRef.current.style.width = `${(tel.tps / 255) * 100}%`
        if (brkBarRef.current) brkBarRef.current.style.width = `${Math.min(tel.fbp / 150 * 100, 100)}%`
        if (rpmTextRef.current) {
          const rpmStr = `${Math.round(tel.rpm)} RPM`
          if (rpmTextRef.current.textContent !== rpmStr) rpmTextRef.current.textContent = rpmStr
        }
        const isBraking = tel.fbp > 10
        const isThrottle = tel.tps >= 240
        const cls = `car-telemetry-hud ${isBraking ? 'hud-braking' : isThrottle ? 'hud-throttle' : 'hud-coast'}`
        if (hudLastClassRef.current !== cls) {
          hudRef.current.className = cls
          hudLastClassRef.current = cls
        }
      }

      if (showDeltaBadge && deltaBadgeRef.current && otherLap?.samples?.length) {
        const refPos = scratchPos1Ref.current
        const refQuat = scratchQuat1Ref.current
        const otherPos = scratchPos3Ref.current
        const otherQuat = scratchQuat2Ref.current
        const otherTime = playheadTime + (otherLapTimeOffset ?? 0)
        if (sampleLapInto(otherLap.samples, otherTime, otherPos, otherQuat)) {
          const forward = scratchForwardRef.current.set(0, 0, 1).applyQuaternion(refQuat)
          const dx = otherPos.x - refPos.x
          const dy = otherPos.y - refPos.y
          const dz = otherPos.z - refPos.z
          const signedDist = dx * forward.x + dy * forward.y + dz * forward.z
          const refIdx = Math.max(1, Math.min(Math.floor(playheadTime * 20), lap.samples.length - 1))
          const p0 = lap.samples[refIdx - 1].position, p1 = lap.samples[refIdx].position
          const speedMs = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) * 20)
          const deltaTime = signedDist / speedMs
          const label = (deltaTime >= 0 ? '+' : '') + deltaTime.toFixed(3) + 's'
          if (deltaBadgeRef.current.textContent !== label) deltaBadgeRef.current.textContent = label
          const aheadOrBehind = deltaTime >= 0 ? 'hud-delta-behind' : 'hud-delta-ahead'
          const cls = `car-delta-badge ${aheadOrBehind}`
          if (deltaBadgeRef.current.dataset.cls !== cls) {
            deltaBadgeRef.current.className = cls
            deltaBadgeRef.current.dataset.cls = cls
          }
          if (deltaBadgeRef.current.style.display !== '') deltaBadgeRef.current.style.display = ''
        } else if (deltaBadgeRef.current.style.display !== 'none') {
          deltaBadgeRef.current.style.display = 'none'
        }
      }
    }
  }, -10)

  return (
    <group ref={groupRef} visible={visible}>
      <primitive object={carScene} />
      {visible && (
        <Html position={[0, isRefLap ? 2.1 : 2.6, 0]} center distanceFactor={26} style={{ pointerEvents: 'none' }}>
          <div className={`car-dot ${lap.ghost ? 'car-dot-ghost' : ''}`} style={{ background: lapColor, boxShadow: `0 0 6px ${lapColor}` }} />
        </Html>
      )}
      {visible && hasTelemetry && showCarHuds && (
        <Html
          position={[0, isRefLap ? 3.2 : 4.5, 0]}
          center
          distanceFactor={14}
          style={{ pointerEvents: 'none' }}
          className="car-telemetry-hud-wrap"
        >
          <div ref={hudRef} className="car-telemetry-hud hud-coast" style={{ transformOrigin: 'center top' }}>
            <div className="hud-bar-row">
              <span className="hud-bar-label">TPS</span>
              <div className="hud-bar"><div ref={tpsBarRef} className="hud-bar-fill hud-bar-tps" /></div>
            </div>
            <div className="hud-bar-row">
              <span className="hud-bar-label">BRK</span>
              <div className="hud-bar"><div ref={brkBarRef} className="hud-bar-fill hud-bar-brake" /></div>
            </div>
            <div ref={rpmTextRef} className="hud-rpm">— RPM</div>
          </div>
        </Html>
      )}
      {/* Delta badge — shown above the REF car when a ghost lap is
          present. Number + green/red colouring tells the user at a
          glance whether the ref is ahead (green, `-X.XXXs`) or behind
          (red, `+X.XXXs`) the ghost at the current playhead. Used
          to be gated by `showCarHuds` (which is hardcoded `false` in
          Viewer.jsx), so the badge never appeared. Decoupling so it
          shows on both desktop and mobile whenever a comparison
          makes sense. The TPS/BRK HUD bars above the cars stay
          behind their separate `showCarHuds` gate. */}
      {visible && showDeltaBadge && (
        <Html position={[0, isRefLap ? 2.6 : 3.1, 0]} center distanceFactor={16} style={{ pointerEvents: 'none' }}>
          <div ref={deltaBadgeRef} className="car-delta-badge" style={{ display: 'none' }} />
        </Html>
      )}
    </group>
  )
})
