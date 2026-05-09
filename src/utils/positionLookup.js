import * as THREE from 'three'
import { applySyncOffset } from './sampleLap'

/**
 * Build a fast "find the t_s where this lap passed closest to (x, z)" lookup.
 *
 * Precomputes the final rendered ground-plane XY for each sample (applying the
 * live sync-offset exactly as the `CarEntity` does at runtime). Search is:
 *
 * 1. Narrow scan in a ±windowSize neighbourhood around the caller's last match
 *    index (fast, O(1) amortised when the car advances smoothly).
 * 2. Fall back to a full scan if the window was exhausted at either edge, or
 *    if no hint was supplied (first frame / big jump after a sector click).
 * 3. Once the nearest vertex is found, project the query point onto the
 *    two adjacent segments to get sub-sample precision.
 */
export function buildPositionLookup(samples, syncOffset) {
  if (!samples?.length) return null
  const n = samples.length
  const xs = new Float32Array(n)
  const zs = new Float32Array(n)
  const ts = new Float32Array(n)
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  for (let i = 0; i < n; i++) {
    tmpPos.fromArray(samples[i].position)
    tmpQuat.fromArray(samples[i].quaternion)
    const { position } = applySyncOffset(tmpPos, tmpQuat, syncOffset)
    xs[i] = position.x
    zs[i] = position.z
    ts[i] = samples[i].t
  }

  const WINDOW = 30

  function scanRange(refX, refZ, start, end) {
    let bestI = start
    let bestD2 = Infinity
    for (let i = start; i < end; i++) {
      const dx = xs[i] - refX
      const dz = zs[i] - refZ
      const d2 = dx * dx + dz * dz
      if (d2 < bestD2) { bestD2 = d2; bestI = i }
    }
    return { bestI, bestD2 }
  }

  return {
    size: n,
    /**
     * Return `{ t, idx, distance }` — the ghost-lap time-stamp at which the
     * lap was physically closest to (refX, refZ). `idx` is the segment
     * start index, usable as the next frame's `hintIdx` for O(1) search.
     */
    findTime(refX, refZ, hintIdx) {
      let bestI, bestD2
      if (hintIdx != null) {
        const lo = Math.max(0, hintIdx - WINDOW)
        const hi = Math.min(n, hintIdx + WINDOW + 1)
        ;({ bestI, bestD2 } = scanRange(refX, refZ, lo, hi))
        // Escape the window if the minimum landed on either edge — the real
        // optimum is probably further out (big jump).
        if (bestI === lo || bestI === hi - 1) {
          ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
        }
      } else {
        ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
      }

      // Project onto the two segments adjacent to bestI for sub-sample match.
      let segIdx = bestI
      let bestAlpha = 0
      let bestProjD2 = bestD2
      for (const [a, b] of [[Math.max(0, bestI - 1), bestI], [bestI, Math.min(n - 1, bestI + 1)]]) {
        if (a === b) continue
        const ax = xs[a], az = zs[a]
        const bx = xs[b], bz = zs[b]
        const vx = bx - ax
        const vz = bz - az
        const vv = vx * vx + vz * vz
        if (vv === 0) continue
        let alpha = ((refX - ax) * vx + (refZ - az) * vz) / vv
        if (alpha < 0) alpha = 0
        else if (alpha > 1) alpha = 1
        const px = ax + vx * alpha
        const pz = az + vz * alpha
        const d2 = (px - refX) * (px - refX) + (pz - refZ) * (pz - refZ)
        if (d2 < bestProjD2) { bestProjD2 = d2; segIdx = a; bestAlpha = alpha }
      }
      const tA = ts[segIdx]
      const tB = ts[Math.min(segIdx + 1, n - 1)]
      return { t: tA + (tB - tA) * bestAlpha, idx: segIdx, distance: Math.sqrt(bestProjD2) }
    },
  }
}
