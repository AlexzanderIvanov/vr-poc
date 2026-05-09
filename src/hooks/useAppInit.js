import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { DataService } from '../services/DataService'
import { makeBackend } from '../services/BackendAdapter'
import { usePlayback } from './usePlayback'
import { useViewportAutoFollow, usePanelResizeTracker } from './useEchartsTimeSync'
import {
  computeCornerAnalysis,
  pairCorners,
  addSectorArcLengths,
} from '../utils/cornerAnalysis'

/**
 * App-level data pipes — wires the data service, playback loop, viewport
 * auto-follow, panel-resize tracker, and the space-to-play keybinding.
 * Both `<DesktopApp>` and `<MobileApp>` mount this once at the platform
 * root so the underlying state machinery is identical across layouts.
 *
 * Returns `manifest` so the caller can early-bail with a loading screen.
 */
const dataService = new DataService(makeBackend())

export function useAppInit() {
  const setPlaying = useStore((s) => s.setPlaying)

  // Kick off data loading once. The service writes laps + telemetry into
  // the store; consumers re-render via `useStore` selectors.
  useEffect(() => {
    dataService.loadRoute(window.location.pathname).catch(console.error)
  }, [])

  // Hot-path playback loop (mutates `playheadRef.current` at RAF rate; emits
  // throttled `playhead` state at 15 Hz).
  usePlayback()
  // Auto-shift the chart viewport while playing to keep the playhead inside
  // the visible window.
  useViewportAutoFollow()
  // Track panel-resize drags via a `body.panel-resizing` latch so chart
  // gestures stay muted for the whole drag.
  usePanelResizeTracker()

  // Space = toggle play/pause (skip when focus is in an input).
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target
      if (
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
          || t.tagName === 'SELECT' || t.isContentEditable)
      ) return
      e.preventDefault()
      setPlaying((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPlaying])
}

/**
 * Canvas-stream recorder for the 3D viewer. Returns `{ recording, toggle }`
 * — desktop wires this to the "Rec" button. Mobile may omit the UI but
 * the hook itself is platform-agnostic; the only browser dependency is the
 * presence of a `.viewer-shell canvas` element in the DOM.
 */
export function useRecorder() {
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])

  const toggle = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    const canvas = document.querySelector('.viewer-shell canvas')
    if (!canvas) return
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm',
      videoBitsPerSecond: 8_000_000,
    })
    chunksRef.current = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lap-recording-${Date.now()}.webm`
      a.click()
      URL.revokeObjectURL(url)
      setRecording(false)
    }
    recorderRef.current = recorder
    recorder.start()
    setRecording(true)
  }, [recording])

  return { recording, toggle }
}

/**
 * Memoised corner-analysis data — used by the Corner Analysis side panel
 * (and any future mobile equivalent). Pure derivation of `laps + telemetry
 * + syncOffsets + deltaData`; returns `null` when the mode is off so the
 * caller can early-bail.
 */
export function useCornerAnalysisData() {
  const cornerAnalysisMode = useStore((s) => s.cornerAnalysisMode)
  const laps             = useStore((s) => s.laps)
  const telemetryData    = useStore((s) => s.telemetryData)
  const syncOffsets      = useStore((s) => s.syncOffsets)
  const deltaData        = useStore((s) => s.deltaData)

  return useMemo(() => {
    if (!cornerAnalysisMode) return null
    const refLap = laps[0]
    const ghostLap = laps[1]
    const refCorners = refLap
      ? computeCornerAnalysis(refLap, telemetryData[refLap.id], syncOffsets[refLap.id])
      : []
    const ghostCorners = ghostLap
      ? computeCornerAnalysis(ghostLap, telemetryData[ghostLap.id], syncOffsets[ghostLap.id])
      : []
    const pairs = pairCorners(refCorners, ghostCorners)
    const sectorsWithArc = deltaData?.sectors && refLap
      ? addSectorArcLengths(deltaData.sectors.map((s) => ({ ...s })), refLap)
      : []
    return { refCorners, ghostCorners, pairs, sectorsWithArc }
  }, [cornerAnalysisMode, laps, telemetryData, syncOffsets, deltaData])
}
