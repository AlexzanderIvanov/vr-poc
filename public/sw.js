/**
 * Service worker — runtime cache for `/assets/` requests.
 *
 * Why it exists:
 *   Chrome's HTTP disk cache silently drops single entries that exceed
 *   ~25 % of its quota (the track GLB at ~70 MB hits this threshold on
 *   most installs), so the `Cache-Control: immutable` header alone is
 *   insufficient to guarantee that the 3D viewer's assets survive a
 *   page refresh. The Cache Storage API used here has separate, much
 *   larger quotas (browsers typically grant ~50 % of free disk), so
 *   even the largest GLB persists.
 *
 * Strategy:
 *   - Stale-while-revalidate-but-prefer-cache for `/assets/`: serve
 *     immediately from the cache on a hit; refresh asynchronously when
 *     the response is `?v=…`-busted and the cache hasn't seen the new
 *     URL yet.
 *   - Cache miss → fetch from network, store the response (only if 2xx
 *     and the URL carries a `?v=` so we know the upstream is treating
 *     the file as immutable).
 *
 * Invalidation:
 *   The manifest's `?v=…` query is part of the cache key (default
 *   `Request` identity includes the URL with its query string). When a
 *   data pipeline re-bakes a GLB and the manifest's `?v=` bumps, the
 *   new URL misses the cache and refetches fresh. Old entries linger
 *   until the next `CACHE_VERSION` bump clears them in `activate`.
 *
 * Devs:
 *   Hard-reload (Cmd-Shift-R / Ctrl-F5) BYPASSES the service worker
 *   for the page navigation, but the fetch handler still intercepts
 *   subresources unless `bypassForNetwork` is set in DevTools. To
 *   force a full cold reload during development, unregister the
 *   worker from the Application → Service Workers panel and reload.
 */

const CACHE_VERSION = 'v1'
const CACHE_NAME = `vr-poc-assets-${CACHE_VERSION}`
const ASSET_PREFIX = '/assets/'

self.addEventListener('install', (event) => {
  // Take over immediately so the very next page load can be served from
  // this worker (no need to wait for all tabs to close).
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from prior CACHE_VERSION bumps so the disk doesn't
    // accumulate stale snapshots indefinitely.
    const keys = await caches.keys()
    await Promise.all(
      keys.filter((k) => k.startsWith('vr-poc-assets-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k)),
    )
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only intercept asset requests on our own origin. Cross-origin (CDN,
  // analytics, …) goes straight to the network unmodified.
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(ASSET_PREFIX)) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(req)
    if (hit) return hit

    let resp
    try {
      resp = await fetch(req)
    } catch (err) {
      // Offline + cache miss — return a synthetic 504 the app's existing
      // error overlay can pick up.
      return new Response('Offline and asset not in cache', {
        status: 504, statusText: 'Gateway Timeout',
      })
    }
    // Only cache successful, non-opaque responses. Don't cache the
    // dev-server's HMR-friendly versions that have no `?v=` query —
    // those URLs are stable but their contents can be edited at any
    // time, so caching them would mask local edits.
    if (resp.ok && url.search.includes('v=')) {
      try { cache.put(req, resp.clone()) } catch {}
    }
    return resp
  })())
})
