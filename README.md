# Virtualization Web POC

Single-page React app that plays back recorded car-telemetry laps on a 3D model
of A1 Motor Park. Two laps run side-by-side at any time: a reference and a
ghost, with synchronised cameras, live telemetry HUDs, lap-delta charts,
sector analysis, corner key-point markers and start/finish jumps.

## Routes

The app is a single React build; the URL path picks which lap pair to load.

| Path | Reference | Ghost |
| --- | --- | --- |
| `/` | UM982 session 2952670682 lap 3 | UM982 session 2998794026 lap 4 |
| `/slow-and-slower` | UM982 session 2952670682 lap 3 | RaceBox 04-04-2026 16:24 lap 9 (117.4 s, fastest of session) |
| `/slow-vs-master` | UM982 session 2952670682 lap 3 | RaceBox 04-04-2026 16:00 lap 4 (110.7 s, master) |
| `/video` | UM982 session 2952670682 lap 3 + cockpit video | UM982 session 2998794026 lap 4 + cockpit video |

Routing is path-string based — no `react-router`. `src/App.jsx` reads
`window.location.pathname` once at mount and picks a manifest from a small map.

## Stack

| Concern | Library | Why |
| --- | --- | --- |
| UI | **React 18** | Function components + hooks. |
| Bundler / dev server | **Vite 5** | Fast HMR. |
| 3D rendering | **three.js 0.177** | WebGL renderer. |
| 3D React glue | **@react-three/fiber 8** | JSX wrapper for three.js (`<Canvas>`, `useFrame`, …). |
| 3D helpers | **@react-three/drei 9** | `PerspectiveCamera`, `OrbitControls`, `Environment`, `Html`, `Line`, `useGLTF`, `useProgress`. |
| Asset format | **glTF 2.0 (GLB)** + **Draco** | Loaded via `useGLTF`. Track is ~73 MB Draco-compressed. |
| Texture format | **DDS** (mipmapped, BC) for normal maps + **JPG** for albedo | DDS via three.js's bundled `DDSLoader`. |

Five runtime deps. Math (Catmull-Rom, slerp, exponential low-pass, ICP-style
nearest-segment search) is hand-rolled in plain JS + `Float32Array`.

## Source layout

```
virtualizationWebPoc/
├─ index.html            # one root div + Open Graph meta
├─ deploy.bat            # build + scp to race-ai EC2 (Windows)
├─ package.json
├─ vite.config.js
├─ src/
│   ├─ main.jsx          # ReactDOM bootstrap + on-screen crash overlay
│   │                      (catches uncaught errors and WebGL context-loss
│   │                       so mobile crashes show their cause on screen)
│   ├─ App.jsx           # ~2.4 kLOC — every component + state lives here
│   ├─ styles.css
│   ├─ constants.js      # FPS, smoothing constants, colour palette
│   ├─ trackOrthophotoGroups.js   # mesh-name → orthophoto bucket
│   ├─ trackRedMeshes.js # 62 names of AC red-painted run-off meshes
│   ├─ utils/
│   │   └─ cornerAnalysis.js   # brake / throttle / apex / arc-length math
│   └─ hooks/
│       └─ usePlayback.js      # RAF clock with throttled UI state updates
└─ public/
    └─ assets/
        ├─ models/       # track.glb (~73 MB), m3_e46_steerable.glb
        ├─ textures/     # asphalt JPG/DDS, kerb, barrier, fence, etc.
        └─ laps/         # manifest*.json + per-lap *.json + *_telemetry.json
```

## Where the assets come from

The web app is the **output side** of a longer pipeline that lives in
`Tracks3dScan/` (a separate Python project). By the time JSON reaches the
browser, every position is already in Blender-scene XYZ ready for `<Canvas>` —
no GPS / geodetic math runs in the browser.

1. **Track** — `KS_A1_Motor_Park` from Assetto Corsa imported into Blender,
   mesh-filtered, and exported as `track.glb` (Draco, Y-up, 1038 meshes).
2. **Car** — BMW E46 from a rigged Blender scene with separated front-wheel
   objects → `m3_e46_steerable.glb`.
3. **Lap data** — recorded GPS+IMU+CAN telemetry from a UM982 / UM981 / RaceBox.
   Pulled from ClickHouse (or CSV for RaceBox) by Python in `rtkDbData/` and
   transformed into Blender-scene coords by the `Tracks3dScan/claude/`
   pipeline (Kabsch-ICP / map-mask grid-search global fit + per-device
   profile + per-device offsets). Output: per-lap `*.json`.
4. **Manifest** — `manifest*.json` lists which laps belong to a route, their
   colours, sync offsets, and links to optional CAN-telemetry sidecars.

## Runtime architecture

