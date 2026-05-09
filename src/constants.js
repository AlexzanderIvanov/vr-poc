// Playback
export const FPS = 20
export const MAX_SECTOR_TIME_FOR_STOP = 999 // placeholder
export const SECTOR_LEAD_TIME = 3.0 // seconds before brake point where sector starts
export const MIN_SECTOR_TIME = 5.0 // merge sectors shorter than this

// Delta computation
export const DELTA_SAMPLE_STEP_M = 2 // distance step for delta point sampling

// Steering
export const STEER_VISUAL_GAIN = 1.5
export const SPIN_VISUAL_GAIN = 1.0
export const STEER_CURVATURE_WHEELBASE_M = 2.72
export const STEER_TELEMETRY_BLEND = 0.35
export const STEER_CENTER_STRAIGHT_SECONDS = 8 // use first N seconds as straight reference

// Camera
export const CAMERA_OFFSETS = {
  chase: { camera: [0, 2.4, -8.0], look: [0, 1.2, 10.0] },
  hood:  { camera: [0, 1.2,  1.7], look: [0, 1.1, 25.0] },
  top:   { camera: [0, 22.0, -0.1], look: [0, 0.0,  0.0] },
  side:  { camera: [8.0, 2.0, 0.0], look: [0.0, 1.0, 4.0] },
}
export const CAMERA_SMOOTHING_EXP = 5 // higher = tighter follow

// Telemetry thresholds
export const BRAKE_ON_THRESHOLD = 10
export const BRAKE_OFF_THRESHOLD = 5
export const TPS_FULL_THRESHOLD = 240
export const TPS_PAD_KNOCKBACK_THRESHOLD = 200 // above this, brake events are ignored
export const TRAIL_BRAKE_TPS_MIN = 50

// Corner-analysis thresholds (used by `utils/cornerAnalysis.js`).
// `TPS_FULL_THRESHOLD` above is the same concept as the legacy
// `FULL_THROTTLE_TPS` that lived here — kept under one name now.
export const THROTTLE_ON_TPS = 50
export const OSCILLATION_TPS_DIP = 25

// Analysis thresholds (race engineer tips)
export const BRAKE_DIFF_FRAMES_MIN = 2
export const BRAKE_PRESSURE_DIFF_MIN = 15
export const THROTTLE_PCT_DIFF_MIN = 8
export const COAST_FRAMES_DIFF_MIN = 5
export const TRAIL_FRAMES_MIN = 3
export const RPM_DIFF_MIN = 300

// Gamification scoring
export const SCORE_GRADES = [
  { threshold: 1500, grade: 'S' },
  { threshold: 1200, grade: 'A' },
  { threshold: 900,  grade: 'B' },
  { threshold: 600,  grade: 'C' },
  { threshold: 0,    grade: 'D' },
]

// Track marker match threshold
export const BRAKE_PAIR_MAX_DIST_M = 60

// Colors
export const PHASE_COLORS = {
  full_throttle: '#4caf50',
  braking: '#f44336',
  trail_braking: '#ff9800',
  coasting: '#607d8b',
}

export const PHASE_LABELS = {
  full_throttle: 'THROTTLE',
  braking: 'BRAKE',
  trail_braking: 'TRAIL',
  coasting: 'COAST',
}

export const DEVICE_COLORS = {
  um982: '#4dd0e1',
  um981: '#9b7bff',
  um981raw: '#ffd166',
  um981ins: '#4dd0e1',
}

export const MODE_LABELS = {
  standard: 'Standard',
  compare_projected_um981: 'Projected',
  compare_projected_raw: 'Raw Projected',
}

// Chart colors
export const CHART_COLORS = {
  tps: '#4caf50',
  brake: '#f44336',
  rpm: '#42a5f5',
  speed: '#42a5f5',           // GPS speed shares the blue slot with RPM
  steer: '#ffb74d',
  delta_faster: '#4caf50',
  delta_slower: '#f44336',
  playhead: '#ffffff',
  grid: 'rgba(255,255,255,0.06)',
}

// Chart pointer-interaction thresholds (consumed by useEchartsClickToSeek).
// These were inline magic numbers in the hook; centralised so click-feel
// can be tuned without grepping the gesture handler.
export const CHART_CLICK_PX        = 4   // mouse-move radius treated as a click
export const CHART_HANDLE_HIT_PX   = 10  // distance to the playhead column counted as "grab"
export const CHART_MIN_ZOOM_DRAG_S = 0.05 // hairline drags rejected as zoom intents

// Class name for the playhead overlay div the rAF loop positions. Used by
// both the React component that renders it and the hook that updates its
// `style.left`. Kept here so renaming touches one place.
export const PLAYHEAD_OVERLAY_CLASS = 'chart-playhead-overlay'

// Canvas dimensions
export const CANVAS_DIMS = {
  telemetry: { w: 400, h: 150 },
  delta:     { w: 400, h: 80 },
  trackMap:  { w: 280, h: 280 },
}

// Recording
export const RECORDING_FPS = 30
export const RECORDING_BITRATE = 8_000_000
