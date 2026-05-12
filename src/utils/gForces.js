import * as THREE from 'three'

/**
 * Compute longitudinal-G, lateral-G and combined-G for each sample of a lap.
 *
 * Inputs: an array of samples with `{ t, position[3], quaternion[4] }`.
 * Returns: an array of `{ t, longG, latG, gsum }`, one per input sample.
 *
 * Method:
 *   1. Central-difference horizontal positions → ground-plane velocity.
 *   2. Smooth velocity with a cascaded moving average (triangular).
 *   3. Central-difference the SMOOTHED velocity → acceleration.
 *   4. Smooth acceleration with a second cascaded MA.
 *   5. Project into the car's local frame (forward / right axes from
 *      the sample's quaternion, flattened to the horizontal plane)
 *      and divide by 9.81 → longG / latG / gsum.
 *
 * Why smooth velocity BEFORE differentiating to accel: two-stage
 * filtering is equivalent to a longer derivative kernel applied to
 * position. The motivating case was a lap whose positions had been
 * upsampled upstream from a low-rate source (≈1 Hz) into a fake 20 Hz
 * stream — every 20th sample sits at a C² discontinuity from the
 * interpolation, which double-differentiation amplifies into periodic
 * 1 Hz spikes (median position-residual at those indices was ~7-10×
 * the baseline at all other indices; p99 ≈ 60 cm). Diff-then-smooth
 * alone left that lap's longitudinal-g jitter ~3.5× a cleanly-
 * recorded lap; adding the velocity-smoothing stage spans multiple
 * glitch periods and brings them within 1.2× of each other.
 *
 * Each smoothing pass is itself a cascaded MA (two flat-MA passes
 * → triangular window): sinc² stopband (≈ −26 dB) instead of plain
 * MA's sinc (≈ −13 dB). Better attenuation at the same window
 * length.
 *
 * Window length is `SMOOTH_WINDOW = 11`. Effective per-stage
 * triangular window ≈ 21 samples = 1.05 s; total temporal extent
 * influencing each accel sample ≈ 2 s — wide enough to span two full
 * 1 Hz glitch periods on the upsampled-source lap, while preserving
 * real 1.5-s brake / corner events with ~15-25 % peak attenuation
 * (intentional trade-off: in noisy data, raw peaks weren't real
 * anyway).
 *
 * Vertical acceleration is intentionally dropped — racing g-forces
 * are conventionally reported in the ground plane.
 */

const G = 9.81
const SMOOTH_WINDOW = 11

export function computeGForces(samples) {
  const n = samples?.length || 0
  if (n < 5) return null

  // ── Stage 1: raw ground-plane velocity (central diff of position) ──
  const vxRaw = new Float32Array(n)
  const vzRaw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    const dt = samples[hi].t - samples[lo].t
    if (dt <= 0) continue
    vxRaw[i] = (samples[hi].position[0] - samples[lo].position[0]) / dt
    vzRaw[i] = (samples[hi].position[2] - samples[lo].position[2]) / dt
  }

  // Cascaded-MA helper. Two passes through `onePass` give a
  // triangular-shaped impulse response (sinc² stopband ≈ −26 dB)
  // at the same total length as the longer flat MA would have, but
  // with materially better high-frequency attenuation.
  const half = (SMOOTH_WINDOW - 1) >> 1
  const onePass = (src, dst) => {
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0
      const lo = Math.max(0, i - half)
      const hi = Math.min(n - 1, i + half)
      for (let j = lo; j <= hi; j++) { sum += src[j]; cnt++ }
      dst[i] = sum / cnt
    }
  }
  const cascadeMA = (src) => {
    const tmp = new Float32Array(n)
    const out = new Float32Array(n)
    onePass(src, tmp)
    onePass(tmp, out)
    return out
  }

  // ── Stage 2: smooth velocity before differentiating. Critical for
  // noisy sessions — diff-then-smooth alone left blue-lap longitudinal
  // jitter ~3.5× red-lap; smooth-then-diff-then-smooth brings them
  // within 1.2× of each other.
  const vxS = cascadeMA(vxRaw)
  const vzS = cascadeMA(vzRaw)

  // ── Stage 3: acceleration via central diff of SMOOTHED velocity ──
  const axRaw = new Float32Array(n)
  const azRaw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    const dt = samples[hi].t - samples[lo].t
    if (dt <= 0) continue
    axRaw[i] = (vxS[hi] - vxS[lo]) / dt
    azRaw[i] = (vzS[hi] - vzS[lo]) / dt
  }

  // ── Stage 4: smooth acceleration with the second cascade ─────────
  const axS = cascadeMA(axRaw)
  const azS = cascadeMA(azRaw)

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
