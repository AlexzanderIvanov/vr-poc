import React from 'react'

/**
 * Wrapper around every visualization that lives inside the LayoutGrid.
 *
 * Provides:
 *   - A title bar (compact, ~22 px tall)
 *   - A body region that fills the remaining height (the panel content goes here)
 *   - Standard styling so all panels look uniform regardless of what's inside
 *
 * Resize semantics: the panel is sized by its parent (a `<Panel>` from
 * `react-resizable-panels`). The frame is `display: flex / flex-direction: column`
 * with the body set to `flex: 1` and `min-height: 0`, so the inner content
 * (charts / canvas / WebGL Canvas) gets a real bounded height to render into.
 *
 * Components rendered inside the body should be flexible — `width: 100%`,
 * `height: 100%`. ECharts and three.js Canvas both honour that pattern.
 */
export function PanelFrame({ title, actions = null, children }) {
  return (
    <div className="panel-frame">
      <div className="panel-frame-header">
        <span className="panel-frame-title">{title}</span>
        {actions && <span className="panel-frame-actions">{actions}</span>}
      </div>
      <div className="panel-frame-body">
        {children}
      </div>
    </div>
  )
}
