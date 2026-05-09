import React from 'react'
import { PLAYHEAD_OVERLAY_CLASS } from '../../constants'

/**
 * Playhead overlay rendered as a React-owned sibling of the ECharts
 * canvas inside the chart wrapper. `useEchartsTimeSync` writes its
 * `style.left` via raf at native refresh rate (no React state, no
 * ECharts setOption); this component just declares the DOM.
 *
 * Render this once inside the chart wrapper (the same div that has the
 * `containerRef` ref attached).
 */
export function ChartPlayheadOverlay() {
  return (
    <div
      className={PLAYHEAD_OVERLAY_CLASS}
      style={{
        position: 'absolute',
        width: 14,
        marginLeft: -7,
        // Must NOT intercept pointer events — the chart's zrender gesture
        // handler detects "near-playhead" within `CHART_HANDLE_HIT_PX`
        // from the canvas mousedown. If this overlay had `auto`, clicks
        // landing exactly on the playhead would be eaten here and the
        // scrub gesture would never start.
        pointerEvents: 'none',
        zIndex: 4,
        display: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: '50%',
          width: 0,
          borderLeft: '1.5px dashed rgba(255,255,255,0.9)',
        }}
      />
    </div>
  )
}
