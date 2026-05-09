import React, { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { applySyncOffset } from '../../utils/sampleLap'
import { sampleColor } from './helpers'

export const Trajectory = React.memo(function Trajectory({ lap, visible, syncOffset, telemetry }) {
  const points = useMemo(() => {
    if (!syncOffset || (syncOffset.forward === 0 && syncOffset.left === 0 && syncOffset.up === 0 && syncOffset.yaw === 0)) {
      return lap.samples.map((sample) => sample.position)
    }
    return lap.samples.map((sample) => {
      const pos = new THREE.Vector3().fromArray(sample.position)
      const quat = new THREE.Quaternion().fromArray(sample.quaternion)
      const { position: adjusted } = applySyncOffset(pos, quat, syncOffset)
      return [adjusted.x, adjusted.y, adjusted.z]
    })
  }, [lap.samples, syncOffset])

  const vertexColors = useMemo(() => {
    if (!telemetry?.samples?.length) return null
    return lap.samples.map((_, i) => sampleColor(telemetry, i))
  }, [telemetry, lap.samples])

  if (!visible) return null

  if (vertexColors) {
    return <Line points={points} vertexColors={vertexColors} lineWidth={3.5} transparent opacity={0.92} />
  }

  return <Line points={points} color={lap.color} lineWidth={2.2} transparent opacity={lap.ghost ? 0.55 : 0.95} />
})
