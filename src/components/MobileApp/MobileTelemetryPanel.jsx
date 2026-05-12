import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useLapColorMap } from '../../hooks/useLapColor'
import { findValueAt } from '../../utils/findValueAt'
import { VRFrictionCircle } from '../VRApp/VRFrictionCircle'

/**
 * Mobile telemetry panel — speed + G-force, designed mobile-first
 * instead of porting the desktop multi-grid ECharts stack.
 *
 * Why a separate component (not the desktop `<TelemetryChartPanel/>`):
 *
 *   • Phone screens fit ~600 px tall × 360 px wide of body. Five
 *     stacked y-axis rows shrink to ~110 px each — illegible. Race
 *     mobile apps (AIM RS Mobile, Harry's LapTimer, Track Addict)
 *     instead show ONE large primary readout per metric with the
 *     graph reduced to background context. We follow the same
 *     pattern: live SPEED + live G-FORCE, each as a hero card.
 *
 *   • Desktop charts assume hover, wheel zoom, drag-to-zoom-region.
 *     None of those work on touch. Mobile gestures are: tap (toggle),
 *     swipe (navigate), pinch (zoom), long-press (mark). This first
 *     iteration uses TAP to toggle units; swipe / long-press are
 *     reserved for the next iteration once we know which workflow
 *     the user keeps reaching for.
 *
 *   • The friction circle (g-g diagram) is naturally mobile-native —
 *     square aspect, no scrolling, intuitive on touch — and we
 *     already have `<VRFrictionCircle/>` from the /vr route. Reused
 *     verbatim. The desktop telemetry chart's G row was a flat
 *     time-series strip; the friction circle on mobile is a
 *     STRICTLY BETTER read of cornering load + grip-budget usage at
 *     the playhead instant.
 *
 *   • No on-graph value chips, no rotated axis names, no sector
 *     header — those make the desktop chart dense and busy. On
 *     mobile, the value chips ARE the chart.
 *
 * Layout (portrait, ~360×560 body):
 *
 *   ┌────────────────────────────┐
 *   │ SPEED              [km/h]  │  ← unit toggle (tap)
 *   │                            │
 *   │        189                 │  ← huge digital readout
 *   │   ─────────●────────       │  ← horizontal gauge (0..peak)
 *   │   0           peak 245     │
 *   │                            │
 *   │   ● ref  189   ● ghost 184 │  ← per-lap compact chips
 *   ├────────────────────────────┤
 *   │ G-FORCE         peak 1.45g │
 *   │                            │
 *   │  ┌──────────────┐  ref     │
 *   │  │      ⊕       │  lon +0.42│
 *   │  │  ╱   ◯       │  lat -1.20│
 *   │  │             │   sum  1.27│
 *   │  └──────────────┘           │
 *   │                  ghost      │
 *   │                  lon +0.38  │
 *   │                  lat -1.18  │
 *   │                  sum  1.23  │
 *   └────────────────────────────┘
 */

const KMH_TO_MPH = 0.621371
const FALLBACK_PEAK_SPEED = 100  // gauge sane-default before stats compute
const FALLBACK_PEAK_G = 1.5

/** One-pass scan over visible laps for the maxes we display + use to
 *  scale the gauge. Cheap (typically 2 × ~2300 samples = 4600 reads). */
function computeStats(laps) {
  let maxSpeed = 0, maxG = 0
  for (const lap of laps) {
    if (lap.gpsSpeed) {
      for (let i = 0; i < lap.gpsSpeed.length; i++) {
        const v = lap.gpsSpeed[i][1]
        if (v > maxSpeed) maxSpeed = v
      }
    }
    if (lap.gForces) {
      for (let i = 0; i < lap.gForces.length; i++) {
        const v = lap.gForces[i].gsum
        if (v > maxG) maxG = v
      }
    }
  }
  return { maxSpeed, maxG }
}

