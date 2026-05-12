import React, { useEffect, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import * as echarts from 'echarts'
import { useEchartsTimeSync } from '../../hooks/useEchartsTimeSync'
import { ChartPlayheadOverlay } from './ChartPlayheadOverlay'
import { ChartDeltaOverlays } from './ChartDeltaOverlays'
import { ChartValueLabels } from './ChartValueLabels'
import { SectorBar } from './SectorBar'
import { ChartHeaderBar } from './ChartHeaderBar'
import { useStore } from '../../state/store'
import { arcLengthAtTime } from '../../utils/arcLength'
import { safe, isEchartsGridReady } from '../../utils/safe'

/**
 * Shared chart wrapper used by every panel that renders an ECharts
 * chart synced to the analysis frame. Owns:
 *
 *   - The wrapper div with the ref `useEchartsTimeSync` needs for
 *     the playhead-overlay rAF loop and the resize observer.
 *   - The `<ReactECharts>` instance and its `dataZoom → setViewport`
 *     handler.
 *   - `<ChartValueLabels>` — live numeric readouts beside each series.
 *   - `<ChartPlayheadOverlay>` — the red vertical playhead crosshair.
 *   - Cross-chart axisPointer linkage via `echarts.connect(group)` so
 *     hovering one chart moves the cursor line on every other chart
 *     in the same group simultaneously.
 *   - `<ChartHeaderBar>` — toolbar with the Δ button + live cursor
 *     readouts. Reads `hoverPointRef` (written below) and the
 *     playhead, displays whichever is current. See header-bar file.
 *   - `<SectorBar>` — numbered sector strip below the header.
 *     Double-click to toggle zoom; drag to pan the viewport.
 *   - Mouse-position tracking — listens to the ECharts ZRender
 *     mousemove / globalout and writes `{time, distance}` into the
 *     store's `hoverPointRef` so the header bar can show the cursor
 *     position in real time.
 *
 * Layout (flex column, top → bottom):
 *
 *   ┌─ chart-shell ────────────────────────────────────────┐
 *   │  chart-header-bar    (~22 px)   [Δ] t  d  [Δt Δd]   │  ← if showHeaderBar
 *   │  chart-sector-bar    (~20 px)   [S1][S2][S3] …      │  ← if showSectorBar
 *   │  chart-shell-body    (flex: 1)                       │
 *   │    ┌─────────────────────────┐  ReactECharts +       │
 *   │    │  ECharts canvas         │  ChartValueLabels +   │
 *   │    │  + value chips + playh. │  ChartPlayheadOverlay │
 *   │    └─────────────────────────┘                       │
 *   └──────────────────────────────────────────────────────┘
 *
 * Both `TelemetryChartEcharts` and `DeltaChartEcharts` previously
 * rendered most of this inline. Extracting it keeps the per-chart
 * files focused on the *option object* — the only thing that
 * actually differs between them.
 *
 * `group` defaults to a shared constant so every chart participates
 * in the connected axisPointer group by default. Pass `group={null}`
 * to opt a chart out.
 *
 * `showSectorBar` / `showHeaderBar` default to `true`. Pass `false`
 * for charts where the strips would just duplicate the chart above
 * (e.g. the delta chart sitting below the telemetry chart — same
 * x-axis, same cursor, redundant duplicate header on the same
 * overlay).
 */

const DEFAULT_CHART_GROUP = 'analysis-charts'

export function ChartShell({
  option,
  valueProviders,
  tMax,
  xAxisFromTime = (t) => t,
  xAxisToTime = (x) => x,
  emptyMessage = 'No data',
  group = DEFAULT_CHART_GROUP,
  // Plot-area padding of the inner ECharts grid (CSS pixels). Used by
  // the sector header so its cells align with the chart's x-axis.
  gridLeft = 30,
  gridRight = 16,
  showSectorBar = true,
  showHeaderBar = true,
  // Pass `true` to disable ECharts' option merging — i.e. every
  // `setOption` call replaces axes / series / grids wholesale. Default
  // (false) preserves the merge for charts whose structural shape
  // (number of grids, axes, etc.) never changes; the telemetry chart
  // overrides this to true because dragging a channel onto it can
  // add an overlay y-axis, and a stale merge would point a previous
  // series at the wrong axis ("xAxis and yAxis must use the same
  // grid" error).
  notMerge = false,
  // Optional ref the parent can read to access the ECharts instance
  // (`echartsRef.current?.getEchartsInstance?.()`) — used by the
  // drag-and-drop channel overlay to compute per-grid pixel rects
  // for the visual drop guides.
  chartInstanceRef,
  // Optional render-prop that gets the chart wrap container ref and
  // the echartsRef — useful for absolute-positioned overlays that
  // need to know where the chart's plot area is. Returns ReactNode.
  renderBodyOverlay,
}) {
  const echartsRef = useRef(null)
  const containerRef = useRef(null)
  // Forward the echarts ref to the parent so it can read the
  // instance directly. This pattern avoids needing forwardRef +
  // useImperativeHandle for a single use case (drop-target rendering).
  useEffect(() => {
    if (!chartInstanceRef) return undefined
    chartInstanceRef.current = echartsRef.current
    return () => { if (chartInstanceRef) chartInstanceRef.current = null }
  })
  const onDataZoom = useEchartsTimeSync(echartsRef, containerRef, {
    tMax, xAxisFromTime, xAxisToTime,
    // Re-asserts the chart's dataZoom from the current store viewport
    // on every `option` change. With `notMerge: true`, ECharts can
    // reset the dataZoom component to defaults on structural swaps
    // (e.g. removing an overlay shrinks the yAxis list and the
    // dataZoom widget re-initialises fresh) — the option's seeded
    // start/end isn't always honoured. The internal handler in the
    // hook sets the ignore flag so this dispatch doesn't loop back
    // through `onDataZoom → setViewport`.
    optionEpoch: option,
  })

  // axisPointer linkage — see header docstring.
  useEffect(() => {
    if (!group) return undefined
    const inst = echartsRef.current?.getEchartsInstance?.()
    if (!inst) return undefined
    inst.group = group
    echarts.connect(group)
    return () => {
      try { echarts.disconnect(group) } catch {}
    }
  }, [group])

  // Mouse-position tracking — write to `hoverPointRef.current` so the
  // ChartHeaderBar's rAF loop can read the cursor's time & distance.
  // Uses ECharts' ZRender (`getZr()`) events directly because they
  // give us a canvas-relative pixel position we can run through
  // `convertFromPixel` to get a chart-axis x-value. `globalout` fires
  // when the pointer leaves the canvas; we null the ref then so the
  // header falls back to the playhead.
  useEffect(() => {
    const inst = echartsRef.current?.getEchartsInstance?.()
    if (!inst) return undefined
    const zr = inst.getZr?.()
    if (!zr) return undefined

    const onMove = (e) => {
      if (!isEchartsGridReady(inst, 0)) return
      const data = safe(
        () => inst.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]),
        null,
      )
      if (!data || data[0] == null) return
      // x is in chart x-axis units — seconds or metres depending on
      // mode. Convert back to canonical lap time, then compute the
      // ref-lap distance for that time.
      const time = xAxisToTime(data[0])
      const laps = useStore.getState().laps
      const refLap = laps.find((l) => !l.ghost) ?? laps[0]
      const distance = refLap?.samples?.length
        ? arcLengthAtTime(refLap.samples, time)
        : 0
      useStore.getState().hoverPointRef.current = { time, distance }
    }
    const onOut = () => {
      useStore.getState().hoverPointRef.current = null
    }
    zr.on('mousemove', onMove)
    zr.on('globalout', onOut)
    return () => {
      try { zr.off('mousemove', onMove); zr.off('globalout', onOut) } catch {}
    }
  }, [echartsRef, xAxisToTime])

  if (!option) return <div className="panel-empty">{emptyMessage}</div>
  return (
    <div className="chart-shell">
      {showHeaderBar && <ChartHeaderBar />}
      {showSectorBar && (
        <SectorBar
          xAxisFromTime={xAxisFromTime}
          xMax={tMax}
          gridLeft={gridLeft}
          gridRight={gridRight}
        />
      )}
      <div ref={containerRef} className="chart-shell-body">
        <ReactECharts
          ref={echartsRef}
          option={option}
          style={{ width: '100%', height: '100%' }}
          onEvents={{ dataZoom: onDataZoom }}
          notMerge={notMerge}
          lazyUpdate
          theme="dark"
        />
        <ChartValueLabels
          containerRef={containerRef}
          echartsRef={echartsRef}
          providers={valueProviders ?? []}
          xAxisFromTime={xAxisFromTime}
        />
        <ChartPlayheadOverlay />
        <ChartDeltaOverlays />
        {renderBodyOverlay
          ? renderBodyOverlay({ containerRef, echartsRef })
          : null}
      </div>
    </div>
  )
}
