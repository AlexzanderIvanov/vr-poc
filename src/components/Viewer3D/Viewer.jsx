import React, { Suspense, useCallback, useMemo, useReducer, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, OrbitControls, PerspectiveCamera } from '@react-three/drei'
import { TrackMapPanel } from '../TrackMap/TrackMap'
import * as THREE from 'three'
import { useStore } from '../../state/store'
import { buildPositionLookup } from '../../utils/positionLookup'
import { sampleLap } from '../../utils/sampleLap'
import { computeCornerAnalysis, pairCorners, addSectorArcLengths } from '../../utils/cornerAnalysis'
import { assetUrl } from '../../config'
import { IS_MOBILE } from '../../utils/platform'
import { TrackScenery } from './TrackScenery'
import { TrackModel } from './TrackModel'
import { Trajectory } from './Trajectory'
import { TrackMarkers } from './TrackMarkers'
import { CornerMarkers } from './CornerMarkers'
import { CornerApexLayer } from './CornerApexLayer'
import { CarEntity } from './CarEntity'
import { CameraRig } from './CameraRig'

/**
 * Composes the 3D scene: track + scenery + per-lap trajectory polylines +
 * cars + camera rig + sector / corner overlays.
 *
 * Subscribes to the store directly (no props from the layout grid). The
 * `Viewer3DPanel` adapter at the bottom is what the panel registry uses.
 */
