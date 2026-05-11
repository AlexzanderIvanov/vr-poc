import React, { useMemo } from 'react'
import { useStore } from '../../state/store'
import { ChartShell } from './ChartShell'
import { findValueAt } from '../../utils/findValueAt'
import {
  arcLengthAtTime,
  timeAtArcLength,
  totalArcLength,
} from '../../utils/arcLength'
import { useLapColorMap } from '../../hooks/useLapColor'

/**
 * Multi-series telemetry chart (TPS / BRAKE / SPEED / STEER) using ECharts.
 *
 * One grid per metric, two series per metric (one line per lap):
 *   - ref lap (laps[0])  → solid line + light area fill
 *   - ghost lap (laps[1+]) → dashed line, no fill
 *
 * X-axis flips with `compareMode`:
 *   - `'time'`     → lap time in seconds (per-lap; laps overlay by elapsed
 *                    time — useful for "what was the driver doing at t=5 s
 *                    after the line").
 *   - `'position'` → cumulative ground-plane distance in metres (per-lap;
 *                    laps overlay by physical track position — the canonical
 *                    race-engineer view that exposes braking points, mid-
 *                    corner speed deltas, throttle-application differences).
 *
 * Two-way sync with the store's analysis frame and 15 Hz playhead is handled
 * by `useEchartsTimeSync`. This component just builds the option object and
 * supplies the time→x converter `ChartShell` threads to the playhead
 * overlay + value labels.
 *
 * Adapter for the layout registry exported as `TelemetryChartPanel`.
 */

const fmtInt    = (v) => `${Math.round(v)}`
const fmtSigned = (v) => `${v >= 0 ? '+' : ''}${Math.round(v)}`

// Series source contract:
//   `getSeries(lap, telemetry) -> [t, v][]`
// AIM-style channels (TPS / BRAKE / STEER) live on per-sample telemetry;
// GPS speed is precomputed by the data layer (`computeGpsSpeed` →
// `lap.gpsSpeed`) and arrives already in `[t, kmh]` form. The chart and
// the live value readout both call this so they stay perfectly in sync.
const seriesFromSamples = (key) => (lap, tel) =>
  tel?.samples?.map((s) => [s.t, s[key] ?? 0]) ?? []

// Each row plots ONE channel for ALL laps. Per-lap traces are coloured
// using the global lap colour pipe (`useLapColorMap()` → resolves the
// override OR `LAP_COLOR_PALETTE[lapIndex]`) so a trace, a car dot, and
// a trajectory line for the same lap always match — and a user-driven
// recolour propagates everywhere on one render. Channels are identified
// by row position + the persistent left-corner label (`<ChartValueLabels
// rowName>`), not by stroke colour.
const SERIES_DEFS = [
  { key: 'tps',   label: 'TPS',   max: 255, format: fmtInt,
    getSeries: seriesFromSamples('tps') },
  { key: 'fbp',   label: 'BRAKE', max: 150, format: fmtInt,
    getSeries: seriesFromSamples('fbp') },
  { key: 'speed', label: 'SPEED', max: 250, format: fmtInt,
    getSeries: (lap) => lap?.gpsSpeed ?? [] },
  { key: 'steer', label: 'STEER', signed: true, max: 250, format: fmtSigned,
    getSeries: seriesFromSamples('steer') },
]

// Row-name colour — a soft neutral so it doesn't fight the per-lap series
// colours below it. Same for both modes.
const ROW_NAME_COLOR = '#cfd6e8'

