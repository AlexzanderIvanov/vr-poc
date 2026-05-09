/**
 * Corner analysis — derive per-corner brake / throttle key-points from a
 * lap's telemetry JSON. Consumed by the Corner Analysis mode UI.
 *
 * ## Telemetry schema (discovered at runtime from real files)
 *
 *   telemetry.samples[] = [{ t, tps, fbp, rbp, rpm, steer, ... }]
 *   telemetry.events[]  = [{ t, type, position }]
 *       type ∈ { 'brake_start', 'brake_end',
 *                 'full_throttle_on', 'full_throttle_off' }
 *   telemetry.phases[]  = [{ type, t_start, t_end, start_idx, end_idx,
 *                            distance_m, start_pos, end_pos, mid_pos,
 *                            brake_zone_number? }]
 *       type ∈ { 'braking', 'coasting', 'full_throttle' }
 *
 * ## Corner definition
 *
 * A "corner" is anchored by a `phases[]` entry with `type: 'braking'`
 * (which carries ``brake_zone_number`` as its identifier and
 * ``distance_m`` as the arc-length of the brake zone).
 *
 * For each braking phase we attach:
 *
 *   - ``brakeStart``   — phase.t_start + scene position (re-sampled with
 *                        the live sync-offset so markers align with where
 *                        the car is actually drawn).
 *   - ``brakeEnd``     — phase.t_end + scene position.
 *   - ``throttleOn``   — first sample after ``brakeEnd`` where
 *                        ``tps >= THROTTLE_ON_TPS`` (car begins accelerating).
 *   - ``fullThrottle`` — first ``full_throttle_on`` event after ``brakeEnd``
 *                        in the same corner window.
 *   - ``oscillations`` — dip-then-rise cycles in TPS between
 *                        ``throttleOn`` and ``fullThrottle``. Counts
 *                        "I lifted then re-applied" corner-exit mistakes.
 *   - ``maxBrake``     — peak ``fbp`` inside the brake window.
 *   - ``brakingDistanceM`` — arc length of the brake zone (phase.distance_m).
 *   - ``arcToBrakeStartM`` — cumulative arc length from lap start to the
 *                        brake-start point, for "where on the lap did each
 *                        driver start braking into this corner" comparisons.
 */

import * as THREE from 'three'
import {
  THROTTLE_ON_TPS,
  TPS_FULL_THRESHOLD as FULL_THROTTLE_TPS,
  OSCILLATION_TPS_DIP,
} from '../constants'

// Re-export so consumers that previously imported these from this module
// keep working. New code should pull straight from `../constants`.
export { THROTTLE_ON_TPS, FULL_THROTTLE_TPS, OSCILLATION_TPS_DIP }

const UP = new THREE.Vector3(0, 1, 0)


// Ground-plane speed (m/s) at an arbitrary time, estimated from the two
// nearest lap samples' (x, z) delta divided by their t delta.
function speedAtTime(lapSamples, t) {
  if (!lapSamples || lapSamples.length < 2) return 0
  const i = Math.min(lapSamples.length - 2, Math.max(0, sampleIndexAtTime(lapSamples, t)))
  const a = lapSamples[i]
  const b = lapSamples[i + 1]
  const dx = b.position[0] - a.position[0]
  const dz = b.position[2] - a.position[2]
  const dt = b.t - a.t
  if (dt <= 0) return 0
  return Math.sqrt(dx * dx + dz * dz) / dt
}


// -------------------------------------------------------------------------- //
// helpers
// -------------------------------------------------------------------------- //


function sampleIndexAtTime(samples, t) {
  if (!samples?.length) return -1
  if (t <= samples[0].t) return 0
  if (t >= samples[samples.length - 1].t) return samples.length - 1
  let lo = 0
  let hi = samples.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }
  return lo
}


function _applySync(position, quaternion, syncOffset) {
  if (!syncOffset) return { position }
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  const left = new THREE.Vector3().crossVectors(UP, forward).normalize()
  const p = position.clone()
  p.addScaledVector(forward, syncOffset.forward)
  p.addScaledVector(left, syncOffset.left)
  p.y += syncOffset.up
  return { position: p }
}


