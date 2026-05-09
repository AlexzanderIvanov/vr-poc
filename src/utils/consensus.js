import * as THREE from 'three'

/**
 * Apply a 2D rigid map-fit upgrade to freshly-loaded lap/telemetry payloads,
 * in-place. The transform is a rotation around web +Y axis (right-hand rule,
 * matching three.js setFromAxisAngle) plus a horizontal translation:
 *
 *     pos_new.x = cos(angle) * pos.x + sin(angle) * pos.z + tx
 *     pos_new.z = -sin(angle) * pos.x + cos(angle) * pos.z + tz
 *     pos_new.y = pos.y                       (altitude unchanged)
 *     quat_new  = Q(angle, axis = +Y) * quat   (heading rotates the same way)
 *
 * Note the cross-term signs: this is the standard three.js Y-rotation
 * (right-hand rule), NOT the textbook 2D rotation matrix. The two differ in
 * handedness because the Blender→Web exporter flips one axis sign
 * (web.z = -blender.y); a textbook rotation here would rotate position in one
 * direction while the quaternion (which uses Three's convention via
 * setFromAxisAngle) rotates in the opposite — they would visibly diverge.
 *
 * Used when a manifest carries a `consensus_delta` field. Mutates the
 * payloads directly to avoid copying ~2300 samples per lap.
 */

const _consensusDeltaY = new THREE.Vector3(0, 1, 0)

export function consensusDeltaParams(delta, includeQuaternion = false) {
  if (!delta) return null
  const angleRad = (delta.angle_deg || 0) * Math.PI / 180
  const tx = delta.tx || 0
  const tz = delta.tz || 0
  if (Math.abs(angleRad) < 1e-9 && Math.abs(tx) < 1e-9 && Math.abs(tz) < 1e-9) return null
  return {
    c: Math.cos(angleRad),
    s: Math.sin(angleRad),
    tx,
    tz,
    qDelta: includeQuaternion ? new THREE.Quaternion().setFromAxisAngle(_consensusDeltaY, angleRad) : null,
  }
}

export function applyConsensusDeltaToPosition(position, params) {
  if (!params || !Array.isArray(position) || position.length < 3) return
  const x = position[0]
  const z = position[2]
  position[0] = params.c * x + params.s * z + params.tx
  position[2] = -params.s * x + params.c * z + params.tz
}

export function applyConsensusDelta(samples, delta) {
  if (!samples || !samples.length) return
  const params = consensusDeltaParams(delta, true)
  if (!params) return
  const tmpQ = new THREE.Quaternion()
  const outQ = new THREE.Quaternion()
  for (const sample of samples) {
    applyConsensusDeltaToPosition(sample.position, params)
    tmpQ.fromArray(sample.quaternion)
    outQ.copy(params.qDelta).multiply(tmpQ)
    sample.quaternion[0] = outQ.x
    sample.quaternion[1] = outQ.y
    sample.quaternion[2] = outQ.z
    sample.quaternion[3] = outQ.w
  }
}
