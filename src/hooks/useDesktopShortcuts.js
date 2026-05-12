import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * Keyboard shortcuts for the desktop layout. Replaces the buttons that
 * used to live in the left HUD (play / rec / camera / follow /
 * compare / corner analysis / speed) — those toggles now have no
 * visible chrome on desktop, and the keyboard is the canonical input.
 *
 * Shortcut table:
 *
 *   space    play / pause                (already in useAppInit; we
 *                                         keep it there because
 *                                         mobile + VR want it too)
 *   r        toggle screen recording
 *   c        cycle camera mode           (chase → hood → side → top → free → chase)
 *   f        cycle focus lap             (next visible lap; wraps)
 *   t        toggle compare mode         (time ↔ position)
 *   n        toggle corner-analysis mode
 *   1..4     playback speed              (0.25 / 0.5 / 1 / 2 ×)
 *   s        toggle sessions drawer
 *   ?  /  h  toggle shortcuts help overlay
 *   esc      close shortcuts help if open
 *
 * All handlers bail out when the user is typing in an input /
 * textarea / contenteditable element and when modifier keys (ctrl /
 * alt / meta) are held — except for `?` which is shift-`/` and we
 * pass through.
 *
 * The shortcuts are wired here as a single window-level keydown
 * listener; reusing one listener avoids the overhead of registering
 * a separate listener per shortcut.
 */

const CAMERA_MODES = ['chase', 'hood', 'side', 'top', 'free']
const SPEED_KEYS = { '1': 0.25, '2': 0.5, '3': 1, '4': 2 }

const isTextField = (el) =>
  !!el && (
    el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || el.isContentEditable
  )

export function useDesktopShortcuts({
  onToggleSessions,
  onToggleHelp,
  onCloseHelp,
  toggleRecording,
}) {
  useEffect(() => {
    const onKey = (e) => {
      // Skip modifier combos (ctrl-c etc.) — the shortcuts here are
      // single-key. Shift is allowed for `?` (= shift-`/`).
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTextField(e.target)) return
      if (e.repeat) return

      const key = e.key.toLowerCase()

      // Help overlay: `?` (shift-`/`) or plain `h` toggles; `Escape`
      // closes when open.
      if (e.key === '?') {
        e.preventDefault()
        onToggleHelp?.()
        return
      }
      if (key === 'escape') {
        onCloseHelp?.()
        return
      }
      if (key === 'h') {
        e.preventDefault()
        onToggleHelp?.()
        return
      }
      if (key === 's') {
        e.preventDefault()
        onToggleSessions?.()
        return
      }
      if (key === 'r') {
        e.preventDefault()
        toggleRecording?.()
        return
      }
      if (key === 'c') {
        e.preventDefault()
        const cur = useStore.getState().cameraMode
        const i = CAMERA_MODES.indexOf(cur)
        useStore.getState().setCameraMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
        return
      }
      if (key === 'f') {
        e.preventDefault()
        const s = useStore.getState()
        const lapIds = s.laps
          .filter((l) => s.visibility[l.id] !== false)
          .map((l) => l.id)
        if (!lapIds.length) return
        const i = lapIds.indexOf(s.focusLapId)
        s.setFocusLapId(lapIds[(i + 1) % lapIds.length])
        return
      }
      if (key === 't') {
        e.preventDefault()
        useStore.getState().setCompareMode((m) => (m === 'time' ? 'position' : 'time'))
        return
      }
      if (key === 'n') {
        e.preventDefault()
        useStore.getState().setCornerAnalysisMode((v) => !v)
        return
      }
      if (SPEED_KEYS[e.key] != null) {
        e.preventDefault()
        useStore.getState().setSpeed(SPEED_KEYS[e.key])
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleSessions, onToggleHelp, onCloseHelp, toggleRecording])
}

/**
 * Static metadata for the help overlay. Sourced from the same
 * constants the listener above uses to keep them in lock-step.
 */
export const DESKTOP_SHORTCUTS = [
  { keys: ['Space'],       label: 'Play / pause' },
  { keys: ['R'],           label: 'Toggle recording' },
  { keys: ['C'],           label: 'Cycle camera mode' },
  { keys: ['F'],           label: 'Cycle focus lap' },
  { keys: ['T'],           label: 'Toggle compare mode (time / position)' },
  { keys: ['N'],           label: 'Toggle corner analysis' },
  { keys: ['1', '2', '3', '4'], label: 'Playback speed (0.25× / 0.5× / 1× / 2×)' },
  { keys: ['S'],           label: 'Open / close sessions drawer' },
  { keys: ['?', 'H'],      label: 'This shortcut list' },
  { keys: ['Esc'],         label: 'Close help' },
]
