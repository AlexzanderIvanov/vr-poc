import React, { useEffect, useRef, useState } from 'react'
import { IS_MOBILE } from '../../utils/platform'
import { assetUrl } from '../../config'
import { useStore } from '../../state/store'

/**
 * Reusable single-lap video tile, synced to a CALLER-PROVIDED time on the
 * lap's own clock (seconds since the lap-start moment in the recording).
 *
 * Separation of concerns vs the existing `<VideoOverlay>`:
 *   - `<VideoOverlay>` is the PIP-style cockpit cam pinned to the bottom
 *     of the viewport on the `/video` route. It owns layout chrome —
 *     resize button, close button, mute toggle, size toggle.
 *   - `<SingleLapVideo>` is the PANEL-shaped tile used inside a layout
 *     grid cell (side-by-side comparison view). It owns ONE concern:
 *     keep an HTML5 `<video>` element synced to `getLiveTimeSec()`, a
 *     callback that returns "what point in the lap to show right now".
 *
 * Sync model:
 *   - Caller decides the lap-time mapping. In `time` compare mode that's
 *     `playhead + lapTimeOffset`. In `position` compare mode that's the
 *     ghost's time-at-physical-position-of-ref. Same function the
 *     `<CarEntity>` uses for the 3D ghost car, just sampled on the
 *     throttled 15 Hz `playhead` state rather than per-RAF.
 *   - The lap's manifest entry tells us where lap-time t=0 lives inside
 *     the video file (`video_lap_start_sec`).
 *   - When playing AND the user hasn't manually scrubbed, we `play()`.
 *     When paused / scrubbing, we `pause()` and seek.
 *
 * Drift correction: every 500 ms while playing, compare the video's
 * own `currentTime` to the target; if drift > 0.4 s (could be GPU
 * stutter, decode lag, or coarse seek precision), force a re-seek.
 *
 * Audio: omitted in the side-by-side variant. Two cockpit cams playing
 * simultaneously would be acoustic mush; users mute one or the other.
 * The single-cam `<VideoOverlay>` keeps the audio path for /video.
 */

const VIDEO_DRIFT_TOLERANCE_S = 0.08

