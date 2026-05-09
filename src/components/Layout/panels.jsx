import { Viewer3DPanel } from '../Viewer3D/Viewer'
import { TrackMapPanel } from '../TrackMap/TrackMap'
import { TelemetryChartPanel } from '../Charts/TelemetryChartEcharts'
import { DeltaChartPanel } from '../Charts/DeltaChartEcharts'
import { VideoPanel } from '../Video/VideoOverlay'

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
 */
export const PANELS = {
  viewer3d:  { title: '3D Viewer',  component: Viewer3DPanel },
  trackmap:  { title: 'Track Map',  component: TrackMapPanel },
  telemetry: { title: 'Telemetry',  component: TelemetryChartPanel },
  delta:     { title: 'Lap Delta',  component: DeltaChartPanel },
  video:     { title: 'Cockpit',    component: VideoPanel },
}
