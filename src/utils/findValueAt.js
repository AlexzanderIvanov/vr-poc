/**
 * Linear-interpolating lookup over an `[t, v]` tuple array.
 *
 * Returns `null` for empty input. Out-of-range times clamp to the first or
 * last sample's value (no extrapolation). Time inside the range is linearly
 * interpolated between the two bracketing samples — same convention ECharts
 * uses for axis-pointer crosshairs.
 *
 * Lives outside `ChartValueLabels.jsx` so its `.jsx` file exports only React
 * components — vite's Fast Refresh refuses to hot-reload mixed-export
 * `.jsx` files (warning: "incompatible export") and we use this helper from
 * both ChartValueLabels and the per-chart panel components.
 */
export function findValueAt(data, t) {
  if (!data?.length) return null
  const n = data.length
  if (t <= data[0][0]) return data[0][1]
  if (t >= data[n - 1][0]) return data[n - 1][1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (data[mid][0] <= t) lo = mid
    else hi = mid
  }
  const [t0, v0] = data[lo]
  const [t1, v1] = data[hi]
  if (t1 === t0) return v0
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
}
