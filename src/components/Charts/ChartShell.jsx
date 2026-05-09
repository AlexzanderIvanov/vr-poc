import React, { useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import { useEchartsTimeSync } from '../../hooks/useEchartsTimeSync'
import { ChartPlayheadOverlay } from './ChartPlayheadOverlay'
import { ChartValueLabels } from './ChartValueLabels'

/**
 * Shared chart wrapper used by every panel that renders an ECharts chart
 * synced to the analysis frame. Owns:
 *
 *   - the wrapper div with the ref `useEchartsTimeSync` needs for the
 *     playhead-overlay rAF loop and the resize observer,
 *   - the `<ReactECharts>` instance and its `dataZoom → setViewport`
 *     handler,
 *   - `<ChartValueLabels>` for the live numeric readouts,
 *   - `<ChartPlayheadOverlay>` for the dashed crosshair.
 *
 * Both `TelemetryChartEcharts` and `DeltaChartEcharts` previously rendered
 * this same JSX inline. Extracting it keeps the per-chart files focused on
 * the *option object* — the only thing that actually differs between them.
 */
export function ChartShell({ option, valueProviders, tMax, emptyMessage = 'No data' }) {
  const echartsRef = useRef(null)
  const containerRef = useRef(null)
  const onDataZoom = useEchartsTimeSync(echartsRef, containerRef, { tMax })

  if (!option) return <div className="panel-empty">{emptyMessage}</div>
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactECharts
        ref={echartsRef}
        option={option}
        style={{ width: '100%', height: '100%' }}
        onEvents={{ dataZoom: onDataZoom }}
        notMerge={false}
        lazyUpdate
        theme="dark"
      />
      <ChartValueLabels
        containerRef={containerRef}
        echartsRef={echartsRef}
        providers={valueProviders ?? []}
      />
      <ChartPlayheadOverlay />
    </div>
  )
}
