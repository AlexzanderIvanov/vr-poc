/**
 * Savitzky-Golay 7-point cubic smoother on the X / Z components of the lap
 * samples. Leaves Y (altitude) and the quaternion untouched.
 *
 * Some recorded laps carry per-50 ms position noise of ±10–20 cm — the per-
 * segment derivative implies up to 50 g of acceleration, which is obviously
 * not real motion. Catmull-Rom interpolation faithfully reproduces this
 * noise as a continuous wobble between sample boundaries; the runtime 8 Hz
 * exponential LP only attenuates 20 Hz noise to ~37%, leaving visible chop.
 *
 * SG cubic-7 with coefficients (-2, 3, 6, 7, 6, 3, -2)/21 attenuates 20 Hz
 * content by ~14 dB while preserving local cubic shape — peak braking and
 * cornering profiles survive intact. Mean position shift on a noisy lap is
 * ~9 cm, p95 ~28 cm — within mesh thickness and not visually material at
 * the chase camera distance. Edges (first/last 3 samples) are left raw.
 */

const _SG7_W = [-2, 3, 6, 7, 6, 3, -2]

export function smoothSamplePositionsXZ(samples) {
  const n = samples?.length ?? 0
  if (n < 7) return
  const xs = new Float64Array(n)
  const zs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = samples[i].position[0]
    zs[i] = samples[i].position[2]
  }
  for (let i = 3; i < n - 3; i++) {
    let sx = 0, sz = 0
    for (let k = -3; k <= 3; k++) {
      const w = _SG7_W[k + 3]
      sx += w * xs[i + k]
      sz += w * zs[i + k]
    }
    samples[i].position[0] = sx / 21
    samples[i].position[2] = sz / 21
  }
}