function sceneXYZAtTime(lapSamples, t, syncOffset) {
  const i = sampleIndexAtTime(lapSamples, t)
  if (i < 0) return null
  const curr = lapSamples[i]
  const next = lapSamples[Math.min(i + 1, lapSamples.length - 1)]
  const span = next.t - curr.t
  const alpha = span > 0 ? Math.max(0, Math.min(1, (t - curr.t) / span)) : 0
  const posA = new THREE.Vector3().fromArray(curr.position)
  const posB = new THREE.Vector3().fromArray(next.position)
  const pos = posA.lerp(posB, alpha)
  const quatA = new THREE.Quaternion().fromArray(curr.quaternion)
  const quatB = new THREE.Quaternion().fromArray(next.quaternion)
  const quat = quatA.slerp(quatB, alpha)
  return _applySync(pos, quat, syncOffset).position
}


// Cumulative ground-plane arc length along lap.samples[]. One Float32Array per
// lap, memoised across calls by key-ing on the samples array identity.
const _arcLenCache = new WeakMap()


function cumulativeArcLengths(lapSamples) {
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


function arcLengthAtTime(lapSamples, t) {
  if (!lapSamples?.length) return 0
  const cum = cumulativeArcLengths(lapSamples)
  const i = sampleIndexAtTime(lapSamples, t)
  const curr = lapSamples[i]
  const next = lapSamples[Math.min(i + 1, lapSamples.length - 1)]
  const span = next.t - curr.t
  const alpha = span > 0 ? Math.max(0, Math.min(1, (t - curr.t) / span)) : 0
  return cum[i] + (cum[Math.min(i + 1, lapSamples.length - 1)] - cum[i]) * alpha
}


export function totalLapArcLength(lap) {
  if (!lap?.samples?.length) return 0
  const cum = cumulativeArcLengths(lap.samples)
  return cum[cum.length - 1]
}


// -------------------------------------------------------------------------- //
// oscillation detector — sample-based dip-rise cycles in TPS
// -------------------------------------------------------------------------- //


function countOscillations(samples, tStart, tEnd) {
  if (!samples?.length || tEnd <= tStart) return 0
  const iStart = sampleIndexAtTime(samples, tStart)
  const iEnd = sampleIndexAtTime(samples, tEnd)
  if (iEnd <= iStart) return 0

  let count = 0
  let phase = 'rising'
  let extremum = samples[iStart].tps
  for (let i = iStart + 1; i <= iEnd; i++) {
    const tps = samples[i].tps
    if (phase === 'rising') {
      if (tps > extremum) extremum = tps
      else if (extremum - tps >= OSCILLATION_TPS_DIP) {
        phase = 'falling'
        extremum = tps
      }
    } else {
      if (tps < extremum) extremum = tps
      else if (tps - extremum >= OSCILLATION_TPS_DIP) {
        count += 1
        phase = 'rising'
        extremum = tps
      }
    }
  }
  return count
}


// -------------------------------------------------------------------------- //
// main entry
// -------------------------------------------------------------------------- //


export function computeCornerAnalysis(lap, telemetry, syncOffset) {
  if (!lap?.samples?.length || !telemetry) return []
  const tSamples = telemetry.samples ?? []
  const phases = telemetry.phases ?? []
  const events = telemetry.events ?? []

  const brakingPhases = phases
    .filter((p) => p.type === 'braking' && p.t_start != null)
    .sort((a, b) => a.t_start - b.t_start)
  const fullThrottleOnEvents = events
    .filter((e) => e.type === 'full_throttle_on' && e.t != null)
    .sort((a, b) => a.t - b.t)

  const corners = []
  for (let k = 0; k < brakingPhases.length; k++) {
    const bp = brakingPhases[k]
    const windowEnd = brakingPhases[k + 1]?.t_start ?? (tSamples[tSamples.length - 1]?.t ?? bp.t_end + 10)

    // throttleOn — first sample after brake end where tps >= THROTTLE_ON_TPS.
    let throttleOn = null
    const iAfter = sampleIndexAtTime(tSamples, bp.t_end)
    for (let i = iAfter; i < tSamples.length && tSamples[i].t <= windowEnd; i++) {
      if (tSamples[i].tps >= THROTTLE_ON_TPS) {
        throttleOn = { t: tSamples[i].t, tps: tSamples[i].tps }
        break
      }
    }

    // fullThrottle — first ``full_throttle_on`` event in the corner window.
    const ftEvent = fullThrottleOnEvents.find((e) => e.t > bp.t_end && e.t <= windowEnd)
    const fullThrottle = ftEvent ? { t: ftEvent.t } : null

    // maxBrake — peak front-brake pressure in the braking phase.
    let maxBrake = 0
    const i0 = sampleIndexAtTime(tSamples, bp.t_start)
    const i1 = sampleIndexAtTime(tSamples, bp.t_end)
    for (let i = i0; i <= i1 && i < tSamples.length; i++) {
      if (tSamples[i].fbp > maxBrake) maxBrake = tSamples[i].fbp
    }

    // Oscillations — dip-rise cycles between throttleOn and fullThrottle
    // (if the pedal never reaches full, we scan to the end of the window).
    const oscEnd = fullThrottle ? fullThrottle.t : windowEnd
    const oscillations = throttleOn ? countOscillations(tSamples, throttleOn.t, oscEnd) : 0

    // Apex window: from brake_start through full_throttle (or throttle-on
    // if the pedal never pinned, else end of the corner segment). Wider
    // window than before so late apexes (drivers who keep turning after
    // cracking the throttle) still get found.
    const apexWindowEnd = (fullThrottle?.t ?? throttleOn?.t ?? windowEnd)

    // Geometric apex — point on the driven trajectory with the highest
    // **path curvature**. Compute k = Δθ / Δs from three consecutive lap
    // samples (the discrete estimator of "how sharply is the car turning
    // per metre driven"). Point of peak curvature ≈ real geometric apex,
    // independent of steering-rack geometry or under/oversteer.
    let geomApex = null
    {
      const iA = Math.max(1, sampleIndexAtTime(lap.samples, bp.t_start))
      const iB = Math.min(lap.samples.length - 2, sampleIndexAtTime(lap.samples, apexWindowEnd))
      let peakK = -1
      let peakT = null
      for (let i = iA; i <= iB; i++) {
        const p0 = lap.samples[i - 1].position
        const p1 = lap.samples[i].position
        const p2 = lap.samples[i + 1].position
        const v1x = p1[0] - p0[0], v1z = p1[2] - p0[2]
        const v2x = p2[0] - p1[0], v2z = p2[2] - p1[2]
        const len1 = Math.sqrt(v1x * v1x + v1z * v1z)
        const len2 = Math.sqrt(v2x * v2x + v2z * v2z)
        if (len1 < 1e-6 || len2 < 1e-6) continue
        const cosA = Math.max(-1, Math.min(1, (v1x * v2x + v1z * v2z) / (len1 * len2)))
        const angle = Math.acos(cosA)
        const k = angle / ((len1 + len2) * 0.5)
        if (k > peakK) { peakK = k; peakT = lap.samples[i].t }
      }
      if (peakT != null) {
        geomApex = {
          t: peakT,
          pos: sceneXYZAtTime(lap.samples, peakT, syncOffset),
          curvature: peakK,
          radius: peakK > 0 ? 1 / peakK : null,
        }
      }
    }

    // Speed apex — lap-sample with minimum ground-plane speed in the apex
    // window. Skip endpoints so the forward-difference estimator has
    // neighbours. The apex window here is **brake_start → apexWindowEnd**,
    // wide enough to cover both early and late apexes.
    let speedApex = null
    {
      const iA = Math.max(1, sampleIndexAtTime(lap.samples, bp.t_start))
      const iB = Math.min(lap.samples.length - 2, sampleIndexAtTime(lap.samples, apexWindowEnd))
      let minSpeed = Infinity
      let minT = null
      for (let i = iA; i <= iB; i++) {
        const v = speedAtTime(lap.samples, lap.samples[i].t)
        if (v < minSpeed) { minSpeed = v; minT = lap.samples[i].t }
      }
      if (minT != null) {
        speedApex = {
          t: minT,
          pos: sceneXYZAtTime(lap.samples, minT, syncOffset),
          speedMps: minSpeed,
        }
      }
    }

    // Scene positions — re-sample from lap geometry with live sync-offset,
    // so the 3D markers move with the sync-slider UI exactly like the car.
    const brakeStartPos = sceneXYZAtTime(lap.samples, bp.t_start, syncOffset)
    const brakeEndPos = sceneXYZAtTime(lap.samples, bp.t_end, syncOffset)
    const throttleOnPos = throttleOn ? sceneXYZAtTime(lap.samples, throttleOn.t, syncOffset) : null
    const fullThrottlePos = fullThrottle ? sceneXYZAtTime(lap.samples, fullThrottle.t, syncOffset) : null

    corners.push({
      cornerNumber: bp.brake_zone_number ?? (k + 1),
      brakeStart: { t: bp.t_start, pos: brakeStartPos },
      brakeEnd: { t: bp.t_end, pos: brakeEndPos },
      throttleOn: throttleOn ? { t: throttleOn.t, pos: throttleOnPos } : null,
      fullThrottle: fullThrottle ? { t: fullThrottle.t, pos: fullThrottlePos } : null,
      geomApex,
      speedApex,
      oscillations,
      maxBrake,
      brakingDistanceM: bp.distance_m ?? null,
      arcToBrakeStartM: arcLengthAtTime(lap.samples, bp.t_start),
      arcToFullThrottleM: fullThrottle ? arcLengthAtTime(lap.samples, fullThrottle.t) : null,
    })
  }

  return corners
}


// -------------------------------------------------------------------------- //
// pair ref vs ghost corners for Δ-metrics
// -------------------------------------------------------------------------- //


function planar2D(a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}


export function pairCorners(refCorners, ghostCorners) {
  const byNumber = new Map(ghostCorners.map((c) => [c.cornerNumber, c]))
  const out = []
  for (const ref of refCorners) {
    const ghost = byNumber.get(ref.cornerNumber) ?? null
    const entry = { cornerNumber: ref.cornerNumber, ref, ghost }
    if (ghost) {
      entry.brakeStartDistanceM = ref.brakeStart?.pos && ghost.brakeStart?.pos
        ? planar2D(ref.brakeStart.pos, ghost.brakeStart.pos) : null
      entry.fullThrottleDistanceM = ref.fullThrottle?.pos && ghost.fullThrottle?.pos
        ? planar2D(ref.fullThrottle.pos, ghost.fullThrottle.pos) : null
      entry.geomApexDistanceM = ref.geomApex?.pos && ghost.geomApex?.pos
        ? planar2D(ref.geomApex.pos, ghost.geomApex.pos) : null
      entry.speedApexDistanceM = ref.speedApex?.pos && ghost.speedApex?.pos
        ? planar2D(ref.speedApex.pos, ghost.speedApex.pos) : null
      entry.oscillationDelta = (ref.oscillations ?? 0) - (ghost.oscillations ?? 0)
      entry.maxBrakeDelta = (ref.maxBrake ?? 0) - (ghost.maxBrake ?? 0)
      // Cumulative distance at brake-start: how far around the lap was each
      // driver when they started braking. Useful as "which lap was ahead
      // at this corner entry" — positive = ref ahead on track.
      entry.arcToBrakeStartDeltaM = ref.arcToBrakeStartM != null && ghost.arcToBrakeStartM != null
        ? ref.arcToBrakeStartM - ghost.arcToBrakeStartM : null
      // Minimum-speed delta in km/h — tells you which driver slowed less
      // through the apex (positive = ref carried more speed).
      entry.speedApexDeltaKph = ref.speedApex?.speedMps != null && ghost.speedApex?.speedMps != null
        ? (ref.speedApex.speedMps - ghost.speedApex.speedMps) * 3.6 : null
    }
    out.push(entry)
  }
  for (const ghost of ghostCorners) {
    if (!refCorners.find((c) => c.cornerNumber === ghost.cornerNumber)) {
      out.push({ cornerNumber: ghost.cornerNumber, ref: null, ghost })
    }
  }
  return out.sort((a, b) => a.cornerNumber - b.cornerNumber)
}


// -------------------------------------------------------------------------- //
// per-sector arc length (used by the panel "sector distances" grid)
// -------------------------------------------------------------------------- //


export function addSectorArcLengths(sectors, lap) {
  if (!sectors?.length || !lap?.samples?.length) return sectors ?? []
  const samples = lap.samples
  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i]
    const t0 = s.t1Start ?? 0
    const t1 = sectors[i + 1]?.t1Start ?? samples[samples.length - 1].t
    s.arcLengthM = Math.max(0, arcLengthAtTime(samples, t1) - arcLengthAtTime(samples, t0))
  }
  return sectors
}
