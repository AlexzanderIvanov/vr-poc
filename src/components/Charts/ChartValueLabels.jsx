import React, { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { safe, isEchartsGridReady } from '../../utils/safe'

/**
 * Live value-readout chips pinned to each chart row.
 *
 * Two-tier compact layout — minimum information at rest, full
 * information when a delta target is active:
 *
 *   Steady state (delta mode OFF):
 *
 *     ┌─────────┐
 *     │ ● 254 % │
 *     │ ● 250 % │
 *     └─────────┘
 *
 *   Delta mode ON (target line set via the Δ header button):
 *
 *     ┌──────────────┐
 *     │ ● 254     %  │      ← main row, value at PLAYHEAD (ref line)
 *     │    198 −56   │      ← secondary, value at TARGET + delta
 *     │ ● 250     %  │
 *     │    195 −55   │
 *     └──────────────┘
 *
 * The secondary row only appears while a delta target is set —
 * hover no longer drives delta values. Sign on the delta is
 * explicit (`+12` / `−56`) so the reader can tell whether the
 * target sample is higher or lower than the playhead.
 *
 * Channel name has moved off the chip entirely — the rotated
 * `yAxis.name` in the scale gutter on the left is where the user
 * reads "this row is TPS". One source of truth, ~36 px width
 * saved per chip.
 *
 * Reference source = the playhead (always — no more frozen-anchor
 * variant; the playhead's own dashed cyan line is the "ref" the
 * value chips report).
 *
 * Target source = `deltaRefPoint` if non-null. Set via the Δ button
 * in the chart header bar and refined by clicking / dragging the
 * orange target line that appears on every chart in the group.
 *
 * Provider contract (NB: param renamed from `cursorX` → `targetX`
 * to reflect the new semantics; callers must read `deltaRefPoint`
 * rather than `hoverPointRef`):
 *   {
 *     gridIndex,
 *     getLines(refX, targetX | null) → [{
 *       value,         // formatted value at refX (always)
 *       cursorValue?,  // formatted value at targetX (when target set)
 *       delta?,        // signed delta string (when target set)
 *       color,         // lap colour for the dot
 *       unit?,         // suffix, dim
 *       opacity?,
 *     }, ...] | null,
 *   }
 *
 * Render this as a sibling of `<ReactECharts>` inside the same
 * wrapper that holds `containerRef`.
 */

const FLIP_PAD = 80
const COL_WIDTH_MIN = 70

export function ChartValueLabels({ containerRef, echartsRef, providers, xAxisFromTime = (t) => t }) {
  const boxRefs = useRef([])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !providers?.length) return undefined

    let alive = true
    let rafId = 0

    const tick = () => {
      if (!alive) return
      const chart = echartsRef.current?.getEchartsInstance?.()
      if (!chart || chart.isDisposed?.()) {
        rafId = requestAnimationFrame(tick); return
      }
      const dom = chart.getDom?.()
      if (!dom) { rafId = requestAnimationFrame(tick); return }

      // Reference position is always the playhead (the cyan dashed
      // line). Each chip's main row shows the value of the lap's
      // sample at THIS x.
      const ph = useStore.getState().playheadRef.current
      const refXValue = xAxisFromTime(ph)

      // Target position: the orange dashed line, present only while
      // the user has armed delta mode. Drives the secondary "value
      // + delta" sub-row in each chip. Hover no longer participates.
      const drp = useStore.getState().deltaRefPoint
      const cursorXValue = drp ? xAxisFromTime(drp.time) : null

      const dRect = dom.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      const offX = dRect.left - cRect.left
      const offY = dRect.top - cRect.top
      // Pixel column of the REF position — used to decide whether
      // the chip is overlapping the playhead/anchor crosshair.
      const refPx = isEchartsGridReady(chart, 0)
        ? safe(() => chart.convertToPixel({ gridIndex: 0 }, [refXValue, 0])?.[0], null)
        : null

      providers.forEach((p, i) => {
        const grid = safe(
          () => chart.getModel().getComponent('grid', p.gridIndex).coordinateSystem.getRect(),
          null,
        )
        const box = boxRefs.current[i]
        if (!box) return
        if (!grid) { box.style.display = 'none'; return }

        const lines = p.getLines(refXValue, cursorXValue)
        if (!lines?.length) { box.style.display = 'none'; return }

        // Cache-skip — only rebuild DOM when something the eye can
        // see changes. cursorValue + delta are in the signature so
        // toggling hover-on / hover-off rebuilds correctly.
        const sig = lines
          .map((l) => `${l.color}|${l.opacity ?? 1}|${l.value}|${l.cursorValue || ''}|${l.delta || ''}|${l.unit || ''}`)
          .join('§')
        if (box.dataset.sig !== sig) {
          while (box.firstChild) box.removeChild(box.firstChild)
          for (const l of lines) {
            // Main row — dot + ref value + unit.
            const main = document.createElement('div')
            main.className = 'chart-value-row'
            main.style.opacity = String(l.opacity ?? 1)
            const dot = document.createElement('span')
            dot.className = 'chart-value-dot'
            dot.style.background = l.color
            main.appendChild(dot)
            const num = document.createElement('span')
            num.className = 'chart-value-num'
            num.textContent = l.value
            main.appendChild(num)
            if (l.unit) {
              const u = document.createElement('span')
              u.className = 'chart-value-unit'
              u.textContent = l.unit
              main.appendChild(u)
            }
            box.appendChild(main)

            // Secondary row — cursor value + delta (hover only).
            if (l.cursorValue != null && l.delta != null) {
              const hr = document.createElement('div')
              hr.className = 'chart-value-hover-row'
              hr.style.opacity = String(l.opacity ?? 1)
              const cv = document.createElement('span')
              cv.className = 'chart-value-cursor-num'
              cv.textContent = l.cursorValue
              hr.appendChild(cv)
              const dl = document.createElement('span')
              dl.className = 'chart-value-delta'
              dl.textContent = l.delta
              hr.appendChild(dl)
              box.appendChild(hr)
            }
          }
          box.dataset.sig = sig
        }
        box.style.display = 'flex'

        // Flip-left when the chip would overlap the ref-position
        // crosshair (the chip's main value mirrors what the line
        // points at, so leaving it under the crosshair is fine —
        // we only flip when actually behind the right edge).
        const boxW = Math.max(box.offsetWidth, COL_WIDTH_MIN)
        const rightEdge = grid.x + grid.width
        const flipLeft = refPx != null
          && refPx >= rightEdge - boxW - FLIP_PAD
          && refPx <= rightEdge + 4

        if (flipLeft) {
          box.style.left = `${offX + grid.x + 4}px`
        } else {
          box.style.left = `${offX + rightEdge - boxW - 4}px`
        }
        box.style.right = 'auto'
        box.style.top = `${offY + grid.y + 2}px`
        box.style.minWidth = `${COL_WIDTH_MIN}px`
      })

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; if (rafId) cancelAnimationFrame(rafId) }
  }, [containerRef, echartsRef, providers, xAxisFromTime])

  return (
    <>
      {providers.map((_, i) => (
        <div
          key={`box-${i}`}
          ref={(el) => { boxRefs.current[i] = el }}
          className="chart-value-box"
          style={{ display: 'none' }}
        />
      ))}
    </>
  )
}