export function TelemetryChartEcharts({ laps = [], telemetryData = {} }) {
  const duration    = useStore((s) => s.duration)
  const compareMode = useStore((s) => s.compareMode)
  const byDistance  = compareMode === 'position'
  // Reactive `{ lapId → hex }` map. Subscribes to the store's `lapColors`
  // override slice AND the `laps` array; the chart's `option` memo lists
  // this in its dep array so a colour change rebuilds the series in
  // one render with no remount.
  const lapColorMap = useLapColorMap()

  // Per-lap `[t, v] → [x, v]` mapper. Position-compare mode rewrites every
  // sample's x-coordinate to the cumulative ground-plane arc length on
  // that lap (so the two cars' traces align where they were physically
  // on track, not where they were in their own elapsed-time clocks).
  const mapXForLap = useMemo(() => {
    if (!byDistance) return () => (data) => data
    return (lap) => {
      if (!lap?.samples?.length) return (data) => data
      // Capture once per lap; the helper memoises the cum-arc table.
      return (data) => data.map(([t, v]) => [arcLengthAtTime(lap.samples, t), v])
    }
  }, [byDistance])

  // Per-grid arrays for the live value readouts. Shape mirrors the chart
  // series — `[xValue, channelValue]` — so the same `findValueAt(data, x)`
  // works whether x is seconds or metres. Each entry also carries its
  // lap colour so the value-label column tints the number with the same
  // hex the trace uses.
  const seriesByGrid = useMemo(() => {
    const lapsWithTel = laps.filter((l) => telemetryData[l.id]?.samples?.length)
    // `isGhost` is driven by the manifest flag — the reference lap is
    // whichever one carries `ghost: false`, independent of array order.
    return SERIES_DEFS.map((def) => lapsWithTel.map((lap) => ({
      isGhost: !!lap.ghost,
      color: lapColorMap[lap.id],
      data: mapXForLap(lap)(def.getSeries(lap, telemetryData[lap.id])),
    })))
  }, [laps, telemetryData, mapXForLap, lapColorMap])

  const valueProviders = useMemo(
    () => SERIES_DEFS.map((def, i) => ({
      gridIndex: i,
      rowName: def.label,
      rowNameColor: ROW_NAME_COLOR,
      getLines: (x) => {
        // `x` is whatever the chart's x-axis represents — seconds in time
        // mode, metres in distance mode — pre-converted by `ChartShell`'s
        // `xAxisFromTime` so this lookup matches `seriesByGrid` data.
        const lapSeries = seriesByGrid[i]
        if (!lapSeries?.length) return null
        const out = []
        for (const ls of lapSeries) {
          const v = findValueAt(ls.data, x)
          if (v == null) continue
          out.push({
            text: def.format(v),
            color: ls.color,
            opacity: ls.isGhost ? 0.7 : 1,
          })
        }
        return out
      },
    })),
    [seriesByGrid],
  )

  // Forward + inverse converters between the playhead's seconds and the
  // chart's x-axis units. Identity in time mode; ref-lap arc length in
  // position mode (the playhead's stored time IS ref-lap time, so the
  // ref lap's distance is the right column to mirror).
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
    const seriesData = []
    SERIES_DEFS.forEach((def, i) => {
      lapsWithTel.forEach((lap) => {
        const tel = telemetryData[lap.id]
        const isGhost = !!lap.ghost
        const rawData = def.getSeries(lap, tel)
        const xMapped = mapXForLap(lap)(rawData)
        const lapColor = lapColorMap[lap.id]
        seriesData.push({
          name: `${def.label} · ${lap.label || lap.id}`,
          type: 'line',
          data: xMapped,
          showSymbol: false,
          symbol: 'none',
          sampling: 'lttb',
          lineStyle: {
            color: lapColor,
            width: isGhost ? 1.1 : 1.5,
            type: isGhost ? 'dashed' : 'solid',
            opacity: isGhost ? 0.85 : 1.0,
          },
          itemStyle: { color: lapColor },
          ...(isGhost ? {} : { areaStyle: { color: lapColor, opacity: 0.10 } }),
          xAxisIndex: i,
          yAxisIndex: i,
          animation: false,
        })
      })
    })
    return {
      animation: false,
      grid: SERIES_DEFS.map((_, i) => ({
        // Wide enough left gutter for tick labels like "127", "-125", "+125".
        left: 30,
        right: 16,
        top: `${4 + i * 22}%`,
        height: '18%',
        containLabel: false,
      })),
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(9, 11, 16, 0.92)',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#cfd6e8', fontSize: 11 },
        // axisPointer.type 'none' suppresses the vertical hover line —
        // we already render our own playhead overlay (`ChartPlayheadOverlay`)
        // and a second crosshair on hover competes with it visually.
        // The tooltip box still pops as the user moves the cursor; just
        // the line is gone.
        axisPointer: { type: 'none', label: { show: false } },
      },
      xAxis: SERIES_DEFS.map((_, i) => ({
        type: 'value',
        gridIndex: i,
        min: 0,
        max: xMax,
        axisLabel: {
          show: i === SERIES_DEFS.length - 1,
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
      yAxis: SERIES_DEFS.map((def, i) => ({
        type: 'value',
        gridIndex: i,
        min: def.signed ? -def.max : 0,
        max: def.max,
        // Sparse middle ticks only — `showMinLabel/showMaxLabel: false`
        // hides the top and bottom ticks of every row, which is also what
        // keeps the bottommost row's lowest tick from bleeding into the
        // dataZoom slider just below the chart.
        axisLabel: {
          show: true,
          fontSize: 9,
          color: '#5a6378',
          showMinLabel: false,
          showMaxLabel: false,
          margin: 4,
        },
        // Hide the actual axis line/ticks — labels alone are enough at this
        // density and an extra vertical line in a 30-px gutter would just
        // visually compete with the channel-name overlay.
        axisLine: { show: false },
        axisTick: { show: false },
        // Horizontal grid lines at each y-axis tick. Very subtle so they
        // sit behind the traces without competing with them — the goal is
        // to let the eye read a value off a trace by mentally extending it
        // to the y-axis labels on the left.
        splitLine: {
          show: true,
          lineStyle: {
            color: 'rgba(255,255,255,0.06)',
            width: 1,
            type: 'solid',
          },
        },
        // Channel label rendered by `<ChartValueLabels>` (top-left of the
        // plot area) — keeping it out of ECharts means it can't overflow
        // into adjacent rows the way a rotated axis name would.
      })),
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: SERIES_DEFS.map((_, i) => i),
          start: 0,
          end: 100,
          zoomOnMouseWheel: true,
          // Drag-pan is owned by `useEchartsClickToSeek` (click-to-seek,
          // scrub-near-playhead, drag-to-zoom). Wheel zoom and slider remain.
          moveOnMouseMove: false,
          moveOnMouseWheel: 'shift',
          preventDefaultMouseMove: true,
        },
        {
          type: 'slider',
          xAxisIndex: SERIES_DEFS.map((_, i) => i),
          height: 16,
          bottom: 4,
          start: 0,
          end: 100,
          backgroundColor: 'rgba(255,255,255,0.03)',
          fillerColor: 'rgba(76,175,200,0.20)',
          borderColor: 'rgba(255,255,255,0.08)',
          handleStyle: { color: '#4cafc8', borderColor: '#4cafc8' },
          textStyle: { color: '#5a6378', fontSize: 9 },
        },
      ],
      series: seriesData,
    }
  }, [laps, telemetryData, xMax, mapXForLap, byDistance, lapColorMap])

  return (
    <ChartShell
      option={option}
      valueProviders={valueProviders}
      tMax={xMax}
      xAxisFromTime={xAxisFromTime}
      xAxisToTime={xAxisToTime}
      emptyMessage="No telemetry"
    />
  )
}

/**
 * Panel adapter for the layout registry — pulls laps + telemetry from the
 * store so the LayoutGrid can place this panel without prop-threading.
 */
export function TelemetryChartPanel() {
  const laps          = useStore((s) => s.laps)
  const telemetryData = useStore((s) => s.telemetryData)
  return <TelemetryChartEcharts laps={laps} telemetryData={telemetryData} />
}
