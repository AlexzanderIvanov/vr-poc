import { Viewer3DSlot } from '../Viewer3D/PersistentViewer3D'
import { TrackMapPanel } from '../TrackMap/TrackMap'
import { TelemetryChartPanel } from '../Charts/TelemetryChartEcharts'
import { DeltaChartPanel } from '../Charts/DeltaChartEcharts'
import { VideoPanel } from '../Video/VideoOverlay'
import { VideoComparePanel } from '../Video/VideoComparePanel'

/**
 * Panel registry. Each entry is `{ title, component }` — the component pulls
 * its data from the store directly, so the LayoutGrid can place it without
 * passing props.
 *
 * Adding a new panel:
 *   1. Implement the component (subscribe to store via `useStore` selectors)
 *   2. Export an adapter component from its file (e.g. `MyPanel`)
 *   3. Register it below
 *   4. Reference its key from any preset in `layouts.js`
 *
 * `viewer3d` is special: the registered component is `<Viewer3DSlot>`, a
 * thin placeholder that reserves cell space and registers itself with
 * `viewerSlotRegistry`. The actual `<Viewer3DPanel>` (Canvas + WebGL +
 * GLB assets) is rendered ONCE by `<PersistentViewer3D>` at app-shell
 * level and absolute-positions itself over whichever slot is current.
 * This keeps the WebGL context alive across preset swaps so textures
 * and geometry don't re-upload.
 */
export const PANELS = {
  viewer3d:     { title: '3D Viewer',         component: Viewer3DSlot },
  trackmap:     { title: 'Track Map',         component: TrackMapPanel },
  telemetry:    { title: 'Telemetry',         component: TelemetryChartPanel },
  delta:        { title: 'Lap Delta',         component: DeltaChartPanel },
  video:        { title: 'Cockpit',           component: VideoPanel },
  videocompare: { title: 'Cockpit Compare',   component: VideoComparePanel },
}
