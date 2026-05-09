import { useStore } from '../state/store'

/**
 * Orchestrator that loads a route's full data set through the backend
 * adapter and pushes it into the zustand store.
 *
 * Responsibilities:
 *   - Resolve a route path (e.g. "/um-racebox") to a manifest via the
 *     adapter, then fan out positional + telemetry loads per lap.
 *   - Apply the per-lap pipeline transforms (consensus delta + smoothing)
 *     — done inside the adapter today so derived channels can attach.
 *   - Cache positional and telemetry payloads per lap id; reloading a
 *     route is cheap.
 *   - Hydrate the store: `manifest`, `laps`, `telemetryData`, default
 *     `focusLapId`, `visibility`, `syncOffsets`.
 *
 * The store stays a thin reactive layer; this service is the only thing
 * that knows how data gets in. UI components never call the adapter
 * directly.
 */
export class DataService {
  constructor(backend) {
    this.backend = backend
    this.posCache = new Map()  // lapId → positional payload (with derived channels)
    this.tlmCache = new Map()  // lapId → telemetry payload | null
  }

  /**
   * Load a route's manifest + all laps + all telemetry, and hydrate
   * the store. Idempotent: callable on route change; cached lap data
   * is reused.
   */
  async loadRoute(routePath) {
    const manifest = await this.backend.getManifest(routePath)

    // The manifest can carry one consensus_delta that applies to every
    // lap in the route, or each lap can carry its own. Per-lap deltas
    // were calibrated independently and disagree — using the manifest-
    // level (or first lap's) value keeps lap-to-lap alignment intact.
    const sharedDelta = manifest.consensus_delta || manifest.laps[0]?.consensus_delta

    const lapPayloads = await Promise.all(
      manifest.laps.map((lapInfo) => this._loadLapPositional(lapInfo, sharedDelta)),
    )

    const telemetry = {}
    await Promise.all(
      manifest.laps.map(async (lapInfo) => {
        const tel = await this._loadLapTelemetry(lapInfo)
        if (tel) telemetry[lapInfo.id] = tel
      }),
    )

    const store = useStore.getState()
    store.setManifest(manifest)
    store.setLaps(lapPayloads)
    store.setTelemetryData(telemetry)
    store.setFocusLapId(lapPayloads[0]?.id ?? null)
    store.setVisibility(Object.fromEntries(lapPayloads.map((l) => [l.id, true])))
    store.setSyncOffsets(Object.fromEntries(lapPayloads.map((l) => {
      // Compensate for any baked-in heading correction on the lap.
      const headingCorrection = l.sync?.car_heading_left_correction_deg ?? 0
      return [l.id, { forward: 0, left: 0, up: 0, yaw: -headingCorrection }]
    })))
  }

  async _loadLapPositional(lapInfo, sharedDelta) {
    const cached = this.posCache.get(lapInfo.id)
    if (cached) return { ...lapInfo, ...cached }
    const lap = await this.backend.getLapPositional(lapInfo, { sharedDelta })
    this.posCache.set(lapInfo.id, lap)
    return { ...lapInfo, ...lap }
  }

  async _loadLapTelemetry(lapInfo) {
    if (this.tlmCache.has(lapInfo.id)) return this.tlmCache.get(lapInfo.id)
    const tel = await this.backend.getLapTelemetry(lapInfo)
    this.tlmCache.set(lapInfo.id, tel)
    return tel
  }
}
