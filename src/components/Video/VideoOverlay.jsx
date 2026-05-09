import React, { useEffect, useRef, useState } from 'react'
import { IS_MOBILE } from '../../utils/platform'
import { assetUrl } from '../../config'
import { useStore } from '../../state/store'

const VIDEO_DRIFT_TOLERANCE_S = 0.08

/**
 * Picture-in-picture HTML5 video overlay synced to the lap playhead.
 * Activates only on the `/video` route. See README for details.
 *
 * Subscribes to `playhead` / `playheadRef` from the store INTERNALLY so
 * the parent (App) doesn't have to. This keeps the 15 Hz playhead state
 * push from causing App to re-render (and reconcile its whole subtree).
 */
export function VideoOverlay({ visible, lap, playing, speed, sectorStartTime, onClose }) {
  const currentTime = useStore((s) => s.playhead)
  const currentTimeRef = useStore((s) => s.playheadRef)
  const videoRef = useRef(null)
  const [muted, setMuted] = useState(true)
  const [size, setSize] = useState('normal')
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('loading')

  const audioCtxRef = useRef(null)
  const audioGainRef = useRef(null)
  const audioBufferRef = useRef(null)
  const audioSourceRef = useRef(null)
  const audioStartCtxTimeRef = useRef(0)
  const audioStartOffsetRef = useRef(0)
  const [audioReady, setAudioReady] = useState(false)

  const useMobileVariants = IS_MOBILE && lap?.video_path_mobile
  const preferredPath = useMobileVariants ? lap.video_path_mobile : lap?.video_path
  const videoSrc = preferredPath ? assetUrl(preferredPath) : null
  const audioSrc = (useMobileVariants && lap?.audio_path_mobile)
    ? assetUrl(lap.audio_path_mobile)
    : null
  const videoStartSec = Number(lap?.video_lap_start_sec ?? 0)

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return null
      audioCtxRef.current = new Ctor()
      audioGainRef.current = audioCtxRef.current.createGain()
      audioGainRef.current.gain.value = muted ? 0 : 1
      audioGainRef.current.connect(audioCtxRef.current.destination)
    }
    return audioCtxRef.current
  }
  const stopAudio = () => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop() } catch {}
      try { audioSourceRef.current.disconnect() } catch {}
      audioSourceRef.current = null
    }
  }
  const startAudioAt = (offsetSec, rate) => {
    const ctx = audioCtxRef.current
    const buffer = audioBufferRef.current
    const gain = audioGainRef.current
    if (!ctx || !buffer || !gain) return
    stopAudio()
    const safeOffset = Math.max(0, Math.min(offsetSec, buffer.duration - 0.01))
    if (safeOffset >= buffer.duration) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = rate
    src.connect(gain)
    src.start(0, safeOffset)
    audioSourceRef.current = src
    audioStartCtxTimeRef.current = ctx.currentTime
    audioStartOffsetRef.current = safeOffset
  }
  const getAudioPosition = () => {
    const ctx = audioCtxRef.current
    const src = audioSourceRef.current
    if (!ctx || !src) return null
    const elapsedReal = ctx.currentTime - audioStartCtxTimeRef.current
    const elapsedAudio = elapsedReal * src.playbackRate.value
    return audioStartOffsetRef.current + elapsedAudio
  }

  useEffect(() => {
    if (playing) return
    const target = currentTime + videoStartSec
    const v = videoRef.current
    if (v && videoSrc && Math.abs(v.currentTime - target) > VIDEO_DRIFT_TOLERANCE_S) {
      try { v.currentTime = Math.max(0, target) } catch {}
    }
  }, [currentTime, videoSrc, videoStartSec, playing])

  useEffect(() => {
    if (sectorStartTime == null) return
    const target = sectorStartTime + videoStartSec
    const v = videoRef.current
    if (v && videoSrc) { try { v.currentTime = Math.max(0, target) } catch {} }
    if (playing && speed <= 1.0 && audioSrc && audioReady) {
      startAudioAt(target, Math.min(speed, 1.0))
    }
  }, [sectorStartTime, videoSrc, audioSrc, audioReady, videoStartSec, playing, speed])

  useEffect(() => {
    const v = videoRef.current
    const rate = Math.min(speed, 1.0)
    const shouldPlay = playing && speed <= 1.0
    if (v && videoSrc) {
      v.playbackRate = rate
      if (shouldPlay) v.play().catch(() => {})
      else v.pause()
    }
    const ctx = audioCtxRef.current
    if (ctx && ctx.state === 'suspended' && shouldPlay) {
      ctx.resume().catch(() => {})
    }
    if (audioSrc && audioReady) {
      if (shouldPlay) {
        const offset = (currentTimeRef?.current ?? 0) + videoStartSec
        startAudioAt(offset, rate)
      } else {
        stopAudio()
      }
    }
  }, [playing, speed, videoSrc, audioSrc, audioReady, currentTimeRef, videoStartSec])

  useEffect(() => {
    if (!playing || (!videoSrc && !audioSrc)) return undefined
    const id = setInterval(() => {
      const liveT = (currentTimeRef?.current ?? 0) + videoStartSec
      const v = videoRef.current
      if (v && videoSrc && Math.abs(v.currentTime - liveT) > 0.4) {
        try { v.currentTime = Math.max(0, liveT) } catch {}
      }
      const audioPos = getAudioPosition()
      if (audioPos != null) {
        if (v && videoSrc) {
          const drift = audioPos - v.currentTime
          if (Math.abs(drift) > 0.2) {
            startAudioAt(v.currentTime, Math.min(speed, 1.0))
          }
        } else if (Math.abs(audioPos - liveT) > 0.4) {
          startAudioAt(liveT, Math.min(speed, 1.0))
        }
      }
    }, 500)
    return () => clearInterval(id)
  }, [playing, videoSrc, audioSrc, currentTimeRef, videoStartSec, speed])

  useEffect(() => {
    if (audioGainRef.current) {
      audioGainRef.current.gain.value = muted ? 0 : 1
    }
  }, [muted])

  useEffect(() => {
    setStatus('loading')
    setError(null)
  }, [videoSrc])

  useEffect(() => {
    if (!audioSrc) {
      audioBufferRef.current = null
      setAudioReady(false)
      return undefined
    }
    let cancelled = false
    const ctx = ensureAudioCtx()
    if (!ctx) return undefined
    fetch(audioSrc, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(`audio fetch ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        if (cancelled) return
        audioBufferRef.current = decoded
        setAudioReady(true)
      })
      .catch((e) => {
        console.warn('Audio decode failed', e)
        if (!cancelled) setAudioReady(false)
      })
    return () => {
      cancelled = true
      stopAudio()
      audioBufferRef.current = null
      setAudioReady(false)
    }
  }, [audioSrc])

  useEffect(() => {
    return () => {
      stopAudio()
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close() } catch {}
        audioCtxRef.current = null
        audioGainRef.current = null
      }
    }
  }, [])

  if (!videoSrc) return null
  const videoMuted = audioSrc ? true : muted
  return (
    <div className={`video-overlay video-overlay-${size}${visible ? '' : ' video-overlay-hidden'}`}>
      <video
        ref={videoRef}
        src={videoSrc}
        muted={videoMuted}
        playsInline
        preload="metadata"
        className="video-overlay-element"
        onLoadedMetadata={() => setStatus('ready')}
        onCanPlay={() => setStatus('ready')}
        onWaiting={() => setStatus('loading')}
        onSeeking={() => setStatus('seeking')}
        onSeeked={() => setStatus('ready')}
        onError={() => { setError('Video failed to load'); setStatus('error') }}
      />
      {(status === 'loading' || status === 'seeking') && !error && (
        <div className="video-overlay-spinner" aria-label={status}>
          <div className="video-overlay-spinner-dot" />
        </div>
      )}
      {error && <div className="video-overlay-error">{error}</div>}
      <div className="video-overlay-controls">
        <button onClick={() => setMuted(m => !m)} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? '🔇' : '🔊'}
        </button>
        <button onClick={() => setSize(s => s === 'normal' ? 'large' : 'normal')} title={size === 'normal' ? 'Enlarge' : 'Shrink'} aria-label={size === 'normal' ? 'Enlarge video' : 'Shrink video'}>
          {size === 'normal' ? '+' : '−'}
        </button>
        <button onClick={onClose} title="Hide video">✕</button>
      </div>
      {lap?.video_label && <div className="video-overlay-label">{lap.video_label}</div>}
    </div>
  )
}

/**
 * Panel adapter — pulls all VideoOverlay props from the store.
 * `playhead` / `playheadRef` are NOT passed: VideoOverlay subscribes to
 * those itself so the 15 Hz tick stays inside this leaf component.
 */
export function VideoPanel() {
  const laps          = useStore((s) => s.laps)
  const focusLapId    = useStore((s) => s.focusLapId)
  const playing       = useStore((s) => s.playing)
  const speed         = useStore((s) => s.speed)
  const sectorStartTime = useStore((s) => s.sectorStartTime)
  const setVideoOverlayOn = useStore((s) => s.setVideoOverlayOn)
  const lap = laps.find((l) => l.id === focusLapId) ?? laps.find((l) => l.video_path) ?? null
  if (!lap?.video_path) return <div className="panel-empty">No video for this lap</div>
  return (
    <VideoOverlay
      visible={true}
      lap={lap}
      playing={playing}
      speed={speed}
      sectorStartTime={sectorStartTime}
      onClose={() => setVideoOverlayOn(false)}
    />
  )
}
