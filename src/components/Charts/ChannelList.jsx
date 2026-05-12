import React, { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { CHANNEL_DEFS } from '../../services/channelCatalog'
import {
  channelLabel,
  channelFormatter,
  channelValueAt,
  formatUnknown,
} from '../../services/channelDisplay'
import {
  DEFAULT_PLOTTED_CHANNEL_KEYS,
  CHANNEL_DRAG_MIME,
} from './TelemetryChartEcharts'

/**
 * Channels side-column — vertical list of every scalar channel the
 * session's devices natively provide (or have derived for them), each
 * row showing the channel's current value at the playhead.
 *
 *   ▌TPS          245
 *   ▌fBP            0    bar
 *   ▌SPEED        189   km/h
 *   ▌STEER        -45     °
 *   ▌lonG       +0.42     g
 *   ▌latG       -1.15     g
 *   ▌gsum        1.22     g
 *    RPM           —     rpm
 *    rBP           —     bar
 *
 * The left-edge accent bar marks rows that are PLOTTED in the chart
 * (default seeds + user-added drops). Unplotted rows keep the channel
 * visible (so the user can still see its current value and drag it
 * onto the chart) but render dim with no bar.
 *
 * Channel discovery is DATA-DRIVEN, not catalogue-declaration-driven.
 * Sources inspected per visible lap:
 *
 *   • `telemetryData[lap.id].samples[0]` — every scalar AIM key the
 *                                          datalogger recorded
 *   • `lap.gpsSpeed` (derived)            — GPS speed
 *   • `lap.gForces`  (derived)            — IMU triplet
 *
 * Label / formatter / value-at-time routing all delegate to
 * `services/channelDisplay.js` — single source of truth. The
 * catalogue (`CHANNEL_DEFS`) drives unit + signedness; channelDisplay
 * drives the rest. Adding a new channel upstream needs at most one
 * label override in `channelDisplay.js` to look pretty (and zero code
 * here).
 *
 * Values are sampled at the REF point — the captured Δ-anchor when
 * active, else the playhead — matching every other value chip in the
 * chart. Updates are rAF-driven; no React re-renders per frame.
 *
 * Reference lap only. Per-lap deltas already live in the chart's
 * corner value chips.
 */

// Display order: vehicle / CAN channels first (driver-input channels
// read top-down — pedal, brakes, gear, revs, steering), then GPS,
// then IMU. Channels not in this list trail in insertion order so
// future AIM additions still surface.
const ORDER_HINT = [
  'tps', 'fbp', 'rbp', 'rpm', 'gear', 'steer',
  'water_temp', 'oil_temp', 'oil_press', 'fuel', 'boost',
  'gps_speed',
  'long_g', 'lat_g', 'g_sum',
]

/** Discover every scalar channel actually present across the visible
 *  laps. AIM/CAN comes from `tel.samples[0]` keys; GPS speed + IMU
 *  triplet come from precomputed derived arrays on the lap. */
function discoverChannelIds(laps, telemetryData) {
  const ids = new Set()
  for (const l of laps) {
    const tel = telemetryData[l.id]
    const s0 = tel?.samples?.[0]
    if (s0) {
      for (const k of Object.keys(s0)) {
        if (k === 't') continue
        if (typeof s0[k] !== 'number') continue
        ids.add(k)
      }
    }
    if (l.gpsSpeed?.length) ids.add('gps_speed')
    if (l.gForces?.length) {
      ids.add('long_g'); ids.add('lat_g'); ids.add('g_sum')
    }
  }
  // Ordered: hint-first, then any unknown ids in insertion order.
  const hinted = ORDER_HINT.filter((id) => ids.has(id))
  const tail = [...ids].filter((id) => !ORDER_HINT.includes(id))
  return [...hinted, ...tail]
}

export function ChannelList({ laps = [], telemetryData = {} }) {
  // Reference lap (first non-ghost) — the column shows ref-lap values;
  // per-lap deltas already appear in the chart's value chips.
  const refLap = useMemo(
    () => laps.find((l) => !l.ghost) ?? laps[0] ?? null,
    [laps],
  )
  const tel = refLap ? telemetryData[refLap.id] : null

  const channelIds = useMemo(
    () => discoverChannelIds(laps, telemetryData),
    [laps, telemetryData],
  )

  // Per-channel formatter cache so the rAF tick doesn't rebuild the
  // closure 9× per frame.
  const formatters = useMemo(
    () => Object.fromEntries(channelIds.map((id) => [id, channelFormatter(id)])),
    [channelIds],
  )

  // rAF-driven DOM updates — no React re-render per frame. Same
  // pattern as ChartValueLabels.
  const valueRefs = useRef({})
  useEffect(() => {
    if (!refLap) return undefined
    let alive = true
    let rafId = 0
    const tick = () => {
      if (!alive) return
      // Ref priority matches the chart value chips: pinned Δ anchor
      // when active, else live playhead.
      const ph = useStore.getState().playheadRef.current
      const drp = useStore.getState().deltaRefPoint
      const t = drp ? drp.time : ph
      for (const id of channelIds) {
        const el = valueRefs.current[id]
        if (!el) continue
        const v = channelValueAt(id, refLap, tel, t)
        const txt = v == null ? '—' : (formatters[id] ?? formatUnknown)(v)
        if (el.textContent !== txt) el.textContent = txt
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; if (rafId) cancelAnimationFrame(rafId) }
  }, [refLap, tel, channelIds, formatters])

  // Plotted set = default chart rows + user-added rows. The chart
  // owns the truth; this column mirrors via the store.
  const userAddedChannels = useStore((s) => s.userAddedChannels)
  const removeUserChannel = useStore((s) => s.removeUserChannel)
  const userAddedIds = useMemo(
    () => new Set(userAddedChannels.map((x) => x.id)),
    [userAddedChannels],
  )
  const plottedSet = useMemo(() => {
    const s = new Set(DEFAULT_PLOTTED_CHANNEL_KEYS)
    for (const id of userAddedIds) s.add(id)
    return s
  }, [userAddedIds])

  // HTML5 drag setup — pack the channel id into the custom MIME so
  // only the chart's drop targets pick it up. `effectAllowed: 'copy'`
  // because the source row stays in place.
  const onDragStart = (id) => (e) => {
    if (!e.dataTransfer) return
    e.dataTransfer.setData(CHANNEL_DRAG_MIME, id)
    e.dataTransfer.effectAllowed = 'copy'
  }

  if (!refLap || !channelIds.length) return null

  return (
    <div className="channel-list-column">
      <div className="channel-list-header">CHANNELS</div>
      <div className="channel-list-body">
        {channelIds.map((id) => {
          const plotted = plottedSet.has(id)
          const userAdded = userAddedIds.has(id)
          const unit = CHANNEL_DEFS[id]?.unit ?? ''
          return (
            <div
              key={id}
              className={`channel-list-row ${plotted ? 'is-plotted' : ''}`}
              title={plotted
                ? (userAdded ? 'In chart — click × to remove' : 'In chart')
                : 'Drag onto the chart to plot'}
              draggable
              onDragStart={onDragStart(id)}
            >
              <span className="channel-list-grip" aria-hidden="true">⋮⋮</span>
              <span className="channel-list-name">{channelLabel(id)}</span>
              <span
                className="channel-list-value"
                ref={(el) => { valueRefs.current[id] = el }}
              >—</span>
              {unit ? <span className="channel-list-unit">{unit}</span> : null}
              {userAdded ? (
                <button
                  type="button"
                  className="channel-list-remove"
                  title="Remove from chart"
                  // `mousedown` rather than `click` — the row's
                  // `draggable` swallows click in some browsers when
                  // the user pressed-and-held by accident.
                  onMouseDown={(e) => { e.stopPropagation(); removeUserChannel(id) }}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                >×</button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
