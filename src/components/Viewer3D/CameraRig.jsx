import React, { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Chase / hood / side / top camera rig.
 *
 * Hot-path discipline: every Vector3 / Quaternion the per-frame block needs
 * is allocated ONCE at module scope and reused. Previously this `useFrame`
 * allocated ~10 throwaway objects per frame (`new THREE.Vector3()`,
 * `.clone()`, …) which produced 600+ GC roots/sec and triggered V8 minor-GC
 * pauses of 1-3 ms — visible as random frame drops in the chase camera.
 */

// exp-filter cutoff ≈ CAMERA_SMOOTHING / (2π) Hz — k=14 gives ~2.2 Hz.
// The camera position IS smoothed here on purpose (unlike the car body) —
// it lets the user pan free in the surrounding scene without snapping with
// every micro-yaw of the car. The car body itself reads playhead directly.
const CAMERA_SMOOTHING = 14

// ── Module-level scratches (single Canvas → safe to share across instances) ──
const _targetPos = new THREE.Vector3()
const _targetQuat = new THREE.Quaternion()
const _camOffset = new THREE.Vector3()
const _lookOffset = new THREE.Vector3()
const _desiredPos = new THREE.Vector3()
const _desiredLook = new THREE.Vector3()
const _delta = new THREE.Vector3()
const _snapOffset = new THREE.Vector3()

// Per-mode local offsets (re-applied by quaternion each frame).
const CAM_CHASE = { pos: [0, 2.4, -8.0],  look: [0, 1.2, 10.0] }
const CAM_HOOD  = { pos: [0, 1.2,  1.7],  look: [0, 1.1, 25.0] }
const CAM_TOP   = { pos: [0, 22.0, -0.1], look: [0, 0.0,  0.0] }
const CAM_SIDE  = { pos: [8.0, 2.0, 0.0], look: [0.0, 1.0, 4.0] }

export function CameraRig({ cameraMode, focusRef, controlsRef, cameraInitRef, laps, snapRequestRef, liftView }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const lastFreeTargetRef = useRef(new THREE.Vector3())
  const hasLastFreeTargetRef = useRef(false)
  const smoothedLookAtRef = useRef(new THREE.Vector3())
  const hasSmoothedLookAtRef = useRef(false)
  const lastSnapSeenRef = useRef(0)

  const zoomRef = useRef(1.0)
  const baseFovRef = useRef(null)

  useEffect(() => {
    if (baseFovRef.current == null) baseFovRef.current = camera.fov
    zoomRef.current = 1.0
    if (baseFovRef.current && Math.abs(camera.fov - baseFovRef.current) > 0.01) {
      camera.fov = baseFovRef.current
      camera.updateProjectionMatrix()
    }
    camera.up.set(0, cameraMode === 'top' ? 0 : 1, cameraMode === 'top' ? 1 : 0)
    hasSmoothedLookAtRef.current = false
  }, [cameraMode, camera])

  useEffect(() => {
    if (cameraMode === 'free') return undefined
    const dom = gl.domElement
    const clamp = (z) => Math.max(0.35, Math.min(3.0, z))

    const onWheel = (e) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1.1 : 0.9
      zoomRef.current = clamp(zoomRef.current * factor)
    }

    let initDist = 0
    let initZoom = 1.0
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        initDist = dist(e.touches)
        initZoom = zoomRef.current
      }
    }
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && initDist > 0) {
        e.preventDefault()
        const ratio = dist(e.touches) / initDist
        zoomRef.current = clamp(initZoom / ratio)
      }
    }
    const onTouchEnd = () => { initDist = 0 }

    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.addEventListener('touchstart', onTouchStart, { passive: true })
    dom.addEventListener('touchmove', onTouchMove, { passive: false })
    dom.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('touchstart', onTouchStart)
      dom.removeEventListener('touchmove', onTouchMove)
      dom.removeEventListener('touchend', onTouchEnd)
    }
  }, [cameraMode, gl])

  useFrame((_, delta) => {
    if (!focusRef.current) return
    focusRef.current.getWorldPosition(_targetPos)
    focusRef.current.getWorldQuaternion(_targetQuat)

    if (_targetPos.lengthSq() < 1) return

    // Snap-to-car request (one-shot from camera-mode cycle button).
    if (snapRequestRef && snapRequestRef.current !== lastSnapSeenRef.current) {
      lastSnapSeenRef.current = snapRequestRef.current
      _snapOffset.set(0, 10.0, -30.0).applyQuaternion(_targetQuat).add(_targetPos)
      camera.position.copy(_snapOffset)
      camera.lookAt(_targetPos)
      if (controlsRef.current) {
        controlsRef.current.target.copy(_targetPos)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current.copy(_targetPos)
      hasLastFreeTargetRef.current = true
      smoothedLookAtRef.current.copy(_targetPos)
      hasSmoothedLookAtRef.current = true
      return
    }

    // First-frame init for the active focus lap.
    if (cameraInitRef && !cameraInitRef.current) {
      if (controlsRef.current) {
        controlsRef.current.target.copy(_targetPos)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current.copy(_targetPos)
      hasLastFreeTargetRef.current = true
      cameraInitRef.current = true
      if (cameraMode === 'free') return
    }

    // Free-orbit mode — translate the camera by the car's velocity so the
    // user's orbit framing is preserved as the car moves.
    if (cameraMode === 'free') {
      const controls = controlsRef.current
      if (!controls) return
      if (hasLastFreeTargetRef.current) {
        _delta.copy(_targetPos).sub(lastFreeTargetRef.current)
        camera.position.add(_delta)
      }
      controls.target.copy(_targetPos)
      controls.update()
      lastFreeTargetRef.current.copy(_targetPos)
      hasLastFreeTargetRef.current = true
      return
    }
    lastFreeTargetRef.current.copy(_targetPos)
    hasLastFreeTargetRef.current = true

    // Per-mode local-space offsets.
    let preset = CAM_CHASE
    if (cameraMode === 'hood') preset = CAM_HOOD
    else if (cameraMode === 'top') preset = CAM_TOP
    else if (cameraMode === 'side') preset = CAM_SIDE
    _camOffset.set(preset.pos[0], preset.pos[1], preset.pos[2])
    _lookOffset.set(preset.look[0], preset.look[1], preset.look[2])

    const zoom = zoomRef.current
    if (cameraMode === 'hood') {
      // Hood: zoom via FOV — keeps the dashboard locked, moves the world.
      const targetFov = baseFovRef.current ? baseFovRef.current / zoom : camera.fov
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-delta * 6))
      camera.updateProjectionMatrix()
    } else {
      // Other modes: zoom by scaling the local-space camera offset.
      _camOffset.multiplyScalar(zoom)
    }

    if (cameraMode === 'top') {
      _desiredPos.set(_targetPos.x, _targetPos.y + _camOffset.y, _targetPos.z)
      _desiredLook.copy(_targetPos)
    } else {
      _desiredPos.copy(_camOffset).applyQuaternion(_targetQuat).add(_targetPos)
      _desiredLook.copy(_lookOffset).applyQuaternion(_targetQuat).add(_targetPos)
    }

    if (liftView && cameraMode !== 'hood' && cameraMode !== 'top') {
      _desiredLook.y -= 2.5
    }

    // Floor clamp — never let the chase camera dip below the car.
    const floorY = _targetPos.y + 0.6
    if (_desiredPos.y < floorY) _desiredPos.y = floorY

    // Critically-damped exp-filter on camera position + look-at — gives the
    // chase camera its "weighty" follow feel. Frame-rate-independent
    // (alpha derives from delta), so the look stays consistent under
    // variable RAF dispatch intervals.
    const alpha = 1 - Math.exp(-delta * CAMERA_SMOOTHING)
    camera.position.lerp(_desiredPos, alpha)
    if (camera.position.y < floorY) camera.position.y = floorY
    if (!hasSmoothedLookAtRef.current) {
      smoothedLookAtRef.current.copy(_desiredLook)
      hasSmoothedLookAtRef.current = true
    } else {
      smoothedLookAtRef.current.lerp(_desiredLook, alpha)
    }
    camera.lookAt(smoothedLookAtRef.current)
  })

  return null
}
