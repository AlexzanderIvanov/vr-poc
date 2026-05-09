import React, { useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStore } from '../../state/store'
import { LAYOUT_PRESETS } from './layouts'
import { PANELS } from './panels'
import { PanelFrame } from './PanelFrame'

/**
 * Renders the active layout preset (read from `store.layoutPreset`) as a
 * nested tree of resizable panel groups.
 *
 * The grid is fully driven by the preset's tree — adding a new panel only
 * requires registering it in `panels.jsx` and referencing it in a preset.
 *
 * Resize behaviour: `react-resizable-panels` (v4 API: Group / Panel /
 * Separator) handles drag handles between adjacent panels.
 */

function PanelLeaf({ id }) {
  const def = PANELS[id]
  if (!def) {
    return (
      <PanelFrame title={`Unknown panel "${id}"`}>
        <div className="panel-empty">Panel id not registered.</div>
      </PanelFrame>
    )
  }
  const { component: Component, title } = def
  return (
    <PanelFrame title={title}>
      <Component />
    </PanelFrame>
  )
}

function renderNode(node, keyPrefix = 'root') {
  if (node.kind === 'panel') {
    return <PanelLeaf id={node.id} />
  }
  // `cssgrid` — flat 2×2 CSS Grid with two INDEPENDENT splitters.
  //
  // Why this exists: nested `react-resizable-panels` Groups exhibit a
  // cursor↔separator decoupling bug — when an inner panel's minSize is
  // hit, the outer separator stops following the cursor but the drag is
  // still active, the cursor floats free, and reversing direction has a
  // dead zone before re-engagement. With a single CSS Grid managed by a
  // small piece of local state, both splits are controlled by the SAME
  // grid template; each splitter touches only its own axis; there is no
  // constraint cascade because there are no nested Groups.
  if (node.kind === 'cssgrid') {
    return (
      <FlatTwoByTwoGrid
        key={keyPrefix}
        cells={node.cells}
        defaultColPct={node.defaultColPct ?? 55}
        defaultRowPct={node.defaultRowPct ?? 70}
      />
    )
  }
  // 'split'
  const orientation = node.dir === 'h' ? 'horizontal' : 'vertical'
  const sizes = node.sizes || node.children.map(() => 100 / node.children.length)
  return (
    <Group key={keyPrefix} orientation={orientation} className="layout-group">
      {node.children.flatMap((child, idx) => {
        const els = []
        if (idx > 0) {
          els.push(
            <Separator
              key={`${keyPrefix}-handle-${idx}`}
              className={orientation === 'horizontal' ? 'panel-handle-h' : 'panel-handle-v'}
            />,
          )
        }
        els.push(
          <Panel
            key={`${keyPrefix}-${idx}`}
            minSize={5}
            defaultSize={sizes[idx]}
            className="panel-cell"
          >
            {renderNode(child, `${keyPrefix}-${idx}`)}
          </Panel>,
        )
        return els
      })}
    </Group>
  )
}

/**
 * 2×2 flat layout with THREE independent splitters: one column splitter
 * (sets the LR ratio) and TWO row splitters — one per column, so each
 * column has its OWN top/bottom split. Vertical alignment between the
 * left and right columns is therefore independent (e.g. the 3D viewer
 * can take 60 % of the left column while telemetry takes 75 % of the
 * right column).
 *
 * Layout: outer 2-column CSS Grid; each column is a flex column with
 * two cells and its own absolutely-positioned row splitter. Each
 * splitter touches exactly one piece of state. No nested
 * react-resizable-panels Groups, no constraint cascading.
 *
 * Cells passed in row-major order: top-left, top-right, bottom-left,
 * bottom-right.
 */
