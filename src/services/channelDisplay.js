import { CHANNEL_DEFS } from './channelCatalog'
import { interpolateField } from '../utils/findValueAt'

/**
 * Display / data-access layer for one telemetry channel.
 *
 * Every part of the UI that needs to talk about a channel by its
 * catalogue id — the chart's series builder, the value chips, the
 * right-side ChannelList — used to keep its OWN copies of:
 *
 *   • The pretty short label    (TPS / fBP / lonG / …)
 *   • The value formatter       (integer vs 2-decimals, signed/unsigned)
 *   • The series-for-lap function  `(lap, tel) → [t,v][]`
 *   • The value-at-time function   `(lap, tel, t) → number | null`
 *
 * Four sites, same routing per id (`gps_speed` reads from `lap.gpsSpeed`;
 * `long_g/lat_g/g_sum` from `lap.gForces`; everything else from per-sample
 * AIM/CAN telemetry). Adding a channel meant editing four tables —
 * remembering which two of the four sources actually moved is what
 * caused the recent "side column ignores AIM channels" bug.
 *
 * This module is the single source of truth. The catalogue
 * (`channelCatalog.js`) stays authoritative for unit / range / signedness;
 * we only own things that ARE UI-display level (short labels for compact
 * chips, value formatters, and the actual data-extraction routing).
 */

// ─── Short pretty labels ─────────────────────────────────────────────
//
// Used by chart y-axis names, chart value chips, and the channel-list
// rows. Falls back to the raw id so a freshly-added AIM channel (e.g.
// `oil_temp`) shows up readable until someone adds an override here.
const LABELS = {
  tps:        'TPS',
  fbp:        'fBP',
  rbp:        'rBP',
  rpm:        'RPM',
  steer:      'STEER',
  gps_speed:  'SPEED',
  long_g:     'lonG',
  lat_g:      'latG',
  g_sum:      'gsum',
}
export const channelLabel = (id) => LABELS[id] ?? id

// ─── Value formatters ────────────────────────────────────────────────
//
// Signed / decimal-precision picked from the catalogue. The heuristic
// "magnitude ≥ 10 → integer, else 2 decimals" matches every existing
// chart formatter — it's just made the one shared function instead of
// being open-coded in three places.
//
// Returns `(v) => string`. Caller decides whether to apply it.

const PREFER_INTEGER = new Set(['tps', 'fbp', 'rbp', 'rpm', 'steer', 'gps_speed'])
const PREFER_DECIMAL = new Set(['long_g', 'lat_g', 'g_sum'])

export function channelFormatter(id) {
  const cat = CHANNEL_DEFS[id]
  const signed = !!cat?.signed
  const prefersInt = PREFER_INTEGER.has(id)
  const prefersDec = PREFER_DECIMAL.has(id)
  // Catalogue range gives a third heuristic for ids we don't enumerate
  // explicitly — small-magnitude channels (< 10) read better with two
  // decimals, anything else as integer.
  const range = cat?.range
  const max = range ? Math.max(Math.abs(range[0]), Math.abs(range[1])) : null
  const isInt = prefersInt || (!prefersDec && max != null && max >= 10)
  const sign = (v) => (signed && v >= 0 ? '+' : '')
  return isInt
    ? (v) => `${sign(v)}${Math.round(v)}`
    : (v) => `${sign(v)}${v.toFixed(2)}`
}

/** Format an unknown-channel value with a magnitude-based heuristic.
 *  Used for the channel-list default cell and any unit-less display
 *  where the catalogue has nothing to say. */
export function formatUnknown(v) {
  if (!Number.isFinite(v)) return '—'
  return Math.abs(v) >= 10 ? `${Math.round(v)}` : v.toFixed(2)
}

// ─── Channel data access ─────────────────────────────────────────────
//
// One routing function per "shape of source":
//   • gps_speed              → `lap.gpsSpeed` (already `[t, kmh][]`)
//   • long_g / lat_g / g_sum → `lap.gForces` (`{t, longG, latG, gsum}[]`)
//   • any other (AIM/CAN)    → `tel.samples` (`{t, <key>: v}[]`)
//
// `channelSeriesFor(id)` is what charts call to build a series.
// `channelValueAt(id, lap, tel, t)` is what readouts call to sample one
// point. Both share the same routing internally so they can't drift.

const GFORCE_FIELD = { long_g: 'longG', lat_g: 'latG', g_sum: 'gsum' }

export function channelSeriesFor(id) {
  if (id === 'gps_speed') return (lap) => lap?.gpsSpeed ?? []
  const gField = GFORCE_FIELD[id]
  if (gField) return (lap) => lap?.gForces?.map((g) => [g.t, g[gField]]) ?? []
  return (_lap, tel) => tel?.samples?.map((s) => [s.t, s[id] ?? 0]) ?? []
}

export function channelValueAt(id, lap, tel, t) {
  if (lap == null) return null
  if (id === 'gps_speed') return interpolateField(lap.gpsSpeed, 1, t)
  const gField = GFORCE_FIELD[id]
  if (gField) return interpolateField(lap.gForces, gField, t)
  return interpolateField(tel?.samples, id, t)
}

