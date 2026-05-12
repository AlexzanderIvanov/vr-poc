import React, { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { arcLengthAtTime } from '../../utils/arcLength'

/**
 * Toolbar that sits above the sector header on every chart shell.
 *
 * Two responsibilities:
 *
 *   1. Live readout — the playhead's current `t` (seconds) and `d`
 *      (metres travelled on the reference lap). The playhead is the
 *      "ref" line on every chart; clicking on a chart (when no target
 *      is active) seeks it.
 *
 *   2. Delta cursor — the `Δ` button toggles delta mode:
 *
 *        OFF  Only the playhead line is drawn. No target / no Δt / Δd
 *             readouts. Clicks on charts seek the playhead.
 *
 *        ON   A second vertical line — the "target" — appears at the
 *             playhead's current position. Header bar gains `Δt` /
 *             `Δd` readouts (target − playhead). Each chart's value
 *             chip grows an inline "target value + delta" sub-row.
 *             Click on a chart → MOVE the target to that x. Drag the
 *             target handle → fine-tune. Drag the playhead handle →
 *             move the general position. The two lines are
 *             independently movable.
 *
 *   Click Δ again to dismiss the target and return to plain mode.
 *
 * Target storage: a `{ time, distance } | null` object on the store's
 * `deltaRefPoint` slice. The name is historical — semantically it's
 * the delta TARGET (the "where to compare to" point); the REFERENCE
 * is always the playhead now.
 *
 * Why both time AND distance in the readout: the chart x-axis
 * switches between time (default) and distance (position-compare
 * mode). Having both visible at all times lets the user correlate
 * a moment on screen with both clocks without rebuilding the chart.
 */

const PLACEHOLDER = '—'

function fmtT(t, signed = false) {
  if (!Number.isFinite(t)) return PLACEHOLDER
  const s = t.toFixed(2)
  return signed && t >= 0 ? `+${s}` : s
}
function fmtD(d, signed = false) {
  if (!Number.isFinite(d)) return PLACEHOLDER
  const s = d.toFixed(0)
  return signed && d >= 0 ? `+${s}` : s
}

export function ChartHeaderBar() {
  const deltaRefPoint    = useStore((s) => s.deltaRefPoint)
  const setDeltaRefPoint = useStore((s) => s.setDeltaRefPoint)
  const laps             = useStore((s) => s.laps)
  const duration         = useStore((s) => s.duration)

  // Reference lap — the manifest-declared `ghost: false`. Distances
  // are reported as arc length along this lap (so the same `d` value
  // for the same on-track location, regardless of which ghost is
  // visible at the moment).
  const refLap = laps.find((l) => !l.ghost) ?? laps[0]

  const tValRef  = useRef(null)
  const dValRef  = useRef(null)
  const dtValRef = useRef(null)
  const ddValRef = useRef(null)

  useEffect(() => {
    let alive = true
    let rafId = 0
    const refSamples = refLap?.samples

    const tick = () => {
      if (!alive) return
      // The "general position" readout = playhead always (no longer
      // hover-driven). The cursor over a chart is just a visual aid;
      // every actionable readout / delta is keyed to the playhead.
      const ph = useStore.getState().playheadRef.current
      const phD = refSamples?.length ? arcLengthAtTime(refSamples, ph) : 0

      if (tValRef.current) tValRef.current.textContent = `${fmtT(ph)} s`
      if (dValRef.current) dValRef.current.textContent = `${fmtD(phD)} m`

      // Δ readout = target − playhead. Disappears entirely when the
      // target line is not set (the parent JSX skips rendering the
      // Δ chips while `deltaRefPoint` is null).
      if (deltaRefPoint) {
        if (dtValRef.current) {
          const dt = deltaRefPoint.time - ph
          dtValRef.current.textContent = `${fmtT(dt, true)} s`
        }
        if (ddValRef.current) {
          const dd = deltaRefPoint.distance - phD
          ddValRef.current.textContent = `${fmtD(dd, true)} m`
        }
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(rafId) }
  }, [refLap, deltaRefPoint])

  const onDeltaClick = useCallback(() => {
    if (deltaRefPoint) {
      // Dismiss the target — back to plain mode.
      setDeltaRefPoint(null)
      return
    }
    // Spawn the target at the playhead's current position. The user
    // can immediately drag it, or click somewhere on a chart to move
    // it there. Starting the target at the playhead means delta
    // values are visible right away (Δt = 0, Δd = 0) so the user can
    // see "yes the target is here" before refining.
    const ph = useStore.getState().playheadRef.current
    const d = refLap?.samples?.length ? arcLengthAtTime(refLap.samples, ph) : 0
    setDeltaRefPoint({ time: ph, distance: d })
  }, [deltaRefPoint, setDeltaRefPoint, refLap])

  if (!refLap || duration <= 0) return null

  return (
    <div className="chart-header-bar">
      <button
        type="button"
        className={`chart-header-delta-btn ${deltaRefPoint ? 'is-active' : ''}`}
        onClick={onDeltaClick}
        title={
          deltaRefPoint
            ? 'Dismiss delta target — back to plain mode'
            : 'Add delta target line (Δ comparison cursor)'
        }
      >
        Δ
      </button>
      <span className="chart-header-readout">
        <span className="chart-header-key">t</span>
        <span ref={tValRef} className="chart-header-val">{PLACEHOLDER}</span>
        <span className="chart-header-unit">s</span>
      </span>
      <span className="chart-header-readout">
        <span className="chart-header-key">d</span>
        <span ref={dValRef} className="chart-header-val">{PLACEHOLDER}</span>
        <span className="chart-header-unit">m</span>
      </span>
      {deltaRefPoint && (
        <>
          <span className="chart-header-sep" />
          <span className="chart-header-readout chart-header-delta">
            <span className="chart-header-key">Δt</span>
            <span ref={dtValRef} className="chart-header-val">{PLACEHOLDER}</span>
            <span className="chart-header-unit">s</span>
          </span>
          <span className="chart-header-readout chart-header-delta">
            <span className="chart-header-key">Δd</span>
            <span ref={ddValRef} className="chart-header-val">{PLACEHOLDER}</span>
            <span className="chart-header-unit">m</span>
          </span>
        </>
      )}
    </div>
  )
}