```
App (state)
├─ usePlayback(...)
│    └─ requestAnimationFrame loop
│        ├─ ref every frame  → currentTimeRef.current   (60 Hz, hot path)
│        └─ React state ~15 Hz → currentTime            (UI numbers / charts)
│
├─ <hud> (left side panel, scrubber + controls + lap list + sync sliders)
│
├─ <Viewer>
│   └─ <Canvas dpr={…} shadows={…} gl={…}>
│       ├─ <PerspectiveCamera> seeded from the first GPS sample
│       ├─ <CameraRig>     chase / hood / side / top / free
│       ├─ Lighting        directional + hemisphere + Environment "park"
│       ├─ <TrackScenery>, <TrackModel>, <Trajectory>×N (racing-line poly)
│       ├─ <CarEntity>×2   useGLTF clone, useFrame samples lap @ liveTime
│       ├─ <TrackMarkers>  paired brake-zone diamonds (per-lap colors)
│       └─ <CornerMarkers> brake/throttle/apex dots + Δ-metres badges
│
├─ <CornerAnalysisPanel> (desktop right-side overlay)
└─ <MobileTelemetryCards> (top-of-screen TPS/BRK/RPM cards on mobile)
```

### Two-tier playback clock

`hooks/usePlayback.js` maintains both:

* `currentTimeRef.current` — updated on every RAF tick and read inside
  `useFrame` so 3D state moves at the display's full refresh rate.
* `currentTime` (React state) — updated at ~15 Hz only. Drives chart
  playheads, scrubber labels and HUD numerics.

This eliminates the per-frame React re-render cascade across `CarEntity`,
`TelemetryPanel`, `DeltaChart`, `MobileTelemetryCards` — the biggest single
contributor to subjective jitter on mobile.

External edits (scrubber drag, sector jump) write through a wrapper that
mirrors the value into both ref and state synchronously.

### 3D rendering — what each frame does

