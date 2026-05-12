import { create } from 'zustand'
import { computeLapDelta } from '../utils/delta'

/**
 * Single source of truth for app-wide state — playback, lap data, view modes.
 *
 * Two-tier clock model:
 *
 *   - `playheadRef` and `sectorEndRef` — plain `{current: number}` objects
 *     created ONCE at module load. Mutated every RAF tick by the playback
 *     loop and read inside `useFrame` at display FPS, with no React overhead.
 *     Components that need the live clock at full FPS read these refs; never
 *     subscribe to React state for the playhead.
 *   - `playhead` (React state) — throttled mirror of `playheadRef.current`,
 *     updated at ~15 Hz by the playback loop. Drives chart playheads, the
 *     scrubber label, HUD numerics — anything that doesn't need per-frame
 *     precision.
 *
 * Setter conventions:
 *   - Action setters mirror `useState`: pass a value OR `(prev) => next`.
 *   - `setPlayhead(v)` writes BOTH the ref (synchronously) and the React
 *     state. External edits (scrubber, sector jump, brush snap) reach the
 *     3D hot path immediately.
 *   - `setLaps` and `setTelemetryData` recompute the derived `duration` and
 *     `deltaData` slices in the same `set()` call, so consumers don't need
 *     to memoise these themselves.
 *
 * What's NOT here (UI-local):
 *   - `recording / recorderRef / chunksRef` — only the record-button block reads.
 *   - `showCarHuds / mobileDrawer` — only the side panel + toolbar.
 */

const INITIAL_PLAYHEAD = 0.01

const apply = (updaterOrValue, prev) =>
  typeof updaterOrValue === 'function' ? updaterOrValue(prev) : updaterOrValue

function defaultCameraMode() {
  if (typeof window === 'undefined') return 'free'
  return window.location?.pathname === '/video' ? 'chase' : 'free'
}

// Derived values that depend on lap data — recomputed inside `setLaps` /
// `setTelemetryData` so consumers can read them straight from the store
// without per-component `useMemo`.
function deriveFromLaps(laps, telemetryData, prevState) {
  const duration = laps.length ? Math.max(...laps.map((l) => l.duration)) : 0
  // Auto-extend viewport to the new full range when the prior viewport was
  // already at full range (or unset).
  const wasFullRange = !prevState
    || prevState.duration === 0
    || prevState.viewport.tEnd >= (prevState.duration - 1e-3)
  const viewport = wasFullRange
    ? { tStart: 0, tEnd: duration }
    : prevState.viewport
  const deltaData = computeLapDelta(laps, telemetryData)
  return { duration, viewport, deltaData }
}

