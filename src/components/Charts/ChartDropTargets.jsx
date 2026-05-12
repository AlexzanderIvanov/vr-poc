import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { safe } from '../../utils/safe'
import { CHANNEL_DRAG_MIME } from './TelemetryChartEcharts'

/**
 * Drop-target overlay rendered inside the telemetry chart's body when
 * the user is dragging a channel from `<ChannelList>`. Shows one
 * highlighted rectangle per existing chart grid (the "add to THIS
 * grid" zone) plus a thin strip at the very bottom for "create a NEW
 * grid". The zone the pointer is currently over is rendered with a
 * brighter accent so the user can tell where the drop will land.
 *
 * Zones are positioned in absolute pixels read from the ECharts
 * instance via `getModel().getComponent('grid', i).coordinateSystem
 * .getRect()`. Recomputed on every dragover so the overlay tracks the
 * actual plot area even if the chart resizes mid-drag.
 *
 * Implementation note — all drag handling uses native
 * `addEventListener` instead of React's `onDragOver` / `onDrop`. The
 * React synthetic event flow + native listeners on an ancestor were
 * fighting over the same drop: the native ancestor listener would
 * dispatch its handler (resetting `active=false`) BEFORE React's
 * delegated dispatch reached the inner zone's onDrop, so the channel
 * never got added. Going fully native everywhere puts the order back
 * under our control.
 *
 * Drop dispatch:
 *   - drop on grid `i` → `addUserChannel(id, gridChannelKey[i])`
 *     where `gridChannelKey[i]` is the primary channel of grid i.
 *   - drop on the "+ New grid" strip → `addUserChannel(id, null)`.
 */
