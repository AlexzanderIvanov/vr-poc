/**
 * Runtime asset URL profile.
 *
 * Two profiles, picked by hostname at boot:
 *
 *   - **localhost / .local / 127.0.0.1 / 0.0.0.0** — assets served from the
 *     same origin as the app (Vite dev server, or a local nginx). Useful so
 *     local development doesn't hit the CDN and so changes are visible
 *     immediately without waiting for a CDN cache bust.
 *
 *   - **everything else** — Bunny CDN: ``https://vr-raceai-me-poc.b-cdn.net``.
 *     Used by the deployed copy of the app on race-ai. The CDN mirrors the
 *     ``public/assets/`` tree (track / car GLBs, textures, lap JSONs).
 *
 * Manifest, models, textures and lap JSONs all run through the same profile
 * — the CDN mirrors the entire ``public/assets/`` tree. Per-lap files are
 * already cache-busted via ``?v=<mtime>`` so deploys don't fight the edge
 * cache. The manifest file itself isn't versioned, so on a re-deploy you
 * may need to purge that one URL on Bunny if you want the change to land
 * before the edge TTL expires (a few minutes typically).
 *
 * Call ``assetUrl('/assets/...')`` from any consumer that fetches an asset
 * — it's a no-op on localhost and prepends the CDN origin elsewhere.
 *
 * Override (any host): append ``?cdn=force`` to use the CDN, or ``?cdn=off``
 * to disable it. Useful for one-off testing.
 */

const CDN_BASE = 'https://vr-raceai-me-poc.b-cdn.net'

function detectLocalhost() {
  if (typeof window === 'undefined') return true
  const host = window.location?.hostname || ''
  if (!host) return true
  if (host === 'localhost') return true
  if (host === '127.0.0.1') return true
  if (host === '0.0.0.0') return true
  if (host.endsWith('.local')) return true
  return false
}

function detectOverride() {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location?.search || '')
  const v = params.get('cdn')
  if (v === 'force') return CDN_BASE
  if (v === 'off') return ''
  return null
}

const override = detectOverride()
const isLocalhost = detectLocalhost()

/** Empty string on localhost, the Bunny CDN origin elsewhere. */
export const ASSET_BASE_URL = override !== null ? override : (isLocalhost ? '' : CDN_BASE)

/**
 * Rewrite a same-origin asset path through the active profile.
 *
 * Safe to call on any string:
 *   - empty / null / undefined → returned as-is
 *   - already absolute (``http://`` or ``https://``) → returned as-is
 *   - relative (no leading slash) → returned as-is
 *   - root-relative (starts with ``/``) → CDN prefix prepended on non-localhost
 */
export function assetUrl(path) {
  if (!path || typeof path !== 'string') return path
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  if (!path.startsWith('/')) return path
  return ASSET_BASE_URL + path
}

if (typeof window !== 'undefined' && typeof console !== 'undefined') {
  console.log(`[config] asset profile: ${ASSET_BASE_URL || '(local)'}  host=${window.location?.hostname}`)
}