function FlatTwoByTwoGrid({
  cells,
  defaultColPct = 55,
  defaultLeftRowPct = 65,
  defaultRightRowPct = 75,
}) {
  const containerRef = useRef(null)
  const leftColRef = useRef(null)
  const rightColRef = useRef(null)
  const [colPct, setColPct] = useState(defaultColPct)
  const [leftRowPct, setLeftRowPct] = useState(defaultLeftRowPct)
  const [rightRowPct, setRightRowPct] = useState(defaultRightRowPct)

  const startDrag = (axis) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    // setPointerCapture throws on synthetic events that don't carry an
    // active browser-level pointer; swallow harmlessly.
    try { target.setPointerCapture?.(e.pointerId) } catch {}
    const move = (ev) => {
      if (axis === 'col') {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const pct = ((ev.clientX - rect.left) / rect.width) * 100
        setColPct(Math.max(10, Math.min(90, pct)))
      } else if (axis === 'leftRow') {
        const rect = leftColRef.current?.getBoundingClientRect()
        if (!rect) return
        const pct = ((ev.clientY - rect.top) / rect.height) * 100
        setLeftRowPct(Math.max(10, Math.min(90, pct)))
      } else if (axis === 'rightRow') {
        const rect = rightColRef.current?.getBoundingClientRect()
        if (!rect) return
        const pct = ((ev.clientY - rect.top) / rect.height) * 100
        setRightRowPct(Math.max(10, Math.min(90, pct)))
      }
    }
    const up = (ev) => {
      try { target.releasePointerCapture?.(ev.pointerId) } catch {}
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const colStyle = (rowPct) => ({
    display: 'grid',
    gridTemplateRows: `minmax(0, ${rowPct}fr) minmax(0, ${100 - rowPct}fr)`,
    minWidth: 0, minHeight: 0,
    position: 'relative',
    width: '100%', height: '100%',
  })
  const cellStyle = { minWidth: 0, minHeight: 0, overflow: 'hidden' }

  return (
    <div
      ref={containerRef}
      className="layout-cssgrid"
      style={{
        display: 'grid',
        // `minmax(0, …fr)` so the chart canvases inside (which set their
        // own pixel size on resize) can't push a track wider/taller than
        // its fr share.
        gridTemplateColumns: `minmax(0, ${colPct}fr) minmax(0, ${100 - colPct}fr)`,
        width: '100%', height: '100%',
        position: 'relative',
      }}
    >
      {/* Left column: top-left + bottom-left + its own row splitter */}
      <div ref={leftColRef} style={colStyle(leftRowPct)}>
        <div className="panel-cell" style={cellStyle}><PanelLeaf id={cells[0].id} /></div>
        <div className="panel-cell" style={cellStyle}><PanelLeaf id={cells[2].id} /></div>
        <div
          className="grid-splitter-h"
          style={{
            position: 'absolute',
            top: `${leftRowPct}%`, left: 0, right: 0,
            height: 16, marginTop: -8,
            cursor: 'row-resize', zIndex: 5,
          }}
          onPointerDown={startDrag('leftRow')}
          role="separator" aria-orientation="horizontal"
        />
      </div>
      {/* Right column: top-right + bottom-right + its own row splitter */}
      <div ref={rightColRef} style={colStyle(rightRowPct)}>
        <div className="panel-cell" style={cellStyle}><PanelLeaf id={cells[1].id} /></div>
        <div className="panel-cell" style={cellStyle}><PanelLeaf id={cells[3].id} /></div>
        <div
          className="grid-splitter-h"
          style={{
            position: 'absolute',
            top: `${rightRowPct}%`, left: 0, right: 0,
            height: 16, marginTop: -8,
            cursor: 'row-resize', zIndex: 5,
          }}
          onPointerDown={startDrag('rightRow')}
          role="separator" aria-orientation="horizontal"
        />
      </div>
      {/* Column splitter */}
      <div
        className="grid-splitter-v"
        style={{
          position: 'absolute',
          left: `${colPct}%`, top: 0, bottom: 0,
          width: 16, marginLeft: -8,
          cursor: 'col-resize', zIndex: 5,
        }}
        onPointerDown={startDrag('col')}
        role="separator" aria-orientation="vertical"
      />
    </div>
  )
}

export function LayoutGrid() {
  const preset = useStore((s) => s.layoutPreset)
  const def = LAYOUT_PRESETS[preset] || LAYOUT_PRESETS.default
  return (
    <div className="layout-grid">
      {renderNode(def.tree)}
    </div>
  )
}

export function LayoutPresetBar() {
  const preset = useStore((s) => s.layoutPreset)
  const setLayoutPreset = useStore((s) => s.setLayoutPreset)
  return (
    <div className="layout-preset-bar">
      {Object.entries(LAYOUT_PRESETS).map(([key, def]) => (
        <button
          key={key}
          className={`layout-preset-btn ${key === preset ? 'is-active' : ''}`}
          onClick={() => setLayoutPreset(key)}
        >
          {def.name}
        </button>
      ))}
    </div>
  )
}
