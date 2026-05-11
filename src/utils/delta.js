/**
 * Compute the per-distance time delta between two laps + braking-derived
 * sectors. Pure data; no THREE dependency.
 *
 * Returns:
 *   {
 *     points:  [{ dist, t1, t2, delta, position }],   // ~2 m apart along ref
 *     sectors: [{ number, idxStart, idxEnd, avgDelta, sectorDelta, winner,
 *                 midPosition, t1Start, t2Start, distStart, distEnd }],
 *     totalDist,
 *     lap1Id, lap2Id,
 *   }
 *
 * `lap*Color` USED to live here too (snapshotted from `lap.color` at
 * compute time) — removed because presentation colour is owned by the
 * store's `lapColors` slice now, resolved via `useLapColor(lapId)`. The
 * IDs above let any consumer fetch the current colour reactively.
 */
export function computeLapDelta(laps, telemetryData) {
  if (laps.length < 2) return null
  const lap1 = laps[0], lap2 = laps[1]
  if (!lap1?.samples?.length || !lap2?.samples?.length) return null

  function cumDist(samples) {
    const d = [0]
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].position, b = samples[i].position
      d.push(d[i - 1] + Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2))
    }
    return d
  }

  const d1 = cumDist(lap1.samples), d2 = cumDist(lap2.samples)
  const totalDist = Math.min(d1[d1.length - 1], d2[d2.length - 1])

  const step = 2 // every 2 meters
  const points = []
  let idx1 = 0, idx2 = 0

  for (let dist = 0; dist <= totalDist; dist += step) {
    while (idx1 + 1 < d1.length && d1[idx1 + 1] < dist) idx1++
    while (idx2 + 1 < d2.length && d2[idx2 + 1] < dist) idx2++
    if (idx1 + 1 >= d1.length || idx2 + 1 >= d2.length) break

    const span1 = d1[idx1 + 1] - d1[idx1]
    const span2 = d2[idx2 + 1] - d2[idx2]
    const alpha1 = span1 > 0 ? Math.min(1, (dist - d1[idx1]) / span1) : 0
    const alpha2 = span2 > 0 ? Math.min(1, (dist - d2[idx2]) / span2) : 0

    const ni1 = Math.min(idx1 + 1, lap1.samples.length - 1)
    const ni2 = Math.min(idx2 + 1, lap2.samples.length - 1)
    const t1 = lap1.samples[idx1].t + (lap1.samples[ni1].t - lap1.samples[idx1].t) * alpha1
    const t2 = lap2.samples[idx2].t + (lap2.samples[ni2].t - lap2.samples[idx2].t) * alpha2

    const s1 = lap1.samples[idx1], s2 = lap1.samples[ni1]
    const px = s1.position[0] + (s2.position[0] - s1.position[0]) * alpha1
    const py = s1.position[1] + (s2.position[1] - s1.position[1]) * alpha1
    const pz = s1.position[2] + (s2.position[2] - s1.position[2]) * alpha1

    points.push({ dist, t1, t2, delta: t2 - t1, position: [px, py, pz] })
  }

  // Build sectors from brake events, offset start before the braking point.
  const tel = telemetryData?.[lap1.id]
  const brakeStarts = tel?.events?.filter((e) => e.type === 'brake_start').map((e) => e.t) || []
  const MIN_SECTOR_TIME = 5.0
  const SECTOR_LEAD_TIME = 3.0 // start sector 3 seconds before brake point

  const sectorBoundaries = [0]
  let lastBoundaryTime = -Infinity
  for (const bt of brakeStarts) {
    const leadTime = Math.max(0, bt - SECTOR_LEAD_TIME)
    if (leadTime - lastBoundaryTime < MIN_SECTOR_TIME) continue
    const idx = points.findIndex((p) => p.t1 >= leadTime)
    if (idx > 0 && idx < points.length - 1) {
      sectorBoundaries.push(idx)
      lastBoundaryTime = leadTime
    }
  }
  sectorBoundaries.push(points.length - 1)

  const sectors = []
  for (let s = 0; s < sectorBoundaries.length - 1; s++) {
    const idxStart = sectorBoundaries[s]
    const idxEnd = sectorBoundaries[s + 1]
    if (idxEnd <= idxStart) continue
    const sectorPts = points.slice(idxStart, idxEnd + 1)
    const avgDelta = sectorPts.reduce((sum, p) => sum + p.delta, 0) / sectorPts.length
    const midIdx = Math.floor((idxStart + idxEnd) / 2)
    const refPos = points[idxStart].position
    const refIdx1 = Math.min(idxStart + 1, points.length - 1)
    const refNext = points[refIdx1].position
    const fwdX = refNext[0] - refPos[0], fwdZ = refNext[2] - refPos[2]
    const fwdLen = Math.hypot(fwdX, fwdZ) || 1

    // Find lap2's time at the same forward-perpendicular plane as refPos, but
    // restrict the search to a time window around the *distance-aligned*
    // expected time. Without this window, sector 1 (whose refPos sits on the
    // start/finish line) would also match lap2's lap-END crossing — the car
    // crosses the same perpendicular plane both leaving the line at t≈0 and
    // returning at t≈duration. With identical lateral distance the loop
    // would pick the end crossing, making `t2Start` ≈ lap2 duration; the
    // ghost car would then render at `playhead + lap2.duration`, past its
    // last sample, and `sampleLapInto` would pin it to the final sample —
    // appearing frozen during playback after a sector-1 click.
    const expectedT2 = points[idxStart].t2
    const T2_SEARCH_WINDOW = 8.0  // seconds — wide enough for normal alignment drift, narrow enough to exclude wrap-around
    let bestLap2Time = expectedT2
    let bestCrossDist = Infinity
    for (let j = 1; j < lap2.samples.length; j++) {
      const a = lap2.samples[j - 1], b = lap2.samples[j]
      if (Math.abs(b.t - expectedT2) > T2_SEARCH_WINDOW
        && Math.abs(a.t - expectedT2) > T2_SEARCH_WINDOW) continue
      const da = (a.position[0] - refPos[0]) * fwdX / fwdLen + (a.position[2] - refPos[2]) * fwdZ / fwdLen
      const db = (b.position[0] - refPos[0]) * fwdX / fwdLen + (b.position[2] - refPos[2]) * fwdZ / fwdLen
      if (da * db <= 0 && (Math.abs(da) + Math.abs(db)) > 0.01) {
        const alpha = Math.abs(da) / (Math.abs(da) + Math.abs(db))
        const crossX = a.position[0] + (b.position[0] - a.position[0]) * alpha
        const crossZ = a.position[2] + (b.position[2] - a.position[2]) * alpha
        const latDist = Math.hypot(crossX - refPos[0], crossZ - refPos[2])
        if (latDist < bestCrossDist) {
          bestCrossDist = latDist
          bestLap2Time = a.t + (b.t - a.t) * alpha
        }
      }
    }

    sectors.push({
      number: sectors.length + 1,
      idxStart,
      idxEnd,
      avgDelta,
      sectorDelta: points[idxEnd].delta - points[idxStart].delta,
      winner: avgDelta > 0 ? lap1.id : lap2.id,
      midPosition: points[midIdx].position,
      t1Start: points[idxStart].t1,
      t1End: points[idxEnd].t1,
      t2Start: bestLap2Time,
      distStart: points[idxStart].dist,
      distEnd: points[idxEnd].dist,
    })
  }

  return { points, sectors, totalDist, lap1Id: lap1.id, lap2Id: lap2.id }
}