/** Binary-search the `gForces` array for the sample bracketing time `t`
 *  and linearly interpolate all three components in one pass. Cheaper
 *  than calling `findValueAt` three times — the rAF loop touches this
 *  once per lap per frame. */
function findGForceAt(gForces, t) {
  if (!gForces?.length) return null
  const n = gForces.length
  if (t <= gForces[0].t) return gForces[0]
  if (t >= gForces[n - 1].t) return gForces[n - 1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (gForces[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = gForces[lo], b = gForces[hi]
  if (a.t === b.t) return a
  const u = (t - a.t) / (b.t - a.t)
  return {
    t, longG: a.longG + (b.longG - a.longG) * u,
    latG:  a.latG  + (b.latG  - a.latG)  * u,
    gsum:  a.gsum  + (b.gsum  - a.gsum)  * u,
  }
}

const shortLabel = (s, n = 8) => (s ?? '').length > n ? `${s.slice(0, n)}…` : (s ?? '')

const fmtSigned2 = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
const fmt2       = (v) => v == null ? '—' : v.toFixed(2)

export function MobileTelemetryPanel() {
  const laps       = useStore((s) => s.laps)
  const visibility = useStore((s) => s.visibility)
  const lapColors  = useLapColorMap()

  const visibleLaps = useMemo(
    () => laps.filter((l) => visibility[l.id] !== false),
    [laps, visibility],
  )

  const stats = useMemo(() => computeStats(visibleLaps), [visibleLaps])

  // Unit toggle local to the panel — desktop has a single unit setting
  // (km/h) wired into the catalogue; on mobile the tap-to-toggle is so
  // natural an affordance that giving the user direct control here is
  // simpler than threading it through the store.
  const [unit, setUnit] = useState('kmh')

  if (!visibleLaps.length) {
    return <div className="m-tel-empty">No telemetry</div>
  }

  return (
    <div className="m-tel-panel">
      <SpeedCard
        laps={visibleLaps}
        lapColors={lapColors}
        peakKmh={stats.maxSpeed || FALLBACK_PEAK_SPEED}
        unit={unit}
        onToggleUnit={() => setUnit((u) => u === 'kmh' ? 'mph' : 'kmh')}
      />
      <GForceCard
        laps={visibleLaps}
        lapColors={lapColors}
        peakG={stats.maxG || FALLBACK_PEAK_G}
      />
    </div>
  )
}

// ─── Speed card ──────────────────────────────────────────────────────

function SpeedCard({ laps, lapColors, peakKmh, unit, onToggleUnit }) {
  const refLap = laps.find((l) => !l.ghost) ?? laps[0]
  const bigRef = useRef(null)
  const gaugeFillRef = useRef(null)
  const peakLabelRef = useRef(null)
  const lapValRefs = useRef({})

  // rAF-driven readouts — same hot-path pattern every other live
  // readout in the app uses (no React re-renders per frame).
  useEffect(() => {
    let alive = true, raf = 0
    const conv = unit === 'mph' ? KMH_TO_MPH : 1
    const tick = () => {
      if (!alive) return
      const t = useStore.getState().playheadRef.current
      // Hero readout — reference lap.
      if (refLap && bigRef.current) {
        const v = findValueAt(refLap.gpsSpeed, t)
        const txt = v == null ? '—' : `${Math.round(v * conv)}`
        if (bigRef.current.textContent !== txt) bigRef.current.textContent = txt
        if (gaugeFillRef.current && peakKmh > 0) {
          const pct = v == null ? 0 : Math.min(100, (v / peakKmh) * 100)
          gaugeFillRef.current.style.width = `${pct}%`
        }
      }
      // Per-lap chips — secondary detail; same calc as above per lap.
      for (const lap of laps) {
        const el = lapValRefs.current[lap.id]
        if (!el) continue
        const v = findValueAt(lap.gpsSpeed, t)
        const txt = v == null ? '—' : `${Math.round(v * conv)}`
        if (el.textContent !== txt) el.textContent = txt
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [laps, refLap, peakKmh, unit])

  // Update the peak label outside rAF — only changes when `peakKmh` /
  // `unit` changes (rare).
  useEffect(() => {
    if (!peakLabelRef.current) return
    const conv = unit === 'mph' ? KMH_TO_MPH : 1
    peakLabelRef.current.textContent = `${Math.round(peakKmh * conv)}`
  }, [peakKmh, unit])

  return (
    <section className="m-tel-card m-tel-speed">
      <header className="m-tel-card-head">
        <span className="m-tel-card-title">SPEED</span>
        <button
          type="button"
          className="m-tel-unit-btn"
          onClick={onToggleUnit}
          aria-label="Toggle units"
        >
          {unit === 'kmh' ? 'km/h' : 'mph'}
        </button>
      </header>
      <div className="m-tel-hero" ref={bigRef}>—</div>
      <div className="m-tel-gauge">
        <div className="m-tel-gauge-track">
          <div ref={gaugeFillRef} className="m-tel-gauge-fill" />
        </div>
        <div className="m-tel-gauge-scale">
          <span>0</span>
          <span>
            peak <span ref={peakLabelRef}>{Math.round(peakKmh)}</span>
          </span>
        </div>
      </div>
      <div className="m-tel-chips">
        {laps.map((lap) => (
          <div key={lap.id} className="m-tel-chip">
            <span
              className="m-tel-chip-dot"
              style={{ background: lapColors[lap.id] }}
            />
            <span className="m-tel-chip-label">
              {shortLabel(lap.label || lap.id, 8)}
            </span>
            <span
              className="m-tel-chip-val"
              ref={(el) => { lapValRefs.current[lap.id] = el }}
            >—</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── G-force card ────────────────────────────────────────────────────

function GForceCard({ laps, lapColors, peakG }) {
  const valRefs = useRef({})

  useEffect(() => {
    let alive = true, raf = 0
    const tick = () => {
      if (!alive) return
      const t = useStore.getState().playheadRef.current
      for (const lap of laps) {
        const rec = valRefs.current[lap.id]
        if (!rec) continue
        const g = findGForceAt(lap.gForces, t)
        const setTxt = (el, s) => {
          if (el && el.textContent !== s) el.textContent = s
        }
        setTxt(rec.lon, fmtSigned2(g?.longG))
        setTxt(rec.lat, fmtSigned2(g?.latG))
        setTxt(rec.sum, fmt2(g?.gsum))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { alive = false; cancelAnimationFrame(raf) }
  }, [laps])

  return (
    <section className="m-tel-card m-tel-gforce">
      <header className="m-tel-card-head">
        <span className="m-tel-card-title">G-FORCE</span>
        <span className="m-tel-card-stat">peak {peakG.toFixed(2)}g</span>
      </header>
      <div className="m-tel-gforce-row">
        <div className="m-tel-friction">
          <VRFrictionCircle />
        </div>
        <div className="m-tel-g-readouts">
          {laps.map((lap) => {
            const rec = valRefs.current[lap.id] ?? (valRefs.current[lap.id] = {})
            return (
              <div key={lap.id} className="m-tel-g-block">
                <div
                  className="m-tel-g-lap"
                  style={{ color: lapColors[lap.id] }}
                >
                  ● {shortLabel(lap.label || lap.id, 10)}
                </div>
                <Row label="lon" suffix="g" elRef={(el) => { rec.lon = el }} />
                <Row label="lat" suffix="g" elRef={(el) => { rec.lat = el }} />
                <Row label="sum" suffix="g" elRef={(el) => { rec.sum = el }} />
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Row({ label, suffix, elRef }) {
  return (
    <div className="m-tel-g-row">
      <span className="m-tel-g-key">{label}</span>
      <span className="m-tel-g-val" ref={elRef}>—</span>
      <span className="m-tel-g-unit">{suffix}</span>
    </div>
  )
}