export function Viewer() {
  const manifest        = useStore((s) => s.manifest)
  const laps            = useStore((s) => s.laps)
  const cameraMode      = useStore((s) => s.cameraMode)
  const compareMode     = useStore((s) => s.compareMode)
  const cornerAnalysisMode = useStore((s) => s.cornerAnalysisMode)
  const focusLapId      = useStore((s) => s.focusLapId)
  const visibility      = useStore((s) => s.visibility)
  const syncOffsets     = useStore((s) => s.syncOffsets)
  const telemetryData   = useStore((s) => s.telemetryData)
  const lapTimeOffset   = useStore((s) => s.lapTimeOffset)
  const sectorStartTime = useStore((s) => s.sectorStartTime)
  const videoOverlayOn  = useStore((s) => s.videoOverlayOn)

  // Per-lap polyline lookup for position-mode comparison.
  const positionLookups = useMemo(() => {
    const out = {}
    for (const lap of laps) {
      out[lap.id] = buildPositionLookup(lap.samples, syncOffsets[lap.id])
    }
    return out
  }, [laps, syncOffsets])

  // The CameraRig follows whichever lap object the focus lap is currently
  // attached to. CarEntity registers its world-space group ref into a Map
  // here on mount; CameraRig dereferences from `targetMapRef.current.get(id)`.
  const targetMapRef = useRef(new Map())
  const orbitControlsRef = useRef(null)
  const cameraSnapRequestRef = useRef(0)
  const [, forceRerender] = useReducer((x) => x + 1, 0)
  const handleTargetReady = useCallback((lapId, object) => {
    if (object) targetMapRef.current.set(lapId, object)
    else targetMapRef.current.delete(lapId)
    forceRerender()
  }, [])
  const focusRef = useRef(null)
  focusRef.current = targetMapRef.current.get(focusLapId) ?? null

  const focusLap = laps.find((l) => l.id === focusLapId) ?? laps[0]
  const focusTelemetry = telemetryData[focusLapId]
  const otherLap = laps.find((l) => l.id !== focusLapId)
  const otherTelemetry = otherLap ? telemetryData[otherLap.id] : null

  const cameraInitRef = useRef(false)

  // Initial camera framing — spawns the camera ~12 m behind whatever
  // position the focus car is at *right now* (not always sample 0).
  //
  // Why current-playhead and not start-of-lap: changing the active layout
  // preset moves the Viewer3D panel to a different position in the React
  // tree, which forces the entire `<Canvas>` to unmount/remount. If we
  // spawned the camera at sample 0 the user would see the camera teleport
  // back to the start of the lap on every layout swap. Reading
  // `playheadRef.current` here pins the spawn to wherever the user
  // currently is in the replay.
  //
  // `useStore.getState()` is intentional — we want a snapshot at mount
  // time, not a reactive subscription, so this `useMemo` isn't invalidated
  // on every playhead tick.
  const initialCamera = useMemo(() => {
    const samples = focusLap?.samples
    if (!samples || samples.length < 2) return { pos: [475, 120, 150], look: [475, 5, 350] }

    const t = useStore.getState().playheadRef?.current ?? 0
    const sampled = sampleLap(samples, t)
    const aheadStep = 0.15
    const ahead = sampleLap(samples, t + aheadStep) || sampleLap(samples, Math.max(0, t - aheadStep))
    if (!sampled || !ahead) {
      // Fallback to start-of-lap framing.
      const p0 = new THREE.Vector3().fromArray(samples[0].position)
      let p1 = new THREE.Vector3().fromArray(samples[1].position)
      for (let i = 2; i < samples.length && p1.distanceTo(p0) < 2; i++) {
        p1 = new THREE.Vector3().fromArray(samples[i].position)
      }
      const forward = p1.clone().sub(p0).setY(0)
      if (forward.lengthSq() < 1e-6) return { pos: [475, 120, 150], look: [475, 5, 350] }
      forward.normalize()
      const camPos = p0.clone().addScaledVector(forward, -12.0).add(new THREE.Vector3(0, 5.0, 0))
      const lookAt = p0.clone().add(new THREE.Vector3(0, 0.8, 0))
      return { pos: camPos.toArray(), look: lookAt.toArray() }
    }

    // `sampleLap` returns `{ position: THREE.Vector3, ... }`, NOT a raw
    // array — clone the vectors directly. (Using `fromArray(vector3)`
    // here writes garbage and ends up spawning the camera in empty space.)
    const p0 = sampled.position.clone()
    const p1 = ahead.position.clone()
    const forward = p1.clone().sub(p0).setY(0)
    if (forward.lengthSq() < 1e-6) {
      // Stationary sample — fall back to the lap-tangent at start.
      const s0 = new THREE.Vector3().fromArray(samples[0].position)
      const s1 = new THREE.Vector3().fromArray(samples[Math.min(samples.length - 1, 5)].position)
      forward.copy(s1).sub(s0).setY(0)
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1)
    }
    forward.normalize()
    const camPos = p0.clone().addScaledVector(forward, -12.0).add(new THREE.Vector3(0, 5.0, 0))
    const lookAt = p0.clone().add(new THREE.Vector3(0, 0.8, 0))
    return { pos: camPos.toArray(), look: lookAt.toArray() }
  }, [focusLap])

  const liftViewForVideo = videoOverlayOn && laps.some((l) => l.video_path)
  const hideDelta = !!manifest?.hide_delta

  if (!manifest) return null
  return (
    <div className="viewer3d-shell" style={{ position: 'relative', width: '100%', height: '100%' }}>
    <Canvas
      shadows={!IS_MOBILE}
      dpr={IS_MOBILE ? [1, 2] : [1, 1.5]}
      gl={{
        antialias: true,
        preserveDrawingBuffer: !IS_MOBILE,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.1,
      }}
    >
      <color attach="background" args={["#b8ccd8"]} />
      <fog attach="fog" args={["#b8ccd8", 400, 2400]} />
      <PerspectiveCamera makeDefault position={initialCamera.pos} fov={48} ref={(c) => { if (c) { c.lookAt(...initialCamera.look); c.updateMatrixWorld(true) } }} />
      <OrbitControls ref={orbitControlsRef} enabled={cameraMode === 'free'} enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI / 2 - 0.05} />
      <CameraRig cameraMode={cameraMode} focusRef={focusRef} controlsRef={orbitControlsRef} cameraInitRef={cameraInitRef} laps={laps} snapRequestRef={cameraSnapRequestRef} liftView={liftViewForVideo} />
      <ambientLight intensity={IS_MOBILE ? 0.55 : 0.35} />
      <directionalLight
        position={[120, 180, 60]}
        intensity={1.4}
        castShadow={!IS_MOBILE}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-300}
        shadow-camera-right={300}
        shadow-camera-top={300}
        shadow-camera-bottom={-300}
        shadow-camera-near={1}
        shadow-camera-far={600}
        shadow-bias={-0.0005}
        shadow-normalBias={0.2}
      />
      <hemisphereLight args={["#b8d7ff", "#1f2126", 0.5]} />
      <Environment preset="park" background={false} environmentIntensity={0.9} />
      <Suspense fallback={null}>
        <TrackScenery />
        <TrackModel url={assetUrl(manifest.track)} />
        {laps.map((lap) => (
          <Trajectory key={`${lap.id}-line`} lap={lap} visible={visibility[lap.id] ?? true} syncOffset={syncOffsets[lap.id]} telemetry={telemetryData[lap.id]} />
        ))}
        {laps.map((lap, lapIdx) => (
          <CarEntity
            key={lap.id}
            carUrl={assetUrl(manifest.car)}
            lap={lap}
            lapTimeOffset={lapIdx > 0 ? lapTimeOffset : 0}
            otherLapTimeOffset={lapIdx === 0 ? lapTimeOffset : 0}
            visible={visibility[lap.id] ?? true}
            onTargetReady={handleTargetReady}
            syncOffset={syncOffsets[lap.id]}
            telemetry={telemetryData[lap.id]}
            isRefLap={lapIdx === 0}
            sectorStartTime={sectorStartTime}
            otherLap={lapIdx === 0 ? laps[1] : null}
            hideDelta={hideDelta}
            showCarHuds={false}
            compareMode={compareMode}
            refLap={lapIdx > 0 ? laps[0] : null}
            refSyncOffset={lapIdx > 0 ? syncOffsets[laps[0].id] : null}
            ownPositionLookup={positionLookups[lap.id]}
          />
        ))}
        {focusTelemetry && (
          <TrackMarkers telemetry={focusTelemetry} telemetry2={otherTelemetry} visible={true}
            lap={focusLap} lap2={otherLap}
            syncOffset={focusLap ? syncOffsets[focusLap.id] : null}
            syncOffset2={otherLap ? syncOffsets[otherLap.id] : null}
            lap1Color={focusLap?.color} lap2Color={otherLap?.color} />
        )}
        {/* Always-on per-corner apex markers (min speed + min radius) for
            the focus lap. Detailed ref/ghost comparison still lives behind
            the corner-analysis toggle below. */}
        <CornerApexLayer />
        {cornerAnalysisMode && <ScopedCornerMarkers />}
      </Suspense>
    </Canvas>
    {/* Mini-map overlay pinned to the top-left of the 3D viewer. Transparent
        so it doesn't block the scene; sits at z-index 1 over the canvas
        and remains fully clickable (sector-jump, click-to-seek). The
        Track Map panel in the layout grid stays in place; this is an
        experimental in-scene mini-map and can be removed in one block. */}
    <div className="viewer3d-minimap-overlay">
      <TrackMapPanel minimal />
    </div>
    </div>
  )
}

