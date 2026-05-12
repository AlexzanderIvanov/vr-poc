/**
 * Pure-data helpers for sampling a value at time `t` from a
 * time-sorted array. Both functions are binary-search + linear-
 * interpolation; out-of-range times clamp (no extrapolation); empty
 * inputs return `null`. Same convention ECharts uses for its own
 * axis-pointer crosshairs, so sampling here stays consistent with
 * what the chart visually draws.
 *
 * Two access patterns, one implementation:
 *
 *   • `findValueAt(data, t)`             — `data` is an `[t, v]`
 *                                          tuple array (the chart-
 *                                          series shape).
 *   • `interpolateField(arr, field, t)`  — `arr` is an array of
 *                                          objects with a `.t` field
 *                                          and a named numeric field.
 *
 * Lives outside any `.jsx` file because vite's Fast Refresh refuses
 * to hot-reload mixed-export `.jsx` modules — keep this purely JS.
 */

/**
 * Binary-search + interpolate a `[t, v]` tuple array.
 * Thin wrapper around `interpolateField` for backwards compatibility
 * with the many call sites that take this shape.
 */
export function findValueAt(data, t) {
  return interpolateField(data, 1, t)
}

/**
 * Binary-search + interpolate a value at time `t`.
 *
 * `arr` items can be either:
 *   - `[t, v]` tuple — pass `field = 1` to read the value at index 1.
 *   - `{ t, …, [field]: v }` object — pass the property name.
 *
 * Out-of-range times clamp to the first/last sample's value. Returns
 * `null` for empty / missing input or when an end-point's value is
 * null/undefined.
 */
export function interpolateField(arr, field, t) {
  if (!arr?.length) return null
  const n = arr.length
  const tupleShape = typeof field === 'number'
  const T = tupleShape
    ? (i) => arr[i][0]
    : (i) => arr[i].t
  const V = tupleShape
    ? (i) => arr[i][field]
    : (i) => arr[i][field]
  if (t <= T(0)) return V(0) ?? null
  if (t >= T(n - 1)) return V(n - 1) ?? null
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (T(mid) <= t) lo = mid
    else hi = mid
  }
  const t0 = T(lo), t1 = T(hi)
  const v0 = V(lo), v1 = V(hi)
  if (v0 == null || v1 == null) return null
  if (t1 === t0) return v0
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
}