export function SingleLapVideo({
  lap,
  getLiveTimeSec,
  label,
  showTitle = true,
}) {
  const playing = useStore((s) => s.playing)
  const speed   = useStore((s) => s.speed)
  const playhead = useStore((s) => s.playhead)
  // Per-instance hot-path ref so the rAF drift-watcher inside the
  // playing loop reads the current target without going through React.
  const liveRef = useRef(getLiveTimeSec)
  liveRef.current = getLiveTimeSec

  const videoRef = useRef(null)
  const [muted, setMuted] = useState(true)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)

  // Manifest fields. Mobile gets the smaller transcode (mp4 + audio
  // out of band) when available; desktop sticks with the standard
  // muxed mp4 (audio inside the video).
  const useMobileVariants = IS_MOBILE && lap?.video_path_mobile
  const preferredPath = useMobileVariants ? lap.video_path_mobile : lap?.video_path
  const videoSrc = preferredPath ? assetUrl(preferredPath) : null
  const videoStartSec = Number(lap?.video_lap_start_sec ?? 0)

  // 1. Seek when the lap-time changes while paused (scrubbing). When
  //    playing we let the video roll on its own at `playbackRate` and
  //    only correct drift in (3) below — avoids the constant re-seek
  //    stutter on every 15 Hz playhead tick.
  //
  //    `getLiveTimeSec` is part of the dep list so a CHANGE IN THE CALLBACK
  //    ITSELF (e.g. `compareMode` flipping from 'time' to 'position', which
  //    rebuilds `liveTimeGhost` in `<VideoComparePanel>`) re-runs this
  //    effect and seeks to the freshly-computed lap-time. Without it the
  //    ghost video kept playing the old time-mode mapping until the next
  //    playhead tick — visible misalignment vs the 3D ghost car which
  //    reads the callback per RAF.
  useEffect(() => {
    if (playing) return
    const v = videoRef.current
    if (!v || !videoSrc) return
    const target = liveRef.current() + videoStartSec
    if (!Number.isFinite(target)) return
    if (Math.abs(v.currentTime - target) > VIDEO_DRIFT_TOLERANCE_S) {
      try { v.currentTime = Math.max(0, target) } catch {}
    }
  }, [playhead, playing, videoSrc, videoStartSec, getLiveTimeSec])

  // 1b. Force a re-seek whenever the lap-time MAPPING changes, even
  //     during playback. The seek-on-pause effect (1) bails when
  //     `playing` is true to avoid stuttering on every 15 Hz playhead
  //     tick — but a compareMode flip (time ↔ position) only changes
  //     the callback identity, not the playhead, so without this we'd
  //     coast for up to one drift-watcher cycle (~500 ms) before
  //     realigning. This effect fires exactly once per callback swap
  //     regardless of play state.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoSrc) return
    const target = getLiveTimeSec() + videoStartSec
    if (!Number.isFinite(target)) return
    if (Math.abs(v.currentTime - target) > VIDEO_DRIFT_TOLERANCE_S) {
      try { v.currentTime = Math.max(0, target) } catch {}
    }
  }, [getLiveTimeSec, videoSrc, videoStartSec])

  // 2. Play / pause + playbackRate. Mirrors the global playback clock.
  //    `speed > 1.0` falls back to pause-and-step: video <video> doesn't
  //    decode reliably above 1× on most laptops, so we let the rest of
  //    the app continue at the user-requested rate and freeze the video.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoSrc) return
    const rate = Math.min(speed, 1.0)
    v.playbackRate = rate
    if (playing && speed <= 1.0) v.play().catch(() => {})
    else v.pause()
  }, [playing, speed, videoSrc])

  // 3. Drift watcher while playing. The HTML5 video element decouples
  //    from our clock when the lap-time mapping jumps (sector click in
  //    position mode, manual scrub), so we periodically re-anchor.
  useEffect(() => {
    if (!playing || !videoSrc) return undefined
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v) return
      const target = liveRef.current() + videoStartSec
      if (!Number.isFinite(target)) return
      if (Math.abs(v.currentTime - target) > 0.4) {
        try { v.currentTime = Math.max(0, target) } catch {}
      }
    }, 500)
    return () => clearInterval(id)
  }, [playing, videoSrc, videoStartSec])

  // 4. Loading state reset on src change.
  useEffect(() => {
    setStatus('loading')
    setError(null)
  }, [videoSrc])

  if (!videoSrc) {
    return (
      <div className="single-lap-video single-lap-video-empty">
        <div className="panel-empty">No video for {lap?.label || 'lap'}</div>
      </div>
    )
  }

  return (
    <div className="single-lap-video">
      <video
        ref={videoRef}
        src={videoSrc}
        muted={muted}
        playsInline
        preload="metadata"
        className="single-lap-video-element"
        onLoadedMetadata={() => setStatus('ready')}
        onCanPlay={() => setStatus('ready')}
        onWaiting={() => setStatus('loading')}
        onSeeking={() => setStatus('seeking')}
        onSeeked={() => setStatus('ready')}
        onError={() => { setError('Video failed to load'); setStatus('error') }}
      />
      {(status === 'loading' || status === 'seeking') && !error && (
        <div className="single-lap-video-spinner" aria-label={status}>
          <div className="single-lap-video-spinner-dot" />
        </div>
      )}
      {error && <div className="single-lap-video-error">{error}</div>}
      {showTitle && (label || lap?.video_label || lap?.label) && (
        <div className="single-lap-video-label">{label || lap?.video_label || lap?.label}</div>
      )}
      <button
        type="button"
        className="single-lap-video-mute"
        onClick={() => setMuted((m) => !m)}
        title={muted ? 'Unmute' : 'Mute'}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
    </div>
  )
}
