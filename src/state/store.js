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

  // ---------- view modes ----------
  cameraMode: defaultCameraMode(),
  compareMode: 'time',           // 'time' | 'position'
  cornerAnalysisMode: false,
  videoOverlayOn: true,

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
  setVideoOverlayOn:     (v) => set((s) => ({ videoOverlayOn: apply(v, s.videoOverlayOn) })),

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
