/**
 * Load-time position smoother on the lap-samples array.
 *
 * Two filters, picked per axis because the noise spectra are very different:
 *
 *   XZ:  Savitzky-Golay 7-point cubic, (-2, 3, 6, 7, 6, 3, -2)/21
 *        XZ noise on these laps is ±10–20 cm sample-to-sample. Catmull-Rom
 *        faithfully reproduces it as continuous wobble between samples;
 *        SG-7 attenuates 20 Hz content by ~14 dB while preserving local
 *        cubic shape so peak braking and cornering profiles survive intact.
 *        Mean horizontal shift on a noisy lap is ~9 cm, p95 ~28 cm — within
 *        track mesh thickness, not visually material at chase distance.
 *
 *   Y:   Cascaded MA-11 × MA-11 (triangular-21, 1.05 s effective window).
 *        Raw Y carries GPS vertical noise of up to ±10 cm per 50 ms sample,
 *        which integrates to p95 vertical acceleration of 6 m/s² (0.6 g of
 *        fake "bobbing") — the car looks like it's hopping on a rough road
 *        even on flat sections. SG-7 was too short here (only halves it).
 *        A 1.05 s window kills 8× more vertical accel (down to ~0.8 m/s²
 *        p95) while preserving any real elevation feature longer than 2 s.
 *        Real-world track elevation changes are 3-5 s long at racing speeds
 *        (16 m elevation over a ~100 m horizontal span), so they pass
 *        through untouched. Maximum vertical shift from raw to smoothed:
 *        ~12 cm — invisible at chase camera distance.
 *
 *        We cascade two flat MAs (sinc² stopband, ~-26 dB) rather than a
 *        single flat MA (sinc, ~-13 dB) because the second-side-lobe
 *        attenuation matters at this window length. Same rationale as the
 *        triangular smoother in `computeGpsSpeed`.
 *
 * Quaternion is left untouched — heading noise is already much lower than
 * position noise and component-wise Catmull-Rom + post-normalize is well-
 * behaved between adjacent samples.
 */

const _SG7_W = [-2, 3, 6, 7, 6, 3, -2]

// Y-axis cascaded triangular window: 11 + 11 → effective length 21 samples
// at 20 Hz = 1.05 s.
const Y_PASS_WINDOW = 11
const Y_PASS_HALF = (Y_PASS_WINDOW - 1) >> 1

function maInPlace(src, dst, n) {
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0
    const lo = Math.max(0, i - Y_PASS_HALF)
    const hi = Math.min(n - 1, i + Y_PASS_HALF)
    for (let j = lo; j <= hi; j++) { sum += src[j]; cnt++ }
    dst[i] = sum / cnt
  }
}

export function smoothSamplePositionsXZ(samples) {
  const n = samples?.length ?? 0
  if (n < 7) return

  // ─── XZ: SG-7 cubic ─────────────────────────────────────────────────────
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

  // ─── Y: cascaded triangular window ──────────────────────────────────────
  // Needs n ≥ 11 to be meaningful; SG path above already needed n ≥ 7, so
  // we ungate on the same check.
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) ys[i] = samples[i].position[1]
  const pass1 = new Float64Array(n)
  const pass2 = new Float64Array(n)
  maInPlace(ys, pass1, n)
  maInPlace(pass1, pass2, n)
  for (let i = 0; i < n; i++) samples[i].position[1] = pass2[i]
}
