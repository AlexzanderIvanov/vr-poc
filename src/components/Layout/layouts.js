/**
 * Layout presets — declarative tree of nested PanelGroups + Panels.
 *
 * Each preset has a `name` (human-readable) and a `tree`. The tree is a
 * recursive structure interpreted by `LayoutGrid`:
 *
 *   { kind: 'split', dir: 'h'|'v', children: [Node, Node, ...], sizes?: number[] }
 *   { kind: 'panel', id: PanelId }
 *
 * `dir: 'v'` = panels stack vertically (split into rows).
 * `dir: 'h'` = panels stack horizontally (split into columns).
 * `sizes` is an optional array of starting percentages (must sum to ~100).
 *
 * `id` references a key in `PANELS` (see panels.jsx).
 */

export const LAYOUT_PRESETS = {
  default: {
    name: 'Default',
    tree: {
      kind: 'split',
      dir: 'v',
      sizes: [60, 40],
      children: [
        { kind: 'panel', id: 'viewer3d' },
        {
          kind: 'split',
          dir: 'h',
          sizes: [38, 62],
          children: [
            { kind: 'panel', id: 'trackmap' },
            {
              kind: 'split',
              dir: 'v',
              sizes: [60, 40],
              children: [
                { kind: 'panel', id: 'telemetry' },
                { kind: 'panel', id: 'delta' },
              ],
            },
          ],
        },
      ],
    },
  },
  analysis: {
    name: 'Analysis',
    // Flat 2×2 CSS Grid — no nested react-resizable-panels Groups so the
    // cursor↔separator decoupling that nested-constraint cascading causes
    // can't happen here. Cells are fixed-proportion (55/45 columns ×
    // 62/38 rows for the left column, mirrored 80/20 for the right); use
    // the `default` preset if you want resizable panels.
    //
    // Telemetry takes the full right column at 80 % height because it has
    // 4 internal rows; delta is 1 row at 20 %. Mismatch with the left
    // column's 62/38 split is intentional — CSS Grid doesn't share row
    // tracks across columns at different heights without a more complex
    // template, and the visual is fine because the panels in each column
    // are independent.
    tree: {
      kind: 'cssgrid',
      defaultColPct: 55,
      // Per-column row splits — left column biases toward the 3D viewer
      // (60 %) since the track map below works fine compact; right column
      // biases harder toward telemetry (78 %) because it has 4 internal
      // rows and the delta chart is one row.
      defaultLeftRowPct: 60,
      defaultRightRowPct: 78,
      cells: [
        { id: 'viewer3d' },
        { id: 'telemetry' },
        { id: 'trackmap' },
        { id: 'delta' },
      ],
    },
  },
  charts: {
    name: 'Charts focus',
    tree: {
      kind: 'split',
      dir: 'v',
      sizes: [40, 60],
      children: [
        { kind: 'panel', id: 'viewer3d' },
        {
          kind: 'split',
          dir: 'h',
          sizes: [30, 35, 35],
          children: [
            { kind: 'panel', id: 'trackmap' },
            { kind: 'panel', id: 'telemetry' },
            { kind: 'panel', id: 'delta' },
          ],
        },
      ],
    },
  },
}
