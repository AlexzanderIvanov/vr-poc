import { useMemo } from 'react'
import { useStore } from '../state/store'
import { LAP_COLOR_PALETTE } from '../constants'

/**
 * Per-lap presentation-colour pipe.
 *
 * Resolution order:
 *
 *   1. `state.lapColors[lapId]` — user override (future colour picker)
 *   2. `LAP_COLOR_PALETTE[lapIndex % palette.length]` — predefined slot
 *      (lap 0 → blue, lap 1 → red, …)
 *   3. `LAP_COLOR_PALETTE[0]` — final fallback for an unknown lap
 *
 * Every visualisation surface (3D trajectory line, car model tint, car
 * dot, corner-apex flag posts, chart series, HUD swatches, mobile cards)
 * resolves its colour through this single accessor. Changing a lap's
 * colour — manually via the store action or through a future picker —
 * propagates to every subscriber on the next render via Zustand's
 * selector subscription.
 *
 * Reactive variants (`useLapColor*`) re-render the calling component when
 * the resolved colour changes. Non-reactive variants (`resolveLapColor*`)
 * take an explicit store-state snapshot and are safe to use inside
 * `useMemo` dependency arrays / `useFrame` hot loops — the caller is
 * responsible for re-running when `lapColors` or `laps` changes.
 *
 * `lap.color` baked into the manifest JSON is intentionally NOT consulted
 * here. Colours are presentation, not data; they live on the store and
 * the user owns them.
 */

// ---- non-reactive (read state snapshot once) -------------------------------

export function resolveLapColor(state, lapId) {
  if (!lapId) return LAP_COLOR_PALETTE[0]
  const override = state.lapColors?.[lapId]
  if (override) return override
  const idx = state.laps.findIndex((l) => l.id === lapId)
  return paletteColor(idx)
}

export function resolveLapColorByIndex(state, lapIndex) {
  const lap = state.laps[lapIndex]
  if (lap) {
    const override = state.lapColors?.[lap.id]
    if (override) return override
  }
  return paletteColor(lapIndex)
}

function paletteColor(idx) {
  if (!Number.isFinite(idx) || idx < 0) return LAP_COLOR_PALETTE[0]
  return LAP_COLOR_PALETTE[idx % LAP_COLOR_PALETTE.length] ?? LAP_COLOR_PALETTE[0]
}

// ---- reactive (Zustand selector) ------------------------------------------

/** Live colour for a single lap. Use this in render bodies. */
export function useLapColor(lapId) {
  return useStore((s) => resolveLapColor(s, lapId))
}

/** Live colour for a lap by its index in `state.laps`. */
export function useLapColorByIndex(lapIndex) {
  return useStore((s) => resolveLapColorByIndex(s, lapIndex))
}

/**
 * Build an `{ [lapId]: colour }` map for ALL current laps. Useful for
 * components that loop over many laps (chart series, lap-row swatches)
 * — saves N selector subscriptions in favour of one.
 *
 * Two-step subscription + `useMemo` avoids the "returns new object each
 * call" trap that would force a render on every unrelated store change.
 */
export function useLapColorMap() {
  const laps = useStore((s) => s.laps)
  const lapColors = useStore((s) => s.lapColors)
  return useMemo(() => {
    const out = {}
    for (let i = 0; i < laps.length; i++) {
      const lap = laps[i]
      out[lap.id] = lapColors[lap.id] ?? paletteColor(i)
    }
    return out
  }, [laps, lapColors])
}
