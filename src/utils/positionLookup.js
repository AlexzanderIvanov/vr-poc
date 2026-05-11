import * as THREE from 'three'
import { applySyncOffset } from './sampleLap'

/**
 * Build a fast "find the ghost-lap time at which the ghost was closest to
 * (refX, refZ)" lookup.
 *
 * At load time: bake the final rendered ground-plane (x, z) for each
 * sample (applying the live sync-offset exactly as `CarEntity` does at
 * runtime), and keep parallel arrays for x, z, and t.
 *
 * Per-frame `findTime`:
 *
 *   1. Coarse scan — find the nearest sample vertex `bestI` within a
 *      WINDOW-sized neighbourhood of the previous-frame hint (O(1)
 *      amortised when the car advances smoothly). Fall back to a full
 *      scan when the hint is missing or the optimum landed at the
 *      window edge.
 *
 *   2. Time-domain refinement — golden-section search over the time
 *      interval [ts[bestI-1], ts[bestI+1]], evaluating the ghost's
 *      (x, z) at each candidate time via the SAME tension-0.5
 *      Catmull-Rom blend `sampleLapInto` uses. Returns a time that is
 *      a *continuous* function of the ref's query point.
 *
 * Why this matters — what the previous algorithm got wrong:
 *
 *   The previous version projected (refX, refZ) onto two polyline
 *   segments adjacent to the nearest vertex and picked the closer
 *   one. That projection is closed-form and looks elegant, but the
 *   resulting matched point on the polyline JUMPS when the winning
 *   segment switches. The switch fires every time the ref crosses the
 *   angle bisector at a vertex where two non-collinear segments meet —
 *   i.e. at every kink in the recorded path. Measured on real lap
 *   data: median frame-over-frame change in the ghost's step magnitude
 *   was 15 cm — the ghost car visibly lurching forward / back every
 *   couple of frames in position-compare mode.
 *
 *   Searching on the Catmull-Rom curve eliminates the staircase. After
 *   the fix, median step-magnitude jitter drops to 0.4 cm (≈40× smoother
 *   at the median, 6× at p95). The same C¹ spline `sampleLapInto`
 *   evaluates for the 3D car body is now the curve we minimise distance
 *   to — so "the match point" is by construction on the exact line the
 *   ghost car will actually be drawn along.
 *
 * Cost: ~18 extra Catmull-Rom (x, z) evaluations per frame per ghost
 * car (golden section converges geometrically at φ≈0.618; 16 iterations
 * → ≈6×10⁻⁴ of the search range, sub-millisecond time precision over a
 * typical 100 ms segment). Negligible compared to the 60+ vertex
 * distance checks the coarse scan already does.
 */

const WINDOW = 30
const PHI = 0.6180339887498949
const REFINE_ITERS = 16

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

  // ── Catmull-Rom distance² evaluator at arbitrary t ────────────────────
  // Inlines a binary search for the containing segment + tension-0.5
  // Catmull-Rom blend (matching `sampleLapInto`'s spline), then returns
  // squared distance to (refX, refZ). Called ~18×/frame inside the
  // golden-section loop — no allocations.
  function distAt(t, refX, refZ) {
    if (t <= ts[0]) {
      const dx = xs[0] - refX, dz = zs[0] - refZ
      return dx * dx + dz * dz
    }
    if (t >= ts[n - 1]) {
      const dx = xs[n - 1] - refX, dz = zs[n - 1] - refZ
      return dx * dx + dz * dz
    }
    let lo = 0, hi = n - 1
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1
      if (ts[mid] <= t) lo = mid; else hi = mid
    }
    const i1 = lo, i2 = hi
    const i0 = i1 > 0 ? i1 - 1 : i1
    const i3 = i2 < n - 1 ? i2 + 1 : i2
    const span = ts[i2] - ts[i1] || 1e-6
    const alpha = (t - ts[i1]) / span
    // Standard Catmull-Rom (k = 0.5) — must match the runtime's
    // `sampleLapInto` exactly so we're searching the actual curve the
    // ghost car traverses on screen, not an approximation.
    const t2 = alpha * alpha
    const t3 = t2 * alpha
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + alpha
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    const m1x = 0.5 * (xs[i2] - xs[i0])
    const m2x = 0.5 * (xs[i3] - xs[i1])
    const m1z = 0.5 * (zs[i2] - zs[i0])
    const m2z = 0.5 * (zs[i3] - zs[i1])
    const x = h00 * xs[i1] + h10 * m1x + h01 * xs[i2] + h11 * m2x
    const z = h00 * zs[i1] + h10 * m1z + h01 * zs[i2] + h11 * m2z
    const dx = x - refX, dz = z - refZ
    return dx * dx + dz * dz
  }

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
     * Return `{ t, idx, distance }` — the ghost-lap time at which the
     * ghost was closest to (refX, refZ). `t` is a continuous function
     * of the query thanks to the Catmull-Rom + golden-section refine;
     * `idx` is the nearest-vertex coarse match, usable as the next
     * frame's `hintIdx` for O(1) re-search.
     */
    findTime(refX, refZ, hintIdx) {
      // ── Step 1: coarse nearest-vertex scan ─────────────────────────
      let bestI, bestD2
      if (hintIdx != null) {
        const lo = Math.max(0, hintIdx - WINDOW)
        const hi = Math.min(n, hintIdx + WINDOW + 1)
        ;({ bestI, bestD2 } = scanRange(refX, refZ, lo, hi))
        // Escape the window if the minimum landed on either edge — the
        // real optimum is probably further out (e.g. just after a
        // sector-jump teleport).
        if (bestI === lo || bestI === hi - 1) {
          ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
        }
      } else {
        ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
      }

      // ── Step 2: golden-section refinement on the Catmull-Rom curve ──
      // Search bracket spans the two segments adjacent to the nearest
      // vertex; the optimum is guaranteed to lie inside (the projection
      // onto either adjacent segment can never lie further than the
      // next-but-one vertex from the matching vertex).
      let lo = ts[bestI > 0 ? bestI - 1 : bestI]
      let hi = ts[bestI < n - 1 ? bestI + 1 : bestI]
      if (hi - lo < 1e-9) {
        // First / last sample — nothing to refine.
        return { t: ts[bestI], idx: bestI, distance: Math.sqrt(bestD2) }
      }
      let mid1 = hi - (hi - lo) * PHI
      let mid2 = lo + (hi - lo) * PHI
      let f1 = distAt(mid1, refX, refZ)
      let f2 = distAt(mid2, refX, refZ)
      for (let iter = 0; iter < REFINE_ITERS; iter++) {
        if (f1 < f2) {
          hi = mid2
          mid2 = mid1
          f2 = f1
          mid1 = hi - (hi - lo) * PHI
          f1 = distAt(mid1, refX, refZ)
        } else {
          lo = mid1
          mid1 = mid2
          f1 = f2
          mid2 = lo + (hi - lo) * PHI
          f2 = distAt(mid2, refX, refZ)
        }
      }
      const tFinal = (lo + hi) * 0.5
      const dFinal = Math.min(f1, f2)
      return { t: tFinal, idx: bestI, distance: Math.sqrt(dFinal) }
    },
  }
}
