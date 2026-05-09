import React, { useMemo } from 'react'
import { useStore } from '../../state/store'
import { ChartShell } from './ChartShell'
import { findValueAt } from '../../utils/findValueAt'
import { CHART_COLORS } from '../../constants'

/**
 * Multi-series telemetry chart (TPS / BRAKE / RPM / STEER) using ECharts.
 *
 * One grid per metric, two series per metric (one line per lap):
 *   - ref lap (laps[0])  → solid line + light area fill
 *   - ghost lap (laps[1+]) → dashed line, no fill
 *
 * Two-way sync with the store's analysis frame and 15 Hz playhead is handled
 * by `useEchartsTimeSync`. This component just builds the option object.
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

// Colours pulled from `constants.CHART_COLORS` so the design system has a
// single source of truth. Adding a new channel? Add the colour there first.
const SERIES_DEFS = [
  { key: 'tps',   color: CHART_COLORS.tps,   label: 'TPS',   max: 255, format: fmtInt,
    getSeries: seriesFromSamples('tps') },
  { key: 'fbp',   color: CHART_COLORS.brake, label: 'BRAKE', max: 150, format: fmtInt,
    getSeries: seriesFromSamples('fbp') },
  { key: 'speed', color: CHART_COLORS.speed, label: 'SPEED', max: 250, format: fmtInt,
    getSeries: (lap) => lap?.gpsSpeed ?? [] },
  { key: 'steer', color: CHART_COLORS.steer, label: 'STEER', signed: true, max: 250, format: fmtSigned,
    getSeries: seriesFromSamples('steer') },
]

export function TelemetryChartEcharts({ laps = [], telemetryData = {} }) {
  const duration = useStore((s) => s.duration)

  // Per-grid `[t, v]` arrays cached for the live value readouts. Mirrors the
  // shape used by the chart's series; rebuilt only when laps/telemetry change.
  const seriesByGrid = useMemo(() => {
    const lapsWithTel = laps.filter((l) => telemetryData[l.id]?.samples?.length)
    return SERIES_DEFS.map((def) => lapsWithTel.map((lap, lapIdx) => ({
      isGhost: lapIdx > 0,
      data: def.getSeries(lap, telemetryData[lap.id]),
    })))
  }, [laps, telemetryData])

  const valueProviders = useMemo(
    () => SERIES_DEFS.map((def, i) => ({
      gridIndex: i,
      rowName: def.label,
      rowNameColor: def.color,
      getLines: (t) => {
        const lapSeries = seriesByGrid[i]
        if (!lapSeries?.length) return null
        const out = []
        for (const ls of lapSeries) {
          const v = findValueAt(ls.data, t)
          if (v == null) continue
          out.push({
            text: def.format(v),
            color: def.color,
            opacity: ls.isGhost ? 0.65 : 1,
          })
        }
        return out
      },
    })),
    [seriesByGrid],
  )

  const option = useMemo(() => {
    const lapsWithTel = laps.filter((l) => telemetryData[l.id]?.samples?.length)
    if (!lapsWithTel.length || duration <= 0) return null
    const seriesData = []
    SERIES_DEFS.forEach((def, i) => {
      lapsWithTel.forEach((lap, lapIdx) => {
        const tel = telemetryData[lap.id]
        const isGhost = lapIdx > 0
        seriesData.push({
          name: `${def.label} · ${lap.label || lap.id}`,
          type: 'line',
          data: def.getSeries(lap, tel),
          showSymbol: false,
          symbol: 'none',
          sampling: 'lttb',
          lineStyle: {
            color: def.color,
            width: isGhost ? 1.1 : 1.5,
            type: isGhost ? 'dashed' : 'solid',
            opacity: isGhost ? 0.85 : 1.0,
          },
          itemStyle: { color: def.color },
          ...(isGhost ? {} : { areaStyle: { color: def.color, opacity: 0.10 } }),
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
        // `line` (perpendicular to value axis) — vertical only. `cross`
        // would also draw a horizontal line through the cursor's y, which
        // we don't want.
        axisPointer: { type: 'line', label: { show: false } },
      },
      xAxis: SERIES_DEFS.map((_, i) => ({
        type: 'value',
        gridIndex: i,
        min: 0,
        max: duration,
        axisLabel: { show: i === SERIES_DEFS.length - 1, color: '#5a6378', fontSize: 9 },
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
        splitLine: { show: false },
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
  }, [laps, telemetryData, duration])

  return (
    <ChartShell
      option={option}
      valueProviders={valueProviders}
      tMax={duration}
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