export function ChartDropTargets({
  containerRef,
  echartsRef,
  gridChannelKeys, // string[] — primary channelKey per grid index
}) {
  const [active, setActive] = useState(false)
  const [hoverIdx, setHoverIdx] = useState(null) // -1 for new-strip
  const addUserChannel = useStore((s) => s.addUserChannel)
  const enterDepthRef = useRef(0)
  const overlayRef = useRef(null)

  // Drag enter / leave on the entire chart wrap to flip the overlay
  // visibility. Native listeners so we don't have to coordinate with
  // React's synthetic event timing.
  useEffect(() => {
    const wrap = containerRef.current?.parentElement
    if (!wrap) return undefined
    const isChannelDrag = (e) =>
      Array.from(e.dataTransfer?.types ?? []).includes(CHANNEL_DRAG_MIME)
    const onEnter = (e) => {
      if (!isChannelDrag(e)) return
      enterDepthRef.current++
      if (!active) setActive(true)
    }
    const onLeave = (e) => {
      if (!isChannelDrag(e)) return
      enterDepthRef.current = Math.max(0, enterDepthRef.current - 1)
      if (enterDepthRef.current === 0) {
        setActive(false)
        setHoverIdx(null)
      }
    }
    // `dragend` on the source row fires after a drag completes
    // (success or cancel). Use it as a safety reset — sometimes the
    // dragleave depth counter doesn't return to 0 (e.g. dropping on a
    // child element of a different listener chain). Without this the
    // overlay could stay "active" after the drag ended.
    const onDragEnd = () => {
      enterDepthRef.current = 0
      setActive(false)
      setHoverIdx(null)
    }
    wrap.addEventListener('dragenter', onEnter)
    wrap.addEventListener('dragleave', onLeave)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      wrap.removeEventListener('dragenter', onEnter)
      wrap.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [containerRef, active])

  // Per-zone native dragover/drop listeners — attached imperatively to
  // each rendered zone div so we control the event order. preventDefault
  // on dragover is what marks the zone as a valid drop target (HTML5
  // DnD requirement); drop reads the channel id and dispatches the add.
  useEffect(() => {
    if (!active) return undefined
    const root = overlayRef.current
    if (!root) return undefined
    const zones = root.querySelectorAll('[data-drop-target]')
    const cleanups = []
    zones.forEach((z) => {
      const target = z.getAttribute('data-drop-target')
      const idx = parseInt(z.getAttribute('data-drop-idx'), 10)
      const onOver = (e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
        if (hoverIdx !== idx) setHoverIdx(idx)
      }
      const onDrop = (e) => {
        e.preventDefault()
        e.stopPropagation()
        const id = e.dataTransfer?.getData(CHANNEL_DRAG_MIME)
        if (id) {
          // `target === '__new__'` is our sentinel for "+ New grid";
          // anything else is a channel-key string. Passing `null` to
          // addUserChannel appends a fresh grid.
          addUserChannel(id, target === '__new__' ? null : target)
        }
        enterDepthRef.current = 0
        setActive(false)
        setHoverIdx(null)
      }
      z.addEventListener('dragover', onOver)
      z.addEventListener('drop', onDrop)
      cleanups.push(() => {
        z.removeEventListener('dragover', onOver)
        z.removeEventListener('drop', onDrop)
      })
    })
    return () => { for (const c of cleanups) c() }
    // `hoverIdx` deliberately excluded — we don't want to re-attach
    // listeners on every hover change. The closure captures hoverIdx
    // via the setter call (functional form would be better, but the
    // `if (hoverIdx !== idx)` guard is just a re-render skipper).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, gridChannelKeys, addUserChannel])

  if (!active) return null

  // Grid rects in container-local pixels.
  const inst = echartsRef.current?.getEchartsInstance?.()
  if (!inst || inst.isDisposed?.()) return null
  const dom = inst.getDom?.()
  const container = containerRef.current
  if (!dom || !container) return null
  const dRect = dom.getBoundingClientRect()
  const cRect = container.getBoundingClientRect()
  const offX = dRect.left - cRect.left
  const offY = dRect.top - cRect.top

  const rects = []
  for (let i = 0; i < gridChannelKeys.length; i++) {
    const r = safe(
      () => inst.getModel().getComponent('grid', i).coordinateSystem.getRect(),
      null,
    )
    if (!r) continue
    rects.push({ i, x: offX + r.x, y: offY + r.y, w: r.width, h: r.height })
  }

  // "New grid" strip — pinned to the bottom of the chart container,
  // taking a fixed 28 px so it's always reachable regardless of how
  // many grids are stacked above. Sits BELOW the last grid; if the
  // last grid runs all the way down, the strip overlaps the last
  // ~28 px of it — acceptable trade-off because the new-grid action
  // is rarer than the add-to-existing-grid one.
  const stripH = 28
  const containerH = container.clientHeight
  const newStripTop = containerH - stripH - 2

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none', // root is invisible; only zones receive events
        zIndex: 30,
      }}
    >
      {rects.map((r) => (
        <div
          key={`grid-${r.i}`}
          data-drop-target={gridChannelKeys[r.i] ?? `idx-${r.i}`}
          data-drop-idx={r.i}
          className={`chart-drop-zone ${hoverIdx === r.i ? 'is-hover' : ''}`}
          style={{
            position: 'absolute',
            left: r.x, top: r.y, width: r.w, height: r.h,
            pointerEvents: 'auto',
          }}
        >
          <span className="chart-drop-zone-label">
            Add to {(gridChannelKeys[r.i] ?? `#${r.i + 1}`).toUpperCase()}
          </span>
        </div>
      ))}
      <div
        data-drop-target="__new__"
        data-drop-idx={-1}
        className={`chart-drop-zone chart-drop-zone-new ${hoverIdx === -1 ? 'is-hover' : ''}`}
        style={{
          position: 'absolute',
          left: 4, right: 4, top: newStripTop, height: stripH,
          pointerEvents: 'auto',
        }}
      >
        <span className="chart-drop-zone-label">+ New grid</span>
      </div>
    </div>
  )
}
