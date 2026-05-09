import React, { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'

/**
 * Persistent playback bar shown above the bottom tab nav on mobile.
 *
 *   [▶/⏸] [scrubber ━━●━━] [mm:ss / mm:ss] [1x]
 *
 * Scrubber uses an HTML `<input type="range">`. Its `value` is driven by
 * the `playheadRef` hot-path ref via rAF (no React state), matching the
 * pattern used by the desktop `TimeScrubber` — keeps the bar smooth at
 * native frame rate without re-rendering the React tree.
 */
const SPEED_OPTIONS = [0.25, 0.5, 1, 2]

function fmtMMSS(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function MobilePlaybackBar() {
  const playing  = useStore((s) => s.playing)
  const speed    = useStore((s) => s.speed)
  const duration = useStore((s) => s.duration)
  const setPlaying = useStore((s) => s.setPlaying)
  const setSpeed   = useStore((s) => s.setSpeed)
  const setPlayhead = useStore((s) => s.setPlayhead)

  const inputRef = useRef(null)
  const timeRef = useRef(null)
  const draggingRef = useRef(false)

  // Drive the slider position from `playheadRef.current` via rAF — same
  // approach as the chart playhead overlay. Skip while the user is
  // actively dragging so the slider doesn't fight their input.
  useEffect(() => {
    if (duration <= 0) return undefined
    const playheadRef = useStore.getState().playheadRef
    let raf = 0
    let lastTxt = ''
    const tick = () => {
      const el = inputRef.current
      const t = playheadRef.current
      if (el && !draggingRef.current) {
        const next = String(t)
        if (el.value !== next) el.value = next
      }
      const lbl = `${fmtMMSS(t)} / ${fmtMMSS(duration)}`
      if (timeRef.current && lbl !== lastTxt) {
        timeRef.current.textContent = lbl
        lastTxt = lbl
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [duration])

  const onInput = (e) => {
    draggingRef.current = true
    const t = parseFloat(e.target.value)
    if (!isFinite(t)) return
    setPlayhead(t)
    useStore.getState().sectorEndRef.current = null
  }
  const onChange = (e) => {
    onInput(e)
    draggingRef.current = false
  }

  const cycleSpeed = () => {
    const i = SPEED_OPTIONS.indexOf(speed)
    setSpeed(SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length])
  }

  return (
    <div className="mobile-playback-bar">
      <button
        className="mobile-pb-btn"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => setPlaying((v) => !v)}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <input
        ref={inputRef}
        className="mobile-pb-scrubber"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        defaultValue={0}
        onInput={onInput}
        onChange={onChange}
        onPointerDown={() => { draggingRef.current = true }}
        onPointerUp={() => { draggingRef.current = false }}
        aria-label="Playhead"
      />
      <div className="mobile-pb-time" ref={timeRef}>0:00 / 0:00</div>
      <button
        className="mobile-pb-btn mobile-pb-speed"
        aria-label={`Speed ${speed}x — tap to cycle`}
        onClick={cycleSpeed}
      >
        {speed}x
      </button>
    </div>
  )
}
