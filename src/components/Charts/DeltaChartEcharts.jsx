import React, { useMemo } from 'react'
import { useStore } from '../../state/store'
import { ChartShell } from './ChartShell'
import { findValueAt } from '../../utils/findValueAt'
import { CHART_COLORS } from '../../constants'

/**
 * Lap-delta chart (signed line, time-axis) using ECharts.
 *
 * X-axis is lap1 time so the playhead crosshair lands at the same pixel
 * column as the telemetry chart. The points carry both `t1` and `dist` so
 * the tooltip shows the corresponding distance for context.
 *
 * Two-way viewport + playhead sync handled by `useEchartsTimeSync`.
 *
 * Adapter for the layout registry exported as `DeltaChartPanel`.
 */
export function DeltaChartEcharts({ deltaData, laps }) {
  const tMax = deltaData?.points?.length ? deltaData.points[deltaData.points.length - 1].t1 : 0

  const valueProviders = useMemo(() => {
    if (!deltaData?.points?.length) return []
    const data = deltaData.points.map((p) => [p.t1, p.delta])
    return [{
      gridIndex: 0,
      rowName: 'DELTA',
      rowNameColor: '#7b8399',
      getLines: (t) => {
        const v = findValueAt(data, t)
        if (v == null) return null
        const sign = v >= 0 ? '+' : ''
        // Red when behind ref (positive delta), green when ahead. Matches
        // the chart's red/green area gradient.
        const color = v >= 0 ? CHART_COLORS.delta_slower : CHART_COLORS.delta_faster
        return [{ text: `${sign}${v.toFixed(3)}s`, color, opacity: 1 }]
      },
    }]
  }, [deltaData])

  const option = useMemo(() => {
    if (!deltaData?.points?.length) return null
    const data = deltaData.points.map((p) => [p.t1, p.delta, p.dist])
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
          const [t1, delta, dist] = p.value
          return `<div style="font-family:monospace">t=${t1.toFixed(2)}s<br/>d=${dist.toFixed(0)}m<br/>Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(3)}s</div>`
        },
        axisPointer: { type: 'line' },
      },
      xAxis: {
        type: 'value',
        min: 0,
        max: tMax,
        axisLabel: { color: '#5a6378', fontSize: 9, formatter: (v) => `${v.toFixed(0)}s` },
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
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
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
  }, [deltaData, tMax])

  return (
    <ChartShell
      option={option}
      valueProviders={valueProviders}
      tMax={tMax}
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
