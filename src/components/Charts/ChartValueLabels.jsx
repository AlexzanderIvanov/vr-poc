import React, { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { safe } from '../../utils/safe'
// `findValueAt` is no longer re-exported from this `.jsx` file — vite's
// Fast Refresh refuses to hot-reload `.jsx` modules that mix React
// components with non-component exports. New imports should target
// `utils/findValueAt` directly.

/**
 * Live numeric readouts (and optional persistent channel name) pinned to
 * each chart row.
 *
 * Per row we render up to two DOM nodes inside the chart wrapper:
 *
 *   - **Channel name** (`rowName`, `rowNameColor`): sits at the row's
 *     top-LEFT corner regardless of playhead position. Rendered once per
 *     provider change; stays put through scrolling/scrubbing.
 *   - **Live value column** (`getLines(t)`): top-RIGHT by default; when
 *     the playhead column comes within `FLIP_PAD` px of that corner, the
 *     column flips to the row's top-RIGHT-just-below-rowname-no — wait
 *     no, it flips to the LEFT side but a few px BELOW the row name so
 *     they don't stack on top of each other.
 *
 * Driven by raf reading `playheadRef.current` directly — no React
 * re-render, no `setOption`. DOM writes are skipped when the rendered
 * text didn't change (cached on `dataset.sig`), so an idle frame costs
 * ~0.05 ms.
 *
 * Provider contract:
 *   {
 *     gridIndex,
 *     rowName?,            // optional persistent channel label, top-left
 *     rowNameColor?,
 *     getLines(t) → [{ text, color, opacity? }, ...] | null,
 *   }
 *
 * Render this as a sibling of `<ReactECharts>` inside the same wrapper
 * that holds `containerRef`, alongside `<ChartPlayheadOverlay />`.
 */

const FLIP_PAD = 80   // px from the right edge at which we flip to the left
const COL_WIDTH = 96  // readout column width in px

export function ChartValueLabels({ containerRef, echartsRef, providers }) {
  const valueNodes = useRef([])
  const nameNodes  = useRef([])

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

      const ph = useStore.getState().playheadRef.current
      const dRect = dom.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      const offX = dRect.left - cRect.left
      const offY = dRect.top - cRect.top
      const phX = safe(() => chart.convertToPixel({ gridIndex: 0 }, [ph, 0])?.[0], null)

      providers.forEach((p, i) => {
        const grid = safe(
          () => chart.getModel().getComponent('grid', p.gridIndex).coordinateSystem.getRect(),
          null,
        )
        const valNode = valueNodes.current[i]
        const nameNode = nameNodes.current[i]
        if (!grid) {
          if (valNode) valNode.style.display = 'none'
          if (nameNode) nameNode.style.display = 'none'
          return
        }

        const rightEdge = grid.x + grid.width
        const flipLeft = phX != null
          && phX >= rightEdge - COL_WIDTH - FLIP_PAD
          && phX <= rightEdge + 4

        // 1. Persistent channel name at top-left of the row (when provided).
        if (nameNode) {
          if (p.rowName) {
            if (nameNode.textContent !== p.rowName) nameNode.textContent = p.rowName
            nameNode.style.color = p.rowNameColor || '#cfd6e8'
            nameNode.style.display = 'block'
            nameNode.style.top = `${offY + grid.y + 2}px`
            nameNode.style.left = `${offX + grid.x + 4}px`
          } else {
            nameNode.style.display = 'none'
          }
        }

        // 2. Live value column.
        if (valNode) {
          const lines = p.getLines(ph)
          if (!lines?.length) {
            valNode.style.display = 'none'
          } else {
            const sig = lines.map((l) => `${l.color}|${l.opacity ?? 1}|${l.text}`).join('§')
            if (valNode.dataset.sig !== sig) {
              while (valNode.firstChild) valNode.removeChild(valNode.firstChild)
              for (const l of lines) {
                const row = document.createElement('div')
                row.style.color = l.color
                row.style.opacity = String(l.opacity ?? 1)
                row.textContent = l.text
                valNode.appendChild(row)
              }
              valNode.dataset.sig = sig
            }
            valNode.style.display = 'block'
            valNode.style.width = `${COL_WIDTH}px`

            if (flipLeft) {
              // Stack below the row name so they don't collide. If there's
              // no row name we still drop a few px so the value sits
              // visually distinct from the playhead's own crosshair.
              const yOffset = p.rowName ? 16 : 2
              valNode.style.left = `${offX + grid.x + 4}px`
              valNode.style.top = `${offY + grid.y + yOffset}px`
              valNode.style.textAlign = 'left'
            } else {
              valNode.style.left = `${offX + rightEdge - COL_WIDTH - 4}px`
              valNode.style.top = `${offY + grid.y + 2}px`
              valNode.style.textAlign = 'right'
            }
          }
        }
      })

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => { alive = false; if (rafId) cancelAnimationFrame(rafId) }
  }, [containerRef, echartsRef, providers])

  const labelStyle = {
    position: 'absolute',
    display: 'none',
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.2,
    pointerEvents: 'none',
    zIndex: 3,
    textShadow: '0 1px 2px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)',
    whiteSpace: 'nowrap',
  }

  return (
    <>
      {providers.map((_, i) => (
        <div
          key={`name-${i}`}
          ref={(el) => { nameNodes.current[i] = el }}
          style={{ ...labelStyle, fontWeight: 700, letterSpacing: 0.5 }}
        />
      ))}
      {providers.map((_, i) => (
        <div
          key={`val-${i}`}
          ref={(el) => { valueNodes.current[i] = el }}
          style={labelStyle}
        />
      ))}
    </>
  )
}

// `findValueAt` is re-exported at the top of this file (now lives in
// `utils/findValueAt.js`) so consumers like the chart panels keep their
// existing import path while this `.jsx` only carries React components.
