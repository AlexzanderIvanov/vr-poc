import React, { useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { ChartShell } from './ChartShell'
import { ChannelList } from './ChannelList'
import { ChartDropTargets } from './ChartDropTargets'
import { findValueAt } from '../../utils/findValueAt'
import {
  arcLengthAtTime,
  timeAtArcLength,
  totalArcLength,
} from '../../utils/arcLength'
import { useLapColorMap } from '../../hooks/useLapColor'
import { CHANNEL_DEFS } from '../../services/channelCatalog'
import {
  channelLabel,
  channelFormatter,
  channelSeriesFor,
} from '../../services/channelDisplay'

/**
 * Multi-series telemetry chart (TPS / BRAKE / SPEED / STEER / G) using
 * ECharts. One grid per row, one line per (channel × lap). The G row
 * is multi-channel (longG / latG / gsum on shared y-axis); the rest
 * are single-channel.
 *
 * Channel ids reference the catalogue in `services/channelCatalog.js`
 * (unit / range / signedness) and `services/channelDisplay.js` (short
 * label, formatter, series builder, value-at-time). NEVER duplicate
 * any of those here.
 *
 * X-axis flips with `compareMode`:
 *   - `'time'`     → lap time in seconds (per-lap; laps overlay by
 *                    elapsed time).
 *   - `'position'` → cumulative ground-plane distance in metres (per-
 *                    lap; laps overlay by physical track position —
 *                    the canonical race-engineer view).
 *
 * Two-way sync with the analysis frame + 15 Hz playhead lives in
 * `useEchartsTimeSync`. This component just builds the option and
 * threads the time→x converter to the playhead overlay + value
 * labels.
 *
 * Adapter for the layout registry exported as `TelemetryChartPanel`.
 */

/** Catalogue channel ids the telemetry chart plots BY DEFAULT — the
 *  baked-in seed grids. Combined with the store's `userAddedChannels`
 *  to produce the runtime "plotted" set the ChannelList consults. */
export const DEFAULT_PLOTTED_CHANNEL_KEYS = new Set([
  'tps', 'fbp', 'gps_speed', 'steer',
  'long_g', 'lat_g', 'g_sum',
])

/** MIME-type marker for the drag payload from `ChannelList` rows.
 *  Custom string so a stray text drag from elsewhere can't mis-trigger
 *  the add. */
export const CHANNEL_DRAG_MIME = 'application/x-telemetry-channel'

// ─── Series defs ─────────────────────────────────────────────────────
//
// Each entry = one grid. `rows` is the list of channel ids to plot on
// that grid; the first id sets the y-axis range / catalogue key.
// `max` / `signed` override the catalogue when the grid wants a tighter
// or different range (e.g. STEER renders ±250° even though the
// catalogue range is the same; G renders ±1.6 g to match the friction
// circle's outer ring).
//
// `dashes` is per-row line-style for multi-channel grids — single-
// channel grids ignore this (their dash slot is used to encode
// ghost-vs-ref instead).
const GRID_DEFS = [
  { rows: ['tps'],                          label: 'TPS',   max: 255 },
  { rows: ['fbp'],                          label: 'BRAKE', max: 150 },
  { rows: ['gps_speed'],                    label: 'SPEED', max: 250 },
  { rows: ['steer'],                        label: 'STEER', max: 250, signed: true },
  { rows: ['long_g', 'lat_g', 'g_sum'],     label: 'G',     max: 1.6, signed: true,
    dashes: ['solid', 'dashed', 'dotted'] },
]

/** Build the runtime def for one grid from a GRID_DEFS entry. Single-
 *  channel grids use a default `dash: 'solid'` (lap-identity uses dash
 *  for ghost-vs-ref). Multi-channel grids use the per-row dash to
 *  distinguish channels; ghost-vs-ref is encoded in opacity + width. */
function buildGridDef(g) {
  const isMulti = g.rows.length > 1
  const headId = g.rows[0]
  return {
    channelKey: headId,
    label:      g.label,
    signed:     !!g.signed,
    max:        g.max,
    format:     channelFormatter(headId),
    channels:   g.rows.map((id, i) => ({
      channelKey: id,
      label:      channelLabel(id),
      dash:       isMulti ? g.dashes[i] : 'solid',
      format:     channelFormatter(id),
      getSeries:  channelSeriesFor(id),
    })),
  }
}

const SERIES_DEFS = GRID_DEFS.map(buildGridDef)

/** Build a def for a user-dropped channel — either a brand-new grid
 *  (when `targetGridKey` is null) or an overlay on an existing grid
 *  (when set; the caller merges it into the receiving grid's
 *  `channels` array with `yAxisSide: 'right'`). */
function userChannelDef(id) {
  const cat = CHANNEL_DEFS[id]
  const range = cat?.range
  const max = range ? Math.max(Math.abs(range[0]), Math.abs(range[1])) : undefined
  return {
    channelKey: id,
    label:      channelLabel(id),
    signed:     !!cat?.signed,
    max,        // may be undefined → ECharts auto-range
    format:     channelFormatter(id),
    userAdded:  true,
    channels: [{
      channelKey: id,
      label:      channelLabel(id),
      dash:       'solid',
      format:     channelFormatter(id),
      getSeries:  channelSeriesFor(id),
    }],
  }
}

/** Build an OVERLAY channel descriptor — to be appended to an existing
 *  grid's `channels[]`. Same shape as a default channel entry, plus
 *  `yAxisSide: 'right'` so the option builder routes it to the
 *  secondary y-axis. Overlays are dashed so they read distinct from
 *  the grid's primary trace(s). */
function overlayChannel(id) {
  return {
    channelKey: id,
    label:      channelLabel(id),
    dash:       'dashed',
    format:     channelFormatter(id),
    yAxisSide:  'right',
    getSeries:  channelSeriesFor(id),
  }
}

/** Catalogue lookup for a def's grid-level unit suffix. Returns '' for
 *  channels whose value is unit-less (raw AIM TPS, 0–255). */
const unitFor = (def) => CHANNEL_DEFS[def.channelKey]?.unit ?? ''

// ─── Axis builders ───────────────────────────────────────────────────
//
// Pulled out of the option useMemo so the option body stays under 60
// lines and stays focused on the high-level option shape.

/** Pre-compute primary/overlay y-axis indices for each grid. yAxis is
 *  a flat list across all grids; each grid gets its primary axis
 *  (left) and, if `hasOverlay`, an extra right-side axis right after. */
function buildAxisIndex(seriesDefs) {
  const primary = [], overlay = []
  let next = 0
  for (let i = 0; i < seriesDefs.length; i++) {
    primary[i] = next++
    overlay[i] = seriesDefs[i].hasOverlay ? next++ : -1
  }
  return { primary, overlay }
}

const Y_AXIS_NAME_STYLE = {
  color: '#cfd6e8',
  fontSize: 11,
  fontWeight: 600,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const Y_AXIS_LABEL_STYLE = {
  show: true,
  fontSize: 9,
  color: '#5a6378',
  showMinLabel: false,
  showMaxLabel: false,
  margin: 4,
}
const Y_AXIS_SPLIT_LINE = {
  show: true,
  lineStyle: { color: 'rgba(255,255,255,0.06)', width: 1, type: 'solid' },
}

/** Compact tick-label formatter for the auto-scaled OVERLAY axis. The
 *  overlay axis can be auto-ranged to anything (RPM 0..8000, brake
 *  bias 0..1, …); without a compact format ECharts renders four-digit
 *  values like "6000" which take wider pixel space than three-digit
 *  values like "200", and that delta is enough to make the plot
 *  visibly nudge left/right when an overlay is added or removed.
 *  Folding 1 000+ into `k`-suffix bounds label width to ~3-4 chars
 *  regardless of magnitude. */
function compactAxisLabel(v) {
  const a = Math.abs(v)
  if (a >= 1000) {
    const k = v / 1000
    // 6 → "6k",  6.5 → "6.5k", −12.3 → "−12.3k"
    return `${(Math.round(k * 10) / 10).toString()}k`
  }
  if (a >= 10) return `${Math.round(v)}`
  return v.toFixed(1)
}

/** Build the flat ECharts `yAxis` list — one primary axis per grid
 *  (left, channel name as rotated label), plus a right-side overlay
 *  axis for grids that have user-added overlay channels. */
function buildYAxis(seriesDefs) {
  const axes = []
  seriesDefs.forEach((def, i) => {
    axes.push({
      type: 'value',
      gridIndex: i,
      min: def.signed ? -def.max : 0,
      max: def.max,
      name: def.label,
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 32,
      nameTextStyle: Y_AXIS_NAME_STYLE,
      axisLabel: Y_AXIS_LABEL_STYLE,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: Y_AXIS_SPLIT_LINE,
    })
    if (!def.hasOverlay) return
    // Right-side auto-scaled axis for overlay channels. Name is a
    // compact `·`-separated list of overlay channel labels so the
    // reader can identify the right-side scale at a glance. Tick
    // labels use `compactAxisLabel` so a wide-range channel like RPM
    // (`6000`) renders as `6k` instead of `6000` — keeps label width
    // stable across overlay range changes so the plot area doesn't
    // visually drift when the auto-scaled range shifts.
    const overlayLabels = def.channels
      .filter((c) => c.yAxisSide === 'right')
      .map((c) => c.label).join('·')
    axes.push({
      type: 'value',
      gridIndex: i,
      position: 'right',
      name: overlayLabels,
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 28,
      nameTextStyle: { ...Y_AXIS_NAME_STYLE, color: '#8a93a3', fontSize: 10, fontWeight: 400 },
      axisLabel: { ...Y_AXIS_LABEL_STYLE, formatter: compactAxisLabel },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false }, // primary already drew them
    })
  })
  return axes
}

export function TelemetryChartEcharts({ laps = [], telemetryData = {}, hideSlider = false }) {
  const duration    = useStore((s) => s.duration)
  const compareMode = useStore((s) => s.compareMode)
  const byDistance  = compareMode === 'position'
  // Reactive `{ lapId → hex }` map. Subscribes to `lapColors` + `laps`;
  // the option memo lists this in deps so a colour change rebuilds the
  // series in one render with no remount.
  const lapColorMap = useLapColorMap()

  // User-added channels — each `{ id, target }`. `target` is either
  // the channelKey of a default grid (overlay onto that grid's right
  // y-axis) or `null` (new grid appended at the bottom). Defaults
  // already in `DEFAULT_PLOTTED_CHANNEL_KEYS` get filtered out so a
  // stray drag of an already-plotted channel is a no-op.
  const userAddedChannels = useStore((s) => s.userAddedChannels)
  const addUserChannel    = useStore((s) => s.addUserChannel)
  const seriesDefs = useMemo(() => {
    const overlaysByGrid = {}
    const newGridIds = []
    for (const { id, target } of userAddedChannels) {
      if (DEFAULT_PLOTTED_CHANNEL_KEYS.has(id)) continue
      const targetDef = target && SERIES_DEFS.find((d) => d.channelKey === target)
      if (targetDef) (overlaysByGrid[target] ??= []).push(id)
      else newGridIds.push(id)
    }
    const augmented = SERIES_DEFS.map((def) => {
      const extras = overlaysByGrid[def.channelKey]
      if (!extras?.length) return def
      return {
        ...def,
        channels: [...def.channels, ...extras.map(overlayChannel)],
        hasOverlay: true,
      }
    })
    return [...augmented, ...newGridIds.map(userChannelDef)]
  }, [userAddedChannels])

  // Per-lap `[t, v] → [x, v]` mapper. Position-compare mode rewrites
  // every sample's x to the lap's cumulative ground-plane arc length
  // (so traces align by physical track position, not by elapsed time).
  const mapXForLap = useMemo(() => {
    if (!byDistance) return () => (data) => data
    return (lap) => {
      if (!lap?.samples?.length) return (data) => data
      return (data) => data.map(([t, v]) => [arcLengthAtTime(lap.samples, t), v])
    }
  }, [byDistance])

  // Per-grid flat list of `(channel × lap)` series — shared by the
  // chart's `option` builder and the value-readout providers so neither
  // re-walks the source array.
  const seriesByGrid = useMemo(() => {
    const lapsWithTel = laps.filter((l) => telemetryData[l.id]?.samples?.length)
    return seriesDefs.map((def) => {
      const out = []
      for (const ch of def.channels) {
        for (const lap of lapsWithTel) {
          out.push({
            ch,
            isGhost: !!lap.ghost,
            color:   lapColorMap[lap.id],
            data:    mapXForLap(lap)(ch.getSeries(lap, telemetryData[lap.id])),
          })
        }
      }
      return out
    })
  }, [laps, telemetryData, mapXForLap, lapColorMap, seriesDefs])

  // ChartValueLabels providers — one per grid. Reads `refX` (playhead)
  // and `targetX` (delta target if active) and returns formatted lines
  // for the chip column.
  const valueProviders = useMemo(() =>
    seriesDefs.map((def, i) => ({
      gridIndex: i,
      // Each line is structured (label, value, unit, dot colour). The
      // channel name is in the rotated y-axis `name` (scale gutter)
      // for single-channel grids; multi-channel grids also prefix the
      // value with the channel label so three same-colour traces stay
      // distinguishable.
      getLines: (refX, targetX) => {
        const lapSeries = seriesByGrid[i]
        if (!lapSeries?.length) return null
        const unit = unitFor(def)
        const isMulti = def.channels.length > 1
        const out = []
        for (const ls of lapSeries) {
          const fmt = ls.ch.format
          const v = findValueAt(ls.data, refX)
          if (v == null) continue
          let cursorValue = null
          let delta = null
          if (targetX != null && Math.abs(targetX - refX) > 1e-6) {
            const cv = findValueAt(ls.data, targetX)
            if (cv != null) {
              cursorValue = fmt(cv)
              const d = cv - v
              delta = (d >= 0 ? '+' : '') + fmt(d).replace(/^[+-]/, '')
            }
          }
          out.push({
            label:       ls.ch.label,
            value:       isMulti ? `${ls.ch.label} ${fmt(v)}` : fmt(v),
            cursorValue,
            delta,
            color:       ls.color,
            unit,
            opacity:     ls.isGhost ? 0.7 : 1,
          })
        }
        return out
      },
    })),
    [seriesByGrid, seriesDefs],
  )

  // Forward + inverse converters between the playhead's seconds and
  // the chart's x-axis units. Identity in time mode; ref-lap arc
  // length in position mode (the playhead's stored time IS ref-lap
  // time, so the ref lap's distance is the right column to mirror).
  const refLap = laps[0]
  const xAxisFromTime = useMemo(() => {
    if (!byDistance || !refLap?.samples?.length) return (t) => t
    return (t) => arcLengthAtTime(refLap.samples, t)
  }, [byDistance, refLap])
  const xAxisToTime = useMemo(() => {
    if (!byDistance || !refLap?.samples?.length) return (x) => x
    return (x) => timeAtArcLength(refLap.samples, x)
  }, [byDistance, refLap])
  const xMax = byDistance && refLap?.samples?.length
    ? totalArcLength(refLap.samples)
    : duration

  const option = useMemo(() => {
    const lapsWithTel = laps.filter((l) => telemetryData[l.id]?.samples?.length)
    if (!lapsWithTel.length || xMax <= 0) return null

    const { primary: primaryAxisIdx, overlay: overlayAxisIdx } = buildAxisIndex(seriesDefs)

    // Seed dataZoom start/end from the current store viewport rather
    // than the default 0/100. Otherwise `notMerge: true` (needed when
    // overlay axes appear/disappear) wipes the chart back to a full-
    // range view on every drop/remove — the viewport→dataZoom mirror
    // in useEchartsTimeSync only fires when viewport actually CHANGES,
    // so a structural option swap with the same viewport leaves the
    // chart zoomed out. Read via getState() so the option memo
    // doesn't list viewport as a dep (we don't want to rebuild the
    // whole option on every scrub).
    const vp = useStore.getState().viewport
    const zoomStart = xMax > 0 ? (xAxisFromTime(vp.tStart) / xMax) * 100 : 0
    const zoomEnd   = xMax > 0 ? (xAxisFromTime(vp.tEnd)   / xMax) * 100 : 100

    const seriesData = []
    seriesDefs.forEach((def, i) => {
      // Single-channel grids use dash for lap-identity (solid = ref,
      // dashed = ghost). Multi-channel grids use dash for channel-
      // identity and rely on opacity + width for ghost-vs-ref.
      const isMulti = def.channels.length > 1
      def.channels.forEach((ch) => {
        const yIdx = ch.yAxisSide === 'right' ? overlayAxisIdx[i] : primaryAxisIdx[i]
        lapsWithTel.forEach((lap) => {
          const isGhost = !!lap.ghost
          const xMapped = mapXForLap(lap)(ch.getSeries(lap, telemetryData[lap.id]))
          const lapColor = lapColorMap[lap.id]
          seriesData.push({
            name: `${ch.label} · ${lap.label || lap.id}`,
            type: 'line',
            data: xMapped,
            showSymbol: false,
            symbol: 'none',
            // sampling: 'lttb' disabled — axis-trigger tooltip returns
            // only one series per axis with LTTB on, losing the cross-
            // lap comparison. Data is small enough (~2300 samples/lap)
            // to render unsampled at the chart sizes we use.
            lineStyle: {
              color:   lapColor,
              width:   isGhost ? 1.0 : 1.5,
              type:    isMulti ? ch.dash : (isGhost ? 'dashed' : 'solid'),
              opacity: isGhost ? 0.85 : 1.0,
            },
            itemStyle: { color: lapColor },
            xAxisIndex: i,
            yAxisIndex: yIdx,
            animation: false,
          })
        })
      })
    })

    return {
      animation: false,
      // Top-level axisPointer — owns the dashed white hover line that
      // tracks the cursor across grids. `link: 'all'` spans every
      // grid; combined with `echarts.connect()` in ChartShell, one
      // cursor tracks across every chart in the connected group.
      // `triggerTooltip: false` keeps the line without the floating
      // tooltip — the corner value chips already show all the numbers.
      axisPointer: {
        show: true,
        type: 'line',
        link: [{ xAxisIndex: 'all' }],
        triggerTooltip: false,
        label: { show: false },
        lineStyle: { color: 'rgba(255,255,255,0.45)', width: 1, type: 'dashed' },
      },
      grid: seriesDefs.map((_, i) => {
        // Rows distributed evenly; computed instead of hardcoded so a
        // new row (or a dragged channel that becomes a new grid)
        // doesn't need a tweak — only its def entry.
        //
        // Right gutter is CONSTANT 46 px on every grid — same width
        // an overlay axis needs — so adding / removing an overlay
        // doesn't reflow the plot area horizontally. Otherwise the
        // user sees the chart's contents "shift" because the same
        // x-range now maps to a wider/narrower pixel width.
        const slot = 96 / seriesDefs.length
        return {
          left: 46,
          right: 46,
          top: `${3 + i * slot}%`,
          height: `${slot - 2}%`,
          containLabel: false,
        }
      }),
      // Floating tooltip suppressed — corner chips already show every
      // relevant number plus delta. Keeping the option key prevents
      // ECharts from re-defaulting on HMR merges.
      tooltip: { show: false },
      xAxis: seriesDefs.map((_, i) => ({
        type: 'value',
        gridIndex: i,
        min: 0,
        max: xMax,
        axisLabel: {
          show: i === seriesDefs.length - 1,
          color: '#5a6378',
          fontSize: 9,
          formatter: byDistance
            ? (v) => `${(v / 1000).toFixed(1)}km`
            : (v) => `${v.toFixed(0)}s`,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      })),
      yAxis: buildYAxis(seriesDefs),
      // `hideSlider` (set by `/vr`) suppresses the built-in slider so
      // the unified bottom timeline isn't duplicated. Wheel zoom +
      // drag-zoom (owned by useChartGestures) stay on regardless.
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: seriesDefs.map((_, i) => i),
          start: zoomStart, end: zoomEnd,
          zoomOnMouseWheel: true,
          moveOnMouseMove: false,
          moveOnMouseWheel: 'shift',
          preventDefaultMouseMove: true,
        },
        ...(hideSlider ? [] : [{
          type: 'slider',
          xAxisIndex: seriesDefs.map((_, i) => i),
          height: 16, bottom: 4,
          start: zoomStart, end: zoomEnd,
          backgroundColor: 'rgba(255,255,255,0.03)',
          fillerColor:     'rgba(76,175,200,0.20)',
          borderColor:     'rgba(255,255,255,0.08)',
          handleStyle:     { color: '#4cafc8', borderColor: '#4cafc8' },
          textStyle:       { color: '#5a6378', fontSize: 9 },
        }]),
      ],
      series: seriesData,
    }
  }, [laps, telemetryData, xMax, mapXForLap, byDistance, lapColorMap, hideSlider, seriesDefs, xAxisFromTime])

  // Drop-target wiring is owned by <ChartDropTargets>. The wrap's
  // `dragover` preventDefault marks the area as a valid drop target
  // (so the zones rendered inside can intercept drops).
  const chartInstanceRef = useRef(null)
  const onWrapDragOver = (e) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes(CHANNEL_DRAG_MIME)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const gridChannelKeys = useMemo(
    () => seriesDefs.map((d) => d.channelKey),
    [seriesDefs],
  )

  return (
    <div className="telemetry-with-channels">
      <div className="telemetry-chart-wrap" onDragOver={onWrapDragOver}>
        <ChartShell
          option={option}
          valueProviders={valueProviders}
          tMax={xMax}
          xAxisFromTime={xAxisFromTime}
          xAxisToTime={xAxisToTime}
          emptyMessage="No telemetry"
          gridLeft={46}
          gridRight={46}
          // notMerge — drag-and-drop can add an overlay y-axis,
          // changing the option's structural shape. ECharts' default
          // merge would leave stale series bindings → "xAxis and yAxis
          // must use the same grid".
          notMerge
          chartInstanceRef={chartInstanceRef}
          renderBodyOverlay={({ containerRef, echartsRef }) => (
            <ChartDropTargets
              containerRef={containerRef}
              echartsRef={echartsRef}
              gridChannelKeys={gridChannelKeys}
            />
          )}
        />
      </div>
      <ChannelList laps={laps} telemetryData={telemetryData} />
    </div>
  )
}

/** Panel adapter for the layout registry — pulls laps + telemetry off
 *  the store so LayoutGrid can place this panel without prop-threading. */
export function TelemetryChartPanel({ hideSlider = false } = {}) {
  const laps          = useStore((s) => s.laps)
  const telemetryData = useStore((s) => s.telemetryData)
  return <TelemetryChartEcharts laps={laps} telemetryData={telemetryData} hideSlider={hideSlider} />
}