1. `CarEntity.useFrame` reads `liveTime = currentTimeRef.current + lapOffset`
   (or, in *Position* compare-mode, derives it from a polyline lookup keyed on
   the ref car's current scene XY).
2. `sampleLap(samples, t)` does a binary search and **Catmull-Rom cubic**
   interpolation for position, plus component-wise interpolation +
   hemisphere alignment + renormalisation for the quaternion (smooth pose
   between sample boundaries).
3. `applySyncOffset(...)` shifts the sample by the live forward / left / up /
   yaw deltas (live-tunable from the side panel sliders).
4. **Exponential low-pass filter** (`fc ≈ 8 Hz`) on both position and
   quaternion smooths the residual jitter from the 20 Hz source data.
5. Front wheels rotate by CAN-bus steering / `STEERING_RATIO`.
6. A small ref-mutation scales the floating HUD card based on camera distance
   so it doesn't overwhelm the viewport in tight zooms.

### Camera

`CameraRig.useFrame` lerps both `camera.position` and a stored
`smoothedLookAtRef` toward the desired chase / hood / side / top vantage
with `α = 1 − exp(−delta · 14)` (≈ 2.2 Hz cutoff). Sector clicks fire
one-shot snaps via a counter ref and reset the smoothed look-at so there's no
swoop.

### Comparison modes

Toggle in the side panel ("Compare: Time/Position"; mobile button labelled
`T` / `P`):

* **Time** (default) — both cars driven by the same playhead clock. If one
  driver is faster, that car is further down the track.
* **Position** — ghost's clock is derived from the ref's current physical
  position. Each frame, ref's scene XY is computed; the ghost lap's polyline
  (precomputed `Float32Array` with last-match-index hint + point-on-segment
  projection) is searched for the time `t` at which the ghost was at that
  point. Cars overlap on track; at-the-spot telemetry diff becomes the focus.

### Corner analysis

Toggle next to the compare mode. Computes per-corner data once (`useMemo`)
from each lap's telemetry JSON (`utils/cornerAnalysis.js::computeCornerAnalysis`):

* brake-start / brake-end key-points (from `telemetry.phases[]` of type
  `braking`)
* throttle-on (first sample after brake_end where `tps >= 50`)
* full-throttle (from the `full_throttle_on` event)
* geometric apex (peak path curvature `k = Δθ / Δs` along the trajectory)
* speed apex (lap sample with minimum ground-plane speed in the corner window)
* oscillation count — TPS dip-then-rise cycles between throttle-on and full
  throttle (counts corner-exit hesitation)
* `brakingDistanceM` and `arcToBrakeStartM` for distance comparisons

Renders four coloured dots + two apex rings per corner per lap on the 3D
track, with `BRK Δ`, `FT Δ`, `GA Δ`, `SA Δ` and `±kph` badges between paired
keypoints. The desktop side panel lists totals (lap distance), per-sector
arc lengths and per-corner stats with a legend explaining every marker.

### Mobile

UA-detected `IS_MOBILE` flag (`?mobile=1` to force) gates several things:

* `<Canvas>` props: `shadows={false}`, `dpr={[1, 2]}`, `preserveDrawingBuffer:false`.
* Track model strips ~918 of 1038 meshes — only road / kerb / grass /
  markings / `RED_TRACK_MESHES` remain visible. Hidden geometries are
  disposed to free GPU memory.
* Texture stack drops to just the asphalt PBR set (~12 MB) instead of the
  ~65 MB desktop set.
* Layout: side hud → bottom-sheet drawer behind a hamburger button. Bottom
  of screen always shows a full-width playback scrubber. Two top-of-screen
  telemetry cards (`MobileTelemetryCards`) replace the desktop `<Html>` HUDs
  above each car.

### Lap video overlay (`/video` route)

A picture-in-picture HTML5 `<video>` overlay that plays cockpit footage in
sync with the 3D playhead. Activates only when the loaded manifest carries
`video_path` per lap — currently just the `/video` route.

Sync model is the same two-tier clock that drives `CarEntity`:

* User edits (scrubber drag, sector jump) → `useEffect` on the throttled
  React state (`currentTime`, `sectorStartTime`) writes
  `video.currentTime = playhead + lap.video_lap_start_sec`.
* Continuous playback → `video.play() / pause() / playbackRate` mirror
  `playing` and `speed`.
* Drift watchdog → 1 Hz `setInterval` reads `currentTimeRef` (60 Hz live
  clock) and re-snaps if the video and the playhead diverge by more than
  ~160 ms (decoder drift on slow mobile).

Manifest schema additions, per-lap:

```json
{
  "video_path": "/assets/videos/um982_2952670682_lap3.mp4?v=1777144131",
  "video_lap_start_sec": 0.0,
  "video_label": "Cockpit cam — lap 3"
}
```

`video_lap_start_sec` is the offset within the file at which the lap
actually begins (start/finish line crossing). The player adds it to the
playhead before each seek, so the 3D animation and video stay frame-aligned.

#### Asset delivery

Videos sit under `public/assets/videos/` and stream through the **same Bunny
CDN pull zone** as everything else (`vr-raceai-me-poc.b-cdn.net`). The CDN
mirrors that tree on first access, then serves from the edge. No separate
"Bunny Stream" library — that product is a managed video platform (auto
HLS transcode + iframe player) and would add an iframe + Player.js
postMessage layer between us and `currentTime`. The native `<video>` element
is simpler for frame-precise sync, and we can promote to Bunny Stream later
by swapping just the `video_path` URL if mobile bandwidth becomes an issue.

**One pre-processing caveat**: source MP4s should be re-muxed with
`-movflags +faststart` so the moov atom is at the file start. Without it,
mobile Safari downloads the entire file before allowing a seek. A 720p
re-encode also halves the file size:

```
ffmpeg -i input.mp4 -c:v libx264 -preset fast -crf 23 -vf scale=-2:720 \
       -c:a aac -b:a 96k -movflags +faststart output.mp4
```

The 149 MB sources currently in `public/assets/videos/` are committable
as-is for the POC but should be re-muxed before any mobile audience uses
them at scale.

### Crash overlay

`src/main.jsx` registers handlers for `error`, `unhandledrejection` and
`webglcontextlost`. Any of those triggers a full-screen red overlay with the
error message and stack — invaluable for debugging mobile-tab failures where
the console isn't visible.

## Build / deploy

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server on `localhost:5173`. SPA fallback handles deep links. |
| `npm run build` | Builds `dist/` — ~1.2 MB JS, 14 KB CSS, 280 MB of `assets/` (textures + GLBs + lap JSON). |
| `.\deploy.bat` | (Windows) `npm run build` → `ssh race-ai 'rm -rf .../dist'` → `scp -rCp dist race-ai:/home/ec2-user/virtualizationPoc/`. Production is served by nginx with SPA fallback. |

The bundler emits one chunk; size is dominated by three.js + drei. Gzipped
JS is ~340 kB.

## Performance notes

* 60 FPS desktop, 30–60 FPS mobile after the mesh-stripping pass.
* Per-frame allocation on the hot path: ~2 `Vector3` + 1 `Quaternion` per car.
  Smoothed-ref filter mutates in place. Generational GC handles this fine.
* Total RAM: ~700 MB on mobile in long sessions (track mesh + textures +
  Draco-decoded buffers + cars). Roughly half that on the stripped-mesh
  mobile path.
* Biggest perf-impacting recent fixes:
  - Two-tier clock (above) — eliminated the 60 Hz React re-render cascade.
  - Camera smoothing constant raised from `k=5` to `k=14` (~0.8 Hz → ~2.2 Hz cutoff) and applied to lookAt as well as position.

## Conventions

* All hot-path 3D mutation is via refs — no `setState` per frame.
* Scene coords come from the JSON pre-baked. Sync sliders apply on top via
  `applySyncOffset` per-frame so the user can fine-tune without re-exporting.
* `lap.id` is the join key for `laps[]`, `telemetryData[id]`, `syncOffsets[id]`,
  and the position-mode polyline lookup.
* Coords inside `samples[i].position` are `[x, y, z]` in **web Y-up**; the
  ground plane is `(x, z)`. `y` is altitude.
