import React from 'react'
import {
  DELTA_TARGET_OVERLAY_CLASS,
  DELTA_WINDOW_OVERLAY_CLASS,
} from '../../constants'

/**
 * Two overlay DOM nodes rendered alongside the playhead overlay:
 *
 *   • Delta WINDOW — a wide, faintly-lit rectangle spanning the span
 *     between the playhead (ref) and the delta target. Sits BEHIND the
 *     two vertical lines (lower z-index) so the lines remain readable
 *     against it. Visualises the "delta range" at a glance — the user
 *     can see how wide the comparison span is even on a busy chart.
 *
 *   • Delta TARGET line — second vertical bar, distinct colour from the
 *     playhead (cyan) so the eye can immediately tell which is which.
 *     14 px hit area lets the gesture handler grab it for drag, similar
 *     to the playhead handle.
 *
 * Both are positioned via the rAF loop in `useEchartsTimeSync` — DOM
 * style writes only, no React state, no ECharts setOption. `display`
 * is `'none'` by default; the rAF loop flips it on when delta mode is
 * active (i.e. when `deltaRefPoint` is non-null).
 *
 * The target line's drag handle deliberately has `pointerEvents: none`
 * for the same reason the playhead does — the zrender gesture handler
 * in `useChartGestures` detects "near target" by pixel distance and
 * starts the drag itself. Letting the overlay intercept clicks would
 * pre-empt that path.
 */
export function ChartDeltaOverlays() {
  return (
    <>
      <div
        className={DELTA_WINDOW_OVERLAY_CLASS}
        style={{
          position: 'absolute',
          pointerEvents: 'none',
          // Behind the playhead (z 4) and target (z 5) — see CSS.
          zIndex: 2,
          display: 'none',
        }}
      />
      <div
        className={DELTA_TARGET_OVERLAY_CLASS}
        style={{
          position: 'absolute',
          width: 14,
          marginLeft: -7,
          pointerEvents: 'none',
          zIndex: 5,
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
            borderLeft: '1.5px dashed rgba(255,167,38,0.95)',
          }}
        />
      </div>
    </>
  )
}