export const useStore = create((set, get) => ({
  // ---------- hot-path refs (NEVER replaced; always mutate `.current`) ----------
  playheadRef: { current: INITIAL_PLAYHEAD },
  sectorEndRef: { current: null },
  // Mouse cursor position over a chart, in lap-time + ref-lap distance.
  // Written by `ChartShell`'s ECharts `zr.mousemove` listener; read at
  // raf rate by the chart header bar's live readout. `null` when no
  // chart is hovered. Hot-path ref (mutate `.current`), never replaced.
  hoverPointRef: { current: null },

  // ---------- playback ----------
  playing: false,
  speed: 1,
  playhead: INITIAL_PLAYHEAD,

  // ---------- lap data ----------
  manifest: null,
  laps: [],
  telemetryData: {},
  visibility: {},
  syncOffsets: {},
  focusLapId: null,

  // ---------- derived from laps + telemetry (auto-recomputed) ----------
  duration: 0,
  deltaData: null,
  viewport: { tStart: 0, tEnd: 0 },

  // ---------- per-lap timing offsets (used for sector-jump alignment) ----------
  lapTimeOffset: 0,
  sectorStartTime: null,
  selectedSector: null,

  // ---------- delta-cursor reference point (chart header bar) ----------
  // `{ time, distance } | null`. Set by the Δ button in the chart
  // header bar; while non-null, the header shows Δt/Δd of the cursor
  // relative to this anchor, and each chart's value chip shows a
  // per-lap Δ value column alongside the live value.
  deltaRefPoint: null,

  // ---------- user-added telemetry chart rows ----------
  // Channels the user has dragged from the right-side ChannelList
  // onto the telemetry chart. Each entry is `{ id, target }`:
  //
  //   - `target: 'tps' | 'fbp' | 'gps_speed' | 'steer' | 'long_g' | …`
  //     → OVERLAY on the existing grid whose primary `channelKey`
  //       matches `target`. Plotted on a SECOND (right-side) y-axis
  //       so the new channel's range doesn't crush the original
  //       trace when scales differ wildly (e.g. RPM 0–8000 over
  //       TPS 0–255).
  //   - `target: null`
  //     → NEW grid appended at the bottom of the chart.
  //
  // Order = insertion order; duplicates (same `id`, regardless of
  // target) rejected by `addUserChannel` — a channel can live in
  // exactly one place at a time. The seed set
  // (`tps` / `fbp` / `gps_speed` / `steer` / G-grid) is baked into
  // `SERIES_DEFS` and never appears here.
  userAddedChannels: [],

  // ---------- view modes ----------
  cameraMode: defaultCameraMode(),
  compareMode: 'time',           // 'time' | 'position'
  cornerAnalysisMode: false,

  // ---------- per-lap presentation overrides ----------
  // `lapColors[lapId] = '#hex'` — user override that wins over the palette
  // default. Empty by default; populated by `<LapColorPicker>` (planned).
  // Resolution helper: `hooks/useLapColor.resolveLapColor(state, lapId)`.
  lapColors: {},

  // ---------- layout ----------
  layoutPreset: 'analysis',      // 'default' | 'analysis' | 'charts'

  // ---------- actions: playback ----------
  setPlaying: (v) => set((s) => ({ playing: apply(v, s.playing) })),
  setSpeed:   (v) => set((s) => ({ speed: apply(v, s.speed) })),
  setPlayhead: (v) => {
    const next = apply(v, get().playheadRef.current)
    get().playheadRef.current = next
    set({ playhead: next })
  },

  // ---------- actions: lap data (auto-derive duration + deltaData) ----------
  setManifest: (v) => set((s) => ({ manifest: apply(v, s.manifest) })),
  setLaps: (v) => set((s) => {
    const laps = apply(v, s.laps)
    return { laps, ...deriveFromLaps(laps, s.telemetryData, s) }
  }),
  setTelemetryData: (v) => set((s) => {
    const telemetryData = apply(v, s.telemetryData)
    return { telemetryData, ...deriveFromLaps(s.laps, telemetryData, s) }
  }),
  setVisibility:  (v) => set((s) => ({ visibility: apply(v, s.visibility) })),
  setSyncOffsets: (v) => set((s) => ({ syncOffsets: apply(v, s.syncOffsets) })),
  setFocusLapId:  (v) => set((s) => ({ focusLapId: apply(v, s.focusLapId) })),

  // ---------- actions: per-lap timing ----------
  setLapTimeOffset:   (v) => set((s) => ({ lapTimeOffset: apply(v, s.lapTimeOffset) })),
  setSectorStartTime: (v) => set((s) => ({ sectorStartTime: apply(v, s.sectorStartTime) })),
  setSelectedSector:  (v) => set((s) => ({ selectedSector: apply(v, s.selectedSector) })),

  // ---------- actions: delta-cursor ----------
  setDeltaRefPoint: (v) => set((s) => ({ deltaRefPoint: apply(v, s.deltaRefPoint) })),

  // ---------- actions: user-added chart rows ----------
  // Append-once: a no-op if the id is already plotted (overlay or new
  // grid), so a double-drop doesn't stack duplicates. To move a
  // channel between targets, call `removeUserChannel(id)` first.
  addUserChannel: (id, target = null) => set((s) => (
    s.userAddedChannels.some((x) => x.id === id)
      ? {}
      : { userAddedChannels: [...s.userAddedChannels, { id, target }] }
  )),
  removeUserChannel: (id) => set((s) => ({
    userAddedChannels: s.userAddedChannels.filter((x) => x.id !== id),
  })),

  // ---------- actions: presentation ----------
  // Write a per-lap colour override. Pass `null` / `undefined` to remove
  // the override and fall back to the palette default. Subscribers via
  // `useLapColor(lapId)` re-render automatically; visualisation
  // components that depend on the colour inside `useMemo` should include
  // `lapColors` in their dependency array.
  setLapColor: (lapId, color) => set((s) => {
    const next = { ...s.lapColors }
    if (color == null) delete next[lapId]; else next[lapId] = color
    return { lapColors: next }
  }),

  // ---------- actions: view modes ----------
  setCameraMode:         (v) => set((s) => ({ cameraMode: apply(v, s.cameraMode) })),
  setCompareMode:        (v) => set((s) => ({ compareMode: apply(v, s.compareMode) })),
  setCornerAnalysisMode: (v) => set((s) => ({ cornerAnalysisMode: apply(v, s.cornerAnalysisMode) })),

  // ---------- actions: analysis frame ----------
  setViewport: (vp) => {
    const duration = get().duration
    const tStart = Math.max(0, Math.min(vp.tStart, duration))
    const tEnd = Math.max(tStart + 0.05, Math.min(vp.tEnd, duration))
    set({ viewport: { tStart, tEnd } })
  },
  resetViewport: () => set((s) => ({ viewport: { tStart: 0, tEnd: s.duration } })),

  // ---------- actions: layout ----------
  setLayoutPreset: (v) => set((s) => ({ layoutPreset: apply(v, s.layoutPreset) })),
}))

// Convenience non-subscribing reads — for the playback hook etc.
export const getPlayheadRef = () => useStore.getState().playheadRef
export const getSectorEndRef = () => useStore.getState().sectorEndRef
