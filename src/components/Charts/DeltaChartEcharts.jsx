import React, { useMemo } from 'react'
import { useStore } from '../../state/store'
import { ChartShell } from './ChartShell'
import { findValueAt } from '../../utils/findValueAt'
import { arcLengthAtTime, timeAtArcLength } from '../../utils/arcLength'
import { CHART_COLORS } from '../../constants'

/**
 * Lap-delta chart (signed line) using ECharts.
 *
 * `compareMode` picks the x-axis:
 *   - `'time'`     → ref-lap (lap1) time. Crosshair lines up pixel-for-pixel
 *                    with the telemetry chart in the same mode.
 *   - `'position'` → distance from start/finish (metres). This is the
 *                    canonical race-engineer view: "where on track did the
 *                    gap accumulate?" — read directly off the x-axis.
 *
 * `deltaData.points[i]` carries both `t1` and `dist`, so switching the
 * x-axis is just picking which field to project. The playhead converter
 * `xAxisFromTime` mirrors the choice so the crosshair lands at the right
 * column regardless of mode.
 *
 * Adapter for the layout registry exported as `DeltaChartPanel`.
 */
export function DeltaChartEcharts({ deltaData, laps }) {
  const compareMode = useStore((s) => s.compareMode)
  const byDistance  = compareMode === 'position'
  const refLap      = laps?.[0]

  const xMax = useMemo(() => {
    const pts = deltaData?.points
    if (!pts?.length) return 0
    const last = pts[pts.length - 1]
    return byDistance ? last.dist : last.t1
  }, [deltaData, byDistance])

  const valueProviders = useMemo(() => {
    if (!deltaData?.points?.length) return []
    const data = deltaData.points.map((p) => [byDistance ? p.dist : p.t1, p.delta])
    return [{
      gridIndex: 0,
      rowName: 'DELTA',
      rowNameColor: '#7b8399',
      getLines: (x) => {
        const v = findValueAt(data, x)
        if (v == null) return null
        const sign = v >= 0 ? '+' : ''
        // Red when behind ref (positive delta), green when ahead. Matches
        // the chart's red/green area gradient.
        const color = v >= 0 ? CHART_COLORS.delta_slower : CHART_COLORS.delta_faster
        return [{ text: `${sign}${v.toFixed(3)}s`, color, opacity: 1 }]
      },
    }]
  }, [deltaData, byDistance])

  // Forward + inverse converters between the playhead's seconds and the
  // chart's x-axis units. In distance mode the playhead's stored seconds
  // map to the ref lap's cumulative arc length so the crosshair tracks
  // the car's physical track position; gestures convert back the other
  // way so a click in distance mode still writes a `playhead` in seconds.
  const xAxisFromTime = useMemo(() => {
    if (!byDistance || !refLap?.samples?.length) return (t) => t
    return (t) => arcLengthAtTime(refLap.samples, t)
  }, [byDistance, refLap])
  const xAxisToTime = useMemo(() => {
    if (!byDistance || !refLap?.samples?.length) return (x) => x
    return (x) => timeAtArcLength(refLap.samples, x)
  }, [byDistance, refLap])

  const option = useMemo(() => {
    if (!deltaData?.points?.length) return null
    // Tooltip wants both axes regardless of mode for context. The third
    // value in each tuple is whichever axis the chart is NOT plotting,
    // so the tooltip can show "you're at d=706 m / t=20.1 s" together.
    const data = byDistance
      ? deltaData.points.map((p) => [p.dist, p.delta, p.t1])
      : deltaData.points.map((p) => [p.t1, p.delta, p.dist])
    return {
      animation: false,
      grid: { left: 36, right: 16, top: 22, bottom: 22, containLabel: false },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(9, 11, 16, 0.92)',
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: '#cfd6e8', fontSize: 11 },
        formatter: (params) => {
          const p = params[0]
          if (!p) return ''
          // Third tuple element is whichever axis the chart is NOT plotting,
          // so the tooltip always shows both time and distance for context.
          const [primary, delta, secondary] = p.value
          const tStr = byDistance ? secondary.toFixed(2) : primary.toFixed(2)
          const dStr = byDistance ? primary.toFixed(0)   : secondary.toFixed(0)
          return `<div style="font-family:monospace">t=${tStr}s<br/>d=${dStr}m<br/>Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s</div>`
        },
        // No hover crosshair — the persistent playhead overlay already
        // shows the user's current time-position; a second line on
        // hover competes with it.
        axisPointer: { type: 'none' },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: xMax,
        axisLabel: {
          color: '#5a6378',
          fontSize: 9,
          formatter: byDistance
            ? (v) => `${(v / 1000).toFixed(1)}km`
            : (v) => `${v.toFixed(0)}s`,
        },
        axisLine: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        // `name: ''` is explicit (not omitted) because ECharts' default
        // merge keeps the prior `name: 'TIME DELTA'` across HMR option
        // swaps, and that would re-reserve the left gutter we just sized
        // for the tick labels.
        name: '',
        nameGap: 0,
        // Signed time-delta scale on the left. Hide min/max so the labels
        // never push past the chart's vertical extents.
        axisLabel: {
          show: true,
          fontSize: 9,
          color: '#5a6378',
          formatter: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}s`,
          showMinLabel: false,
          showMaxLabel: false,
          margin: 4,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        // Horizontal grid lines at each y-axis tick — same opacity as the
        // telemetry chart's rows so the two surfaces feel visually unified.
        splitLine: {
          show: true,
          lineStyle: { color: 'rgba(255,255,255,0.06)', width: 1, type: 'solid' },
        },
      },
      // No `slider` here — the telemetry chart above already shows the
      // viewport window via its own slider, and the two charts share
      // viewport state via `useEchartsTimeSync`. Keep `inside` so wheel
      // zoom and the click-and-drag-to-zoom gesture still work.
      dataZoom: [
        {
          type: 'inside',
          start: 0,
          end: 100,
          zoomOnMouseWheel: true,
          moveOnMouseMove: false,
          moveOnMouseWheel: 'shift',
          preventDefaultMouseMove: true,
        },
      ],
      series: [
        {
          type: 'line',
          data,
          showSymbol: false,
          symbol: 'none',
          sampling: 'lttb',
          lineStyle: { color: '#ffffff', width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(76,175,80,0.28)' },
                { offset: 0.5, color: 'rgba(76,175,80,0)' },
                { offset: 0.5, color: 'rgba(244,67,54,0)' },
                { offset: 1, color: 'rgba(244,67,54,0.28)' },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            animation: false,
            lineStyle: { color: 'rgba(255,255,255,0.18)', width: 1, type: 'solid' },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    }
  }, [deltaData, xMax, byDistance])

  return (
    <ChartShell
      option={option}
      valueProviders={valueProviders}
      tMax={xMax}
      xAxisFromTime={xAxisFromTime}
      xAxisToTime={xAxisToTime}
      emptyMessage="No delta yet"
    />
  )
}

/**
 * Panel adapter — reads `deltaData` straight off the store (recomputed
 * automatically on lap/telemetry changes).
 */
export function DeltaChartPanel() {
  const deltaData = useStore((s) => s.deltaData)
  const laps      = useStore((s) => s.laps)
  return <DeltaChartEcharts deltaData={deltaData} laps={laps} />
}
