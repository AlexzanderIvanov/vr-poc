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
 *      speed.  Y is intentionally skipped: `smoothSamplePositionsXZ` only
 *      smooths X and Z, so the vertical channel still carries 2–3 m of
 *      raw GPS jitter — folding it into the speed differentiator turned
 *      that into 10–20 km/h waves on the chart. Track elevation does
 *      contribute a real component to ground speed, but the horizontal
 *      approximation is the convention for racing telemetry and what
 *      AIM / RaceStudio reports.
 *   2. Moving-average post-smoothing (window matches `computeGForces`).
 *      Differentiation amplifies whatever residual position noise is
 *      left after the Savitzky-Golay XZ smoother; without a post-pass
 *      the chart was visibly choppy at every sample.
 */
const SPEED_SMOOTH_WINDOW = 7   // odd; ~0.35 s at 20 Hz

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

  // Step 2: moving-average smoothing. Same pattern `computeGForces` uses
  // after its second differentiation — keeps the visible signal stable
  // without losing brake-zone fidelity (window is ~0.35 s, well below
  // typical brake-event duration).
  const half = (SPEED_SMOOTH_WINDOW - 1) >> 1
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    for (let j = lo; j <= hi; j++) { sum += raw[j]; cnt++ }
    out[i] = [samples[i].t, (sum / cnt) * 3.6]
  }
  return out
}
