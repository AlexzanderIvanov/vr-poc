// =========================================================================
// Global constants — single source for tunable values used across the app.
//
// What lives here:
//   - User-tunable thresholds (TPS / brake levels, sector heuristics)
//   - Visual presentation constants (palette, chart hit-test pixels)
//   - Recording parameters
//
// What does NOT live here:
//   - Per-component module locals tied to physics constants
//     (e.g. `STEERING_RATIO` in `CarEntity.jsx` — depends on the GLB
//     model's steering wheel rig and is unlikely to ever be tuned
//     independently of CarEntity).
//   - Anything derived at runtime from manifest / lap data
//     (those live on the store).
//
// Adding a new constant: prefer dropping it here when more than one
// module would otherwise duplicate the literal, or when tuning the value
// without grep'ing the source tree is a goal.
//
// Removed: legacy constants that survived past feature reverts
// (`MAX_SECTOR_TIME_FOR_STOP`, `STEER_VISUAL_GAIN`, race-engineer-tip
// thresholds, `CAMERA_OFFSETS`, `SCORE_GRADES`, `CANVAS_DIMS`, …) — all
// had zero external references at audit time.
// =========================================================================

// ─── Playback / sectors ──────────────────────────────────────────────────
/**
 * Seconds of straight lead-in time prepended to a brake-derived sector.
 * Drivers brake-into a corner; the sector that ends "at the apex" starts
 * `SECTOR_LEAD_TIME` seconds BEFORE brake-on so the user sees the approach.
 */
export const SECTOR_LEAD_TIME = 3.0

/**
 * Sectors shorter than this many seconds get merged with the next sector.
 * Track-day data sometimes has spurious double-tap brakes that would
 * otherwise produce noisy 0.5 s segments.
 */
export const MIN_SECTOR_TIME = 5.0


// ─── Telemetry thresholds (raw AIM units: TPS 0–255, fbp 0–~150 bar) ─────
/**
 * Anything ≥ this TPS counts as "full throttle". Used by
 * `cornerAnalysis.js` to label the full-throttle phase and to find the
 * driver's earliest moment back on the pedal after corner exit.
 */
export const TPS_FULL_THRESHOLD = 240

/**
 * TPS at which we count the driver as having "applied throttle" after a
 * corner. Anything below this is considered coasting / brake-feathering.
 */
export const THROTTLE_ON_TPS = 50

/**
 * Drop in TPS (units) that counts as a "dip" in the throttle-oscillation
 * detector. Catches "I lifted, then re-applied" corner-exit mistakes.
 */
export const OSCILLATION_TPS_DIP = 25


// ─── Presentation colour palette ─────────────────────────────────────────
//
// Per-lap presentation colours used across every visualisation surface
// (3D trajectory line, car dot, model material tint, corner-apex flag
// posts, chart series, HUD swatches, …). Index 0 = ref lap, index 1 =
// first ghost, etc. Indices beyond `length` wrap with modulo so the app
// never crashes on N-lap comparisons.
//
// Override mechanism: `state.lapColors[lapId] = '#hex'` (written by a
// future `<LapColorPicker>`). The resolver in `hooks/useLapColor.js`
// prefers the override and falls back to this palette by lap index.
// The manifest JSONs still carry a baked-in `lap.color` but it is now
// IGNORED — colours live entirely on the presentation layer so the user
// can recolour without touching data, and so the picker propagates
// through the same reactive store mechanism every other UI piece uses.
export const LAP_COLOR_PALETTE = [
  '#3b82f6',  // blue   — ref lap   (laps[0])
  '#ef4444',  // red    — first ghost (laps[1])
  '#10b981',  // green  — second ghost (future)
  '#f59e0b',  // amber  — third ghost  (future)
  '#a855f7',  // purple — fourth      (future)
]

/** Telemetry-phase colours for the trajectory tint (`sampleColor`). */
export const PHASE_COLORS = {
  full_throttle: '#4caf50',
  braking:       '#f44336',
  trail_braking: '#ff9800',
  coasting:      '#607d8b',
}

/** Short labels for the trajectory-phase legend. */
export const PHASE_LABELS = {
  full_throttle: 'THROTTLE',
  braking:       'BRAKE',
  trail_braking: 'TRAIL',
  coasting:      'COAST',
}

/** Border colour per GNSS-device tag (sidebar lap-row badge). */
export const DEVICE_COLORS = {
  um982:    '#4dd0e1',
  um981:    '#9b7bff',
  um981raw: '#ffd166',
  um981ins: '#4dd0e1',
}

/** Human-readable labels for the per-lap `mode` field in manifests. */
export const MODE_LABELS = {
  standard:                'Standard',
  compare_projected_um981: 'Projected',
  compare_projected_raw:   'Raw Projected',
}

/**
 * Chart series accent colours by channel name. The line stroke uses the
 * per-lap colour from `LAP_COLOR_PALETTE`, but the area-fill green-vs-red
 * gradient on the delta chart uses these — same green = "ahead" / red =
 * "behind" semantics the trajectory phase colours use.
 */
export const CHART_COLORS = {
  tps:           '#4caf50',
  brake:         '#f44336',
  rpm:           '#42a5f5',
  speed:         '#42a5f5',           // GPS speed shares the blue slot with RPM
  steer:         '#ffb74d',
  delta_faster:  '#4caf50',
  delta_slower:  '#f44336',
  playhead:      '#ffffff',
  grid:          'rgba(255,255,255,0.06)',
}


// ─── Chart pointer-interaction thresholds ────────────────────────────────
// Centralised so click-feel can be tuned without grep'ing the gesture
// handler (`hooks/useChartGestures.js`).
/** Mouse-move radius (px) below which the gesture is treated as a click. */
export const CHART_CLICK_PX = 4
/** Distance (px) to the playhead column counted as "grab" → scrub mode. */
export const CHART_HANDLE_HIT_PX = 10
/** Drag width (seconds) below which a zoom intent is rejected as accidental. */
export const CHART_MIN_ZOOM_DRAG_S = 0.05

/**
 * Class name for the playhead overlay div the rAF loop positions. Used
 * by both the React component that renders it and the hook that updates
 * its `style.left`. Kept here so renaming touches one place.
 */
export const PLAYHEAD_OVERLAY_CLASS = 'chart-playhead-overlay'
/** Class name for the delta-target overlay div (second vertical line
 *  that appears only while delta mode is active). Mirrors the playhead
 *  pattern — DOM div positioned via rAF rather than an ECharts markLine
 *  so we stay off the chart's setOption hot path. */
export const DELTA_TARGET_OVERLAY_CLASS = 'chart-delta-target-overlay'
/** Class name for the lighter band drawn BETWEEN the playhead (ref)
 *  and the delta target. Visualises the "delta window" so the user can
 *  see at a glance how wide the comparison span is. */
export const DELTA_WINDOW_OVERLAY_CLASS = 'chart-delta-window-overlay'


// ─── Recording (MediaRecorder, canvas.captureStream) ─────────────────────
/** Frame rate at which the 3D canvas is captured during /assets/ recording. */
export const RECORDING_FPS = 30
/** Encoder bitrate (bits/sec). 8 Mbps ≈ visually lossless 1080p WebM/VP9. */
export const RECORDING_BITRATE = 8_000_000