/**
 * Corner overlay — pulls cornerData lazily so we don't compute it when the
 * mode is off. Kept as a child component so its `useMemo` doesn't re-run on
 * every Viewer subscription change.
 */
function ScopedCornerMarkers() {
  const laps          = useStore((s) => s.laps)
  const telemetryData = useStore((s) => s.telemetryData)
  const syncOffsets   = useStore((s) => s.syncOffsets)
  const deltaData     = useStore((s) => s.deltaData)
  const cornerData = useMemo(() => {
    const refLap = laps[0]
    const ghostLap = laps[1]
    const refCorners = refLap ? computeCornerAnalysis(refLap, telemetryData[refLap.id], syncOffsets[refLap.id]) : []
    const ghostCorners = ghostLap ? computeCornerAnalysis(ghostLap, telemetryData[ghostLap.id], syncOffsets[ghostLap.id]) : []
    const pairs = pairCorners(refCorners, ghostCorners)
    const sectorsWithArc = deltaData?.sectors && refLap
      ? addSectorArcLengths(deltaData.sectors.map((s) => ({ ...s })), refLap)
      : []
    return { refCorners, ghostCorners, pairs, sectorsWithArc }
  }, [laps, telemetryData, syncOffsets, deltaData])
  return <CornerMarkers cornerData={cornerData} lap1Color={laps[0]?.color} lap2Color={laps[1]?.color} />
}

// Panel adapter for the layout registry — the Viewer component is fully
// self-contained, so the adapter is just a passthrough.
export const Viewer3DPanel = Viewer
