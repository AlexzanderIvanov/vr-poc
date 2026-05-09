import React, { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// Chase / hood / side / top camera smoothing factor.
// exp-filter cutoff ≈ CAMERA_SMOOTHING / (2π) Hz — k=14 gives ~2.2 Hz.
const CAMERA_SMOOTHING = 14

export function CameraRig({ cameraMode, focusRef, controlsRef, cameraInitRef, laps, snapRequestRef, liftView }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const lastFreeTargetRef = useRef(null)
  const smoothedLookAtRef = useRef(null)
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
    smoothedLookAtRef.current = null
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
    const targetPosition = new THREE.Vector3()
    const targetQuaternion = new THREE.Quaternion()
    focusRef.current.getWorldPosition(targetPosition)
    focusRef.current.getWorldQuaternion(targetQuaternion)

    if (targetPosition.lengthSq() < 1) return

    if (snapRequestRef && snapRequestRef.current !== lastSnapSeenRef.current) {
      lastSnapSeenRef.current = snapRequestRef.current
      const snapOffset = new THREE.Vector3(0, 10.0, -30.0).applyQuaternion(targetQuaternion).add(targetPosition)
      camera.position.copy(snapOffset)
      camera.lookAt(targetPosition)
      if (controlsRef.current) {
        controlsRef.current.target.copy(targetPosition)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current = targetPosition.clone()
      smoothedLookAtRef.current = targetPosition.clone()
      return
    }

    if (cameraInitRef && !cameraInitRef.current) {
      if (controlsRef.current) {
        controlsRef.current.target.copy(targetPosition)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current = targetPosition.clone()
      cameraInitRef.current = true
      if (cameraMode === 'free') return
    }

    if (cameraMode === 'free') {
      const controls = controlsRef.current
      if (!controls) return
      if (lastFreeTargetRef.current) {
        camera.position.add(targetPosition.clone().sub(lastFreeTargetRef.current))
      }
      controls.target.copy(targetPosition)
      controls.update()
      lastFreeTargetRef.current = targetPosition.clone()
      return
    }
    lastFreeTargetRef.current = targetPosition.clone()
    let localCameraOffset = new THREE.Vector3(0, 2.4, -8.0)
    let localLookOffset = new THREE.Vector3(0, 1.2, 10.0)
    if (cameraMode === 'hood') {
      localCameraOffset = new THREE.Vector3(0, 1.2, 1.7)
      localLookOffset = new THREE.Vector3(0, 1.1, 25.0)
    } else if (cameraMode === 'top') {
      localCameraOffset = new THREE.Vector3(0, 22.0, -0.1)
      localLookOffset = new THREE.Vector3(0, 0.0, 0.0)
    } else if (cameraMode === 'side') {
      localCameraOffset = new THREE.Vector3(8.0, 2.0, 0.0)
      localLookOffset = new THREE.Vector3(0.0, 1.0, 4.0)
    }
    const zoom = zoomRef.current
    if (cameraMode === 'hood') {
      const targetFov = baseFovRef.current ? baseFovRef.current / zoom : camera.fov
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-delta * 6))
      camera.updateProjectionMatrix()
    } else {
      localCameraOffset.multiplyScalar(zoom)
    }
    let desiredPosition, desiredLookAt
    if (cameraMode === 'top') {
      desiredPosition = new THREE.Vector3(targetPosition.x, targetPosition.y + localCameraOffset.y, targetPosition.z)
      desiredLookAt = targetPosition.clone()
    } else {
      desiredPosition = localCameraOffset.applyQuaternion(targetQuaternion).add(targetPosition)
      desiredLookAt = localLookOffset.applyQuaternion(targetQuaternion).add(targetPosition)
    }
    if (liftView && cameraMode !== 'hood' && cameraMode !== 'top') {
      desiredLookAt.y -= 2.5
    }
    const floorY = targetPosition.y + 0.6
    if (desiredPosition.y < floorY) desiredPosition.y = floorY
    const alpha = 1 - Math.exp(-delta * CAMERA_SMOOTHING)
    camera.position.lerp(desiredPosition, alpha)
    if (camera.position.y < floorY) camera.position.y = floorY
    if (!smoothedLookAtRef.current) smoothedLookAtRef.current = desiredLookAt.clone()
    else smoothedLookAtRef.current.lerp(desiredLookAt, alpha)
    camera.lookAt(smoothedLookAtRef.current)
  })
  return null
}
