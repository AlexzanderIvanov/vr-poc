import * as THREE from 'three'

/**
 * Hot-path lap-sample interpolation.
 *
 * - `sampleLapInto(samples, t, outPos, outQuat)` — writes into caller-owned
 *   Vector3/Quaternion. Used by `useFrame` so per-frame allocations stay zero.
 * - `sampleLap(samples, t)` — allocating variant. Cold callers only
 *   (Trajectory build, position-mode lookup, etc.).
 * - `applySyncOffsetInPlace` — mutates pose by per-lap forward/left/up/yaw
 *   sliders. Module-level scratch vectors avoid GC pressure.
 * - `applySyncOffset` — allocating variant of the same.
 */

export function catmullRom(p0, p1, p2, p3, t, tension = 0.5) {
  // tension 0 = standard CR, tension 1 = linear (no overshoot)
  const k = (1 - tension) * 0.5
  const t2 = t * t
  const t3 = t2 * t
  const m1 = k * (p2 - p0)
  const m2 = k * (p3 - p1)
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2
}

// Ensure neighbour quaternions are in the same hemisphere (avoid sign flips that look jittery)
export function alignQuat(ref, q) {
  // Dot product < 0 means q is in opposite hemisphere → negate for shorter interpolation path
  const dot = ref[0] * q[0] + ref[1] * q[1] + ref[2] * q[2] + ref[3] * q[3]
  return dot < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q
}

export function sampleLapInto(samples, t, outPos, outQuat) {
  if (!samples?.length) return false
  const n = samples.length
  if (t <= samples[0].t) {
    outPos.fromArray(samples[0].position)
    outQuat.fromArray(samples[0].quaternion)
    return true
  }
  if (t >= samples[n - 1].t) {
    outPos.fromArray(samples[n - 1].position)
    outQuat.fromArray(samples[n - 1].quaternion)
    return true
  }
  let lo = 0, hi = n - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid; else hi = mid
  }
  const p1 = samples[lo], p2 = samples[hi]
  const p0 = samples[Math.max(0, lo - 1)]
  const p3 = samples[Math.min(n - 1, hi + 1)]
  const span = Math.max(p2.t - p1.t, 1e-6)
  const alpha = THREE.MathUtils.clamp((t - p1.t) / span, 0, 1)
  outPos.set(
    catmullRom(p0.position[0], p1.position[0], p2.position[0], p3.position[0], alpha),
    catmullRom(p0.position[1], p1.position[1], p2.position[1], p3.position[1], alpha),
    catmullRom(p0.position[2], p1.position[2], p2.position[2], p3.position[2], alpha),
  )
  const q1 = p1.quaternion
  const q0 = alignQuat(q1, p0.quaternion)
  const q2 = alignQuat(q1, p2.quaternion)
  const q3 = alignQuat(q1, p3.quaternion)
  let qx = catmullRom(q0[0], q1[0], q2[0], q3[0], alpha)
  let qy = catmullRom(q0[1], q1[1], q2[1], q3[1], alpha)
  let qz = catmullRom(q0[2], q1[2], q2[2], q3[2], alpha)
  let qw = catmullRom(q0[3], q1[3], q2[3], q3[3], alpha)
  const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1
  outQuat.set(qx / qLen, qy / qLen, qz / qLen, qw / qLen)
  return true
}

const _syncForward = new THREE.Vector3()
const _syncUp = new THREE.Vector3(0, 1, 0)
const _syncLeft = new THREE.Vector3()
const _syncYawQuat = new THREE.Quaternion()
export function applySyncOffsetInPlace(position, quaternion, offset) {
  if (!offset) return
  _syncForward.set(0, 0, 1).applyQuaternion(quaternion)
  _syncLeft.crossVectors(_syncUp, _syncForward).normalize()
  position.addScaledVector(_syncForward, offset.forward || 0)
  position.addScaledVector(_syncLeft, offset.left || 0)
  position.y += offset.up || 0
  if (Math.abs(offset.yaw || 0) > 0.001) {
    _syncYawQuat.setFromAxisAngle(_syncUp, THREE.MathUtils.degToRad(offset.yaw))
    quaternion.premultiply(_syncYawQuat)
  }
}

export function sampleLap(samples, t) {
  if (!samples?.length) return null
  const toSample = (sample, time = sample.t) => ({
    t: time,
    position: new THREE.Vector3().fromArray(sample.position),
    quaternion: new THREE.Quaternion().fromArray(sample.quaternion),
  })
  if (t <= samples[0].t) return toSample(samples[0], t)
  if (t >= samples[samples.length - 1].t) return toSample(samples[samples.length - 1], t)

  let lo = 0, hi = samples.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid; else hi = mid
  }

  const p1 = samples[lo], p2 = samples[hi]
  const p0 = samples[Math.max(0, lo - 1)]
  const p3 = samples[Math.min(samples.length - 1, hi + 1)]
  const span = Math.max(p2.t - p1.t, 1e-6)
  const alpha = THREE.MathUtils.clamp((t - p1.t) / span, 0, 1)

  const px = catmullRom(p0.position[0], p1.position[0], p2.position[0], p3.position[0], alpha)
  const py = catmullRom(p0.position[1], p1.position[1], p2.position[1], p3.position[1], alpha)
  const pz = catmullRom(p0.position[2], p1.position[2], p2.position[2], p3.position[2], alpha)

  const q1 = p1.quaternion
  const q0 = alignQuat(q1, p0.quaternion)
  const q2 = alignQuat(q1, p2.quaternion)
  const q3 = alignQuat(q1, p3.quaternion)
  let qx = catmullRom(q0[0], q1[0], q2[0], q3[0], alpha)
  let qy = catmullRom(q0[1], q1[1], q2[1], q3[1], alpha)
  let qz = catmullRom(q0[2], q1[2], q2[2], q3[2], alpha)
  let qw = catmullRom(q0[3], q1[3], q2[3], q3[3], alpha)
  const qLen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1
  qx /= qLen; qy /= qLen; qz /= qLen; qw /= qLen

  return {
    t,
    position: new THREE.Vector3(px, py, pz),
    quaternion: new THREE.Quaternion(qx, qy, qz, qw),
  }
}

export function sampleTelemetry(samples, t) {
  if (!samples?.length) return null
  if (t <= samples[0].t) return samples[0]
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1]
  const idx = Math.min(Math.floor(t * 20), samples.length - 1)
  return samples[idx]
}

export function applySyncOffset(position, quaternion, offset) {
  if (!offset) return { position, quaternion }
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  const up = new THREE.Vector3(0, 1, 0)
  const left = new THREE.Vector3().crossVectors(up, forward).normalize()
  const newPosition = position.clone()
  newPosition.addScaledVector(forward, offset.forward)
  newPosition.addScaledVector(left, offset.left)
  newPosition.y += offset.up
  let newQuaternion = quaternion.clone()
  if (Math.abs(offset.yaw) > 0.001) {
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(offset.yaw))
    newQuaternion = yawQuat.multiply(newQuaternion)
  }
  return { position: newPosition, quaternion: newQuaternion }
}
