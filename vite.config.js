import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Long-cache the `/assets/` directory in the dev server.
 *
 * Vite's default `Cache-Control: no-cache` is set so HMR can replace
 * module source on save — but it also forces the browser to round-trip
 * an `If-None-Match` ETag check for the 70+ MB track GLB on every page
 * load (returns 304, but the request still goes out, and 70 MB at any
 * non-LAN speed is slow). The asset files don't change between HMR
 * cycles — only when the user re-runs a data pipeline and bumps the
 * `?v=…` cache-bust query in `manifest.json`. So we mirror what nginx
 * does in production: aggressive `max-age` + `immutable`, and rely on
 * the `?v=` query for invalidation.
 *
 * `immutable` means the browser won't revalidate on a normal reload
 * (Cmd-R / F5) — only a hard reload (Cmd-Shift-R / Ctrl-F5) bypasses
 * the cache. Devs editing GLBs locally must either bump `?v=` in the
 * manifest OR hard-reload.
 */
const longCacheAssetsPlugin = {
  name: 'long-cache-assets-in-dev',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable')
      }
      next()
    })
  },
}

export default defineConfig({
  plugins: [react(), longCacheAssetsPlugin],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    // Split the bundle into vendor chunks so the initial JS payload is
    // smaller (and so the heavy 3D / charts code can download in parallel
    // with the React shell, rather than after it).
    //
    // Pre-split this gives roughly:
    //   - one ~2.5 MB chunk (everything mashed together)
    // Post-split:
    //   - three / drei / r3f → ~600 KB (3D engine; ~50 % of the bundle)
    //   - echarts / echarts-for-react → ~600 KB (charts)
    //   - react / react-dom → ~140 KB
    //   - app code → ~120 KB
    //
    // The browser fetches them in parallel over HTTP/2, and the service
    // worker caches each by content-hashed URL independently — so a
    // tweak to chart code doesn't bust the 3D chunk and vice versa.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          echarts: ['echarts', 'echarts-for-react'],
          react: ['react', 'react-dom', 'react-resizable-panels'],
          zustand: ['zustand'],
        },
      },
    },
    // Raise the warn threshold to suit our split layout — three+drei alone
    // is naturally ~600 KB minified and can't be made smaller without
    // dropping features. The warning is informational; don't silence it.
    chunkSizeWarningLimit: 700,
  },
})
