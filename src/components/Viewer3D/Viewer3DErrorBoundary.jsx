import React from 'react'

/**
 * Error boundary around the persistent 3D viewer.
 *
 * Why:
 *   The viewer's React subtree contains a `<Canvas>` from
 *   `@react-three/fiber`, and inside it `<Environment preset="park">`
 *   from `@react-three/drei`, which fetches an HDR file from drei's
 *   own CDN at runtime. That fetch is intermittently flaky (CORS race,
 *   network blip, CDN cold start) and when it throws, drei propagates
 *   the error past its own internal `ErrorBoundary` and React unmounts
 *   the ENTIRE app subtree above the Canvas. Without a boundary at the
 *   app-shell level the whole page goes blank — including the side
 *   panel, the charts, the playback bar — none of which depend on the
 *   3D viewer.
 *
 *   By wrapping `<PersistentViewer3D>` in this boundary we:
 *     - catch any Canvas-level throw (HDR fetch, GLB parse, WebGL
 *       context loss the global window listener didn't recover)
 *     - render a small "3D unavailable" placeholder where the viewer
 *       would be
 *     - let the rest of the app stay alive so the user can still
 *       interact with charts / playback / map / videos
 *
 * The boundary's state is internal — it does NOT touch the store, so
 * fallback rendering doesn't ripple through every subscriber. A
 * `Reload page` button is the only way to retry; refreshing is the
 * pragmatic recovery for these CDN-failure cases (drei caches the HDR
 * after a single success).
 */
export class Viewer3DErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Log to console rather than the global crash overlay — the crash
    // overlay (see main.jsx) is for unhandled / unrecoverable errors.
    // This one is recoverable; the rest of the app keeps working.

    console.warn('[Viewer3D] caught error, rendering fallback:', error?.message, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="viewer3d-fallback" role="alert">
          <div className="viewer3d-fallback-title">3D view unavailable</div>
          <div className="viewer3d-fallback-body">
            {String(this.state.error?.message || this.state.error || 'Unknown error')}
          </div>
          <button
            type="button"
            className="viewer3d-fallback-retry"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
