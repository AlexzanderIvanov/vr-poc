/**
 * Cumulative ground-plane (XZ) arc-length tables for lap sample arrays.
 *
 * The `cumulativeArcLengths(samples)` accessor returns a `Float32Array` of
 * the same length as `samples`, where entry `i` is the total distance
 * driven from `samples[0]` to `samples[i]`. The result is cached per
 * `samples` array identity via a `WeakMap`, so repeated callers (e.g. the
 * chart-axis converter and the corner-analysis pipeline) share one
 * computation per lap.
 *
 * `arcLengthAtTime(samples, t)` linearly interpolates between adjacent
 * samples — returns `0` for empty input and the trailing total for
 * out-of-range times.
 *
 * Both helpers are pure (no React, no THREE) so they can run on the cold
 * data-prep path (chart series construction) and the hot path equally.
 *
 * `cornerAnalysis.js` re-exports these for back-compat; new callers
 * should import here directly.
 */
const _arcLenCache = new WeakMap()

export function cumulativeArcLengths(lapSamples) {
  if (!lapSamples?.length) return new Float32Array(0)
  let cum = _arcLenCache.get(lapSamples)
  if (cum) return cum
  cum = new Float32Array(lapSamples.length)
  for (let i = 1; i < lapSamples.length; i++) {
    const a = lapSamples[i - 1].position
    const b = lapSamples[i].position
    const dx = b[0] - a[0]
    const dz = b[2] - a[2]
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz)
  }
  _arcLenCache.set(lapSamples, cum)
  return cum
}

export function totalArcLength(lapSamples) {
  const cum = cumulativeArcLengths(lapSamples)
  return cum.length ? cum[cum.length - 1] : 0
}

/**
 * Linearly-interpolated arc length at a given time. Uses a binary search
 * to find the bracketing samples, then interpolates the cumulative-arc
 * value between them.
 */
export function arcLengthAtTime(lapSamples, t) {
  if (!lapSamples?.length) return 0
  const n = lapSamples.length
  const cum = cumulativeArcLengths(lapSamples)
  if (t <= lapSamples[0].t) return 0
  if (t >= lapSamples[n - 1].t) return cum[n - 1]
  let lo = 0, hi = n - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (lapSamples[mid].t <= t) lo = mid; else hi = mid
  }
  const a = lapSamples[lo], b = lapSamples[hi]
  const span = b.t - a.t
  const alpha = span > 0 ? (t - a.t) / span : 0
  return cum[lo] + (cum[hi] - cum[lo]) * alpha
}

/**
 * Build a `[t → distance]` converter closure for a lap. Returns the
 * identity function (passes time through unchanged) when `lap` is empty,
 * so callers can use it as a drop-in default for non-position contexts.
 */
export function makeArcLengthConverter(lapSamples) {
  if (!lapSamples?.length) return (t) => t
  return (t) => arcLengthAtTime(lapSamples, t)
}

/**
 * Inverse of `arcLengthAtTime` — binary-searches the cum-arc table for
 * the bracketing distance, then linearly interpolates the lap's sample
 * times. Used by chart gesture handlers to convert pixel→distance→time
 * so a click in distance-axis mode still writes a `playhead` value in
 * seconds (the canonical clock).
 */
export function timeAtArcLength(lapSamples, dist) {
  if (!lapSamples?.length) return 0
  const n = lapSamples.length
  const cum = cumulativeArcLengths(lapSamples)
  if (dist <= 0) return lapSamples[0].t
  if (dist >= cum[n - 1]) return lapSamples[n - 1].t
  let lo = 0, hi = n - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= dist) lo = mid; else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const alpha = span > 0 ? (dist - cum[lo]) / span : 0
  return lapSamples[lo].t + (lapSamples[hi].t - lapSamples[lo].t) * alpha
}
