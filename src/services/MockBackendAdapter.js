import { assetUrl } from '../config'
import {
  applyConsensusDelta,
  smoothSamplePositionsXZ,
  computeGForces,
  computeGpsSpeed,
} from './transforms'
import { listChannels } from './channelCatalog'

/**
 * Mock backend adapter — returns the same data the eventual real backend
 * will, but reads it from the static lap JSONs that ship under
 * `public/assets/laps/` rather than hitting a server.
 *
 * Pre-computes the derived channels (`gForces`, `gpsSpeed`) on the fly
 * so the rest of the app reads them as if they were sent ready by the
 * backend. When the real backend lands these will arrive directly from
 * the server (e.g. RaceBox's hardware IMU); switching adapters changes
 * nothing for the consumers.
 *
 * Each load is delayed by a small simulated latency so callers exercise
 * their async-handling paths exactly like they would against a network.
 */

const ROUTE_TO_MANIFEST = {
  '/':                '/assets/laps/manifest.json',
  '/um-racebox':      '/assets/laps/manifest_um_racebox.json',
  '/slow-and-slower': '/assets/laps/manifest_slow_and_slower.json',
  '/slow-vs-master':  '/assets/laps/manifest_slow_vs_master.json',
  '/video':           '/assets/laps/manifest_video.json',
}

const SIMULATED_LATENCY_MS = 25
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class MockBackendAdapter {
  async listManifests() {
    return Object.entries(ROUTE_TO_MANIFEST).map(([id, path]) => ({ id, path }))
  }

  async getManifest(routeId) {
    const path = ROUTE_TO_MANIFEST[routeId] ?? ROUTE_TO_MANIFEST['/']
    const r = await fetch(assetUrl(path))
    if (!r.ok) throw new Error(`getManifest(${routeId}) → ${r.status}`)
    await sleep(SIMULATED_LATENCY_MS)
    return r.json()
  }

  /**
   * Fetch positional samples for a lap, apply the data-pipeline
   * transforms (consensus_delta + smoothing), then attach derived
   * channels (g-forces, gps-speed) so the consumer doesn't need to
   * compute them.
   *
   * `sharedDelta` is the manifest-level consensus delta (or the lap's
   * own). DataService passes one shared value per route so all laps
   * land in the same coordinate frame.
   */
  async getLapPositional(lapInfo, { sharedDelta = null } = {}) {
    const r = await fetch(assetUrl(lapInfo.path))
    if (!r.ok) throw new Error(`getLapPositional(${lapInfo.id}) → ${r.status}`)
    await sleep(SIMULATED_LATENCY_MS)
    const lap = await r.json()

    if (sharedDelta && lap.samples) applyConsensusDelta(lap.samples, sharedDelta)
    if (lap.samples) smoothSamplePositionsXZ(lap.samples)

    // Derived channels — pre-computed here so the eventual real backend
    // can drop them in directly without changes on the consumer side.
    lap.gForces = computeGForces(lap.samples)
    lap.gpsSpeed = computeGpsSpeed(lap.samples)

    return lap
  }

  /**
   * Fetch CAN/ECU telemetry for a lap. Returns `null` if the lap doesn't
   * have an associated AIM sidecar (e.g. a RaceBox-only lap).
   *
   * `channels` is an optional subset filter. The mock currently returns
   * all channels regardless; the parameter is in the contract so a
   * future HTTP backend can use it for narrower payloads.
   */
  async getLapTelemetry(lapInfo, _channels) {
    if (!lapInfo.telemetry_path) return null
    const r = await fetch(assetUrl(lapInfo.telemetry_path))
    if (!r.ok) return null
    await sleep(SIMULATED_LATENCY_MS)
    return r.json()
  }

  async getLapEvents(lapInfo) {
    const tel = await this.getLapTelemetry(lapInfo)
    return tel?.events ?? []
  }

  getDeviceChannels(deviceId) {
    return listChannels(deviceId)
  }
}
