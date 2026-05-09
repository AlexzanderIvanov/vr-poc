/**
 * Backend adapter — interface for everything the app loads from "outside".
 *
 * Two implementations live alongside this file:
 *   - `MockBackendAdapter` — wraps the existing static lap JSONs in
 *     `public/assets/laps/`, simulates a small network latency, and
 *     pre-computes derived channels (g-forces, GPS speed) so the UI
 *     consumes them as if the backend had sent them ready-made.
 *   - `HttpBackendAdapter` — placeholder; will hit a real REST/WebSocket
 *     endpoint when the backend exists. Same interface, swappable.
 *
 * The adapter is selected by `makeBackend()` based on the `VITE_BACKEND`
 * env var. The rest of the app only ever sees a `BackendAdapter`-shaped
 * object via `DataService`, so the swap is transparent.
 *
 * Interface (JSDoc):
 *
 *   listManifests() → Promise<{id, path}[]>
 *     Available routes / manifests the user can load.
 *
 *   getManifest(routeId) → Promise<Manifest>
 *     Manifest descriptor for a route. Includes `laps[]` (with metadata
 *     like device_id, color, sync, telemetry_path, …), the shared
 *     `consensus_delta`, and route-level config (hide_delta, sync, …).
 *
 *   getLapPositional(lapInfo) → Promise<PositionalLap>
 *     Lap geometry: `{ id, fps, duration, samples: [{t, position, quaternion}] }`.
 *     PLUS pre-computed derived channels: `gForces`, `gpsSpeed` arrays
 *     aligned by index with `samples`. The mock adapter computes these
 *     after applying transforms; a real backend would return them
 *     directly.
 *
 *   getLapTelemetry(lapInfo, channels?) → Promise<TelemetryLap | null>
 *     Vehicle/CAN telemetry: `{ id, samples: [{t, tps, fbp, rbp, rpm, steer}], events[] }`.
 *     Returns `null` when the lap's device class doesn't expose CAN data
 *     (e.g. a RaceBox-only lap with no AIM sidecar).
 *     `channels` is an optional list to subset; the mock currently returns
 *     all channels, but a future backend can use this to reduce payload.
 *
 *   getDeviceChannels(deviceId) → string[]
 *     Channels a device class natively provides; thin wrapper over
 *     `channelCatalog.listChannels` for adapters that may differ from
 *     the catalogue in the future.
 */

import { MockBackendAdapter } from './MockBackendAdapter'

/**
 * Factory — picks a backend implementation based on the build env.
 *
 * `VITE_BACKEND=http` will wire in the HTTP adapter once that exists.
 * Anything else (default) returns the in-process Mock adapter that
 * reads `public/assets/laps/*.json`.
 */
export function makeBackend() {
  // const which = import.meta.env.VITE_BACKEND
  // if (which === 'http') return new HttpBackendAdapter()
  return new MockBackendAdapter()
}
