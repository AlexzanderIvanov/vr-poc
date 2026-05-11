/**
 * Data-pipeline transforms applied as laps load.
 *
 * Re-exports the existing utility functions so the rest of the codebase
 * can import from a single place (`services/transforms`) once the data
 * layer migration is complete. The original modules under `utils/` are
 * preserved as-is for now; this file is the canonical entry for the
 * data layer and the place to add new derivations.
 *
 * Pipeline order (mirrors the legacy App.jsx#loadAssets sequence):
 *   1. `applyConsensusDelta(lap.samples, sharedDelta)` — moves baked
 *      track-frame samples into the latest consensus AI-line frame.
 *   2. `smoothSamplePositionsXZ(lap.samples)` — Savitzky-Golay 7-point
 *      cubic smoother on horizontal positions to denoise GPS jitter.
 *   3. Derived channels — `computeGForces`, `computeGpsSpeed`. The mock
 *      backend pre-computes these and attaches them to the lap so the
 *      rest of the app reads channels without recomputing on the fly.
 */

export { applyConsensusDelta } from '../utils/consensus'
export { smoothSamplePositionsXZ } from '../utils/smoothing'
export { computeGForces } from '../utils/gForces'

/**
 * GPS-derived speed series, one entry per `lap.samples` index.
 *
 * Returns `[t, kmh]` tuples so it drops directly into ECharts series data
 * (which expects 2-tuples for `[time, value]` points).
 *
 * Method:
 *   1. Central-difference horizontal (XZ) positions → raw ground-plane
 *      speed.  Y is intentionally skipped: even after the load-time
 *      smoothing of `smoothSamplePositionsXZ` (which now applies a wider
 *      triangular window to Y for visual purposes), absolute vertical
 *      accuracy is still poorer than horizontal — folding it into the
 *      speed differentiator was producing 10–20 km/h waves on the chart.
 *      Track elevation does contribute a real component to ground speed,
 *      but the horizontal approximation is the convention for racing
 *      telemetry and what AIM / RaceStudio reports.
 *
 *   2. Two flat moving-average passes (cascaded).
 *      A single flat MA reduces variance by `1/N`, but its frequency
 *      response is a sinc with ~-13 dB first-side-lobe — content in
 *      that lobe survives as visible wiggle. Cascading two MAs is
 *      equivalent to a TRIANGULAR window, whose response is sinc² —
 *      side-lobes are squared, so they drop to ~-26 dB. At the same
 *      total filter length, the triangular response gives
 *      dramatically cleaner stopband than flat-MA with no extra
 *      compute cost worth worrying about (each pass is O(N) and N is
 *      ~2000).
 *
 *      Window 9 + window 9 → effective length 17 samples = 0.85 s at
 *      20 Hz. Real brake events (>1 s typical) survive intact; the
 *      0.5-1 km/h sample-to-sample chop that GPS noise produces after
 *      the position smoother is cleanly suppressed.
 *
 *      We tried Savitzky-Golay 7-cubic here first — but its negative
 *      end-coefficients (-2, 3, 6, 7, 6, 3, -2) act like a partial
 *      differentiator on white-ish noise, so noise variance actually
 *      INCREASED ~2× vs flat MA-7. SG is the right tool when you must
 *      preserve cubic shape, wrong tool when you want max noise
 *      rejection at a given window length.
 */
const PASS_WINDOW = 9
const PASS_HALF = (PASS_WINDOW - 1) >> 1

// In-place centred moving average. Edges average over the available
// window (shrinks symmetrically) so endpoints don't jump.
function movingAverageInPlace(src, dst, n) {
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    const lo = Math.max(0, i - PASS_HALF)
    const hi = Math.min(n - 1, i + PASS_HALF)
    for (let j = lo; j <= hi; j++) { sum += src[j]; cnt++ }
    dst[i] = sum / cnt
  }
}

export function computeGpsSpeed(samples) {
  if (!samples?.length) return null
  const n = samples.length

  // Step 1: raw horizontal speed via 2-sample central difference.
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    const dt = samples[hi].t - samples[lo].t
    if (dt <= 0) continue
    const dx = samples[hi].position[0] - samples[lo].position[0]
    const dz = samples[hi].position[2] - samples[lo].position[2]
    raw[i] = Math.hypot(dx, dz) / dt
  }

  // Step 2: cascade two moving-average passes (triangular-window equivalent).
  const pass1 = new Float32Array(n)
  movingAverageInPlace(raw, pass1, n)
  const pass2 = new Float32Array(n)
  movingAverageInPlace(pass1, pass2, n)

  // Step 3: pack into `[t, kmh]` tuples — m/s × 3.6 → km/h.
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = [samples[i].t, pass2[i] * 3.6]
  }
  return out
}
