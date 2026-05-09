import * as THREE from 'three'

/**
 * Compute longitudinal-G, lateral-G and combined-G for each sample of a lap.
 *
 * Inputs: an array of samples with `{ t, position[3], quaternion[4] }`.
 * Returns: an array of `{ t, longG, latG, gsum }`, one per input sample.
 *
 * Method:
 *   1. Central-difference horizontal positions → ground-plane velocity.
 *   2. Central-difference velocity → ground-plane acceleration.
 *   3. Smooth acceleration with a moving average so GPS noise doesn't
 *      produce jagged g-spikes.
 *   4. Project each sample's acceleration into the car's local frame
 *      (forward/right axes derived from its quaternion, flattened to the
 *      horizontal plane), divide by 9.81 to convert to g.
 *
 * Vertical acceleration is intentionally dropped — racing g-forces are
 * conventionally reported in the ground plane.
 */

const G = 9.81
const SMOOTH_WINDOW = 7  // odd; ~0.35 s at 20 Hz sampling

export function computeGForces(samples) {
  const n = samples?.length || 0
  if (n < 5) return null

  // Ground-plane velocity (vx, vz) at each sample via central difference.
  const vx = new Float32Array(n)
  const vz = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    const dt = samples[hi].t - samples[lo].t
    if (dt <= 0) continue
    vx[i] = (samples[hi].position[0] - samples[lo].position[0]) / dt
    vz[i] = (samples[hi].position[2] - samples[lo].position[2]) / dt
  }

  // World-frame acceleration via second central difference.
  const ax = new Float32Array(n)
  const az = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    const dt = samples[hi].t - samples[lo].t
    if (dt <= 0) continue
    ax[i] = (vx[hi] - vx[lo]) / dt
    az[i] = (vz[hi] - vz[lo]) / dt
  }

  // Moving-average smoothing — denoises GPS-derived acceleration.
  const half = (SMOOTH_WINDOW - 1) >> 1
  const smooth = (arr) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0
      const lo = Math.max(0, i - half)
      const hi = Math.min(n - 1, i + half)
      for (let j = lo; j <= hi; j++) { sum += arr[j]; cnt++ }
      out[i] = sum / cnt
    }
    return out
  }
  const axS = smooth(ax)
  const azS = smooth(az)

  const out = new Array(n)
  const fw = new THREE.Vector3()
  const rt = new THREE.Vector3()
  const q = new THREE.Quaternion()
  for (let i = 0; i < n; i++) {
    q.fromArray(samples[i].quaternion)
    fw.set(0, 0, -1).applyQuaternion(q)
    fw.y = 0
    if (fw.lengthSq() < 1e-6) { fw.set(0, 0, -1) }
    fw.normalize()
    // Right-perpendicular in the horizontal plane (right-handed).
    rt.set(fw.z, 0, -fw.x)

    const aLong = axS[i] * fw.x + azS[i] * fw.z
    const aLat  = axS[i] * rt.x + azS[i] * rt.z
    const mag = Math.sqrt(aLong * aLong + aLat * aLat)
    out[i] = {
      t: samples[i].t,
      longG: aLong / G,
      latG: aLat / G,
      gsum: mag / G,
    }
  }
  return out
}
